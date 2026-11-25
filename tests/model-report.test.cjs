'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ResultStore } = require('../lib/model');
const { htmlReport, writeReport, formatBytes } = require('../lib/report');
function fixture() {
    const assets = ['image', 'image@frame', 'prefab', 'scene', 'other'].map(uuid => ({ uuid, url: `db://assets/${uuid}`, name: uuid, type: 'test', size: 1, dependencies: [] }));
    const references = [
        ['prefab', 'image@frame'], ['scene', 'prefab'], ['prefab', 'scene'], ['other', 'image@frame'],
    ].map(([sourceUuid, targetUuid], index) => ({ id: String(index), sourceUuid, targetUuid, sourceUrl: `db://assets/${sourceUuid}`, kind: 'serialized', property: 'spriteFrame' }));
    return { version: 1, projectPath: 'fixture', scannedAt: '2026-11-18T00:00:00.000Z', assets, references, issues: [], summary: { assets: 5 }, limitations: [] };
}
test('deleting an image includes users of its subassets and transitive cycles terminate', () => {
    const store = new ResultStore(fixture());
    const impact = store.getImpact({ uuid: 'image' });
    assert.deepEqual(impact.direct.map(value => value.uuid).sort(), ['other', 'prefab']);
    assert.deepEqual(impact.transitive.map(value => value.uuid), ['scene']);
    assert.equal(impact.truncated, false);
    assert.match(impact.caveat, /动态加载/);
    assert.equal(store.queryReferences({ uuid: 'image', direction: 'incoming' }).total, 2);
    assert.equal(store.queryReferences({ uuid: 'prefab', direction: 'outgoing' }).total, 2);
});
test('pagination bounds IPC records and search matches UUID and paths', () => {
    const result = fixture();
    result.assets.push(...Array.from({ length: 400 }, (_, i) => ({ uuid: `id-${i}`, url: `db://assets/folder/${i}`, name: `file-${i}`, type: 'image' })));
    result.issues.push({ id: '1', severity: 'error', code: 'MISSING_ASSET', message: '丢失引用', sourceUrl: 'db://assets/example.prefab', nodePath: 'Canvas/Button' });
    const store = new ResultStore(result);
    assert.equal(store.queryAssets({ pageSize: 100000 }).items.length, 200);
    assert.equal(store.queryAssets({ query: 'id-399' }).total, 1);
    assert.equal(store.queryIssues({ query: 'button', severity: 'error' }).total, 1);
    assert.equal(store.queryIssues({ severity: 'warning' }).total, 0);
    assert.equal(store.queryAssets({ page: 1000, pageSize: 200 }).page, 3);
});
test('impact propagates from an affected imported subasset through its physical parent', () => {
    const result = fixture();
    result.assets = ['texture', 'atlas', 'atlas@frame', 'prefab'].map(uuid => ({ uuid, url: `db://assets/${uuid}`, name: uuid }));
    result.references = [{ sourceUuid: 'atlas@frame', targetUuid: 'texture' }, { sourceUuid: 'prefab', targetUuid: 'atlas' }];
    const impact = new ResultStore(result).getImpact({ uuid: 'texture' });
    assert.deepEqual(impact.direct.map(item => item.uuid), ['atlas']);
    assert.deepEqual(impact.transitive.map(item => item.uuid), ['prefab']);
});
test('size sorting happens before pagination and puts unknown or shared subassets after real sizes', () => {
    const result = fixture();
    result.assets = [
        { uuid: 'small', url: 'db://assets/small', size: 500 },
        { uuid: 'large@frame', url: 'db://assets/large/frame', size: 99999, subAsset: true, parentUuid: 'large' },
        { uuid: 'unknown', url: 'db://assets/unknown', size: 999999, sizeKnown: false },
        { uuid: 'large', url: 'db://assets/large', size: 3000, sizeKnown: true },
        { uuid: 'empty', url: 'db://assets/empty', size: 0, sizeKnown: true },
    ];
    const store = new ResultStore(result);
    assert.deepEqual(store.queryAssets({ sort: 'size-desc', pageSize: 2 }).items.map(item => item.uuid), ['large', 'small']);
    assert.equal(store.queryAssets({ sort: 'size-desc', pageSize: 2, page: 2 }).items[0].uuid, 'empty');
    assert.deepEqual(store.queryAssets({ sort: 'size-asc', pageSize: 3 }).items.map(item => item.uuid), ['empty', 'small', 'large']);
    assert.equal(result.assets[0].uuid, 'small', 'sorting must not mutate the retained report');
});
test('reports retain size stats, readable units and unknown/partial scope without interpreting asset names as markup', () => {
    const result = fixture();
    result.sizeStats = { totalBytes: 65536, totalFiles: 2, unknownFiles: 1, partial: true, largestThresholdBytes: 51200, scope: 'source-files',
        byType: [{ type: 'image', count: 1, bytes: 65536 }], largestAssets: [{ url: 'db://assets/<img>.png', type: 'image', size: 65536 }] };
    const html = htmlReport(result);
    assert.match(html, /资源大小/);
    assert.match(html, /64\.00 KiB/);
    assert.match(html, /扫描不完整/);
    assert.match(html, /1 个文件大小未知/);
    assert.match(html, /&lt;img&gt;\.png/);
    assert.ok(!html.includes('<img>'));
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(1536), '1.50 KiB');
    assert.equal(formatBytes(1048576), '1.00 MiB');
    assert.equal(formatBytes(null), '不可用');
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-size-report-'));
    try {
        const output = writeReport(temporary, result, 'json');
        assert.deepEqual(JSON.parse(fs.readFileSync(output.path, 'utf8')).sizeStats, result.sizeStats);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
test('HTML includes every source above the size threshold even beyond generic report row limits', () => {
    const result = fixture();
    const largestAssets = Array.from({ length: 10001 }, (_, index) => ({ url: `db://assets/large-${index}.png`, type: 'image', size: 70000 - index }));
    const totalBytes = largestAssets.reduce((sum, asset) => sum + asset.size, 0);
    result.sizeStats = { totalBytes, totalFiles: largestAssets.length, unknownFiles: 0, partial: false, largestThresholdBytes: 51200,
        byType: [{ type: 'image', count: largestAssets.length, bytes: totalBytes }], largestAssets };
    const html = htmlReport(result);
    assert.match(html, /大于 50 KB 的源资源/);
    assert.match(html, /large-10000\.png/);
    assert.equal((html.match(/db:\/\/assets\/large-\d+\.png/g) || []).length, 10001);
});
test('HTML export escapes project data and JSON retains full scan result', () => {
    const result = fixture();
    result.projectPath = '<script>alert(1)</script>';
    result.issues.push({ severity: 'error', message: '<img src=x onerror=alert(1)>', code: 'BAD', sourceUrl: '&' });
    const html = htmlReport(result, true);
    assert.ok(!html.includes('<script>'));
    assert.ok(!html.includes('<img src=x'));
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /资源已发生变化/);
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-report-test-'));
    try {
        const output = writeReport(temporary, result, 'json', true);
        const parsed = JSON.parse(fs.readFileSync(output.path, 'utf8'));
        assert.equal(path.dirname(output.path), path.join(temporary, 'RIReports'));
        assert.deepEqual(parsed.references, result.references);
        assert.equal(parsed.staleAtExport, true);
        assert.throws(() => writeReport(temporary, result, '../bad'), /仅支持/);
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
});
