'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scanProject } = require('../lib/core');
const { ResultStore } = require('../lib/model');
const { htmlReport, writeReport } = require('../lib/report');

function fixture(t) {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-usage-'));
    t.after(() => fs.rmSync(projectPath, { recursive: true, force: true }));
    fs.mkdirSync(path.join(projectPath, 'assets'));
    let index = 0;
    function write(relative, data) {
        const file = path.join(projectPath, 'assets', relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, Buffer.isBuffer(data) || typeof data === 'string' ? data : JSON.stringify(data));
        return file;
    }
    function asset(relative, data, importer = 'json', extra = {}) {
        const uuid = `12345678-1234-4234-8234-${String(++index).padStart(12, '0')}`;
        write(relative, data);
        write(`${relative}.meta`, { uuid, importer, ...extra });
        return uuid;
    }
    function folder(relative, userData = {}) {
        fs.mkdirSync(path.join(projectPath, 'assets', relative), { recursive: true });
        write(`${relative}.meta`, { uuid: `87654321-1234-4234-8234-${String(++index).padStart(12, '0')}`, importer: 'directory', userData });
    }
    return { projectPath, write, asset, folder, scan: options => scanProject({ projectPath, assetInfos: [], ...options }) };
}
const row = (result, uuid) => result.usage.items.find(item => item.uuid === uuid);
const atlas = (...pages) => pages.map(name => `${name}\nsize: 128,128\nformat: RGBA8888\nfilter: Linear,Linear\nrepeat: none\nregion\n  rotate: false\n  xy: 0,0\n  size: 10,10`).join('\n\n');

test('physical image families ignore their own metadata references and do not duplicate bytes', async t => {
    const f = fixture(t);
    const unused = f.asset('unused.png', Buffer.alloc(15), 'image');
    const used = f.asset('used.png', Buffer.alloc(20), 'image');
    f.write('unused.png.meta', { uuid: unused, importer: 'image', subMetas: { texture: { uuid: `${unused}@texture`, importer: 'texture', userData: { imageUuid: unused } }, frame: { uuid: `${unused}@frame`, importer: 'sprite-frame', userData: { textureUuid: `${unused}@texture` } } } });
    f.write('used.png.meta', { uuid: used, importer: 'image', subMetas: { frame: { uuid: `${used}@frame`, importer: 'sprite-frame' } } });
    f.asset('consumer.json', { frame: { __uuid__: `${used}@frame` } });
    const result = await f.scan();
    assert.equal(row(result, unused).status, 'unused');
    assert.equal(row(result, unused).incomingCount, 0);
    assert.equal(row(result, used).status, 'referenced');
    assert.equal(result.usage.items.length, 2);
    assert.equal(result.usage.stats.unusedBytes, 15);
});

test('Spine JSON and binary files retain atlas pages through usage chains including multiple pages', async t => {
    const f = fixture(t);
    const usedImage = f.asset('used/page.png', Buffer.alloc(11), 'image');
    const usedAtlas = f.asset('used/hero.atlas', atlas('page.png'), 'text');
    const json = f.asset('used/hero.json', { skeleton: { spine: '3.8' }, bones: [] }, 'spine-data');
    const imageA = f.asset('unused/first page.png', Buffer.alloc(12), 'image');
    const imageB = f.asset('unused/second.webp', Buffer.alloc(13), 'image');
    const unusedAtlas = f.asset('unused/hero.txt', atlas('first page.png', 'second.webp'), 'text');
    const binary = f.asset('unused/hero.skel', Buffer.from([0, 255, 50]), 'spine-data');
    f.asset('consumer.json', { skeleton: { __uuid__: json } });
    const result = await f.scan({ assetInfos: [{ uuid: json, url: 'db://assets/used/hero.json' }] });
    assert.equal(result.summary.partial, false);
    for (const id of [json, usedAtlas, usedImage]) assert.equal(row(result, id).status, 'referenced');
    for (const id of [binary, unusedAtlas, imageA, imageB]) assert.equal(row(result, id).status, 'unused');
    assert.equal(row(result, binary).category, 'spine-binary');
    assert.equal(row(result, unusedAtlas).category, 'atlas');
    assert.ok(result.references.some(ref => ref.sourceUuid === unusedAtlas && ref.targetUuid === imageB && ref.kind === 'importer-path'));
    assert.deepEqual(new ResultStore(result).getImpact({ uuid: usedImage }).transitive.map(item => item.uuid).sort(), [json, result.assets.find(item => item.name === 'consumer.json').uuid].sort());
});

