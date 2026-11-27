'use strict';

const fs = require('fs');
const path = require('path');

const isTypeScript = file => /\.(?:ts|tsx|mts|cts)$/i.test(file);
const slash = file => file.replace(/\\/g, '/');
function within(root, file) {
    const relative = path.relative(root, file);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

// Creator ships TypeScript. Resolve it explicitly because a project extension's
// normal module search does not necessarily reach the editor's node_modules.
function loadCompiler(projectPath) {
    const resources = process.resourcesPath || path.join(path.dirname(process.execPath), 'resources');
    const roots = [projectPath, path.join(resources, 'app.asar'), path.join(resources, 'app.asar.unpacked'), path.resolve(__dirname, '..')];
    for (const root of roots) {
        try {
            const compiler = require(require.resolve('typescript', { paths: [root] }));
            if (typeof compiler.createProgram === 'function' && typeof compiler.parseJsonConfigFileContent === 'function') return compiler;
        } catch (_) { /* Try the next installed compiler; never install into the project. */ }
    }
    return null;
}

async function checkTypeScript({ projectPath, entries, limits, issue, limitation, progress, cancelled }) {
    const scripts = entries.filter(entry => !entry.directory && isTypeScript(entry.file));
    const stats = { status: 'no-files', totalFiles: scripts.length, checkedFiles: 0, excludedFiles: 0, errors: 0, warnings: 0, partial: false };
    if (!scripts.length) return stats;
    if (cancelled()) { stats.status = 'cancelled'; stats.partial = true; return stats; }
    progress('typescript', 0, scripts.length, '正在检查 TypeScript 脚本…');
    const ts = loadCompiler(projectPath);
    const assetsPath = path.join(projectPath, 'assets');
    const sourceMap = new Map(scripts.map(entry => [key(entry.file), entry.asset]));
    function key(file) { const resolved = path.resolve(file); return process.platform === 'win32' ? resolved.toLowerCase() : resolved; }
    function sourceLocation(file) {
        if (!file) return {};
        const absolute = path.resolve(file);
        const asset = sourceMap.get(key(absolute));
        return { ...(asset ? { sourceUuid: asset.uuid } : {}), sourceUrl: within(assetsPath, absolute)
            ? `db://assets/${slash(path.relative(assetsPath, absolute))}` : slash(path.relative(projectPath, absolute)) };
    }
    function incomplete(message, code) {
        stats.partial = true;
        limitation(message);
        if (code) {
            stats.warnings++;
            issue('warning', code, message, { category: 'typescript' });
        }
    }
    if (!ts) {
        stats.status = 'unavailable';
        incomplete('未找到 TypeScript 编译器，TS 脚本未检查。请在 Creator 中扫描；命令行模式请先在插件源码目录运行 npm ci。', 'TS_COMPILER_UNAVAILABLE');
        return stats;
    }
    stats.compilerVersion = ts.version;
    const seen = new Set();
    function diagnostic(value, kind) {
        const location = sourceLocation(value.file && value.file.fileName);
        if (!location.sourceUrl && kind === 'config') location.sourceUrl = stats.configFile;
        if (value.file && typeof value.start === 'number') {
            const position = value.file.getLineAndCharacterOfPosition(value.start);
            location.line = position.line + 1;
            location.column = position.character + 1;
        }
        const message = ts.flattenDiagnosticMessageText(value.messageText, '\n');
        const identity = `${value.code}|${location.sourceUrl}|${value.start}|${message}`;
        if (seen.has(identity)) return;
        seen.add(identity);
        const severity = value.category === ts.DiagnosticCategory.Error ? 'error' : value.category === ts.DiagnosticCategory.Warning ? 'warning' : 'info';
        if (severity === 'error') stats.errors++;
        if (severity === 'warning') stats.warnings++;
        issue(severity, `TS${value.code}`, message, { ...location, category: 'typescript', diagnosticKind: kind });
    }
    try {
        const configFile = path.join(projectPath, 'tsconfig.json');
        let parsed;
        if (fs.existsSync(configFile)) {
            stats.configFile = 'tsconfig.json';
            const config = ts.readConfigFile(slash(configFile), ts.sys.readFile);
            if (config.error) diagnostic(config.error, 'config');
            else {
                parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, slash(projectPath), undefined, slash(configFile));
                for (const error of parsed.errors) diagnostic(error, 'config');
                // A broken extends chain loses cc declarations and would generate
                // misleading cascades. Keep genuine syntax checks available.
                if (parsed.errors.length || (parsed.projectReferences || []).length) {
                    if ((parsed.projectReferences || []).length) incomplete('TS 配置使用 project references，本次仅检查语法；请使用项目的 tsc --build 检查跨项目类型。');
                    parsed = undefined;
                }
            }
        }
        const syntaxOnly = !parsed;
        if (syntaxOnly) incomplete('TS 本次仅检查语法：tsconfig.json 缺失或配置不完整。请先在 Creator 中打开项目生成 tmp/tsconfig.cocos.json，并修复配置后重新扫描。');
        stats.status = syntaxOnly ? 'syntax-only' : 'checked';
        const included = parsed && new Set(parsed.fileNames.map(key));
        const selected = scripts.filter(entry => !included || included.has(key(entry.file)));
        stats.excludedFiles = scripts.length - selected.length;
        const compilerOptions = Object.assign({}, parsed ? parsed.options : { target: ts.ScriptTarget.ESNext, experimentalDecorators: true, noLib: true, noResolve: true }, { noEmit: true, incremental: false, composite: false });
        // Newer compilers may allow disabling checking through tsconfig.
        if ('noCheck' in compilerOptions) compilerOptions.noCheck = false;
        const host = ts.createCompilerHost(compilerOptions);
        host.getCurrentDirectory = () => slash(projectPath);
        host.writeFile = () => { throw new Error('TS 检查不允许写入编译产物'); };
        const readFile = host.readFile;
        let loaded = 0;
        host.readFile = file => {
            try {
                if (++loaded > limits.maxFiles || fs.statSync(file).size > limits.maxFileBytes) {
                    incomplete('TS 依赖文件数量或大小达到扫描上限，部分脚本及类型信息未检查。');
                    return undefined;
                }
                return readFile(file);
            } catch (_) { return undefined; }
        };
        const program = ts.createProgram(parsed ? parsed.fileNames : selected.map(entry => entry.file), compilerOptions, host);
        if (!syntaxOnly) {
            for (const error of [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics()]) diagnostic(error, 'config');
        }
        const token = { isCancellationRequested: cancelled, throwIfCancellationRequested() { if (cancelled()) throw new ts.OperationCanceledException(); } };
        for (let index = 0; index < selected.length; index++) {
            if (cancelled()) { stats.partial = true; stats.status = 'cancelled'; break; }
            const entry = selected[index];
            const source = program.getSourceFile(entry.file);
            if (source) {
                const syntax = program.getSyntacticDiagnostics(source, token);
                for (const error of syntax) diagnostic(error, 'syntax');
                if (!syntaxOnly && !syntax.length) for (const error of program.getSemanticDiagnostics(source, token)) diagnostic(error, 'semantic');
                stats.checkedFiles++;
            } else incomplete(`TS 文件未能读取或超过大小上限：${sourceLocation(entry.file).sourceUrl}`);
            progress('typescript', index + 1, selected.length, `正在检查 TS：${slash(path.relative(projectPath, entry.file))}`);
            await new Promise(resolve => setImmediate(resolve));
        }
    } catch (error) {
        stats.status = cancelled() ? 'cancelled' : 'failed';
        incomplete(`TS 脚本检查未完成：${error.message || String(error)}`, stats.status === 'failed' ? 'TS_CHECK_FAILED' : undefined);
    }
    return stats;
}

module.exports = { checkTypeScript, isTypeScript, loadCompiler };
