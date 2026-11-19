'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const imageId = '12345678-1234-4234-8234-123456789abc';
const prefabId = 'abcdef12-1234-4234-8234-123456789abc';
async function waitForReady(extension) {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
        const state = extension.methods.getState();
        if (state.status === 'ready') return state;
        if (state.status === 'error') throw new Error(state.error);
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('扫描超时');
}
test('extension scans on worker, keeps IPC lightweight, invalidates changed data and releases listeners', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-extension-'));
    const listeners = new Map(), calls = [];
    fs.mkdirSync(path.join(root, 'assets'));
    fs.writeFileSync(path.join(root, 'assets', 'image.png'), 'image');
    fs.writeFileSync(path.join(root, 'assets', 'image.png.meta'), JSON.stringify({ uuid: imageId, importer: 'image' }));
    fs.writeFileSync(path.join(root, 'assets', 'example.prefab'), JSON.stringify([
        { __type__: 'cc.Prefab', data: { __id__: 1 } },
        { __type__: 'cc.Node', _name: 'Root', _components: [{ __id__: 2 }], _children: [], _parent: null },
        { __type__: 'cc.Sprite', node: { __id__: 1 }, _spriteFrame: { __uuid__: imageId } },
    ]));
    fs.writeFileSync(path.join(root, 'assets', 'example.prefab.meta'), JSON.stringify({ uuid: prefabId, importer: 'prefab' }));
    global.Editor = {
        Project: { path: root }, Panel: { open() {} }, Selection: { clear() {}, select() {} },
        Message: {
            async request(...args) { calls.push(args); if (args[1] === 'query-assets') return [{ uuid: imageId, url: 'db://assets/image.png', type: 'cc.ImageAsset' }, { uuid: prefabId, url: 'db://assets/example.prefab', type: 'cc.Prefab' }]; if (args[0] === 'scene' && args[1] === 'execute-scene-script') return { uuid: 'live-button', nodePath: 'Root/ActualButton' }; throw new Error('unexpected'); },
            send(...args) { calls.push(args); },
            addBroadcastListener(name, listener) { listeners.set(name, listener); },
            removeBroadcastListener(name, listener) { assert.equal(listeners.get(name), listener); listeners.delete(name); },
        },
    };
    const extension = require('../main');
    try {
        extension.load();
        const started = extension.methods.scanProject();
        assert.equal(started.status, 'scanning');
        const state = await waitForReady(extension);
        assert.equal(state.revision, 1);
        assert.equal(state.dirty, false);
        assert.ok(!Object.hasOwn(state.result, 'assets'));
        assert.ok(!Object.hasOwn(state.result, 'references'));
        assert.deepEqual(calls[0], ['asset-db', 'query-assets']);
        assert.equal(extension.methods.queryReferences({ uuid: imageId, direction: 'incoming' }).total, 1);
        assert.equal(extension.methods.getImpact({ uuid: imageId }).direct[0].uuid, prefabId);
        const sizeStats = extension.methods.getSizeStats();
        const expectedSize = fs.statSync(path.join(root, 'assets', 'image.png')).size + fs.statSync(path.join(root, 'assets', 'example.prefab')).size;
        assert.equal(sizeStats.totalBytes, expectedSize);
        assert.equal(sizeStats.totalFiles, 2);
        assert.equal(state.result.summary.totalSourceBytes, expectedSize);
        assert.equal(state.result.sizeStats, undefined, 'routine state polling only sends scalar size totals');
        listeners.get('asset-db:asset-change')({ uuid: imageId });
        assert.equal(extension.methods.getState().dirty, true);
        assert.throws(() => extension.methods.locateAsset({ uuid: 'unknown' }), /不存在/);
        assert.throws(() => extension.methods.locateAsset({ uuid: imageId, url: 'db://assets/another.png' }), /UUID 重复或索引/);
        extension.methods.locateAsset({ uuid: imageId });
        assert.ok(calls.some(call => call[0] === 'assets' && call[1] === 'twinkle'));
        const nodeLocator = { version: 1, segments: [{ name: 'Root', fileId: 'root-file-id', assetUuid: prefabId }] };
        const prefabTarget = { localID: ['component-file-id'] };
        const location = await extension.methods.locateNode({ sourceUuid: prefabId, nodePath: 'Root', nodeId: 'saved-id', nodeLocator, prefabTarget });
        const sceneCall = calls.find(call => call[0] === 'scene' && call[1] === 'execute-scene-script');
        assert.deepEqual(sceneCall[2].args[0].nodeLocator, nodeLocator);
        assert.deepEqual(sceneCall[2].args[0].prefabTarget, prefabTarget);
        assert.match(location.message, /Root\/ActualButton/);
        assert.ok(calls.some(call => call[0] === 'hierarchy' && call[2] === 'live-button'));
    } finally {
        extension.unload();
        assert.equal(listeners.size, 0);
        fs.rmSync(root, { recursive: true, force: true });
        delete global.Editor; delete require.cache[require.resolve('../main')];
    }
});
test('cancel during database wait ignores late database response and does not start a worker', async () => {
    const listeners = new Map(); let respond;
    global.Editor = {
        Project: { path: os.tmpdir() },
        Message: { request: () => new Promise(resolve => { respond = resolve; }), addBroadcastListener: (name, listener) => listeners.set(name, listener), removeBroadcastListener: name => listeners.delete(name) },
    };
    const extension = require('../main');
    try {
        extension.load();
        assert.equal(extension.methods.scanProject().status, 'scanning');
        assert.equal(extension.methods.cancelScan().status, 'idle');
        respond([]);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(extension.methods.getState().status, 'idle');
        assert.equal(extension.methods.getState().result, undefined);
    } finally { extension.unload(); delete global.Editor; delete require.cache[require.resolve('../main')]; }
});
