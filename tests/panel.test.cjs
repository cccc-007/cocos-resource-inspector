'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');

class Element {
  constructor(tag, doc) { this.tagName = tag; this.ownerDocument = doc; this.childNodes = []; this.listeners = new Map(); this.dataset = {}; this.attributes = {}; this.value = ''; this._text = ''; this.className = ''; this.disabled = false; this.hidden = false; this.classList = { toggle: (name, force) => { const parts = new Set(this.className.split(/\s+/).filter(Boolean)); const next = force === undefined ? !parts.has(name) : force; if (next) parts.add(name); else parts.delete(name); this.className = [...parts].join(' '); return next; } }; }
  set textContent(value) { this.childNodes = []; this._text = String(value); }
  get textContent() { return this._text + this.childNodes.map(item => item.textContent).join(''); }
  append(...items) { for (const item of items) { if (item.tagName === '#fragment') this.append(...item.childNodes); else { item.parentNode = this; this.childNodes.push(item); } } }
  replaceChildren(...items) { this._text = ''; this.childNodes = []; this.append(...items); }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(listener); }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  dispatch(type) { if (this.disabled && type === 'click') return; for (const handler of this.listeners.get(type) || []) handler({ stopPropagation() {} }); }
  all() { return this.childNodes.flatMap(node => [node, ...node.all()]); }
  querySelectorAll(selector) { return this.all().filter(node => selector.startsWith('.') ? node.className.split(/\s+/).includes(selector.slice(1)) : selector === '[data-tab]' ? !!node.dataset.tab : selector.startsWith('#') ? node.id === selector.slice(1) : node.tagName === selector); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}
