'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { scanProject } = require('../lib/core');
const { buildSizeStats } = require('../lib/size');

const FIRST = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';

function fixture(t) {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cocos-resource-size-test-'));
    t.after(() => fs.rmSync(projectPath, { recursive: true, force: true }));
    const assets = path.join(projectPath, 'assets');
    fs.mkdirSync(assets);
    function write(relative, data) {
        const destination = path.join(assets, relative);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data));
        return destination;
    }
    function asset(relative, bytes, uuid, importer) {
        const file = write(relative, Buffer.alloc(bytes));
        write(`${relative}.meta`, { uuid, importer, subMetas: {} });
        return file;
    }
    return { projectPath, assets, write, asset };
}

test('source accounting includes malformed/missing meta and zero-byte files and excludes imported sub-assets and external trees', async t => {
    const f = fixture(t);
    f.asset('nested/image.png', 7, FIRST, 'image');
    f.write('nested/image.png.meta', { uuid: FIRST, importer: 'image', subMetas: {
        texture: { uuid: `${FIRST}@texture`, importer: 'texture', subMetas: {
            frame: { uuid: `${FIRST}@frame`, importer: 'sprite-frame' },
        } },
    } });
    f.write('bad.png', Buffer.alloc(9));
    f.write('bad.png.meta', '{broken');
    f.write('raw.png', Buffer.alloc(5));
    f.write('empty.bin', Buffer.alloc(0));
    for (const root of ['library', 'build']) {
        fs.mkdirSync(path.join(f.projectPath, root));
        fs.writeFileSync(path.join(f.projectPath, root, 'ignored.bin'), Buffer.alloc(100));
    }
    const result = await scanProject({ projectPath: f.projectPath, assetInfos: [{ uuid: SECOND, url: 'db://internal/default.png', importer: 'image', size: 1000 }] });
    assert.equal(result.sizeStats.scope, 'source-files');
    assert.equal(result.sizeStats.totalBytes, 21);
    assert.equal(result.sizeStats.totalFiles, 4);
    assert.equal(result.sizeStats.unknownFiles, 0);
    assert.equal(result.sizeStats.partial, false, 'bad metadata does not make the physical size accounting incomplete');
    assert.equal(result.sizeStats.byType.reduce((sum, item) => sum + item.bytes, 0), 21);
    assert.deepEqual(result.sizeStats.byType, [{ type: 'image', count: 3, bytes: 21 }, { type: 'bin', count: 1, bytes: 0 }]);
    assert.equal(result.sizeStats.largestAssets.length, 0, 'small and zero-byte sources remain in totals but not the large-resource list');
    assert.equal(result.summary.totalSourceBytes, 21);
    assert.equal(result.summary.sourceFiles, 4);
    assert.equal(result.summary.unknownSizeFiles, 0);
    assert.equal(result.assets.find(asset => asset.url.endsWith('/empty.bin')).sizeKnown, true);
    assert.equal(result.assets.filter(asset => asset.subAsset).length, 2);
    assert.ok(result.assets.filter(asset => asset.subAsset).every(asset => asset.size === 0));
});

test('duplicate UUID source files retain their own path, category, and bytes in size accounting', async t => {
    const f = fixture(t);
    f.asset('first.png', 51203, FIRST, 'image');
    f.asset('second.mp3', 51211, FIRST, 'audio-clip');
    const result = await scanProject({ projectPath: f.projectPath, assetInfos: [] });
    assert.ok(result.issues.some(issue => issue.code === 'DUPLICATE_UUID'));
    assert.equal(result.sizeStats.totalFiles, 2);
    assert.equal(result.sizeStats.totalBytes, 102414);
    assert.deepEqual(result.sizeStats.byType, [{ type: 'audio-clip', count: 1, bytes: 51211 }, { type: 'image', count: 1, bytes: 51203 }]);
    assert.deepEqual(result.sizeStats.largestAssets.map(asset => [asset.uuid, asset.url, asset.size]), [
        [FIRST, 'db://assets/second.mp3', 51211], [FIRST, 'db://assets/first.png', 51203],
    ]);
});

test('JSON files above the parser limit still contribute their complete source size', async t => {
    const f = fixture(t);
    const file = f.write('huge.json', '');
    const bytes = 16 * 1024 * 1024 + 17;
    const descriptor = fs.openSync(file, 'w');
    try { fs.ftruncateSync(descriptor, bytes); } finally { fs.closeSync(descriptor); }
    const result = await scanProject({ projectPath: f.projectPath, assetInfos: [] });
    assert.equal(result.sizeStats.totalBytes, bytes);
    assert.equal(result.sizeStats.partial, false);
    assert.equal(result.summary.partial, true, 'reference parsing is incomplete independently of the size coverage');
    assert.equal(result.sizeStats.largestAssets[0].size, bytes);
});

