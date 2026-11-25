'use strict';

const path = require('path');

const LARGE_THRESHOLD_BYTES = 50 * 1024;
const EXTENSION_TYPES = Object.freeze({
    '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.webp': 'image', '.bmp': 'image', '.gif': 'image', '.tga': 'image', '.tif': 'image', '.tiff': 'image', '.psd': 'image', '.hdr': 'image', '.exr': 'image',
    '.mp3': 'audio-clip', '.wav': 'audio-clip', '.ogg': 'audio-clip', '.m4a': 'audio-clip', '.aac': 'audio-clip', '.flac': 'audio-clip',
    '.ttf': 'ttf-font', '.otf': 'ttf-font', '.woff': 'ttf-font', '.woff2': 'ttf-font', '.fnt': 'bitmap-font',
    '.prefab': 'prefab', '.scene': 'scene', '.fire': 'scene',
    '.ts': 'script', '.js': 'script', '.mjs': 'script', '.cjs': 'script',
    '.mtl': 'material', '.material': 'material', '.anim': 'animation-clip', '.animation': 'animation-clip',
    '.fbx': 'fbx', '.gltf': 'gltf', '.glb': 'gltf', '.obj': 'obj', '.json': 'json', '.txt': 'text',
});

function sourceType(file) {
    const ext = path.extname(file || '').toLowerCase();
    return EXTENSION_TYPES[ext] || ext.slice(1) || 'asset';
}

function compareLargest(a, b) { return b.size - a.size || a.url.localeCompare(b.url); }

// A physical source path, rather than a UUID, is the accounting identity. A
// duplicate UUID is still two files, while imported sub-assets share one file.
// The scanner provides a separate entry.asset record so duplicate UUID merging
// in the reference index cannot change the URL/type of the second source file.
function buildSizeStats(entries, options = {}) {
    const stats = { totalBytes: 0, totalFiles: 0, unknownFiles: 0, byType: [], largestAssets: [], largestThresholdBytes: LARGE_THRESHOLD_BYTES, partial: options.partial === true, scope: 'source-files' };
    const types = new Map();
    const seen = new Set();
    const largest = [];
    for (const entry of entries || []) {
        if (!entry || typeof entry !== 'object') continue;
        const asset = entry.asset || entry;
        const source = entry.file || asset.source || '';
        const url = asset.url || '';
        if (entry.directory || asset.type === 'folder' || asset.subAsset || asset.internal || /\.meta$/i.test(source || url)) continue;
        if (url && !url.startsWith('db://assets/')) continue;
        const identity = source ? path.resolve(source) : url;
        if (!identity || seen.has(identity)) continue;
        seen.add(identity);
        const type = asset.type || sourceType(source || url);
        let group = types.get(type);
        if (!group) { group = { type, count: 0, bytes: 0 }; types.set(type, group); }
        group.count++;
        stats.totalFiles++;
        const known = entry.sizeKnown === true || (entry.sizeKnown === undefined && asset.sizeKnown === true);
        const bytes = entry.size === undefined ? asset.size : entry.size;
        if (!known || !Number.isSafeInteger(bytes) || bytes < 0) { stats.unknownFiles++; stats.partial = true; continue; }
        stats.totalBytes += bytes;
        group.bytes += bytes;
        if (bytes > LARGE_THRESHOLD_BYTES) largest.push({ uuid: asset.uuid || '', url, name: asset.name || path.basename(source || url), type, size: bytes, ...(source ? { source } : {}) });
    }
    stats.byType = Array.from(types.values()).sort((a, b) => b.bytes - a.bytes || a.type.localeCompare(b.type));
    stats.largestAssets = largest.sort(compareLargest);
    return stats;
}

module.exports = { buildSizeStats, sourceType };
