'use strict';
// This file intentionally runs with the editor's own Node, without node:test.
const fs = require('fs');
const path = require('path');
const assert = require('assert').strict;
const vm = require('vm');
const source = process.argv[2];
if (!source || !fs.existsSync(path.join(source, 'package.json'))) throw new Error('请先运行 npm run build。');
const temporary = fs.mkdtempSync(path.join(path.dirname(path.resolve(source)), 'cocos-resource-editor-smoke-'));
const installed = path.join(temporary, 'extensions', 'cocos-resource-inspector');
let extension;
function copyDirectory(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error('不复制符号链接');
        if (entry.isDirectory()) copyDirectory(path.join(from, entry.name), path.join(to, entry.name));
        else fs.copyFileSync(path.join(from, entry.name), path.join(to, entry.name));
    }
}
async function run() {
    copyDirectory(source, installed);
    const assetsPath = path.join(temporary, 'assets');
    fs.mkdirSync(assetsPath);
    fs.mkdirSync(path.join(temporary, 'tmp'));
    fs.writeFileSync(path.join(temporary, 'tsconfig.json'), JSON.stringify({ extends: './tmp/tsconfig.cocos.json' }));
    fs.writeFileSync(path.join(temporary, 'tmp/tsconfig.cocos.json'), JSON.stringify({ compilerOptions: { target: 'ES2017', module: 'ESNext', strict: true }, include: ['../assets/**/*.ts', './cc.d.ts'] }));
    fs.writeFileSync(path.join(temporary, 'tmp/cc.d.ts'), 'declare module "cc" { export class Component {} } declare function playSound(name: string): void;');
    const image = '12345678-1234-4234-8234-123456789abc', prefab = 'abcdef12-1234-4234-8234-123456789abc', frame = image + '@f9941';
    fs.writeFileSync(path.join(assetsPath, 'image.png'), Buffer.alloc(50 * 1024 + 1));
    fs.writeFileSync(path.join(assetsPath, 'image.png.meta'), JSON.stringify({ uuid: image, importer: 'image', subMetas: { f9941: { uuid: frame, importer: 'sprite-frame' } } }));
    const audio = '12345678-1234-4234-8234-123456789abd', unusedAudio = '12345678-1234-4234-8234-123456789abe';
    for (const [filename, uuid] of [['sound.mp3', audio], ['unused.mp3', unusedAudio], ['Audio.ts', '12345678-1234-4234-8234-123456789abf']]) {
        fs.writeFileSync(path.join(assetsPath, filename), filename.endsWith('.ts') ? "import { Component } from 'cc'; export class Audio extends Component { start() { playSound('sound'); } }" : Buffer.from([0, 255, 1]));
        fs.writeFileSync(path.join(assetsPath, filename + '.meta'), JSON.stringify({ uuid, importer: filename.endsWith('.ts') ? 'typescript' : 'audio-clip' }));
    }
    fs.writeFileSync(path.join(assetsPath, 'Example.prefab.meta'), JSON.stringify({ uuid: prefab, importer: 'prefab' }));
    fs.writeFileSync(path.join(assetsPath, 'Example.prefab'), JSON.stringify([
        { __type__: 'cc.Prefab', data: { __id__: 1 } },
        { __type__: 'cc.Node', _name: 'Root', _id: 'saved-root-id', _children: [], _components: [{ __id__: 2 }], _parent: null, _prefab: { __id__: 3 } },
        { __type__: 'cc.Sprite', node: { __id__: 1 }, _spriteFrame: { __uuid__: frame } },
        { __type__: 'cc.PrefabInfo', root: { __id__: 1 }, asset: { __id__: 0 }, fileId: 'root-file-id' },
    ]));
    const listeners = new Map();
    global.Editor = {
        Project: { path: temporary }, Panel: { define: value => value }, Selection: { clear() {}, select() {} },
        Message: {
            async request(name, method) {
                assert.equal(name, 'asset-db'); assert.equal(method, 'query-assets');
                return [{ uuid: image, url: 'db://assets/image.png' }, { uuid: prefab, url: 'db://assets/Example.prefab' }];
            },
            send() {}, addBroadcastListener: (name, fn) => listeners.set(name, fn), removeBroadcastListener: name => listeners.delete(name),
        },
    };
    const manifest = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
    extension = require(path.join(installed, manifest.main));
    assert.ok(require(path.join(installed, 'panels/default/index.js')).template);
    extension.load();
    assert.equal(extension.methods.scanProject().status, 'scanning');
    const deadline = Date.now() + 20000;
    while (extension.methods.getState().status === 'scanning' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    const state = extension.methods.getState();
    assert.equal(state.status, 'ready', state.error || '扫描超时');
    assert.equal(state.result.summary.errors, 0);
    assert.equal(state.result.summary.warnings, 0);
    assert.equal(state.result.scriptCheck.status, 'checked');
    assert.equal(state.result.scriptCheck.checkedFiles, 1);
    assert.equal(extension.methods.queryReferences({ uuid: image, direction: 'incoming' }).total, 1);
    assert.equal(extension.methods.getImpact({ uuid: image }).direct[0].uuid, prefab);
    assert.equal(extension.methods.queryUnusedAssets({ status: 'referenced', category: 'image' }).items[0].uuid, image);
    assert.equal(extension.methods.queryUnusedAssets({ status: 'unused' }).items[0].uuid, unusedAudio);
    assert.equal(extension.methods.queryUnusedAssets({ status: 'referenced', category: 'audio' }).items[0].uuid, audio);
    assert.equal(extension.methods.queryReferences({ uuid: audio }).items[0].kind, 'audio-name');
    const reference = extension.methods.queryReferences({ uuid: image, direction: 'incoming' }).items[0];
    const liveNode = { uuid: 'editor-rebuilt-root', name: 'Root', children: [], _prefab: { fileId: 'root-file-id', asset: { _uuid: prefab } } };
    const liveScene = { uuid: 'wrapper-scene', name: 'EditorScene', children: [{ uuid: 'wrapper-canvas', name: 'Canvas', children: [liveNode] }] };
    const sceneExports = {};
    vm.runInNewContext(fs.readFileSync(path.join(installed, 'scene.js'), 'utf8'), {
        exports: sceneExports,
        require: name => { assert.equal(name, 'cc'); return { director: { getScene: () => liveScene } }; },
        Editor: { Message: { request: async () => prefab } },
    });
    assert.equal((await sceneExports.methods.findNode(reference)).uuid, liveNode.uuid);
    liveNode.components = [{ __prefab: { fileId: 'sprite-file-id' }, node: liveNode }];
    assert.equal((await sceneExports.methods.findNode({ ...reference, prefabTarget: { localID: ['sprite-file-id'] } })).uuid, liveNode.uuid);
    const sizeStats = extension.methods.getSizeStats();
    const expectedBytes = fs.readdirSync(assetsPath).filter(name => !name.endsWith('.meta')).reduce((total, name) => total + fs.statSync(path.join(assetsPath, name)).size, 0);
    assert.equal(sizeStats.totalBytes, expectedBytes);
    assert.equal(sizeStats.totalFiles, 5);
    assert.equal(sizeStats.unknownFiles, 0);
    assert.equal(sizeStats.largestThresholdBytes, 50 * 1024);
    assert.equal(sizeStats.largestAssets.length, 1);
    assert.equal(sizeStats.largestAssets[0].uuid, image);
    assert.equal(extension.methods.queryAssets({ sort: 'size-desc' }).items[0].uuid, image);
    listeners.get('asset-db:asset-change')();
    assert.equal(extension.methods.getState().dirty, true);
    for (const format of ['html', 'json']) {
        const exported = extension.methods.exportReport({ format });
        assert.equal(path.dirname(exported.path), path.join(installed, 'RIReports'));
        assert.ok(fs.statSync(exported.path).size > 100);
        const contents = fs.readFileSync(exported.path, 'utf8');
        if (format === 'json') assert.equal(JSON.parse(contents).sizeStats.totalBytes, expectedBytes);
        else assert.ok(contents.includes('资源大小'));
    }
    fs.appendFileSync(path.join(assetsPath, 'Audio.ts'), '\nexport const invalid: number = "wrong";');
    assert.equal(extension.methods.scanProject().status, 'scanning');
    const tsDeadline = Date.now() + 20000;
    while (extension.methods.getState().status === 'scanning' && Date.now() < tsDeadline) await new Promise(resolve => setTimeout(resolve, 20));
    const tsState = extension.methods.getState();
    assert.equal(tsState.status, 'ready', tsState.error || 'TS 扫描超时');
    assert.equal(tsState.result.summary.tsErrors, 1);
    const tsIssue = extension.methods.queryIssues({ category: 'typescript' }).items[0];
    assert.equal(tsIssue.code, 'TS2322');
    assert.equal(tsIssue.line, 2);
    assert.equal(tsIssue.column, 14);
    assert.equal(tsIssue.sourceUrl, 'db://assets/Audio.ts');
    assert.equal(fs.existsSync(path.join(assetsPath, 'Audio.js')), false);
    extension.unload(); extension = undefined;
    assert.equal(listeners.size, 0);
    console.log('EDITOR_RUNTIME_SMOKE_OK ' + JSON.stringify({ node: process.versions.node, electron: process.versions.electron, version: manifest.version,
        checks: ['packaged-modules', 'panel-load', 'worker-scan', 'typescript-diagnostics', 'subasset-references', 'unused-queries', 'audio-name-references', 'prefab-node-location', 'prefab-override-location', 'deletion-impact', 'source-size-stats', 'size-sorting', 'invalidation', 'html-json-export', 'unload'] }));
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    if (extension) extension.unload();
    delete global.Editor;
    fs.rmSync(temporary, { recursive: true, force: true });
});