test('stat errors remain unknown with a warning and never appear as real zero-byte assets', async t => {
    const f = fixture(t);
    const source = f.asset('denied.png', 100, FIRST, 'image');
    f.asset('healthy.mp3', 6, SECOND, 'audio-clip');
    const original = fs.promises.stat;
    let attempts = 0;
    fs.promises.stat = async function (file, ...args) {
        if (file === source) { attempts++; throw Object.assign(new Error('Access denied for test'), { code: 'EACCES' }); }
        return original.call(this, file, ...args);
    };
    let result;
    try { result = await scanProject({ projectPath: f.projectPath, assetInfos: [] }); }
    finally { fs.promises.stat = original; }
    assert.equal(attempts, 1, 'source stat is cached across the metadata and physical-file phases');
    assert.equal(result.sizeStats.totalBytes, 6);
    assert.equal(result.sizeStats.totalFiles, 2);
    assert.equal(result.sizeStats.unknownFiles, 1);
    assert.equal(result.summary.unknownSizeFiles, 1);
    assert.equal(result.summary.partial, true);
    assert.equal(result.sizeStats.partial, true);
    assert.equal(result.assets.find(asset => asset.uuid === FIRST).sizeKnown, false);
    assert.ok(result.issues.some(issue => issue.code === 'SIZE_READ_ERROR' && issue.sourceUrl.endsWith('/denied.png')));
    assert.ok(result.limitations.some(text => /未知大小/.test(text)));
    assert.ok(!result.sizeStats.largestAssets.some(asset => asset.uuid === FIRST));
});

test('all sources strictly above 50 KB are retained, descending by size with deterministic URL ties', () => {
    const entries = Array.from({ length: 90 }, (_, index) => ({ uuid: `id-${index}`, url: `db://assets/${String(index).padStart(3, '0')}.bin`, size: 51200 + index % 9 - 1, sizeKnown: true, type: 'bin' }));
    const expected = entries.filter(asset => asset.size > 51200).sort((a, b) => b.size - a.size || a.url.localeCompare(b.url));
    const stats = buildSizeStats(entries);
    assert.equal(stats.largestThresholdBytes, 51200);
    assert.equal(stats.largestAssets.length, 70, 'there is no fifty-item cap');
    assert.ok(stats.largestAssets.every(asset => asset.size > 51200), 'exactly 50 KB is excluded');
    assert.ok(stats.largestAssets.some(asset => asset.size === 51201), 'one byte over the threshold is included');
    assert.deepEqual(stats.largestAssets.map(asset => asset.url), expected.map(asset => asset.url));
    assert.equal(stats.totalFiles, 90);
    assert.equal(stats.totalBytes, entries.reduce((sum, entry) => sum + entry.size, 0));
});

test('size builder deduplicates physical paths and ignores folders, meta, virtual assets, and invalid sizes', () => {
    const stats = buildSizeStats([
        { source: '/assets/image.png', url: 'db://assets/image.png', size: 51207, sizeKnown: true, type: 'image' },
        { source: '/assets/image.png', url: 'db://assets/image.png', size: 100, sizeKnown: true, type: 'image', uuid: 'duplicate-row' },
        { source: '/assets/image.png', url: 'db://assets/image.png/frame', size: 1000, sizeKnown: true, subAsset: true, type: 'sprite-frame' },
        { url: 'db://assets/folder', size: 1000, sizeKnown: true, type: 'folder' },
        { url: 'db://internal/default.png', size: 1000, sizeKnown: true, internal: true },
        { url: 'db://assets/image.png.meta', size: 1000, sizeKnown: true },
        { url: 'db://assets/unknown.bin', size: 0, sizeKnown: false },
        { url: 'db://assets/invalid.bin', size: -2, sizeKnown: true },
    ]);
    assert.equal(stats.totalFiles, 3);
    assert.equal(stats.totalBytes, 51207);
    assert.equal(stats.unknownFiles, 2);
    assert.equal(stats.partial, true);
    assert.equal(stats.largestAssets.length, 1);
});

test('file enumeration limits and cancellation explicitly mark incomplete size coverage', async t => {
    const f = fixture(t);
    f.write('a.bin', Buffer.alloc(3));
    f.write('b.bin', Buffer.alloc(4));
    const limited = await scanProject({ projectPath: f.projectPath, assetInfos: [], limits: { maxFiles: 1 } });
    assert.equal(limited.sizeStats.totalFiles, 1);
    assert.equal(limited.sizeStats.totalBytes, 3);
    assert.equal(limited.sizeStats.partial, true);
    const cancelled = await scanProject({ projectPath: f.projectPath, assetInfos: [], isCancelled: () => true });
    assert.equal(cancelled.sizeStats.partial, true);
});
