'use strict';

const path = require('path');
const { sourceType } = require('./size');

function isAudio(asset) {
    return sourceType(asset.url) === 'audio-clip' || /^(?:audio-clip|cc\.audioclip)$/i.test(asset.type || '');
}

// Name mentions are conservative evidence, not proof that a call executes.
// Resolve exact asset paths first; ambiguous basenames retain every match.
function createAudioInspector(assets, addReference) {
    const aliases = new Map();
    const normalized = value => value.replace(/\\/g, '/').replace(/^db:\/\/assets\//, '').replace(/^\.\//, '').toLowerCase();
    function alias(value, asset) {
        const key = normalized(value);
        if (!key) return;
        if (!aliases.has(key)) aliases.set(key, new Set());
        aliases.get(key).add(asset);
    }
    for (const asset of assets) {
        if (!isAudio(asset) || asset.internal || asset.subAsset || asset.missingSource || asset.type === 'folder') continue;
        const relative = asset.url.replace(/^db:\/\/assets\//, '');
        const ext = path.posix.extname(relative);
        for (const value of [relative, relative.slice(0, -ext.length), path.posix.basename(relative), path.posix.basename(relative, ext)]) alias(value, asset);
        const resources = relative.indexOf('resources/');
        if (resources >= 0) { alias(relative.slice(resources + 10), asset); alias(relative.slice(resources + 10, -ext.length), asset); }
    }
    return function inspect(source, text, property = 'text', location = {}) {
        if (!aliases.size || typeof text !== 'string' || !text) return;
        const matches = new Map();
        function consider(value, offset) {
            const key = normalized(value);
            const targets = aliases.get(key) || aliases.get(path.posix.basename(key));
            for (const target of targets || []) if (target.uuid !== source.uuid && !matches.has(target.uuid)) matches.set(target.uuid, { target, offset });
            if (!targets && /^[\w$\u0080-\uffff]+(?:\.[\w$\u0080-\uffff]+)+$/.test(key)) {
                for (const part of key.split('.')) for (const target of aliases.get(part) || []) {
                    if (target.uuid !== source.uuid && !matches.has(target.uuid)) matches.set(target.uuid, { target, offset });
                }
            }
        }
        consider(text, 0);
        // Quoted strings preserve spaces in names. Tokens also cover unquoted
        // CSV/YAML entries and script identifiers without substring collisions.
        const pattern = /(['"`])([^'"`\r\n]+)\1|[^\s'"`<>{}()[\],;:=!?|&+]+/g;
        let match;
        while ((match = pattern.exec(text))) consider(match[2] || match[0], match.index);
        for (const { target, offset } of matches.values()) addReference(source, target.uuid, `${property}@${offset}`, 'audio-name', location);
    };
}

module.exports = { createAudioInspector, isAudio };
