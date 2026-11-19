'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { scanProject } = require('../lib/core');

const SOURCE = '11111111-1111-4111-8111-111111111111';
const NESTED = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const IMAGE = '44444444-4444-4444-8444-444444444444';

function node(name, uuid, metadata, children = []) {
    const result = { name, uuid, children, isValid: true };
    if (metadata) result._prefab = metadata;
    Object.defineProperty(result, 'prefab', { get: () => result._prefab });
    for (const child of children) child.parent = result;
    return result;
}

function prefab(fileId, assetUuid = SOURCE, instanceFileId) {
    return { fileId, asset: { _uuid: assetUuid },
        ...(instanceFileId ? { instance: { fileId: instanceFileId } } : {}) };
}

function component(owner, fileId) {
    const value = { node: owner, __prefab: { fileId }, isValid: true };
    if (!owner.components) owner.components = [];
    owner.components.push(value);
    owner._components = owner.components;
    return value;
}

function locator(...segments) { return { version: 1, segments }; }
function request(nodeLocator, extra = {}) {
    return { sourceUuid: SOURCE, nodePath: nodeLocator.segments.map(segment => segment.name).join('/'), nodeLocator, ...extra };
}

function scene(root, current = SOURCE) {
    const methods = {};
    const calls = [];
    const source = fs.readFileSync(path.join(__dirname, '../scene.js'), 'utf8');
    vm.runInNewContext(source, { exports: methods,
        require(name) {
            if (name === 'cc') return { director: { getScene: () => typeof root === 'function' ? root() : root }, isValid: value => !!value && value.isValid !== false };
            if (name.startsWith('./')) return require(path.join(__dirname, '..', name));
            return require(name);
        },
        Editor: { Message: { request: async (...args) => {
            calls.push(args);
            assert.equal(args[0], 'scene');
            assert.equal(args[1], 'query-current-scene', 'node lookup must not open or replace the current asset');
            return typeof current === 'function' ? current() : current;
        } } },
    }, { filename: 'scene.js' });
    return { findNode: methods.methods.findNode, calls };
}

function rejected(result) {
    assert.ok(result && typeof result.message === 'string' && result.message, 'return an actionable explanation');
    assert.ok(!result.uuid, 'do not select an approximate match');
}

function fixture(t) {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-node-location-'));
    fs.mkdirSync(path.join(projectPath, 'assets'));
    t.after(() => fs.rmSync(projectPath, { recursive: true, force: true }));
    return {
        projectPath,
        asset(name, uuid, data) {
            fs.writeFileSync(path.join(projectPath, 'assets', name), JSON.stringify(data));
            fs.writeFileSync(path.join(projectPath, 'assets', `${name}.meta`), JSON.stringify({ uuid, importer: name.endsWith('.prefab') ? 'prefab' : 'scene' }));
        },
    };
}

test('scanned Prefab identities locate a live node whose UUID was rebuilt by Creator', async t => {
    const f = fixture(t);
    f.asset('Demo.prefab', SOURCE, [
        { __type__: 'cc.Prefab', _name: 'Demo', data: { __id__: 1 } },
        { __type__: 'cc.Node', _name: 'Root', _id: 'old-root-id', _parent: null, _children: [{ __id__: 2 }], _components: [], _prefab: { __id__: 4 } },
        { __type__: 'cc.Node', _name: 'Button', _id: 'old-button-id', _parent: { __id__: 1 }, _children: [], _components: [{ __id__: 3 }], _prefab: { __id__: 5 } },
        { __type__: 'cc.Sprite', node: { __id__: 2 }, _spriteFrame: { __uuid__: IMAGE } },
        { __type__: 'cc.PrefabInfo', root: { __id__: 1 }, asset: { __id__: 0 }, fileId: 'root-file-id' },
        { __type__: 'cc.PrefabInfo', root: { __id__: 1 }, asset: { __id__: 0 }, fileId: 'button-file-id' },
    ]);
    const result = await scanProject({ projectPath: f.projectPath, assetInfos: [] });
    const reference = result.references.find(item => item.targetUuid === IMAGE);
    assert.ok(reference && reference.nodeLocator, 'reference carries a stable node identity');
    assert.equal(reference.nodeLocator.version, 1);
    assert.deepEqual(reference.nodeLocator.segments.map(segment => ({ name: segment.name, fileId: segment.fileId, assetUuid: segment.assetUuid })), [
        { name: 'Root', fileId: 'root-file-id', assetUuid: SOURCE },
        { name: 'Button', fileId: 'button-file-id', assetUuid: SOURCE },
    ], 'PrefabInfo.asset local references refer to this source Prefab');
    const issue = result.issues.find(item => item.targetUuid === IMAGE);
    assert.deepEqual(issue.nodeLocator, reference.nodeLocator, 'issues and references locate the same owning node');
    const button = node('Button', 'runtime-prefix-button-file-id', prefab('button-file-id'));
    const liveRoot = node('EditorScene', 'editor-scene', null, [node('Root', 'runtime-root', prefab('root-file-id'), [button])]);
    const located = await scene(liveRoot).findNode(reference);
    assert.equal(located.uuid, button.uuid);
});