const doc = { createElement: tag => new Element(tag, doc), createDocumentFragment: () => new Element('#fragment', doc), createTextNode: text => { const node = new Element('#text', doc); node.textContent = text; return node; } };
const app = new Element('div', doc);
for (const match of fs.readFileSync(path.join(root, 'static/panel.html'), 'utf8').matchAll(/<([a-z]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
  if (match[3] === 'app') continue;
  const node = doc.createElement(match[1]); node.id = match[3];
  node.className = match[2].match(/class="([^"]*)"/)?.[1] || '';
  node.dataset.tab = match[2].match(/data-tab="([^"]*)"/)?.[1];
  if (node.id === 'reference-direction') node.value = 'incoming';
  if (node.id === 'asset-sort') node.value = 'path';
  app.append(node);
}
const timers = new Map(); let timerId = 0;
const assets = Array.from({ length: 201 }, (_, i) => ({ uuid: `uuid-${i}`, url: `db://assets/file-${i}.prefab`, name: `file-${i}`, type: 'cc.Prefab', size: 512, sizeKnown: true }));
Object.assign(assets[0], { size: 1024 }); Object.assign(assets[1], { size: 0, subAsset: true });
Object.assign(assets[2], { size: 0, sizeKnown: false }); Object.assign(assets[3], { size: null });
Object.assign(assets[4], { size: 1024 ** 2 }); Object.assign(assets[5], { size: 1024 ** 3 });
Object.assign(assets[6], { size: 0, missingSource: true });
const state = { status: 'ready', revision: 1, dirty: false, outputDirectory: 'D:/out', result: { summary: { assets: 201, prefabs: 201, references: 102, errors: 1, warnings: 100, totalSourceBytes: 1024 ** 3, sourceFiles: 200, unknownSizeFiles: 2 }, scannedAt: '2026-11-18T08:00:00.000Z', limitations: ['动态加载未覆盖'] } };
const malicious = '<img src=x onerror=alert(1)>';
const issues = Array.from({ length: 101 }, (_, i) => ({ id: `issue-${i}`, severity: 'warning', code: 'MISSING', message: i ? `issue ${i}` : malicious, sourceUuid: 'uuid-0', sourceUrl: assets[0].url, nodePath: 'Root/Child', component: 'cc.Sprite', property: 'spriteFrame', nodeId: 'node-id', nodeLocator: { version: 1, segments: [{ name: 'Root', fileId: 'root-file-id' }] }, prefabTarget: { localID: ['component-file-id'] } }));
const calls = []; let oldResolve, oldRequested = false, oldAssetsResolve, oldSizesResolve;
const sizeStats = totalBytes => ({ totalBytes, totalFiles: 201, unknownFiles: 2, byType: [{ type: 'image', count: 100, bytes: totalBytes / 2 }, { type: 'prefab', count: 101, bytes: totalBytes / 2 }], largestAssets: Array.from({ length: 201 }, (_, i) => ({ ...assets[5], name: i === 0 ? malicious : `large-${i}`, type: i < 100 ? 'image' : 'cc.Prefab' })), largestThresholdBytes: 50 * 1024, partial: true, scope: 'source-files' });
const messageRequest = async (name, message, args) => {
  assert.equal(name, 'cocos-resource-inspector'); calls.push({ message, args });
  if (message === 'get-state') return state;
  if (message === 'query-assets') {
    if (args.sort === 'size-desc') return new Promise(resolve => { oldAssetsResolve = resolve; });
    if (args.sort === 'size-asc') return { items: [{ ...assets[0], name: 'ascending result' }], total: 1, page: 1, pageSize: 200 };
    return { items: assets, total: assets.length, page: 1, pageSize: 200 };
  }
  if (message === 'get-size-stats') {
    if (state.revision === 2) return new Promise(resolve => { oldSizesResolve = resolve; });
    if (state.revision === 4) { const stats = sizeStats(4 * 1024 ** 3); stats.largestAssets = stats.largestAssets.filter(asset => asset.type === 'cc.Prefab'); return stats; }
    if (state.revision === 5) return { ...sizeStats(5 * 1024 ** 3), largestAssets: [] };
    return sizeStats(state.revision * 1024 ** 3);
  }
  if (message === 'query-issues') {
    if (args.query === 'old') { oldRequested = true; return new Promise(resolve => { oldResolve = resolve; }); }
    if (args.query === 'new') return { items: [{ ...issues[0], message: 'new result' }], total: 1, page: 1, pageSize: 100 };
    return { items: issues, total: 101, page: 1, pageSize: 100 };
  }
  if (message === 'query-unused-assets') {
    if (args.query === 'old') return new Promise(resolve => { oldResolve = resolve; });
    if (args.query === 'new') return { items: [{ ...assets[0], name: 'fresh audio', category: 'audio', status: 'referenced', reason: 'name mention', incomingCount: 1 }], total: 1, page: 1, pageSize: 100, stats: { unused: 1, dynamic: 2, unknown: 3, unusedBytes: 1024 } };
    return { items: assets.map(asset => ({ ...asset, name: malicious, category: 'audio', status: 'unused', reason: 'no references', incomingCount: 0 })), total: 201, page: 1, pageSize: 100, stats: { unused: 201, dynamic: 2, unknown: 3, unusedBytes: 1024 } };
  }
  if (message === 'query-references') return { items: [{ ...issues[0], targetUuid: 'uuid-1', targetUrl: assets[1].url, kind: 'serialized' }], total: 1, page: 1, pageSize: 100 };
  if (message === 'get-impact') return { direct: assets.slice(0, 150), transitive: assets.slice(0, 125), directTotal: 600, transitiveTotal: 800, truncated: true, caveat: 'STATIC ONLY' };
  if (message === 'locate-node' || message === 'locate-asset') return { message: 'located' };
  if (message === 'export-report') return { path: 'D:/out/report.html' };
  throw new Error(message);
};
const context = { module: { exports: {} }, require, __dirname: path.join(root, 'panels/default'), Editor: { Panel: { define: options => options }, Message: { request: messageRequest } }, setTimeout(callback, ms) { timers.set(++timerId, { callback, ms }); return timerId; }, clearTimeout(id) { timers.delete(id); } };
vm.runInNewContext(fs.readFileSync(path.join(root, 'panels/default/index.js'), 'utf8'), context);
const panel = context.module.exports;
const instance = { $: { app } };
const q = selector => app.querySelector(selector);
const flush = () => new Promise(resolve => setImmediate(resolve));
const fireDebounce = () => { for (const [id, timer] of timers) if (timer.ms === 250) { timers.delete(id); timer.callback(); } };
const firePoll = async () => { const entry = [...timers].find(([, timer]) => timer.ms === 2000); assert(entry, 'poll is scheduled'); timers.delete(entry[0]); await entry[1].callback(); await flush(); };
test('panel bounds DOM, escapes data, rejects stale responses, locates nodes and releases lifecycle resources', async () => {
  panel.ready.call(instance); await flush();
  assert.equal(q('#assets').querySelectorAll('.asset-item').length, 200, 'asset DOM cap');
  assert.equal(q('#issue-table').querySelectorAll('tr').length, 101, '100 issues plus header');
  assert(q('#issue-table').textContent.includes(malicious), 'hostile text remains text');
  assert.equal(q('#issue-table').querySelectorAll('img').length, 0);
  assert.equal(q('#asset-next').disabled, false);
  assert(q('#metrics').textContent.includes('源资源总大小1 GiB'));
  assert(q('#assets').textContent.includes('1 KiB')); assert(q('#assets').textContent.includes('1 MiB')); assert(q('#assets').textContent.includes('1 GiB')); assert(q('#assets').textContent.includes('512 B'));
  const rows = q('#assets').querySelectorAll('.asset-item');
  assert(rows[1].textContent.includes('随主资源')); assert(rows[2].textContent.includes('不可用')); assert(rows[3].textContent.includes('不可用')); assert(rows[6].textContent.includes('不可用'));
  assert.equal(calls.filter(call => call.message === 'get-size-stats').length, 0, 'size stats load only when tab opens');
  q('#asset-sort').value = 'size-desc'; q('#asset-sort').dispatch('change'); await flush();
  q('#asset-sort').value = 'size-asc'; q('#asset-sort').dispatch('change'); await flush();
  assert.equal(calls.filter(call => call.message === 'query-assets').at(-1).args.sort, 'size-asc');
  oldAssetsResolve({ items: [{ ...assets[0], name: 'stale large asset' }], total: 1, page: 1, pageSize: 200 }); await flush();
  assert(q('#assets').textContent.includes('ascending result')); assert(!q('#assets').textContent.includes('stale large asset'));
  q('#asset-sort').value = 'path'; q('#asset-sort').dispatch('change'); await flush();
  q('#issue-search').value = 'old'; q('#issue-search').dispatch('input'); fireDebounce(); await flush(); assert(oldRequested);
  q('#issue-search').value = 'new'; q('#issue-search').dispatch('input'); fireDebounce(); await flush();
  oldResolve({ items: [{ ...issues[0], message: 'stale old result' }], total: 1, page: 1, pageSize: 100 }); await flush();
  assert(q('#issue-table').textContent.includes('new result')); assert(!q('#issue-table').textContent.includes('stale old result'));
  q('#tab-unused').dispatch('click'); await flush();
  assert.equal(q('#unused-table').querySelectorAll('tr').length, 101, 'usage DOM capped at 100 rows');
  assert(q('#unused-table').textContent.includes(malicious)); assert.equal(q('#unused-table').querySelectorAll('img').length, 0);
  assert(q('#unused-summary').textContent.includes('1 KiB')); assert.equal(q('#unused-next').disabled, false);
  q('#unused-category').value = 'audio'; q('#unused-category').dispatch('change'); await flush();
  assert.equal(calls.filter(call => call.message === 'query-unused-assets').at(-1).args.category, 'audio');
  q('#unused-status').value = 'referenced'; q('#unused-status').dispatch('change'); await flush();
  assert.equal(calls.filter(call => call.message === 'query-unused-assets').at(-1).args.status, 'referenced');
  q('#unused-next').dispatch('click'); await flush();
  assert.equal(calls.filter(call => call.message === 'query-unused-assets').at(-1).args.page, 2);
  q('#unused-search').value = 'old'; q('#unused-search').dispatch('input'); fireDebounce(); await flush();
  q('#unused-search').value = 'new'; q('#unused-search').dispatch('input'); fireDebounce(); await flush();
  oldResolve({ items: [{ ...assets[0], name: 'stale audio' }], total: 1, page: 1, pageSize: 100 }); await flush();
  assert(q('#unused-table').textContent.includes('fresh audio')); assert(!q('#unused-table').textContent.includes('stale audio'));
  q('#unused-table').querySelectorAll('button').find(button => button.textContent === '查看引用').dispatch('click'); await flush();
  assert.equal(q('#tab-references').attributes['aria-selected'], 'true');
  q('#assets').querySelectorAll('.asset-item')[0].dispatch('click'); q('#tab-references').dispatch('click'); await flush();
  assert(q('#reference-table').textContent.includes('spriteFrame'));
  const nodeButton = q('#reference-table').querySelectorAll('button').find(button => button.textContent === '定位节点'); nodeButton.dispatch('click'); await flush();
  const nodeCall = calls.find(call => call.message === 'locate-node'); assert.equal(nodeCall.args.nodeId, 'node-id');
  assert.deepEqual(nodeCall.args.nodeLocator, issues[0].nodeLocator); assert.deepEqual(nodeCall.args.prefabTarget, issues[0].prefabTarget);
  q('#reference-direction').value = 'outgoing'; q('#reference-direction').dispatch('change'); await flush();
  assert.equal(calls.filter(call => call.message === 'query-references').at(-1).args.direction, 'outgoing');
  q('#tab-impact').dispatch('click'); await flush();
  assert(q('#impact-body').textContent.includes('600')); assert(q('#impact-body').textContent.includes('800')); assert(q('#impact-body').textContent.includes('不完整'));
  assert.equal(q('#impact-body').querySelectorAll('li').length, 200, 'two impact sections capped at 100');
  q('#tab-sizes').dispatch('click'); await flush();
  assert(q('#size-body').textContent.includes('1 GiB')); assert(q('#size-body').textContent.includes('50.00%'));
  assert(q('#size-body').textContent.includes('不完整')); assert(q('#size-body').textContent.includes(malicious));
  assert.equal(q('#size-body').querySelectorAll('img').length, 0, 'size names stay text');
  assert(q('#size-body').textContent.includes('大于 50 KB 的源资源（共 201 项）'));
  assert.equal(q('#size-body').querySelectorAll('button').filter(button => button.textContent === '定位').length, 100, 'large resources paginate without truncating results');
  q('#size-body').querySelectorAll('button')[0].dispatch('click'); await flush();
  assert(calls.some(call => call.message === 'locate-asset' && call.args.uuid === 'uuid-5'));
  const sizeNext = () => q('#size-body').querySelectorAll('button').find(button => button.textContent === '下一页');
  const sizePrev = () => q('#size-body').querySelectorAll('button').find(button => button.textContent === '上一页');
  assert.equal(sizePrev().disabled, true);
  sizeNext().dispatch('click'); await flush();
  assert(q('#size-body').textContent.includes('large-100')); assert(q('#size-body').textContent.includes('large-199'));
  sizeNext().dispatch('click'); await flush();
  assert(q('#size-body').textContent.includes('large-200'));
  assert.equal(q('#size-body').querySelectorAll('button').filter(button => button.textContent === '定位').length, 1);
  assert.equal(sizeNext().disabled, true);
  assert.equal(calls.filter(call => call.message === 'get-size-stats').length, 1, 'paging reuses the current size result');
  sizePrev().dispatch('click'); await flush(); assert(q('#size-body').textContent.includes('large-100'));
  const sizeType = () => q('#size-type-filter');
  const largeTable = () => q('#size-body').querySelectorAll('table').at(-1);
  assert.equal(sizeType().value, '', 'all types are selected by default');
  assert.equal(sizeType().querySelectorAll('option').length, 3, 'types come from the full result, not the current page');
  sizeType().value = 'image'; sizeType().dispatch('change'); await flush();
  assert(q('#size-body').textContent.includes('大于 50 KB 的源资源（共 100 项）'));
  assert.equal(q('#size-body').querySelectorAll('button').filter(button => button.textContent === '定位').length, 100);
  assert(!largeTable().textContent.includes('large-100')); assert(largeTable().textContent.includes(malicious));
  assert.equal(sizePrev().disabled, true); assert.equal(sizeNext().disabled, true);
  sizeType().value = 'cc.Prefab'; sizeType().dispatch('change'); await flush();
  assert(q('#size-body').textContent.includes('大于 50 KB 的源资源（共 101 项）'));
  assert(largeTable().textContent.includes('large-100')); assert(!largeTable().textContent.includes(malicious));
  sizeNext().dispatch('click'); await flush();
  assert(largeTable().textContent.includes('large-200')); assert.equal(sizeNext().disabled, true);
  sizeType().value = ''; sizeType().dispatch('change'); await flush();
  assert(q('#size-body').textContent.includes('大于 50 KB 的源资源（共 201 项）'));
  assert(largeTable().textContent.includes(malicious)); assert.equal(sizePrev().disabled, true);
  sizeType().value = 'image'; sizeType().dispatch('change'); await flush();
  assert.equal(calls.filter(call => call.message === 'get-size-stats').length, 1, 'type filtering reuses the full cached result');
  q('#tab-issues').dispatch('click'); q('#tab-sizes').dispatch('click'); await flush();
  assert.equal(sizeType().value, 'image', 'type selection survives tab changes');
  assert.equal(calls.filter(call => call.message === 'get-size-stats').length, 1, 'size stats cached for same revision');
  await firePoll(); assert.equal(calls.filter(call => call.message === 'get-size-stats').length, 1, 'poll carries no size stats request');
  state.revision = 2; await firePoll(); assert.equal(calls.filter(call => call.message === 'get-size-stats').length, 2);
  state.revision = 3; await firePoll(); assert(q('#size-body').textContent.includes('3 GiB'));
  assert(q('#size-body').textContent.includes(malicious), 'new scan resets large resources to first page');
  oldSizesResolve(sizeStats(2 * 1024 ** 3)); await flush();
  assert(q('#size-body').textContent.includes('3 GiB')); assert(!q('#size-body').textContent.includes('2 GiB'), 'stale size response rejected');
  assert.equal(sizeType().value, 'image', 'existing type selection survives a rescan');
  state.revision = 4; await firePoll();
  assert.equal(sizeType().value, '', 'missing types reset to all after a rescan');
  assert(q('#size-body').textContent.includes('大于 50 KB 的源资源（共 101 项）'));
  state.revision = 5; await firePoll();
  assert.equal(sizeType().disabled, true, 'empty large-resource lists disable the type selector');
  assert.equal(sizeType().querySelectorAll('option').length, 1);
  assert(q('#size-body').textContent.includes('没有大于 50 KB 的源资源'));
  q('#export-html').dispatch('click'); await flush(); assert(q('#status').textContent.includes('D:/out/report.html'));
  panel.close.call(instance); await flush(); assert.equal(timers.size, 0); assert.equal(q('#assets').childNodes.length, 0); assert.equal(q('#size-body').childNodes.length, 0);
  assert.equal(q('#unused-table').childNodes.length, 0);
  const callsAfterClose = calls.length; q('#scan').dispatch('click'); await flush(); assert.equal(calls.length, callsAfterClose);
});
