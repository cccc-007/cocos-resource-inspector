'use strict';
const path = require('path');
const { Worker } = require('worker_threads');
const { ResultStore, page } = require('./lib/model');
const { outputDirectory, writeReport } = require('./lib/report');

const NAME = 'cocos-resource-inspector';
const BROADCASTS = ['asset-db:asset-add', 'asset-db:asset-change', 'asset-db:asset-delete'];
let store, job, enabled = false, generation = 0, revision = 0, changes = 0;
let status = 'idle', progress, lastError, dirty = false;

function getState() {
    return { status, progress, revision, dirty, error: lastError, outputDirectory: outputDirectory(__dirname),
        result: store ? { summary: store.result.summary, scannedAt: store.result.scannedAt, limitations: store.result.limitations.slice(0, 100),
            limitationsTotal: store.result.limitations.length } : undefined };
}
function invalidate() { changes++; if (store || status === 'scanning') dirty = true; }
function requireStore() { if (!store) throw new Error('请先扫描项目。'); return store; }
function timeout(promise, milliseconds) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('资源数据库查询超时，将使用磁盘元数据扫描。')), milliseconds); })]).finally(() => clearTimeout(timer));
}
function flattenAssets(infos) {
    const items = [], seen = new Set();
    const walk = value => {
        if (!value || typeof value !== 'object') return;
        if (typeof value.uuid === 'string' && !seen.has(value.uuid)) {
            seen.add(value.uuid);
            items.push({ uuid: value.uuid, url: value.url, path: value.path || value.file, file: value.file, name: value.name,
                type: value.type, importer: value.importer, isDirectory: value.isDirectory, isSubAsset: value.isSubAsset });
        }
        if (Array.isArray(value.children)) value.children.forEach(walk);
        if (value.subAssets && typeof value.subAssets === 'object') Object.values(value.subAssets).forEach(walk);
    };
    if (Array.isArray(infos)) infos.forEach(walk);
    else if (infos && Array.isArray(infos.assets)) infos.assets.forEach(walk);
    else throw new Error('资源数据库返回格式不受支持，将使用磁盘元数据扫描。');
    return items;
}
async function startScan() {
    if (!enabled) throw new Error('插件已停用，请重新启用。');
    if (status === 'scanning') return getState();
    const token = ++generation, startChanges = changes;
    status = 'scanning'; lastError = undefined;
    progress = { phase: 'database', done: 0, total: 0, message: '正在读取资源数据库…' };
    let assetInfos, databaseWarning;
    try {
        assetInfos = flattenAssets(await timeout(Editor.Message.request('asset-db', 'query-assets'), 20000));
        if (!assetInfos.length) { assetInfos = undefined; databaseWarning = '资源数据库未返回资源；内置资源及自定义导入器引用只能做有限检查。'; }
    } catch (error) { databaseWarning = error.message || String(error); }
    if (!enabled || token !== generation) return getState();
    try {
        const worker = new Worker(path.join(__dirname, 'lib', 'worker.js'), {
            workerData: { projectPath: Editor.Project.path, assetInfos },
            resourceLimits: { maxOldGenerationSizeMb: 512 },
        });
        job = worker;
        const fail = error => {
            if (token !== generation || !enabled) return;
            job = undefined; status = 'error'; lastError = error.message || String(error); progress = undefined;
            dirty = !!store;
        };
        worker.on('message', message => {
            if (token !== generation || !enabled) return;
            if (message.type === 'progress') { progress = message.progress; return; }
            if (message.type === 'error') { fail(new Error(message.error)); void worker.terminate(); return; }
            if (message.type === 'result') {
                try {
                    if (databaseWarning) message.result.limitations.unshift(databaseWarning);
                    store = new ResultStore(message.result);
                    revision++; status = 'ready'; dirty = changes !== startChanges; progress = undefined; job = undefined;
                } catch (error) { fail(error); }
            }
        });
        worker.once('error', fail);
        worker.once('exit', code => { if (job === worker && token === generation) fail(new Error(`扫描线程意外退出（${code}），可重试或缩小项目规模。`)); });
    } catch (error) {
        status = 'error'; lastError = error.message || String(error); progress = undefined;
    }
    return getState();
}
function cancelScan() {
    ++generation;
    if (job) { void job.terminate(); job = undefined; }
    status = store ? 'ready' : 'idle'; progress = undefined; lastError = undefined;
    return getState();
}

exports.load = function () {
    enabled = true;
    for (const broadcast of BROADCASTS) Editor.Message.addBroadcastListener(broadcast, invalidate);
};
exports.unload = function () {
    enabled = false; cancelScan();
    for (const broadcast of BROADCASTS) Editor.Message.removeBroadcastListener(broadcast, invalidate);
    store = undefined; dirty = false;
};
exports.methods = {
    openPanel() { return Editor.Panel.open(NAME); },
    getState,
    scanProject() {
        if (!enabled) throw new Error('插件已停用，请重新启用。');
        void startScan().catch(error => { status = 'error'; lastError = error.message || String(error); progress = undefined; });
        return getState();
    },
    cancelScan,
    queryAssets(options) { return store ? store.queryAssets(options) : page([], options); },
    queryUnusedAssets(options) { return store ? store.queryUnusedAssets(options) : page([], options); },
    queryIssues(options) { return store ? store.queryIssues(options) : page([], options); },
    queryReferences(options) { return store ? store.queryReferences(options) : page([], options); },
    getSizeStats() { return requireStore().result.sizeStats; },
    getImpact(options) { return requireStore().getImpact(options); },
    locateAsset(options = {}) {
        const asset = requireStore().assets.get(String(options.uuid || '').toLowerCase());
        if (!asset) throw new Error('该资源不存在于当前索引，请重新扫描。');
        if (options.url && options.url !== asset.url) throw new Error('资源 UUID 重复或索引已变化，请按报告中的路径手动定位并重新扫描。');
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:@|$)/i.test(asset.uuid)) throw new Error('资源尚未导入或缺少有效 UUID，请在资源管理器按路径查找。');
        Editor.Selection.clear('asset');
        Editor.Selection.select('asset', asset.uuid);
        Editor.Message.send('assets', 'twinkle', asset.uuid);
        return { message: `已定位：${asset.url}` };
    },
    async locateNode(options = {}) {
        const currentStore = requireStore();
        const asset = currentStore.assets.get(String(options.sourceUuid || '').toLowerCase());
        if (!asset || !options.nodePath) throw new Error('该记录没有可定位的节点。');
        const result = await Editor.Message.request('scene', 'execute-scene-script', { name: NAME, method: 'findNode',
            args: [{ sourceUuid: asset.uuid, nodePath: String(options.nodePath), nodeId: options.nodeId, nodeLocator: options.nodeLocator, prefabTarget: options.prefabTarget }] });
        if (!enabled || store !== currentStore) throw new Error('插件状态或扫描结果已变化，请重新定位。');
        if (!result || !result.uuid) throw new Error(result && result.message || '请先在编辑器打开对应的场景或 Prefab，再定位节点。');
        Editor.Selection.clear('node');
        Editor.Selection.select('node', result.uuid);
        Editor.Message.send('hierarchy', 'twinkle', result.uuid);
        return { message: `已定位节点：${result.nodePath || options.nodePath}` };
    },
    exportReport(options = {}) {
        if (status === 'scanning') throw new Error('请等待扫描完成后导出。');
        return writeReport(__dirname, requireStore().result, options.format || 'html', dirty);
    },
};