test('stable Prefab identities survive both a node rename and a rebuilt UUID', async () => {
    const button = node('Renamed Button', 'new-button-id', prefab('button-file-id'));
    const root = node('Renamed Root', 'new-root-id', prefab('root-file-id'), [button]);
    const found = await scene(root).findNode(request(locator(
        { name: 'Root', nodeId: 'old-root-id', fileId: 'root-file-id', assetUuid: SOURCE },
        { name: 'Button', nodeId: 'old-button-id', fileId: 'button-file-id', assetUuid: SOURCE },
    ), { nodeId: 'old-button-id' }));
    assert.equal(found.uuid, button.uuid);
});

test('Prefab isolation tolerates both editor Scene and Canvas wrappers before the actual source root', async () => {
    const button = node('Button', 'live-button', prefab('button-file-id'));
    const prefabRoot = node('Root', 'live-prefab-root', prefab('root-file-id'), [button]);
    const root = node('EditorScene', 'editor-scene', null, [node('Canvas', 'editor-canvas', null, [prefabRoot])]);
    const found = await scene(root).findNode(request(locator(
        { name: 'Root', fileId: 'root-file-id', assetUuid: SOURCE },
        { name: 'Button', fileId: 'button-file-id', assetUuid: SOURCE },
    ), { nodeId: 'serialized-button-id' }));
    assert.equal(found.uuid, button.uuid);
});

test('scanner preserves scene root kind and serialized nested Prefab instance identity', async t => {
    const f = fixture(t);
    f.asset('Main.scene', SOURCE, [
        { __type__: 'cc.SceneAsset', _name: 'Main', scene: { __id__: 1 } },
        { __type__: 'cc.Scene', _name: 'Main', _id: 'serialized-scene', _parent: null, _children: [{ __id__: 2 }], _components: [] },
        { __type__: 'cc.Node', _id: 'serialized-instance', _parent: { __id__: 1 }, _children: [], _components: [{ __id__: 7 }], _prefab: { __id__: 3 } },
        { __type__: 'cc.PrefabInfo', root: { __id__: 2 }, asset: { __uuid__: NESTED }, fileId: 'panel-root-file-id', instance: { __id__: 4 } },
        { __type__: 'cc.PrefabInstance', fileId: 'instance-A', prefabRootNode: { __id__: 2 }, propertyOverrides: [{ __id__: 8 }, { __id__: 5 }] },
        { __type__: 'CCPropertyOverrideInfo', targetInfo: { __id__: 6 }, propertyPath: ['_name'], value: 'Panel A' },
        { __type__: 'cc.TargetInfo', localID: ['panel-root-file-id'] },
        { __type__: 'cc.Sprite', node: { __id__: 2 }, _spriteFrame: { __uuid__: IMAGE } },
        { __type__: 'CCPropertyOverrideInfo', targetInfo: { __id__: 9 }, propertyPath: ['_name'], value: 'A child rename must not rename this instance' },
        { __type__: 'cc.TargetInfo', localID: ['some-child-file-id'] },
    ]);
    const result = await scanProject({ projectPath: f.projectPath, assetInfos: [] });
    const reference = result.references.find(item => item.targetUuid === IMAGE);
    assert.ok(reference && reference.nodeLocator);
    assert.equal(reference.nodeLocator.segments[0].kind, 'scene');
    const instance = reference.nodeLocator.segments[1];
    assert.equal(instance.name, 'Panel A');
    assert.equal(instance.fileId, 'panel-root-file-id');
    assert.equal(instance.instanceFileId, 'instance-A');
    assert.equal(instance.assetUuid, NESTED);
    const liveInstance = node('Panel A', 'rebuilt-instance', prefab('panel-root-file-id', NESTED, 'instance-A'));
    const root = node('Main', 'editor-scene-generated-uuid', null, [liveInstance]);
    assert.equal((await scene(root).findNode(reference)).uuid, liveInstance.uuid);
});

