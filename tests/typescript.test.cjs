'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { scanProject, DEFAULT_LIMITS } = require('../lib/core');
const { ResultStore } = require('../lib/model');
const { htmlReport, writeReport } = require('../lib/report');

function fixture(t) {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-ts-check-'));
    t.after(() => fs.rmSync(projectPath, { recursive: true, force: true }));
    const write = (relative, value) => {
        const file = path.join(projectPath, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
        if (relative.startsWith('assets/') && /\.(?:ts|tsx|mts|cts)$/.test(relative)) {
            fs.writeFileSync(file + '.meta', JSON.stringify({ uuid: require('crypto').randomUUID(), importer: 'typescript' }));
        }
        return file;
    };
    fs.mkdirSync(path.join(projectPath, 'assets'));
    return { projectPath, write };
}

test('checks types, unresolved modules and syntax with Cocos extends, aliases, ambient declarations and exclusions; emits no files', async t => {
    const f = fixture(t);
    f.write('tmp/tsconfig.cocos.json', { compilerOptions: { target: 'ES2017', module: 'ESNext', moduleResolution: 'node', experimentalDecorators: true, strict: true, baseUrl: '..', paths: { cc: ['types/cc.d.ts'], '@app/*': ['assets/*'] } }, include: ['../assets/**/*', '../types/**/*.d.ts'] });
    f.write('tsconfig.json', '{ // Creator project config\n "extends": "./tmp/tsconfig.cocos.json", "exclude": ["assets/ignored.ts"], }');
    f.write('types/cc.d.ts', 'declare module "cc" { export class Component { enabled: boolean; } export const _decorator: { ccclass(name: string): ClassDecorator }; }\ndeclare function gameLog(message: string): void;');
    f.write('assets/valid.ts', 'import { Component, _decorator } from "cc";\n@_decorator.ccclass("Valid")\nexport class Valid extends Component { start() { gameLog("ok"); this.enabled = true; } }');
    f.write('assets/bad.ts', 'import { Valid } from "@app/valid";\nconst count: number = "wrong";\nnew Valid().missing();');
    f.write('assets/module.ts', 'import { missing } from "./does-not-exist";\nmissing();');
    f.write('assets/syntax.ts', 'export const broken = ;');
    f.write('assets/ignored.ts', 'const ignored: number = "skip me";');
    const phases = [];
    const result = await scanProject({ projectPath: f.projectPath, onProgress: value => phases.push(value.phase) });
    assert.equal(result.scriptCheck.status, 'checked');
    assert.equal(result.scriptCheck.checkedFiles, 4);
    assert.equal(result.scriptCheck.excludedFiles, 1);
    assert.equal(result.scriptCheck.partial, false);
    assert(phases.includes('typescript'));
    const store = new ResultStore(result);
    const issues = store.queryIssues({ category: 'typescript' }).items;
    const assignment = issues.find(issue => issue.code === 'TS2322');
    assert(assignment);
    assert.equal(assignment.sourceUrl, 'db://assets/bad.ts');
    assert.equal(assignment.line, 2);
    assert.equal(assignment.column, 7);
    assert.equal(assignment.sourceUuid, result.assets.find(asset => asset.url === assignment.sourceUrl).uuid);
    assert(issues.some(issue => issue.code === 'TS2339'));
    assert(issues.some(issue => issue.code === 'TS2307'));
    assert(issues.some(issue => issue.diagnosticKind === 'syntax'));
    assert(!issues.some(issue => /valid.ts|ignored.ts/.test(issue.sourceUrl || '')));
    assert.equal(store.queryIssues({ category: 'typescript', query: 'TS2322', severity: 'error' }).total, 1);
    assert.equal(store.queryIssues({ category: 'resource' }).total, 0);
    assert.equal(result.summary.tsErrors, issues.length);
    assert.equal(result.summary.errors, issues.length);
    assert.equal(fs.existsSync(path.join(f.projectPath, 'assets/bad.js')), false);
    assert.equal(fs.existsSync(path.join(f.projectPath, 'tsconfig.tsbuildinfo')), false);
    const html = htmlReport(result);
    assert.match(html, /TS 脚本检查/);
    assert.match(html, /已检查语法和类型/);
    assert.match(html, /2:7/);
    const jsonFile = writeReport(f.projectPath, result, 'json').path;
    assert.deepEqual(JSON.parse(fs.readFileSync(jsonFile, 'utf8')).scriptCheck, result.scriptCheck);
});

test('missing config checks syntax without reporting missing cc types or claiming full type coverage', async t => {
    const f = fixture(t);
    f.write('assets/syntax.ts', 'export const value: = 1;');
    f.write('assets/types.ts', 'import { Component } from "cc"; const count: number = "wrong";');
    const result = await scanProject({ projectPath: f.projectPath });
    assert.equal(result.scriptCheck.status, 'syntax-only');
    assert.equal(result.scriptCheck.checkedFiles, 2);
    assert.equal(result.scriptCheck.partial, true);
    assert(result.issues.some(issue => issue.category === 'typescript' && issue.diagnosticKind === 'syntax'));
    assert(!result.issues.some(issue => issue.code === 'TS2307' || issue.code === 'TS2322'));
    assert.match(result.limitations.join('\n'), /仅检查语法/);
    assert.match(htmlReport(result), /TS 检查不完整/);
});

test('missing generated Creator config and malformed tsconfig retain config diagnostics and syntax fallback', async t => {
    const f = fixture(t);
    f.write('assets/bad.ts', 'import { Component } from "cc";\nexport const bad = ;');
    for (const config of ['{"extends":"./tmp/tsconfig.cocos.json"}', '{"compilerOptions": {"target": }}']) {
        f.write('tsconfig.json', config);
        const result = await scanProject({ projectPath: f.projectPath });
        assert.equal(result.scriptCheck.status, 'syntax-only', JSON.stringify(result.issues));
        assert(result.issues.some(issue => issue.diagnosticKind === 'config'));
        assert(result.issues.some(issue => issue.diagnosticKind === 'syntax'));
        assert(!result.issues.some(issue => issue.code === 'TS2307'));
    }
});

test('source limits and cancellation explicitly leave TS checks incomplete; issue caps retain counts', async t => {
    const f = fixture(t);
    f.write('tsconfig.json', { compilerOptions: { target: 'ES2017' }, include: ['assets/**/*.ts'] });
    f.write('assets/large.ts', 'export const value: number = "wrong";\n'.repeat(20));
    const limited = await scanProject({ projectPath: f.projectPath, limits: { maxFileBytes: 200 } });
    assert.equal(limited.scriptCheck.partial, true);
    assert.equal(limited.scriptCheck.checkedFiles, 0);
    f.write('assets/large.ts', 'export const value: number = "wrong";');
    f.write('assets/second.ts', 'export const other: number = "wrong";');
    const capped = await scanProject({ projectPath: f.projectPath, limits: { maxIssues: 1 } });
    assert.equal(capped.issues.length, 1);
    assert.equal(capped.scriptCheck.errors, 2);
    assert.equal(capped.summary.tsErrors, 2);
    assert.equal(capped.summary.partial, true);
    let cancel = false;
    const cancelled = await scanProject({ projectPath: f.projectPath, isCancelled: () => cancel, onProgress(value) { if (value.phase === 'typescript' && value.completed === 1) cancel = true; } });
    assert.equal(cancelled.scriptCheck.status, 'cancelled');
    assert.equal(cancelled.scriptCheck.checkedFiles, 1);
    assert.equal(cancelled.summary.cancelled, true);
});

test('missing compiler produces an explicit warning instead of a clean result', async t => {
    const f = fixture(t);
    const file = f.write('assets/test.ts', 'export const bad = ;');
    const isolatedRequire = name => require(name);
    isolatedRequire.resolve = () => { throw new Error('compiler not installed'); };
    const context = { module: { exports: {} }, require: isolatedRequire, process, __dirname: path.resolve(__dirname, '../lib') };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../lib/typescript.js'), 'utf8'), context);
    const issues = [];
    const result = await context.module.exports.checkTypeScript({ projectPath: f.projectPath, entries: [{ file }], limits: DEFAULT_LIMITS, issue: (...args) => issues.push(args), limitation() {}, progress() {}, cancelled: () => false });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.partial, true);
    assert.equal(issues[0][0], 'warning');
    assert.equal(issues[0][1], 'TS_COMPILER_UNAVAILABLE');
});