test('explicit importer UUID arrays select an atlas with a different basename', async t => {
    const f = fixture(t);
    const image = f.asset('atlas/page.png', 'png', 'image');
    const pages = f.asset('atlas/shared.atlas', atlas('page.png'), 'text');
    const spine = f.asset('actor.skel', Buffer.from([0, 1]), 'spine-data', { userData: { dependencies: [pages] } });
    f.asset('config.json', { skeleton: { __uuid__: spine } });
    const result = await f.scan();
    assert.equal(result.summary.partial, false);
    assert.equal(row(result, image).status, 'referenced');
});

test('DragonBones binary and JSON atlas imagePath dependencies do not require decoding binary data', async t => {
    const f = fixture(t);
    const image = f.asset('dragon/texture.png', 'png', 'image');
    const tex = f.asset('dragon/hero_tex.json', { imagePath: 'texture.png', SubTexture: [] }, 'dragonbones-atlas');
    const skeleton = f.asset('dragon/hero_ske.dbbin', Buffer.from([0, 1]), 'dragonbones');
    const json = f.asset('dragon/other_ske.json', { version: '5.5', armature: [] }, 'dragonbones');
    f.asset('config.json', { dragon: { __uuid__: skeleton } });
    const result = await f.scan();
    assert.equal(row(result, skeleton).category, 'dragonbones-binary');
    assert.equal(row(result, json).status, 'unused');
    for (const id of [skeleton, tex, image]) assert.equal(row(result, id).status, 'referenced');
});

test('sprite sheet plist paths and animation clip UUIDs retain images', async t => {
    const f = fixture(t);
    const image = f.asset('sheet.png', 'png', 'image');
    const sheet = f.asset('sheet.plist', '<plist><dict><key>textureFileName</key><string>sheet.png</string></dict></plist>', 'sprite-atlas');
    const clip = f.asset('run.anim', { frame: { __uuid__: sheet } }, 'animation-clip');
    f.asset('consumer.json', { clip: { __uuid__: clip } });
    const result = await f.scan();
    for (const id of [image, sheet, clip]) assert.equal(row(result, id).status, 'referenced');
});

test('resources, Bundle descendants and their dependencies outside those directories stay pending', async t => {
    const f = fixture(t);
    f.folder('resources'); f.folder('pack', { isBundle: true });
    const resource = f.asset('resources/idle.png', 'png', 'image');
    const image = f.asset('external.png', 'png', 'image');
    const bundle = f.asset('pack/idle.anim', { texture: { __uuid__: image } }, 'animation-clip');
    const unused = f.asset('loose.png', 'png', 'image');
    const result = await f.scan();
    for (const id of [resource, bundle, image]) assert.equal(row(result, id).status, 'dynamic');
    assert.equal(row(result, unused).status, 'unused');
    assert.equal(result.usage.stats.dynamic, 3);
});

test('unreachable resource cycles are candidates while shared images remain in use', async t => {
    const f = fixture(t);
    const image = f.asset('shared.png', 'png', 'image');
    const a = f.asset('a.anim', {}, 'animation-clip');
    const b = f.asset('b.anim', { clip: { __uuid__: a }, texture: { __uuid__: image } }, 'animation-clip');
    f.write('a.anim', { clip: { __uuid__: b } });
    f.asset('consumer.json', { texture: { __uuid__: image } });
    const result = await f.scan();
    assert.equal(row(result, a).status, 'unused'); assert.equal(row(result, b).status, 'unused');
    assert.equal(row(result, image).status, 'referenced');
});

test('partial scans, unresolved atlas paths, malformed configs and unknown identities cannot yield unused claims', async t => {
    for (const mode of ['limit', 'atlas', 'json', 'cancel']) {
        const f = fixture(t);
        const image = f.asset('a.png', 'png', 'image');
        if (mode === 'atlas') f.asset('orphan.skel', Buffer.from([1]), 'spine-data');
        if (mode === 'json') f.asset('broken.json', '{broken');
        if (mode === 'limit') f.asset('consumer.json', { first: { __uuid__: image }, second: { __uuid__: image } });
        const result = await f.scan(mode === 'limit' ? { limits: { maxReferences: 1 } } : mode === 'cancel' ? { isCancelled: () => true } : {});
        assert.equal(result.summary.partial, true, mode);
        assert.equal(result.usage.stats.unused, 0, mode);
    }
    const f = fixture(t);
    f.write('no-meta.png', 'png');
    const result = await f.scan();
    assert.equal(result.usage.items[0].status, 'unknown');
});