test('a resource property override locates the target component node rather than the containing Prefab instance', async t => {
    const f = fixture(t);
    f.asset('Main.scene', SOURCE, [
        { __type__: 'cc.SceneAsset', _name: 'Main', scene: { __id__: 1 } },
        { __type__: 'cc.Scene', _name: 'Main', _id: 'serialized-scene', _parent: null, _children: [{ __id__: 2 }], _components: [] },
        { __type__: 'cc.Node', _name: 'Panel', _id: 'serialized-instance', _parent: { __id__: 1 }, _children: [], _components: [], _prefab: { __id__: 3 } },
        { __type__: 'cc.PrefabInfo', root: { __id__: 2 }, asset: { __uuid__: NESTED }, fileId: 'panel-root-file-id', instance: { __id__: 4 } },
        { __type__: 'cc.PrefabInstance', fileId: 'outer-instance', prefabRootNode: { __id__: 2 }, propertyOverrides: [{ __id__: 5 }] },
        { __type__: 'CCPropertyOverrideInfo', targetInfo: { __id__: 6 }, propertyPath: ['_spriteFrame'], value: { __uuid__: IMAGE } },
        { __type__: 'cc.TargetInfo', localID: ['button-sprite-file-id'] },
    ]);
    const result = await scanProject({ projectPath: f.projectPath, assetInfos: [] });
    const reference = result.references.find(item => item.targetUuid === IMAGE);
    assert.ok(reference && reference.nodeLocator);
    assert.deepEqual(reference.prefabTarget, { localID: ['button-sprite-file-id'] });
    assert.deepEqual(result.issues.find(item => item.targetUuid === IMAGE).prefabTarget, reference.prefabTarget);
    const button = node('Button', 'expanded-button-node', prefab('button-node-file-id', NESTED));
    component(button, 'button-sprite-file-id');
    const instance = node('Panel', 'live-instance', prefab('panel-root-file-id', NESTED, 'outer-instance'), [button]);
    const root = node('Main', 'live-scene-root', null, [instance]);
    assert.equal((await scene(root).findNode(reference)).uuid, button.uuid);
});

test('override target local IDs distinguish equal component file IDs in nested instance namespaces', async () => {
    const a = node('Button', 'nested-A-button', prefab('button-node-file-id', OTHER));
    const b = node('Button', 'nested-B-button', prefab('button-node-file-id', OTHER));
    component(a, 'sprite-file-id');
    component(b, 'sprite-file-id');
    const panel = node('Panel', 'outer-panel', prefab('panel-root', NESTED, 'outer-instance'), [
        node('Inner', 'inner-A', prefab('inner-root', OTHER, 'inner-instance-A'), [a]),
        node('Inner', 'inner-B', prefab('inner-root', OTHER, 'inner-instance-B'), [b]),
    ]);
    const options = request(locator({ name: 'Panel', fileId: 'panel-root', instanceFileId: 'outer-instance', assetUuid: NESTED }), {
        nodeId: 'old-panel-id', prefabTarget: { localID: ['inner-instance-B', 'sprite-file-id'] },
    });
    const lookup = scene(node('EditorScene', 'editor-scene', null, [panel]));
    assert.equal((await lookup.findNode(options)).uuid, b.uuid);
    assert.equal((await lookup.findNode({ ...options, prefabTarget: { localID: ['inner-instance-B', 'button-node-file-id'] } })).uuid, b.uuid,
        'a local ID can also point directly to a node');
});

