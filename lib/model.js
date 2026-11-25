'use strict';

const CAVEAT = '结果基于可识别的静态引用。代码拼接路径、resources.load / Bundle 动态加载、远程资源和自定义导入器依赖可能未覆盖；没有查到引用不等于可以安全删除。';
const normalized = value => String(value || '').trim().toLowerCase();

function page(items, options = {}) {
    const pageSize = Math.max(1, Math.min(200, Math.trunc(Number(options.pageSize) || 100)));
    const total = items.length;
    const current = Math.max(1, Math.min(Math.max(1, Math.ceil(total / pageSize)), Math.trunc(Number(options.page) || 1)));
    return { items: items.slice((current - 1) * pageSize, current * pageSize), total, page: current, pageSize };
}
function append(map, key, value) {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
}
function assetView(asset) {
    const { dependencies, ...view } = asset;
    return { ...view, dependencyCount: (dependencies || []).length };
}

class ResultStore {
    constructor(result) {
        this.result = result;
        this.assets = new Map();
        this.incoming = new Map();
        this.outgoing = new Map();
        this.subassets = new Map();
        for (const asset of result.assets) {
            this.assets.set(normalized(asset.uuid), asset);
            const base = normalized(asset.uuid).split('@')[0];
            if (base !== normalized(asset.uuid)) append(this.subassets, base, normalized(asset.uuid));
        }
        for (const reference of result.references) {
            append(this.incoming, normalized(reference.targetUuid), reference);
            append(this.outgoing, normalized(reference.sourceUuid), reference);
        }
    }
    queryAssets(options = {}) {
        const query = normalized(options.query);
        const items = this.result.assets.filter(asset => !asset.internal && asset.type !== 'folder' && (!query || normalized(`${asset.uuid} ${asset.url} ${asset.name} ${asset.type}`).includes(query)));
        const pathOrder = (a, b) => a.url.localeCompare(b.url) || a.uuid.localeCompare(b.uuid);
        if (options.sort === 'size-desc' || options.sort === 'size-asc') {
            const knownSize = asset => !asset.subAsset && !asset.parentUuid && asset.sizeKnown !== false && !asset.missingSource && Number.isFinite(asset.size) && asset.size >= 0;
            const direction = options.sort === 'size-asc' ? 1 : -1;
            items.sort((a, b) => {
                const knownA = knownSize(a), knownB = knownSize(b);
                return Number(knownB) - Number(knownA) || (knownA && knownB ? direction * (a.size - b.size) : 0) || pathOrder(a, b);
            });
        } else items.sort(pathOrder);
        const response = page(items, options);
        response.items = response.items.map(assetView);
        return response;
    }
    queryIssues(options = {}) {
        const query = normalized(options.query);
        return page(this.result.issues.filter(issue => (!options.severity || options.severity === 'all' || options.severity === issue.severity)
            && (!query || normalized(`${issue.code} ${issue.message} ${issue.sourceUrl || ''} ${issue.nodePath || ''} ${issue.component || ''} ${issue.property || ''} ${issue.targetUuid || ''}`).includes(query))), options);
    }
    queryUnusedAssets(options = {}) {
        const query = normalized(options.query);
        const usage = this.result.usage || { items: [], stats: {} };
        const items = usage.items.filter(asset => (!options.status || options.status === 'all' || options.status === asset.status)
            && (!options.category || options.category === 'all' || options.category === asset.category)
            && (!query || normalized(`${asset.uuid} ${asset.url} ${asset.name} ${asset.type}`).includes(query)));
        items.sort((a, b) => Number(b.sizeKnown === true) - Number(a.sizeKnown === true) || (b.size || 0) - (a.size || 0) || a.url.localeCompare(b.url));
        return { ...page(items, options), stats: usage.stats };
    }
    selectionIds(uuid) {
        const id = normalized(uuid);
        return [id, ...(id.includes('@') ? [] : this.subassets.get(id) || [])];
    }
    queryReferences(options = {}) {
        const source = options.direction === 'outgoing' ? this.outgoing : this.incoming;
        const items = this.selectionIds(options.uuid).flatMap(id => source.get(id) || []);
        return page(items, options);
    }
    getImpact(options = {}) {
        const selected = normalized(options.uuid);
        const asset = this.assets.get(selected);
        if (!asset) throw new Error('资源已不在扫描结果中，请重新扫描或选择资源。');
        const roots = this.selectionIds(selected);
        const pending = roots.slice(0, 20000).map(id => ({ id, depth: 0 }));
        const queued = new Set(pending.map(item => item.id));
        const direct = new Map(), transitive = new Map();
        let position = 0, truncated = roots.length > 20000;
        while (position < pending.length) {
            const { id, depth } = pending[position++];
            for (const reference of this.incoming.get(id) || []) {
                const source = normalized(reference.sourceUuid);
                const physicalId = source.split('@')[0];
                if (physicalId === selected.split('@')[0]) continue;
                const item = this.assets.get(source);
                if (item) {
                    const physical = this.assets.get(physicalId) || item;
                    if (depth === 0) direct.set(physicalId, physical);
                    else if (!direct.has(physicalId)) transitive.set(physicalId, physical);
                }
                // An importer dependency may be recorded on one subasset. Continue
                // through its physical parent and sibling subassets as one unit.
                for (const next of this.selectionIds(physicalId)) {
                    if (queued.has(next)) continue;
                    if (queued.size >= 20000) { truncated = true; break; }
                    queued.add(next); pending.push({ id: next, depth: depth + 1 });
                }
                if (truncated) break;
            }
            if (truncated) break;
        }
        for (const key of direct.keys()) transitive.delete(key);
        const sort = values => [...values].sort((a, b) => a.url.localeCompare(b.url));
        const directItems = sort(direct.values()), transitiveItems = sort(transitive.values());
        return { asset: assetView(asset), direct: directItems.slice(0, 500).map(assetView), transitive: transitiveItems.slice(0, 500).map(assetView), directTotal: direct.size, transitiveTotal: transitive.size,
            truncated: truncated || direct.size > 500 || transitive.size > 500, caveat: CAVEAT };
    }
}

module.exports = { ResultStore, page, CAVEAT };