test('audio matches names, paths and extensionless names in scripts and config formats', async t => {
    const f = fixture(t);
    const byFile = f.asset('sfx/click.mp3', Buffer.from([0, 1]), 'audio-clip');
    const byStem = f.asset('bgm/主题曲.ogg', Buffer.from([0, 1]), 'audio-clip');
    const byCsv = f.asset('voice/welcome.wav', Buffer.from([0, 1]), 'audio-clip');
    const byYaml = f.asset('voice/win.m4a', Buffer.from([0, 1]), 'audio-clip');
    const byProperty = f.asset('sfx/coin.wav', Buffer.from([0, 1]), 'audio-clip');
    const spaced = f.asset('bgm/battle theme.mp3', Buffer.from([0, 1]), 'audio-clip');
    const unused = f.asset('sfx/hit.mp3', Buffer.from([0, 1]), 'audio-clip');
    f.asset('Game.ts', 'playSound("sfx/click.mp3"); playMusic("bgm/主题曲"); playMusic("battle theme"); play(Sounds.coin); const white = true;', 'typescript');
    f.asset('config.csv', 'event,sound\nlogin,welcome.wav\n', 'text');
    f.asset('config.yaml', 'victory: win\n', 'text');
    const result = await f.scan();
    for (const id of [byFile, byStem, byCsv, byYaml, byProperty, spaced]) {
        assert.equal(row(result, id).status, 'referenced', id);
        assert.ok(result.references.some(ref => ref.targetUuid === id && ref.kind === 'audio-name'));
    }
    assert.equal(row(result, unused).status, 'unused', 'hit must not match white');
    assert.equal(row(result, unused).category, 'audio');
    assert.ok(result.references.some(ref => ref.targetUuid === byFile && ref.property.startsWith('text@')));
});

test('ambiguous audio basenames keep all matches; explicit paths disambiguate and rescan removes old evidence', async t => {
    const f = fixture(t);
    const one = f.asset('a/click.mp3', 'audio', 'audio-clip');
    const two = f.asset('b/click.mp3', 'audio', 'audio-clip');
    f.asset('Game.js', 'play("click");', 'javascript');
    const first = await f.scan();
    for (const id of [one, two]) assert.equal(row(first, id).status, 'referenced');
    f.write('Game.js', 'play("a/click.mp3");');
    const second = await f.scan();
    assert.equal(row(second, one).status, 'referenced');
    assert.equal(row(second, two).status, 'unused');
    f.write('Game.js', '');
    const third = await f.scan();
    for (const id of [one, two]) assert.equal(row(third, id).status, 'unused');
});

test('audio UUID references and JSON name references coexist without requiring a load API pattern', async t => {
    const f = fixture(t);
    const one = f.asset('sfx/select.mp3', 'audio', 'audio-clip');
    const two = f.asset('voice/start.mp3', 'audio', 'audio-clip');
    f.asset('config.json', { onClick: 'select', clip: { __uuid__: two } });
    const result = await f.scan();
    for (const id of [one, two]) assert.equal(row(result, id).status, 'referenced');
    assert.ok(result.references.some(ref => ref.targetUuid === one && ref.property.startsWith('onClick')));
});

test('script literal UUIDs preserve binary resources, without interpreting arbitrary GUID strings as missing assets', async t => {
    const f = fixture(t);
    const binary = f.asset('anim.bytes', Buffer.from([0, 1]), 'buffer');
    f.asset('Game.ts', `loadAny('${binary}'); const other = 'ffffffff-ffff-4fff-8fff-ffffffffffff';`, 'typescript');
    const result = await f.scan();
    assert.equal(row(result, binary).status, 'referenced');
    assert.equal(result.summary.errors, 0);
});

test('usage queries filter and sort before pagination, bound IPC, escape reports and retain JSON detail', async t => {
    const f = fixture(t);
    const image = f.asset('image.png', Buffer.alloc(10), 'image');
    const audio = f.asset('sound.mp3', Buffer.alloc(20), 'audio-clip');
    const result = await f.scan();
    const store = new ResultStore(result);
    row(result, image).url = 'db://assets/<img>.png';
    assert.equal(store.queryUnusedAssets({ status: 'unused', pageSize: 1 }).items[0].uuid, audio);
    assert.equal(store.queryUnusedAssets({ category: 'image' }).items[0].uuid, image);
    assert.equal(store.queryUnusedAssets({ query: 'SOUND' }).total, 1);
    assert.equal(store.queryUnusedAssets({ page: 500, pageSize: 1 }).page, 2);
    assert.equal(store.queryUnusedAssets({ status: 'dynamic' }).total, 0);
    assert.equal(store.queryUnusedAssets({ pageSize: 100000 }).pageSize, 200);
    assert.equal(store.queryUnusedAssets({}).stats.unusedBytes, 30);
    const html = htmlReport(result);
    assert.match(html, /未使用资源检测/); assert.match(html, /&lt;img&gt;\.png/); assert.ok(!html.includes('<img>'));
    const exported = writeReport(f.projectPath, result, 'json');
    assert.deepEqual(JSON.parse(fs.readFileSync(exported.path, 'utf8')).usage, result.usage);
});