test('missing or ambiguous override targets cannot fall back to selecting the instance root', async () => {
    const a = node('Button', 'button-A', prefab('button-A-file-id', NESTED));
    const b = node('Button', 'button-B', prefab('button-B-file-id', NESTED));
    component(a, 'duplicate-sprite-file-id');
    component(b, 'duplicate-sprite-file-id');
    const panel = node('Panel', 'panel', prefab('panel-root', NESTED, 'outer-instance'), [a, b]);
    const lookup = scene(node('EditorScene', 'editor-scene', null, [panel]));
    const options = request(locator({ name: 'Panel', fileId: 'panel-root', instanceFileId: 'outer-instance', assetUuid: NESTED }));
    rejected(await lookup.findNode({ ...options, prefabTarget: { localID: ['removed-sprite-file-id'] } }));
    rejected(await lookup.findNode({ ...options, prefabTarget: { localID: ['duplicate-sprite-file-id'] } }));
});

test('ancestor instance identity distinguishes repeated nested Prefabs with the same node names and file IDs', async () => {
    const firstButton = node('Button', 'first-button', prefab('button-file-id', NESTED));
    const secondButton = node('Button', 'second-button', prefab('button-file-id', NESTED));
    const root = node('Root', 'new-root', prefab('root-file-id'), [
        node('Panel', 'first-panel', prefab('panel-file-id', NESTED, 'instance-A'), [firstButton]),
        node('Panel', 'second-panel', prefab('panel-file-id', NESTED, 'instance-B'), [secondButton]),
    ]);
    const found = await scene(root).findNode(request(locator(
        { name: 'Root', fileId: 'root-file-id', assetUuid: SOURCE },
        { name: 'Panel', fileId: 'panel-file-id', instanceFileId: 'instance-B', assetUuid: NESTED },
        { name: 'Button', fileId: 'button-file-id', assetUuid: NESTED },
    ), { nodeId: 'serialized-old-button' }));
    assert.equal(found.uuid, secondButton.uuid);
});

test('nested instance chains resolve all ancestors rather than choosing the first repeated file ID', async () => {
    const buttonA = node('Button', 'A-inner-button', prefab('button', OTHER));
    const buttonB = node('Button', 'B-inner-button', prefab('button', OTHER));
    const outer = (instance, leaf) => node('Outer', `${instance}-outer`, prefab('outer-root', NESTED, instance), [
        node('Inner', `${instance}-inner`, prefab('inner-root', OTHER, 'same-inner-instance-id'), [leaf]),
    ]);
    const root = node('Root', 'root', prefab('root-file-id'), [outer('outer-A', buttonA), outer('outer-B', buttonB)]);
    const found = await scene(root).findNode(request(locator(
        { name: 'Root', fileId: 'root-file-id', assetUuid: SOURCE },
        { name: 'Outer', fileId: 'outer-root', instanceFileId: 'outer-B', assetUuid: NESTED },
        { name: 'Inner', fileId: 'inner-root', instanceFileId: 'same-inner-instance-id', assetUuid: OTHER },
        { name: 'Button', fileId: 'button', assetUuid: OTHER },
    ), { nodeId: 'stale-leaf-id' }));
    assert.equal(found.uuid, buttonB.uuid);
});

test('duplicate stable identities are rejected when their ancestor instances are also ambiguous', async () => {
    const root = node('Root', 'root', prefab('root-file-id'), [
        node('Button', 'button-A', prefab('duplicate-file-id')),
        node('Button', 'button-B', prefab('duplicate-file-id')),
    ]);
    rejected(await scene(root).findNode(request(locator(
        { name: 'Root', fileId: 'root-file-id', assetUuid: SOURCE },
        { name: 'Button', fileId: 'duplicate-file-id', assetUuid: SOURCE },
    ), { nodeId: 'old-id' })));
});

