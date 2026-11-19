'use strict';

const { readFileSync } = require('fs');
const { join } = require('path');
const NAME = 'cocos-resource-inspector';
const ASSET_PAGE_SIZE = 200;
const ROW_PAGE_SIZE = 100;

module.exports = Editor.Panel.define({
  template: readFileSync(join(__dirname, '../../static/panel.html'), 'utf8'),
  style: readFileSync(join(__dirname, '../../static/panel.css'), 'utf8'),
  $: { app: '#app' },
  ready() {
    const app = this.$.app;
    const q = selector => app.querySelector(selector);
    const request = (message, args) => args === undefined
      ? Editor.Message.request(NAME, message) : Editor.Message.request(NAME, message, args);
    let closed = false, state, activeTab = 'issues', selectedAsset = null;
    let pollTimer, statePending = false, stateAgain = false, busy = false, stateEpoch = 0;
    let assetPage = 1, issuePage = 1, referencePage = 1;
    let revision = '', impact = null, impactDirectPage = 1, impactTransitivePage = 1;
    let sizeStats = null, sizeStatsRevision = '';
    const epochs = { assets: 0, issues: 0, references: 0, impact: 0, sizes: 0 };
    const searchTimers = new Map();
    const listeners = [];
    const on = (element, type, listener) => {
      element.addEventListener(type, listener);
      listeners.push(() => element.removeEventListener(type, listener));
    };
    const el = (tag, className, text) => {
      const node = app.ownerDocument.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = String(text == null ? '' : text);
      return node;
    };
    const setStatus = (message, error = false) => {
      if (closed) return;
      q('#status').textContent = String(message || '');
      q('#status').classList.toggle('error', error);
    };
    const reportError = err => setStatus(err && err.message ? err.message : String(err), true);
    const empty = (container, message) => container.replaceChildren(el('div', 'empty', message));
    const count = value => Number.isFinite(Number(value)) ? Number(value).toLocaleString('zh-CN') : '—';
    const bytes = value => {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '不可用';
      const units = ['B', 'KiB', 'MiB', 'GiB'];
      let unit = 0, amount = value;
      while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; ++unit; }
      return `${amount.toLocaleString('zh-CN', { maximumFractionDigits: unit ? 2 : 0 })} ${units[unit]}`;
    };
    const assetSize = asset => asset.subAsset ? '随主资源' : asset.sizeKnown === false || asset.missingSource ? '不可用' : bytes(asset.size);
    const hasResult = () => !!(state && state.result);
    const isScanning = () => state && state.status === 'scanning';
    const formatDate = value => {
      if (!value) return '尚未扫描';
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('zh-CN', { hour12: false });
    };
    const nameOf = asset => asset.name || String(asset.url || asset.uuid || '').split('/').pop() || '未命名资源';
    const pageInfo = (prefix, response) => {
      const total = Math.max(0, Number(response.total) || 0);
      const pageSize = Math.max(1, Number(response.pageSize) || (prefix === 'asset' ? ASSET_PAGE_SIZE : ROW_PAGE_SIZE));
      const page = Math.max(1, Number(response.page) || 1);
      const pages = Math.ceil(total / pageSize);
      q(`#${prefix}-page`).textContent = `${total ? page : 0} / ${pages}`;
      q(`#${prefix}-prev`).disabled = !total || page <= 1;
      q(`#${prefix}-next`).disabled = !total || page >= pages;
      return page;
    };
    const resetPager = prefix => pageInfo(prefix, { total: 0, page: 1 });
    const actionButton = (label, handler) => {
      const button = el('button', '', label);
      button.type = 'button';
      // Row buttons are owned by their rendered subtree and released when it is replaced.
      button.addEventListener('click', event => { event.stopPropagation(); void handler(); });
      return button;
    };
    const locateAsset = async asset => {
      try {
        const result = await request('locate-asset', { uuid: asset.uuid, url: asset.url });
        if (!closed && result && result.message) setStatus(result.message);
      } catch (err) { if (!closed) reportError(err); }
    };
    const locateNode = async record => {
      try {
        const result = await request('locate-node', { sourceUuid: record.sourceUuid, nodePath: record.nodePath, nodeId: record.nodeId, nodeLocator: record.nodeLocator, prefabTarget: record.prefabTarget });
        if (!closed) setStatus(result && result.message ? result.message : '已请求定位节点。');
      } catch (err) { if (!closed) reportError(err); }
    };
    const sourceCell = record => {
      const cell = el('td');
      cell.append(el('span', 'cell-title', record.sourceUrl || record.sourceUuid || '—'));
      if (record.sourceUuid) cell.append(el('small', 'code', record.sourceUuid));
      const actions = el('div', 'row-actions');
      if (record.sourceUuid || record.sourceUrl) actions.append(actionButton('定位资源', () => locateAsset({ uuid: record.sourceUuid, url: record.sourceUrl })));
      if (record.sourceUuid && record.nodePath) actions.append(actionButton('定位节点', () => locateNode(record)));
      if (actions.childNodes.length) cell.append(actions);
      return cell;
    };
    const positionCell = record => {
      const cell = el('td');
      cell.append(el('span', 'cell-title', record.nodePath || '—'));
      if (record.component) cell.append(el('small', '', `组件：${record.component}`));
      if (record.property) cell.append(el('small', 'code', `属性：${record.property}`));
      return cell;
    };
    const makeTable = headers => {
      const table = el('table'), head = el('thead'), row = el('tr'), body = el('tbody');
      for (const label of headers) { const th = el('th', '', label); th.scope = 'col'; row.append(th); }
      head.append(row); table.append(head, body);
      return { table, body };
    };
    const selectAsset = asset => {
      selectedAsset = asset;
      referencePage = impactDirectPage = impactTransitivePage = 1;
      impact = null;
      ++epochs.references; ++epochs.impact;
      app.querySelectorAll('.asset-item').forEach(item => {
        const selected = item.dataset.uuid === asset.uuid;
        item.classList.toggle('selected', selected);
        item.setAttribute('aria-selected', String(selected));
      });
      renderSelection();
      if (activeTab === 'references') void loadReferences();
      if (activeTab === 'impact') void loadImpact();
    };
    const renderSelection = () => {
      for (const selector of ['#reference-selection', '#impact-selection']) {
        const container = q(selector);
        container.classList.toggle('empty', !selectedAsset);
        if (!selectedAsset) { container.textContent = '请在左侧选择一个资源'; continue; }
        container.replaceChildren(el('strong', '', nameOf(selectedAsset)), el('div', 'muted', selectedAsset.url || '—'), el('div', 'code', selectedAsset.uuid || '—'));
        container.append(actionButton('在资源管理器中定位', () => locateAsset(selectedAsset)));
      }
    };
    async function loadAssets() {
      const epoch = ++epochs.assets;
      if (closed || !hasResult()) { empty(q('#assets'), '扫描后显示项目资源'); resetPager('asset'); return; }
      const query = q('#asset-search').value.trim();
      try {
        const response = await request('query-assets', { query, sort: q('#asset-sort').value || 'path', page: assetPage, pageSize: ASSET_PAGE_SIZE });
        if (closed || epoch !== epochs.assets) return;
        const items = Array.isArray(response.items) ? response.items.slice(0, ASSET_PAGE_SIZE) : [];
        assetPage = pageInfo('asset', response);
        q('#asset-total').textContent = `${count(response.total)} 项`;
        if (!items.length) { empty(q('#assets'), query ? '没有匹配的资源' : '没有可显示的项目资源'); return; }
        const fragment = app.ownerDocument.createDocumentFragment();
        for (const asset of items) {
          const button = el('button', 'asset-item');
          button.type = 'button'; button.dataset.uuid = asset.uuid; button.setAttribute('role', 'option');
          const selected = !!selectedAsset && selectedAsset.uuid === asset.uuid;
          button.classList.toggle('selected', selected); button.setAttribute('aria-selected', String(selected));
          button.title = `${asset.url || ''}\n${asset.uuid || ''}`;
          button.append(el('strong', '', nameOf(asset)), el('small', 'asset-type', asset.type || '未知类型'), el('small', 'asset-size', assetSize(asset)), el('small', '', asset.url || asset.uuid));
          button.addEventListener('click', () => selectAsset(asset));
          fragment.append(button);
        }
        q('#assets').replaceChildren(fragment);
      } catch (err) { if (!closed && epoch === epochs.assets) reportError(err); }
    }
    async function loadIssues() {
      const epoch = ++epochs.issues;
      if (closed || activeTab !== 'issues') return;
      if (!hasResult()) { empty(q('#issue-table'), '扫描后显示检查结果'); resetPager('issue'); return; }
      try {
        const response = await request('query-issues', { query: q('#issue-search').value.trim(), severity: q('#severity').value || undefined, page: issuePage, pageSize: ROW_PAGE_SIZE });
        if (closed || epoch !== epochs.issues || activeTab !== 'issues') return;
        issuePage = pageInfo('issue', response);
        q('#issue-total').textContent = `${count(response.total)} 条问题`;
        const items = Array.isArray(response.items) ? response.items.slice(0, ROW_PAGE_SIZE) : [];
        if (!items.length) { empty(q('#issue-table'), '当前筛选下没有发现问题；动态引用仍需结合项目逻辑检查。'); return; }
        const { table, body } = makeTable(['级别 / 检查项', '问题说明', '来源资源', '节点 / 组件 / 属性']);
        const labels = { error: '错误', critical: '错误', warning: '警告', info: '提示' };
        for (const issue of items) {
          const row = el('tr'), severity = el('td'), message = el('td');
          const level = ['error', 'critical', 'warning', 'info'].includes(issue.severity) ? issue.severity : 'info';
          severity.append(el('span', `tag ${level}`, labels[level]), el('small', 'code', issue.code || ''));
          message.append(el('span', '', issue.message || '—'));
          if (issue.targetUuid) message.append(el('small', 'code', `目标：${issue.targetUuid}`));
          row.append(severity, message, sourceCell(issue), positionCell(issue)); body.append(row);
        }
        q('#issue-table').replaceChildren(table);
      } catch (err) { if (!closed && epoch === epochs.issues && activeTab === 'issues') reportError(err); }
    }
    async function loadReferences() {
      const epoch = ++epochs.references;
      if (closed || activeTab !== 'references') return;
      if (!selectedAsset || !hasResult()) { empty(q('#reference-table'), '请在左侧选择一个资源'); resetPager('reference'); q('#reference-total').textContent = '0 条引用'; return; }
      empty(q('#reference-table'), '正在读取引用…');
      try {
        const response = await request('query-references', { uuid: selectedAsset.uuid, direction: q('#reference-direction').value, page: referencePage, pageSize: ROW_PAGE_SIZE });
        if (closed || epoch !== epochs.references || activeTab !== 'references') return;
        referencePage = pageInfo('reference', response);
        q('#reference-total').textContent = `${count(response.total)} 条引用`;
        const items = Array.isArray(response.items) ? response.items.slice(0, ROW_PAGE_SIZE) : [];
        if (!items.length) { empty(q('#reference-table'), '未发现匹配的静态引用。动态加载可能未包含在索引中。'); return; }
        const { table, body } = makeTable(['来源资源', '引用位置', '目标资源', '引用方式']);
        for (const record of items) {
          const row = el('tr'), target = el('td'), kind = el('td');
          target.append(el('span', 'cell-title', record.targetUrl || record.targetUuid || '—'));
          if (record.targetUuid) {
            target.append(el('small', 'code', record.targetUuid));
            const actions = el('div', 'row-actions');
            actions.append(actionButton('定位资源', () => locateAsset({ uuid: record.targetUuid, url: record.targetUrl })));
            target.append(actions);
          }
          kind.append(el('span', 'tag', record.kind || '静态引用'));
          row.append(sourceCell(record), positionCell(record), target, kind); body.append(row);
        }
        q('#reference-table').replaceChildren(table);
      } catch (err) { if (!closed && epoch === epochs.references && activeTab === 'references') reportError(err); }
    }
    function renderImpact() {
      const container = q('#impact-body');
      if (!impact) { empty(container, selectedAsset ? '正在计算删除影响…' : '请在左侧选择一个资源'); return; }
      const direct = Array.isArray(impact.direct) ? impact.direct : [];
      const transitive = Array.isArray(impact.transitive) ? impact.transitive : [];
      const fragment = app.ownerDocument.createDocumentFragment();
      const stats = el('div', 'impact-stats');
      for (const [label, value] of [['直接引用它的资源', impact.directTotal == null ? direct.length : impact.directTotal], ['间接受影响的资源', impact.transitiveTotal == null ? transitive.length : impact.transitiveTotal]]) {
        const item = el('span'); item.append(el('strong', '', count(value)), app.ownerDocument.createTextNode(label)); stats.append(item);
      }
      fragment.append(stats);
      if (impact.truncated) fragment.append(el('div', 'notice', '影响列表达到扫描上限，以下结果不完整。请勿据此直接删除资源。'));
      const cycles = Array.isArray(impact.cycles) ? impact.cycles.length : Number(impact.cycles) || 0;
      if (cycles) fragment.append(el('p', 'helper', `发现 ${count(cycles)} 处循环依赖，删除影响需结合整个依赖环检查。`));
      fragment.append(el('p', 'helper', impact.caveat || '未发现静态引用也不能证明可以安全删除，需同时检查动态加载与打包配置。'));
      const section = (title, items, kind) => {
        fragment.append(el('h3', '', title));
        if (!items.length) { fragment.append(el('div', 'empty', '未发现匹配的静态依赖')); return; }
        let page = kind === 'direct' ? impactDirectPage : impactTransitivePage;
        const pages = Math.ceil(items.length / ROW_PAGE_SIZE); page = Math.min(pages, Math.max(1, page));
        if (kind === 'direct') impactDirectPage = page; else impactTransitivePage = page;
        const list = el('ul', 'impact-list');
        for (const asset of items.slice((page - 1) * ROW_PAGE_SIZE, page * ROW_PAGE_SIZE)) {
          const item = el('li'), text = el('div', 'impact-item-text');
          text.append(el('span', '', nameOf(asset)), el('small', '', asset.url || asset.uuid || '—'));
          item.append(text, actionButton('定位', () => locateAsset(asset))); list.append(item);
        }
        fragment.append(list);
        const pager = el('div', 'pagination');
        const turn = delta => { if (kind === 'direct') impactDirectPage += delta; else impactTransitivePage += delta; renderImpact(); };
        const previous = actionButton('上一页', () => turn(-1)), next = actionButton('下一页', () => turn(1));
        previous.disabled = page <= 1; next.disabled = page >= pages;
        pager.append(previous, el('span', '', `${page} / ${pages}`), next); fragment.append(pager);
      };
      section('直接受影响', direct, 'direct'); section('间接受影响', transitive, 'transitive');
      container.replaceChildren(fragment);
    }
    async function loadImpact() {
      const epoch = ++epochs.impact;
      if (closed || activeTab !== 'impact') return;
      impact = null; renderImpact();
      if (!selectedAsset || !hasResult()) return;
      try {
        const result = await request('get-impact', { uuid: selectedAsset.uuid });
        if (closed || epoch !== epochs.impact || activeTab !== 'impact') return;
        impact = result; renderImpact();
      } catch (err) { if (!closed && epoch === epochs.impact && activeTab === 'impact') { empty(q('#impact-body'), '读取删除影响失败，请重试或重新扫描。'); reportError(err); } }
    }
    function renderSizes() {
      const container = q('#size-body');
      if (!sizeStats) { empty(container, hasResult() ? '正在读取资源大小…' : '扫描后显示资源大小'); return; }
      const fragment = app.ownerDocument.createDocumentFragment();
      const totals = el('div', 'size-totals');
      for (const [label, value] of [['源资源总大小', bytes(sizeStats.totalBytes)], ['源文件数量', count(sizeStats.totalFiles)], ['大小不可用', count(sizeStats.unknownFiles)]]) {
        const item = el('div', 'metric'); item.append(el('span', '', label), el('strong', '', value)); totals.append(item);
      }
      fragment.append(totals);
      if (sizeStats.partial) fragment.append(el('div', 'notice', '本次大小统计不完整，部分文件未能读取或超出扫描范围。'));
      fragment.append(el('h3', '', '按资源类型统计'));
      const types = Array.isArray(sizeStats.byType) ? sizeStats.byType : [];
      if (types.length) {
        const { table, body } = makeTable(['类型', '源文件数量', '大小', '已知总大小占比']);
        for (const type of types.slice(0, 200)) {
          const row = el('tr');
          const share = sizeStats.totalBytes > 0 && typeof type.bytes === 'number' ? `${(type.bytes / sizeStats.totalBytes * 100).toFixed(2)}%` : '—';
          for (const value of [type.type || '未知类型', count(type.count), bytes(type.bytes), share]) row.append(el('td', '', value));
          body.append(row);
        }
        const region = el('div', 'table-region size-types'); region.append(table); fragment.append(region);
        if (types.length > 200) fragment.append(el('p', 'helper', '类型表显示前 200 项，完整统计请查看导出报告。'));
      } else fragment.append(el('div', 'empty', '没有可统计的源文件'));
      const largest = Array.isArray(sizeStats.largestAssets) ? sizeStats.largestAssets.slice(0, 50) : [];
      fragment.append(el('h3', '', '最大的 50 个源资源'));
      if (largest.length) {
        const { table, body } = makeTable(['排名', '名称 / 路径', '类型', '大小', '操作']);
        largest.forEach((asset, index) => {
          const row = el('tr'), resource = el('td'), action = el('td');
          resource.append(el('span', 'cell-title', nameOf(asset)), el('small', '', asset.url || asset.uuid || '—'));
          action.append(actionButton('定位', () => locateAsset(asset)));
          row.append(el('td', 'size-number', index + 1), resource, el('td', '', asset.type || '未知类型'), el('td', 'size-number', bytes(asset.size)), action);
          body.append(row);
        });
        const region = el('div', 'table-region'); region.append(table); fragment.append(region);
      } else fragment.append(el('div', 'empty', '没有大小可用的源资源'));
      container.replaceChildren(fragment);
    }
    async function loadSizes() {
      const epoch = ++epochs.sizes;
      if (closed || activeTab !== 'sizes') return;
      if (!hasResult()) { sizeStats = null; renderSizes(); return; }
      if (sizeStats && sizeStatsRevision === revision) { renderSizes(); return; }
      renderSizes();
      const requestedRevision = revision;
      try {
        const result = await request('get-size-stats');
        if (closed || epoch !== epochs.sizes || activeTab !== 'sizes' || revision !== requestedRevision) return;
        sizeStats = result; sizeStatsRevision = requestedRevision; renderSizes();
      } catch (err) {
        if (!closed && epoch === epochs.sizes && activeTab === 'sizes') { empty(q('#size-body'), '读取资源大小失败，请重新打开此页签或重新扫描。'); reportError(err); }
      }
    }
    const loadActive = () => activeTab === 'issues' ? loadIssues() : activeTab === 'references' ? loadReferences() : activeTab === 'sizes' ? loadSizes() : loadImpact();
    const renderState = () => {
      const scanning = isScanning(), result = state && state.result;
      const labels = { idle: '尚未扫描', scanning: '扫描中', ready: '扫描完成', error: '扫描失败' };
      q('#scan-status').textContent = labels[state && state.status] || '尚未扫描';
      q('#scan-status').className = `badge ${state && state.status || ''}`;
      q('#scan').disabled = !!scanning || busy; q('#scan').textContent = result ? '重新扫描' : '扫描项目';
      q('#cancel').disabled = !scanning || busy;
      q('#export-html').disabled = q('#export-json').disabled = !result || !!scanning || busy;
      q('#dirty-notice').hidden = !(state && state.dirty && result);
      q('#partial-notice').hidden = !(result && result.summary && result.summary.partial);
      q('#progress-area').hidden = !scanning;
      if (scanning) {
        const progress = state.progress || {};
        q('#progress-label').textContent = progress.message || progress.phase || '正在扫描项目…';
        const done = Math.max(0, Number(progress.done) || 0), total = Math.max(0, Number(progress.total) || 0);
        q('#progress-count').textContent = total ? `${count(done)} / ${count(total)}` : '';
        q('#progress').max = total || 1;
        if (total) q('#progress').value = Math.min(done, total); else q('#progress').removeAttribute('value');
      }
      q('#output-directory').textContent = state && state.outputDirectory || '—';
      q('#scanned-at').textContent = formatDate(result && result.scannedAt);
      const summary = result && result.summary || {};
      const number = (keys, fallback) => {
        for (const key of keys) if (typeof summary[key] === 'number') return summary[key];
        return fallback;
      };
      const metrics = [['项目资源', number(['assets', 'assetCount', 'totalAssets'], null), ''], ['Prefab', number(['prefabs'], null), ''], ['源资源总大小', number(['totalSourceBytes'], null), '', bytes], ['静态引用', number(['references', 'referenceCount', 'totalReferences'], null), ''], ['错误', number(['errors', 'errorCount'], null), 'error'], ['警告', number(['warnings', 'warningCount'], null), 'warning']];
      const fragment = app.ownerDocument.createDocumentFragment();
      for (const [label, value, kind, format] of metrics) { const metric = el('div', `metric ${kind}`); metric.append(el('span', '', label), el('strong', '', result && value != null ? (format || count)(value) : '—')); fragment.append(metric); }
      q('#metrics').replaceChildren(fragment);
      const limitations = result && result.limitations;
      const entries = Array.isArray(limitations) ? limitations : typeof limitations === 'string' ? [limitations] : [];
      const list = el('ul');
      for (const entry of entries.slice(0, 100)) list.append(el('li', '', typeof entry === 'string' ? entry : entry.message || entry.detail || JSON.stringify(entry)));
      const limitationsTotal = Math.max(entries.length, Number(result && result.limitationsTotal) || 0);
      if (limitationsTotal > 100) list.append(el('li', '', `覆盖限制共 ${count(limitationsTotal)} 条，面板显示前 100 条；完整说明请查看导出报告。`));
      q('#limitations').replaceChildren(list);
      if (state && state.error) setStatus(state.error, true);
    };
    const applyState = next => {
      if (closed || !next) return;
      const wasScanning = isScanning();
      state = next;
      renderState();
      const nextRevision = state.result ? String(state.revision == null ? state.result.scannedAt || JSON.stringify(state.result.summary || {}) : state.revision) : '';
      if (nextRevision !== revision || (wasScanning && !isScanning() && hasResult())) {
        revision = nextRevision;
        for (const key of Object.keys(epochs)) ++epochs[key];
        impact = null;
        sizeStats = null; sizeStatsRevision = '';
        void loadAssets(); void loadActive();
        if (hasResult() && !state.error) setStatus(state.dirty ? '扫描完成后资源又有变化，请重新扫描。' : '扫描完成。可查看问题或选择资源检查引用。');
      }
    };
    async function refreshState() {
      if (closed) return;
      if (statePending) { stateAgain = true; return; }
      statePending = true;
      const epoch = stateEpoch;
      try { const next = await request('get-state'); if (!closed && epoch === stateEpoch) applyState(next); }
      catch (err) { if (!closed) reportError(err); }
      finally {
        statePending = false;
        if (!closed && stateAgain) { stateAgain = false; void refreshState(); }
      }
    }
    const schedulePoll = () => {
      if (closed) return;
      clearTimeout(pollTimer);
      pollTimer = setTimeout(async () => { await refreshState(); schedulePoll(); }, isScanning() ? 1000 : 2000);
    };
    const runAction = async (message, args) => {
      if (closed || busy) return;
      busy = true; ++stateEpoch; renderState();
      try {
        const result = await request(message, args);
        if (closed) return;
        if (message === 'scan-project' || message === 'cancel-scan') {
          if (result && result.status) applyState(result);
          setStatus(message === 'scan-project' ? '正在扫描项目，结果完成后会自动刷新。' : '已请求取消扫描。');
        } else if (result) setStatus(result.message || (result.path ? `报告已导出：${result.path}` : '操作完成。'));
      } catch (err) { if (!closed) reportError(err); }
      finally { busy = false; if (!closed) { renderState(); await refreshState(); schedulePoll(); } }
    };
    const debounce = (key, handler) => {
      clearTimeout(searchTimers.get(key));
      searchTimers.set(key, setTimeout(() => { searchTimers.delete(key); if (!closed) void handler(); }, 250));
    };
    on(q('#scan'), 'click', () => void runAction('scan-project'));
    on(q('#cancel'), 'click', () => void runAction('cancel-scan'));
    on(q('#export-html'), 'click', () => void runAction('export-report', { format: 'html' }));
    on(q('#export-json'), 'click', () => void runAction('export-report', { format: 'json' }));
    on(q('#asset-search'), 'input', () => { ++epochs.assets; assetPage = 1; debounce('assets', loadAssets); });
    on(q('#asset-sort'), 'change', () => { assetPage = 1; void loadAssets(); });
    on(q('#issue-search'), 'input', () => { ++epochs.issues; issuePage = 1; debounce('issues', loadIssues); });
    on(q('#severity'), 'change', () => { issuePage = 1; void loadIssues(); });
    on(q('#reference-direction'), 'change', () => { referencePage = 1; void loadReferences(); });
    on(q('#asset-prev'), 'click', () => { assetPage = Math.max(1, assetPage - 1); void loadAssets(); });
    on(q('#asset-next'), 'click', () => { ++assetPage; void loadAssets(); });
    on(q('#issue-prev'), 'click', () => { issuePage = Math.max(1, issuePage - 1); void loadIssues(); });
    on(q('#issue-next'), 'click', () => { ++issuePage; void loadIssues(); });
    on(q('#reference-prev'), 'click', () => { referencePage = Math.max(1, referencePage - 1); void loadReferences(); });
    on(q('#reference-next'), 'click', () => { ++referencePage; void loadReferences(); });
    for (const button of app.querySelectorAll('[data-tab]')) on(button, 'click', () => {
      const tab = button.dataset.tab;
      if (activeTab === tab) return;
      activeTab = tab;
      ++epochs.issues; ++epochs.references; ++epochs.impact; ++epochs.sizes;
      for (const item of app.querySelectorAll('[data-tab]')) {
        const selected = item.dataset.tab === tab;
        item.classList.toggle('active', selected); item.setAttribute('aria-selected', String(selected));
      }
      for (const content of app.querySelectorAll('.tab-content')) content.hidden = content.id !== tab;
      renderSelection(); void loadActive();
    });
    this.dispose = () => {
      closed = true;
      clearTimeout(pollTimer);
      for (const timer of searchTimers.values()) clearTimeout(timer);
      searchTimers.clear();
      for (const key of Object.keys(epochs)) ++epochs[key];
      for (const remove of listeners) remove();
      state = selectedAsset = impact = sizeStats = null;
      sizeStatsRevision = '';
      q('#assets').replaceChildren(); q('#issue-table').replaceChildren(); q('#reference-table').replaceChildren(); q('#impact-body').replaceChildren(); q('#size-body').replaceChildren();
    };
    renderState();
    void refreshState().then(schedulePoll);
  },
  close() { if (this.dispose) this.dispose(); this.dispose = undefined; },
});
