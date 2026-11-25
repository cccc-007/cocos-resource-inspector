'use strict';

const path = require('path');
const { sourceType } = require('./size');

const USAGE_LABELS = { unused: '疑似未使用', dynamic: '动态加载待确认', unknown: '扫描不完整待确认', referenced: '已发现引用' };
const CATEGORY_LABELS = { image: '图片', audio: '音频', spine: 'Spine JSON', 'spine-binary': 'Spine 二进制', dragonbones: 'DragonBones JSON', 'dragonbones-binary': 'DragonBones 二进制', animation: '动画剪辑', atlas: '图集', binary: '其他二进制' };

function resourceCategory(asset) {
    if (asset.usageCategory) return asset.usageCategory;
    const ext = path.posix.extname(asset.url || '').toLowerCase();
    const type = String(asset.type || '').toLowerCase();
    if (ext === '.skel') return 'spine-binary';
    if (ext === '.dbbin') return 'dragonbones-binary';
    if (/spine|skeleton-data|sp\.skeletondata/.test(type)) return /\.(?:bin|bytes)$/.test(ext) ? 'spine-binary' : 'spine';
    if (/dragonbones|dragon-bones|dragonbonesasset/.test(type)) return /atlas/.test(type) ? 'atlas' : /\.(?:bin|bytes)$/.test(ext) ? 'dragonbones-binary' : 'dragonbones';
    if (sourceType(asset.url) === 'audio-clip' || /^(?:audio-clip|cc\.audioclip)$/.test(type)) return 'audio';
    if (sourceType(asset.url) === 'image' || /^(?:image|texture|sprite-frame|cc\.imageasset|cc\.texture2d)$/.test(type)) return 'image';
    if (sourceType(asset.url) === 'animation-clip' || /animation-clip|cc\.animationclip/.test(type)) return 'animation';
    if (ext === '.atlas' || ext === '.plist' || /^(?:sprite-atlas|spriteatlas|cc\.spriteatlas)$/.test(type)) return 'atlas';
    if (ext === '.bin' || ext === '.bytes' || type === 'buffer') return 'binary';
    return '';
}

// Classify physical source families: an image's SpriteFrame and Texture metadata
// must neither count as consumers nor duplicate its bytes. Other source types
// (all scenes, Prefabs, scripts, materials and business configs) are conservative
// entry points. This is a cleanup aid, not a build-specific reachability report.
function buildUsage(result) {
    const assets = new Map(result.assets.map(asset => [asset.uuid, asset]));
    const physical = new Map(result.assets.filter(asset => !asset.internal && !asset.subAsset && !asset.parentUuid && !asset.missingSource && asset.type !== 'folder').map(asset => [asset.uuid, asset]));
    const family = uuid => {
        const asset = assets.get(uuid);
        return asset ? asset.parentUuid || (asset.subAsset ? uuid.split('@')[0] : uuid) : uuid.split('@')[0];
    };
    const edges = new Map(), incoming = new Map();
    for (const ref of result.references) {
        const source = family(ref.sourceUuid), target = family(ref.targetUuid);
        if (source === target || !physical.has(target)) continue;
        if (!edges.has(source)) edges.set(source, new Set());
        edges.get(source).add(target);
        if (!incoming.has(target)) incoming.set(target, new Set());
        incoming.get(target).add(source);
    }
    const categories = new Map([...physical].map(([uuid, asset]) => [uuid, resourceCategory(asset)]));
    function traverse(seeds) {
        const seen = new Set(seeds), pending = [...seen];
        for (let index = 0; index < pending.length; index++) {
            for (const target of edges.get(pending[index]) || []) if (!seen.has(target)) { seen.add(target); pending.push(target); }
        }
        return seen;
    }
    const roots = [...physical.keys()].filter(uuid => !categories.get(uuid));
    // References from built-in/editor-only assets also constitute evidence.
    for (const source of edges.keys()) if (!physical.has(source)) roots.push(source);
    const referenced = traverse(roots);
    const bundles = new Set(result.assets.filter(asset => asset.type === 'folder' && asset.isBundle).map(asset => asset.url));
    const dynamicRoots = [...physical.values()].filter(asset => {
        if (asset.url.split('/').slice(3, -1).includes('resources')) return true;
        let directory = path.posix.dirname(asset.url);
        while (directory.startsWith('db://assets/')) {
            if (bundles.has(directory)) return true;
            directory = path.posix.dirname(directory);
        }
        return false;
    }).map(asset => asset.uuid);
    const dynamic = traverse(dynamicRoots);
    const stats = { total: 0, unused: 0, dynamic: 0, unknown: 0, referenced: 0, unusedBytes: 0, unknownSizeFiles: 0, partial: !!result.summary.partial };
    const items = [];
    for (const [uuid, asset] of physical) {
        const category = categories.get(uuid);
        if (!category) continue;
        const status = referenced.has(uuid) ? 'referenced' : dynamic.has(uuid) ? 'dynamic'
            : result.summary.partial || asset.duplicate || uuid.startsWith('path:') ? 'unknown' : 'unused';
        const reason = status === 'referenced' ? '可从场景、Prefab、脚本或其他资源的静态引用到达。'
            : status === 'dynamic' ? '位于 resources / Bundle 中，或被这些资源依赖，可能在运行时加载。'
                : status === 'unknown' ? '扫描被截断、存在读取异常或资源身份不完整，暂不能判断。'
                    : '未从场景、Prefab、脚本或其他资源发现使用链；同文件子资源互引不计为使用。';
        const { dependencies, ...view } = asset;
        items.push({ ...view, category, status, reason, incomingCount: (incoming.get(uuid) || new Set()).size });
        stats.total++; stats[status]++;
        if (status === 'unused') {
            if (asset.sizeKnown === true && Number.isSafeInteger(asset.size) && asset.size >= 0) stats.unusedBytes += asset.size;
            else stats.unknownSizeFiles++;
        }
    }
    return { stats, items };
}

module.exports = { resourceCategory, buildUsage, USAGE_LABELS, CATEGORY_LABELS };