test('a matching file ID in a different Prefab asset cannot replace the original node', async () => {
    const root = node('Root', 'root', prefab('root-file-id'), [node('Button', 'replacement', prefab('button-file-id', OTHER))]);
    rejected(await scene(root).findNode(request(locator(
        { name: 'Root', fileId: 'root-file-id', assetUuid: SOURCE },
        { name: 'Button', fileId: 'button-file-id', assetUuid: SOURCE },
    ), { nodeId: 'original-id' })));
});

test('a deleted node is not replaced by a new node occupying the same name and hierarchy position', async () => {
    const root = node('Root', 'root', prefab('root-file-id'), [node('Button', 'replacement', prefab('replacement-file-id'))]);
    rejected(await scene(root).findNode(request(locator(
        { name: 'Root', fileId: 'root-file-id', assetUuid: SOURCE },
        { name: 'Button', fileId: 'original-file-id', assetUuid: SOURCE },
    ), { nodeId: 'original-id' })));
    rejected(await scene(root).findNode({ sourceUuid: SOURCE, nodePath: 'Root/Button', nodeId: 'original-id' }));
});

test('segment arrays preserve slash-containing node names rather than interpreting them as hierarchy separators', async () => {
    const wanted = node('Panel/Button', 'wanted', null);
    const decoy = node('Panel', 'decoy-panel', null, [node('Button', 'decoy-button', null)]);
    const root = node('Root', 'root', null, [wanted, decoy]);
    const found = await scene(root).findNode(request(locator({ name: 'Root' }, { name: 'Panel/Button' })));
    assert.equal(found.uuid, wanted.uuid);
});

test('scene root identity is verified against the open source and survives editor UUID regeneration', async () => {
    const button = node('Button', 'rebuilt-button', prefab('button-file-id', NESTED));
    const root = node('Main', 'editor-scene-generated-uuid', null, [button]);
    const options = request(locator(
        { name: 'Main', kind: 'scene', nodeId: 'serialized-scene-root' },
        { name: 'Button', fileId: 'button-file-id', assetUuid: NESTED },
    ), { nodeId: 'serialized-button-id' });
    assert.equal((await scene(root, { uuid: SOURCE }).findNode(options)).uuid, button.uuid);
    const wrongScene = scene(root, OTHER);
    rejected(await wrongScene.findNode(options));
    assert.ok(wrongScene.calls.every(call => call[1] === 'query-current-scene'));
});

test('the scene root itself can be located after its serialized UUID changes', async () => {
    const root = node('Main', 'new-scene-root-id', null);
    const options = request(locator({ name: 'Main', kind: 'scene', nodeId: 'serialized-scene-root-id' }), {
        nodeId: 'serialized-scene-root-id',
    });
    assert.equal((await scene(root).findNode(options)).uuid, root.uuid);
    rejected(await scene(root, OTHER).findNode(options));
});

test('switching the open source during the asynchronous scene query cannot select a node in the new source', async () => {
    let root = node('Main', 'original-scene', null, [node('Panel', 'original-panel', prefab('panel-root', NESTED))]);
    let respond;
    const pendingQuery = new Promise(resolve => { respond = resolve; });
    const lookup = scene(() => root, () => pendingQuery);
    const options = request(locator(
        { name: 'Main', kind: 'scene', nodeId: 'old-scene-id' },
        { name: 'Panel', fileId: 'panel-root', assetUuid: NESTED },
    ), { nodeId: 'old-panel-id' });
    const pendingLocation = lookup.findNode(options);
    assert.equal(lookup.calls.length, 1);
    root = node('Other Scene', 'replacement-scene', null, [node('Panel', 'replacement-panel', prefab('panel-root', NESTED))]);
    respond(SOURCE);
    rejected(await pendingLocation);
});

test('malformed location options are rejected without throwing or choosing a node', async () => {
    const root = node('Root', 'root', prefab('root-file-id'));
    const methods = scene(root);
    for (const options of [undefined, null, {}, [], { sourceUuid: {} },
        { sourceUuid: SOURCE, nodeLocator: { version: 1, segments: 'Root' } },
        { sourceUuid: SOURCE, nodeLocator: { version: 1, segments: [null] } },
        { sourceUuid: SOURCE, nodeLocator: { version: 1, segments: [{ name: {}, fileId: 'root-file-id' }] } },
    ]) rejected(await methods.findNode(options));
});
