'use strict';

const path = require('path');
const { resourceCategory } = require('./usage');

function atlasPages(text) {
    const pages = [];
    let start = true;
    for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) { start = true; continue; }
        if (start && !line.includes(':')) pages.push(line);
        start = false;
    }
    return pages;
}

function createAnimationInspector({ sourceByPath, assetsByUuid, dependencies, readText, addReference, incomplete }) {
    const inspectedAtlases = new Set();
    function link(source, name, property) {
        if (typeof name !== 'string' || !name.trim()) return null;
        const target = sourceByPath.get(path.resolve(path.dirname(source.source), name.replace(/\\/g, '/')));
        if (target && !target.missingSource && target.type !== 'folder') {
            addReference(source, target.uuid, property, 'importer-path');
            return target;
        }
        incomplete(source, `无法解析动画依赖路径：${name}`);
        return null;
    }
    async function inspectAtlas(source) {
        if (inspectedAtlases.has(source.uuid)) return;
        inspectedAtlases.add(source.uuid);
        source.usageCategory = 'atlas';
        const text = await readText(source);
        if (text == null) return;
        const pages = atlasPages(text);
        if (!pages.length) incomplete(source, '图集未解析到纹理页，图片依赖待确认。');
        for (let index = 0; index < pages.length; index++) link(source, pages[index], `atlas.pages[${index}]`);
    }
    return async function inspect(source, data) {
        if (data && !Array.isArray(data)) {
            if (Array.isArray(data.bones) && data.skeleton) source.usageCategory = 'spine';
            else if (Array.isArray(data.armature) && data.version) source.usageCategory = 'dragonbones';
            else if (typeof data.imagePath === 'string' && Array.isArray(data.SubTexture)) source.usageCategory = 'atlas';
        }
        const category = resourceCategory(source);
        if (category === 'spine' || category === 'spine-binary') {
            // Prefer explicit importer metadata; otherwise use Creator's sibling
            // atlas naming convention. Never decode binary skeleton contents.
            const explicit = [...(dependencies.get(source.uuid) || [])].map(uuid => assetsByUuid.get(uuid)).filter(asset => asset && /\.(atlas|txt)$/i.test(asset.source || ''));
            const stem = source.source.slice(0, -path.extname(source.source).length);
            const atlas = explicit[0] || sourceByPath.get(`${stem}.atlas`) || sourceByPath.get(`${stem}.txt`);
            if (atlas) {
                addReference(source, atlas.uuid, 'spine.atlas', 'importer-path');
                await inspectAtlas(atlas);
            } else incomplete(source, '未找到 Spine 对应的 .atlas / .txt，图集和贴图依赖待确认。');
        } else if (/\.atlas$/i.test(source.source)) await inspectAtlas(source);
        else if (/\.plist$/i.test(source.source)) {
            const text = await readText(source);
            if (text != null) {
                const match = /<key>\s*(?:realTextureFileName|textureFileName)\s*<\/key>\s*<string>([^<]+)<\/string>/.exec(text);
                if (match) link(source, match[1].replace(/&(?:amp|lt|gt|quot|apos);/g, value => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }[value])), 'atlas.textureFileName');
                else incomplete(source, '未识别到 plist 图集纹理路径，图片依赖待确认。');
            }
        }
        if (data && typeof data.imagePath === 'string' && (category === 'atlas' || Array.isArray(data.SubTexture))) link(source, data.imagePath, 'dragonbones.imagePath');
        // DragonBones' component can reference any atlas explicitly. The common
        // export pair is extra conservative evidence when no component uses it.
        if (category === 'dragonbones' || category === 'dragonbones-binary') {
            const atlas = sourceByPath.get(source.source.replace(/_ske\.(?:json|dbbin)$/i, '_tex.json'));
            if (atlas && atlas !== source) addReference(source, atlas.uuid, 'dragonbones.atlas', 'importer-path');
        }
    };
}

module.exports = { createAnimationInspector, atlasPages };
