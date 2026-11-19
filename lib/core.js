'use strict';

// The scanner runs in a worker. It only reads the project's source assets.
// Creator 3.8.3 embeds Node 14.16, before CommonJS supports the node: prefix.
const fs = require('fs').promises;
const path = require('path');
const { buildSizeStats, sourceType } = require('./size');

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SERIALIZED_EXTENSIONS = new Set(['.prefab', '.scene', '.fire', '.mtl', '.material', '.anim', '.animation', '.pmtl', '.physicmaterial', '.render-texture', '.render-pipeline', '.spriteatlas', '.pac', '.terrain', '.json']);
const SCRIPT_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.cjs']);
const DEFAULT_LIMITS = Object.freeze({ maxFileBytes: 16 * 1024 * 1024, maxFiles: 200000, maxAssets: 200000, maxReferences: 150000, maxIssues: 30000, maxObjectVisits: 1000000, maxDepth: 160 });
const YIELD_EVERY = 4000;

function normalizeUuid(value) {
    if (typeof value !== 'string') return '';
    const raw = value.trim();
    const separator = raw.indexOf('@');
    const base = separator < 0 ? raw : raw.slice(0, separator);
    const suffix = separator < 0 ? '' : raw.slice(separator);
    if (UUID_RE.test(base)) return base.toLowerCase() + suffix;
    const header = base.length === 22 ? 2 : base.length === 23 ? 5 : 0;
    if (!header || !new RegExp(`^[0-9a-f]{${header}}[A-Za-z0-9+/]{${base.length - header}}$`, 'i').test(base)) return raw;
    let hex = base.slice(0, header).toLowerCase();
    for (let index = header; index < base.length; index += 2) {
        const pair = (BASE64.indexOf(base[index]) << 6) | BASE64.indexOf(base[index + 1]);
        hex += pair.toString(16).padStart(3, '0');
    }
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}${suffix}`;
}

function isUuid(value) { return UUID_RE.test(normalizeUuid(value).split('@')[0]); }

function scriptUuidFromType(value) {
    if (typeof value !== 'string') return null;
    // Editor component class IDs use 23 characters; runtime asset IDs may use 22.
    const base = value.split('@')[0];
    // Built-in names such as CCPropertyOverrideInfo happen to have 22 base64
    // characters. The compressed UUID header is emitted as lowercase hex.
    if (!UUID_RE.test(base) && !/^(?:[0-9a-f]{2}[A-Za-z0-9+/]{20}|[0-9a-f]{5}[A-Za-z0-9+/]{18})$/.test(base)) return null;
    const normalized = normalizeUuid(base);
    return UUID_RE.test(normalized) ? normalized : null;
}

function slash(value) { return value.replace(/\\/g, '/'); }
function within(root, value) { const relative = path.relative(root, value); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); }
function extension(value) { return path.extname(value).toLowerCase(); }
function fileType(file, importer, directory) {
    if (directory || importer === 'directory') return 'folder';
    const ext = extension(file);
    if (ext === '.prefab' || importer === 'prefab') return 'prefab';
    if (ext === '.scene' || ext === '.fire' || importer === 'scene') return 'scene';
    if (SCRIPT_EXTENSIONS.has(ext) || importer === 'typescript' || importer === 'javascript') return 'script';
    return importer && importer !== '*' ? importer : sourceType(file);
}

function relationLocation(source, extra = {}) {
    return Object.assign({ sourceUuid: source.uuid, sourceUrl: source.url }, extra);
}

async function scanProject(options) {
    if (!options || typeof options.projectPath !== 'string') throw new Error('projectPath 必须是项目目录。');
    const projectPath = path.resolve(options.projectPath);
    const assetsPath = path.join(projectPath, 'assets');
    const rootStat = await fs.stat(assetsPath).catch(() => null);
    if (!rootStat || !rootStat.isDirectory()) throw new Error('该目录下没有 assets 文件夹，请选择 Cocos Creator 项目。');
    const limits = Object.assign({}, DEFAULT_LIMITS, options.limits || {});
    for (const key of Object.keys(limits)) if (!Number.isSafeInteger(limits[key]) || limits[key] < 1) limits[key] = DEFAULT_LIMITS[key];
    const authoritative = Array.isArray(options.assetInfos);
    const result = { version: 1, projectPath, scannedAt: new Date().toISOString(), summary: {}, assets: [], issues: [], references: [], limitations: [] };
    const limitations = new Set();
    const assetsByUuid = new Map();
    const assetsByUrl = new Map();
    const sourceByPath = new Map();
    const metadata = [];
    const entries = [];
    const dependencySets = new Map();
    const editorSubAssets = new Map();
    const issueCounts = { error: 0, warning: 0, info: 0 };
    const metrics = { scannedFiles: 0, skippedFiles: 0, directories: 0, serializedFiles: 0, cancelled: false, partial: false };
    let issueNumber = 0;
    let referenceNumber = 0;
    let referencesTruncated = false;
    let issuesTruncated = false;
    let lastProgress = 0;
    let sizePartial = false;

    function limitation(message, partial = false) {
        if (partial) metrics.partial = true;
        if (limitations.size < 200) limitations.add(message);
        else limitations.add('覆盖限制明细超过 200 条，后续同类详情已省略。');
    }
    function cancelled() { if (typeof options.isCancelled === 'function' && options.isCancelled()) { metrics.cancelled = true; metrics.partial = true; return true; } return false; }
    function progress(phase, completed, total, current = '') {
        const now = Date.now();
        if (typeof options.onProgress === 'function' && (now - lastProgress > 80 || completed === total)) {
            lastProgress = now;
            options.onProgress({ phase, completed, total, current, assets: assetsByUuid.size, references: result.references.length, issues: result.issues.length });
        }
    }
    async function breathe() { await new Promise(resolve => setImmediate(resolve)); }
    function issue(severity, code, message, location = {}) {
        issueCounts[severity]++;
        if (result.issues.length >= limits.maxIssues) {
            if (!issuesTruncated) { issuesTruncated = true; limitation(`问题明细达到 ${limits.maxIssues} 条上限，后续问题仅累计数量。`, true); }
            return;
        }
        result.issues.push(Object.assign({ id: `issue-${++issueNumber}`, severity, code, message }, location));
    }
    async function inspectSize(entry) {
        if (!entry || entry.directory || entry.sizeChecked) return;
        entry.sizeChecked = true;
        try {
            const stat = await fs.stat(entry.file);
            if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0) throw new Error('源文件已不再是普通文件，或大小无效');
            entry.size = stat.size;
            entry.sizeKnown = true;
        } catch (error) {
            entry.size = 0;
            entry.sizeKnown = false;
            sizePartial = true;
            const sourceUrl = `db://assets/${slash(path.relative(assetsPath, entry.file))}`;
            issue('warning', 'SIZE_READ_ERROR', `无法读取源文件大小：${error.message}`, { sourceUrl });
            limitation('部分源文件大小读取失败；总字节数仅包含已知大小，未知大小文件不会按 0 字节计入。', true);
        }
    }
    function addAsset(asset, origin) {
        const uuid = normalizeUuid(asset.uuid);
        if (!uuid) return null;
        asset.uuid = uuid;
        const previous = assetsByUuid.get(uuid);
        if (previous) {
            if (origin === 'disk' && previous._origin === 'disk' && previous.url !== asset.url) {
                issue('error', 'DUPLICATE_UUID', `UUID 与另一个资源重复：${previous.url}`, relationLocation(asset, { targetUuid: uuid }));
                previous.duplicate = true;
                return previous;
            }
            if (origin === 'editor' && previous._origin === 'disk') return previous;
            const merged = Object.assign(previous, asset, { _origin: origin });
            assetsByUrl.set(merged.url, merged);
            return merged;
        }
        if (assetsByUuid.size >= limits.maxAssets) { limitation(`资源达到 ${limits.maxAssets} 项上限，索引不完整。`, true); return null; }
        asset._origin = origin;
        asset.dependencies = [];
        assetsByUuid.set(uuid, asset);
        assetsByUrl.set(asset.url, asset);
        return asset;
    }
    function addReference(source, targetValue, property, kind, location = {}) {
        const targetUuid = normalizeUuid(targetValue);
        if (!targetUuid) return;
        referenceNumber++;
        if (result.references.length >= limits.maxReferences) {
            if (!referencesTruncated) { referencesTruncated = true; limitation(`引用明细达到 ${limits.maxReferences} 条上限，删除影响预览可能不完整。`, true); }
            return;
        }
        let dependencies = dependencySets.get(source.uuid);
        if (!dependencies) { dependencies = new Set(); dependencySets.set(source.uuid, dependencies); }
        dependencies.add(targetUuid);
        const reference = Object.assign({ id: `ref-${referenceNumber}`, sourceUuid: source.uuid, sourceUrl: source.url, targetUuid, property, propertyPath: property, kind }, location);
        const target = assetsByUuid.get(targetUuid);
        if (target) reference.targetUrl = target.url;
        result.references.push(reference);
        if (!target || target.missingSource) {
            const exactKnownParent = targetUuid.includes('@') && assetsByUuid.has(targetUuid.split('@')[0]);
            const definite = authoritative || exactKnownParent || kind === 'script';
            issue(definite ? 'error' : 'warning', kind === 'script' ? 'MISSING_SCRIPT' : definite ? 'MISSING_ASSET' : 'UNRESOLVED_ASSET', kind === 'script' ? `找不到组件脚本：${targetUuid}` : exactKnownParent ? `主资源存在，但找不到指定子资源：${targetUuid}` : definite ? `找不到引用的资源：${targetUuid}` : `磁盘索引未找到资源，需在编辑器中确认是否为内置资源：${targetUuid}`, relationLocation(source, Object.assign({ targetUuid, property, propertyPath: property }, location)));
        }
    }

    // Editor's asset database contains built-in resources which are absent from assets/.
    if (authoritative) {
        const stack = options.assetInfos.slice();
        const seen = new Set();
        while (stack.length) {
            const info = stack.pop();
            if (!info || typeof info !== 'object' || seen.has(info)) continue;
            seen.add(info);
            for (const children of [info.children, info.subAssets]) if (children && typeof children === 'object') stack.push(...Object.values(children));
            if (typeof info.uuid !== 'string') continue;
            const uuid = normalizeUuid(info.uuid);
            const url = typeof info.url === 'string' ? info.url : typeof info.path === 'string' && info.path.startsWith('db://') ? info.path : '';
            if (!url) continue;
            const internal = info.internal === true || !url.startsWith('db://assets/');
            const source = typeof info.file === 'string' ? info.file : typeof info.source === 'string' ? info.source : '';
            addAsset({ uuid, url, name: info.name || path.posix.basename(url), type: fileType(url, info.importer || info.type, info.isDirectory), size: Number(info.size) || 0, source, subAsset: info.isSubAsset === true || uuid.includes('@'), internal, ...(uuid.includes('@') ? { parentUuid: uuid.split('@')[0] } : {}) }, 'editor');
            if (uuid.includes('@') && !internal) {
                const baseUuid = uuid.split('@')[0];
                let siblings = editorSubAssets.get(baseUuid);
                if (!siblings) { siblings = []; editorSubAssets.set(baseUuid, siblings); }
                siblings.push(uuid);
            }
        }
    } else {
        limitation('未取得编辑器完整资源数据库：磁盘外的内置资源无法确认，未知资源引用标为“待确认”。');
    }

    // Collect paths first, so all metadata can be indexed before checking dependencies.
    const directories = [assetsPath];
    while (directories.length && !cancelled()) {
        const directory = directories.pop();
        let children;
        try { children = await fs.readdir(directory, { withFileTypes: true }); }
        catch (error) { sizePartial = true; issue('warning', 'READ_ERROR', `无法读取目录：${error.message}`, { sourceUrl: `db://assets/${slash(path.relative(assetsPath, directory))}` }); limitation('部分目录读取失败。', true); continue; }
        children.sort((a, b) => a.name.localeCompare(b.name));
        for (const child of children) {
            if (child.name.startsWith('.')) continue;
            const fullPath = path.join(directory, child.name);
            if (child.isSymbolicLink()) { sizePartial = true; metrics.skippedFiles++; limitation('跳过符号链接，避免扫描项目目录之外的文件。', true); continue; }
            if (entries.length + metadata.length >= limits.maxFiles) { sizePartial = true; limitation(`文件达到 ${limits.maxFiles} 项上限，未扫描全部资源。`, true); directories.length = 0; break; }
            if (child.isDirectory()) { directories.push(fullPath); entries.push({ file: fullPath, directory: true }); metrics.directories++; }
            else if (child.isFile()) { if (child.name.endsWith('.meta')) metadata.push(fullPath); else entries.push({ file: fullPath, directory: false }); }
        }
        progress('collect', entries.length + metadata.length, 0, slash(path.relative(projectPath, directory)));
    }
    const pathEntries = new Map(entries.map(entry => [entry.file, entry]));
    const metasBySource = new Set();
    for (let index = 0; index < metadata.length && !cancelled(); index++) {
        const metaFile = metadata[index];
        const source = metaFile.slice(0, -5);
        const relative = slash(path.relative(assetsPath, source));
        const url = `db://assets/${relative}`;
        metasBySource.add(source);
        let data;
        try {
            const stat = await fs.stat(metaFile);
            if (stat.size > limits.maxFileBytes) { metrics.skippedFiles++; limitation(`跳过过大的 meta（超过 ${limits.maxFileBytes} 字节）：${url}`, true); continue; }
            data = JSON.parse((await fs.readFile(metaFile, 'utf8')).replace(/^\uFEFF/, ''));
            if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.uuid !== 'string' || !data.uuid) throw new Error('缺少有效 uuid 字段');
        } catch (error) { issue('error', 'INVALID_META', `meta 无法解析：${error.message}`, { sourceUrl: url }); metrics.skippedFiles++; limitation('部分 meta 无法解析，UUID 索引不完整。', true); continue; }
        const entry = pathEntries.get(source);
        await inspectSize(entry);
        const physicalAsset = { uuid: normalizeUuid(data.uuid), url, name: path.basename(source), type: fileType(source, data.importer, !!entry && entry.directory), size: entry && entry.sizeKnown ? entry.size : 0, sizeKnown: !!entry && entry.sizeKnown === true, source, subAsset: false, internal: false, missingSource: !entry };
        if (entry) entry.asset = physicalAsset;
        const root = addAsset(physicalAsset, 'disk');
        if (!root) continue;
        // Disk metadata is authoritative. Remove stale database sub-assets before
        // importing its current subMetas, including children removed since import.
        for (const uuid of editorSubAssets.get(root.uuid) || []) {
            const stale = assetsByUuid.get(uuid);
            if (stale && stale._origin === 'editor') { assetsByUuid.delete(uuid); assetsByUrl.delete(stale.url); }
        }
        sourceByPath.set(source, physicalAsset);
        if (!entry) issue('warning', 'MISSING_SOURCE', '存在 meta，但源资源文件已不存在。', relationLocation(root));
        const metaStack = [{ data, asset: root, property: '', depth: 0 }];
        let subMetaVisits = 0;
        while (metaStack.length) {
            const current = metaStack.pop();
            if (++subMetaVisits > limits.maxObjectVisits || current.depth > limits.maxDepth) { limitation(`meta 子资源数量或深度超过上限：${url}`, true); break; }
            if (current.data.subMetas && typeof current.data.subMetas === 'object') {
                for (const [key, sub] of Object.entries(current.data.subMetas)) {
                    if (!sub || typeof sub !== 'object') continue;
                    const uuid = sub.uuid || `${root.uuid}@${sub.id || key}`;
                    const subAsset = addAsset({ uuid, url: `${url}/${sub.name || sub.displayName || key}`, name: sub.displayName || sub.name || key, type: sub.importer || 'subasset', size: 0, source, parentUuid: root.uuid, subAsset: true, internal: false, missingSource: !entry }, 'disk');
                    if (subAsset) metaStack.push({ data: sub, asset: subAsset, property: `${current.property}subMetas.${key}.`, depth: current.depth + 1 });
                }
            }
        }
        // Retain only the file path; metadata is reread after the UUID index is complete.
        if (index % 100 === 0) await breathe();
        progress('index', index + 1, metadata.length, relative);
    }

    for (const entry of entries) {
        if (cancelled()) break;
        if (!sourceByPath.has(entry.file)) {
            const url = `db://assets/${slash(path.relative(assetsPath, entry.file))}`;
            const known = assetsByUrl.get(url);
            await inspectSize(entry);
            const physicalAsset = { uuid: known ? known.uuid : `path:${slash(path.relative(projectPath, entry.file))}`, url, name: path.basename(entry.file), type: known ? known.type : fileType(entry.file, null, entry.directory), size: entry.sizeKnown ? entry.size : 0, sizeKnown: entry.sizeKnown === true, source: entry.file, subAsset: false, internal: false };
            entry.asset = physicalAsset;
            const asset = addAsset(physicalAsset, 'disk');
            if (asset) sourceByPath.set(entry.file, physicalAsset);
            if (!metasBySource.has(entry.file)) issue('warning', 'MISSING_META', '未找到 meta；资源可能尚未导入，UUID 引用检查不完整。', { sourceUuid: asset ? asset.uuid : '', sourceUrl: url });
        }
    }
    // Do not let stale database rows make deleted source assets look valid.
    for (const asset of assetsByUuid.values()) {
        if (asset._origin === 'editor' && !asset.internal && asset.url.startsWith('db://assets/')) {
            const relative = asset.url.slice('db://assets/'.length);
            const source = path.resolve(assetsPath, ...relative.split('/'));
            if (!asset.subAsset && within(assetsPath, source) && !pathEntries.has(source)) asset.missingSource = true;
        }
    }

    // Metadata dependencies include SpriteFrame -> Texture -> Image and importer references.
    for (let index = 0; index < metadata.length && !cancelled(); index++) {
        const metaFile = metadata[index];
        const root = sourceByPath.get(metaFile.slice(0, -5));
        if (!root) continue;
        let data;
        try { const stat = await fs.stat(metaFile); if (stat.size > limits.maxFileBytes) continue; data = JSON.parse((await fs.readFile(metaFile, 'utf8')).replace(/^\uFEFF/, '')); } catch (_) { continue; }
        const stack = [{ value: data, source: root, property: '', depth: 0 }];
        let visits = 0;
        while (stack.length && !cancelled()) {
            const { value, source, property, depth } = stack.pop();
            if (!value || typeof value !== 'object') continue;
            if (++visits > limits.maxObjectVisits || depth > limits.maxDepth) { limitation(`meta 对象数量或嵌套深度超过上限：${root.url}`, true); break; }
            for (const [key, child] of Object.entries(value)) {
                const propertyPath = property ? `${property}.${key}` : key;
                if (key === 'subMetas' && child && typeof child === 'object') {
                    for (const [subKey, sub] of Object.entries(child)) {
                        if (!sub || typeof sub !== 'object') continue;
                        const subAsset = assetsByUuid.get(normalizeUuid(sub.uuid || `${root.uuid}@${sub.id || subKey}`));
                        stack.push({ value: sub, source: subAsset || source, property: `${propertyPath}.${subKey}`, depth: depth + 1 });
                    }
                } else if (key === 'uuid' && (!property || /(?:^|\.)subMetas\.[^.]+$/.test(property))) { /* metadata identity */ }
                else if (typeof child === 'string' && /uuid/i.test(key) && (isUuid(child) || child.startsWith('db://'))) {
                    const target = child.startsWith('db://') ? assetsByUrl.get(child) : null;
                    if (target || !child.startsWith('db://')) addReference(source, target ? target.uuid : child, propertyPath, 'meta');
                    else issue('warning', 'UNRESOLVED_DATABASE_URI', `资源数据库路径无法解析：${child}`, relationLocation(source, { property: propertyPath }));
                } else if (child && typeof child === 'object') stack.push({ value: child, source, property: propertyPath, depth: depth + 1 });
            }
            if (visits % YIELD_EVERY === 0) await breathe();
        }
        progress('metadata', index + 1, metadata.length, root.url);
    }

    const files = entries.filter(entry => !entry.directory);
    for (let index = 0; index < files.length && !cancelled(); index++) {
        const entry = files[index];
        const source = sourceByPath.get(entry.file);
        if (!source) { metrics.skippedFiles++; continue; }
        metrics.scannedFiles++;
        if (!SERIALIZED_EXTENSIONS.has(extension(entry.file))) continue;
        if (entry.sizeKnown !== true) { metrics.skippedFiles++; continue; }
        if (source.size > limits.maxFileBytes) { metrics.skippedFiles++; limitation(`跳过过大的 JSON（超过 ${limits.maxFileBytes} 字节）：${source.url}`, true); issue('warning', 'SCAN_LIMIT', '文件超过单文件扫描大小上限。', relationLocation(source)); continue; }
        let data;
        try { data = JSON.parse((await fs.readFile(entry.file, 'utf8')).replace(/^\uFEFF/, '')); }
        catch (error) { issue('error', 'INVALID_JSON', `JSON 无法解析：${error.message}`, relationLocation(source)); metrics.skippedFiles++; limitation('部分 JSON 无法解析，这些文件的引用未扫描。', true); continue; }
        metrics.serializedFiles++;
        const isScene = source.type === 'scene';
        const isPrefab = source.type === 'prefab';
        const table = Array.isArray(data) && data.some(value => value && typeof value === 'object' && typeof value.__type__ === 'string') ? data : null;
        if ((isScene || isPrefab) && (!table || !table[0] || table[0].__type__ !== (isScene ? 'cc.SceneAsset' : 'cc.Prefab'))) {
            issue('error', 'INVALID_SERIALIZED_ASSET', isScene ? '场景文件缺少有效的 cc.SceneAsset 序列化对象表。' : 'Prefab 文件缺少有效的 cc.Prefab 序列化对象表。', relationLocation(source));
        }
        const context = table ? buildContext(table, assetsByUuid, source) : null;
        const stack = table ? table.map((value, objectIndex) => ({ value, property: '', objectIndex, depth: 0 })) : [{ value: data, property: '', depth: 0 }];
        let visits = 0;
        while (stack.length && !cancelled()) {
            const current = stack.pop();
            const value = current.value;
            if (!value || typeof value !== 'object') continue;
            if (++visits > limits.maxObjectVisits || current.depth > limits.maxDepth) { limitation(`JSON 对象数量或嵌套深度超过上限：${source.url}`, true); issue('warning', 'SCAN_LIMIT', '对象数量或嵌套深度超过扫描上限。', relationLocation(source)); break; }
            const location = context ? context.location(current.objectIndex) : {};
            const property = current.property || '$';
            if (Object.prototype.hasOwnProperty.call(value, '__uuid__')) {
                if (typeof value.__uuid__ === 'string' && value.__uuid__.trim()) addReference(source, value.__uuid__, property, 'serialized', location);
                else issue('error', 'INVALID_ASSET_REFERENCE', '资源引用 __uuid__ 不是有效的非空字符串。', relationLocation(source, Object.assign({ property }, location)));
            }
            if (table && Object.prototype.hasOwnProperty.call(value, '__id__')) {
                const targetIndex = value.__id__;
                if (!Number.isSafeInteger(targetIndex) || targetIndex < 0 || targetIndex >= table.length || !table[targetIndex] || typeof table[targetIndex] !== 'object') issue('error', 'INVALID_LOCAL_REFERENCE', `对象引用 __id__ 无效：${String(targetIndex)}`, relationLocation(source, Object.assign({ property, objectIndex: current.objectIndex }, location)));
            }
            if (table && typeof value.__type__ === 'string') {
                const scriptUuid = scriptUuidFromType(value.__type__);
                if (scriptUuid) addReference(source, scriptUuid, current.property ? `${current.property}.__type__` : '__type__', 'script', Object.assign({}, location, { component: context.componentName(value.__type__), componentType: context.componentName(value.__type__) }));
            }
            // Serialized button/event handlers identify their callback component
            // separately from the component records themselves.
            if (table && typeof value._componentId === 'string') {
                const scriptUuid = scriptUuidFromType(value._componentId);
                if (scriptUuid) addReference(source, scriptUuid, current.property ? `${current.property}._componentId` : '_componentId', 'script', location);
            }
            for (const [key, child] of Object.entries(value)) if (child && typeof child === 'object') stack.push({ value: child, property: current.property ? Array.isArray(value) ? `${current.property}[${key}]` : `${current.property}.${key}` : key, objectIndex: current.objectIndex, depth: current.depth + 1 });
            if (visits % YIELD_EVERY === 0) await breathe();
        }
        progress('references', index + 1, files.length, source.url);
    }
    if (metrics.cancelled) limitation('扫描已取消，当前结果不完整。', true);
    limitation('仅分析已保存的源资源及 meta；未保存的场景、脚本运行时动态加载、字符串拼接和反射引用不在静态引用图中。');
    limitation('未被引用不等于可删除；resources、Bundle 入口、远程资源和业务配置可能在运行时加载。插件不删除项目资源。');
    limitation('脚本检查验证 UUID 对应文件是否存在，不替代 TypeScript 编译、组件类注册和运行时验证。');
    for (const asset of assetsByUuid.values()) {
        asset.dependencies = Array.from(dependencySets.get(asset.uuid) || []);
        delete asset._origin;
        result.assets.push(asset);
    }
    result.assets.sort((a, b) => a.url.localeCompare(b.url) || a.uuid.localeCompare(b.uuid));
    const projectAssets = result.assets.filter(asset => !asset.internal && !asset.subAsset && asset.type !== 'folder');
    result.sizeStats = buildSizeStats(entries, { partial: sizePartial || metrics.cancelled });
    result.summary = Object.assign({ assets: projectAssets.length, subAssets: result.assets.filter(asset => asset.subAsset && !asset.internal).length, internalAssets: result.assets.filter(asset => asset.internal).length, prefabs: projectAssets.filter(asset => asset.type === 'prefab').length, scenes: projectAssets.filter(asset => asset.type === 'scene').length, scripts: projectAssets.filter(asset => asset.type === 'script').length, references: referenceNumber, errors: issueCounts.error, warnings: issueCounts.warning, infos: issueCounts.info, retainedReferences: result.references.length, retainedIssues: result.issues.length, totalSourceBytes: result.sizeStats.totalBytes, sourceFiles: result.sizeStats.totalFiles, unknownSizeFiles: result.sizeStats.unknownFiles }, metrics);
    result.limitations = Array.from(limitations);
    progress('complete', metrics.scannedFiles, files.length);
    return result;
}

function buildContext(table, assetsByUuid, source) {
    const owner = new Map();
    const componentTypes = new Map();
    const paths = new Map();
    const locators = new Map();
    const queue = [];
    function local(value) { return value && typeof value === 'object' && Number.isInteger(value.__id__) ? value.__id__ : null; }
    function componentName(type) { const uuid = scriptUuidFromType(type); const asset = uuid && assetsByUuid.get(uuid); return asset ? asset.name.replace(/\.[^.]+$/, '') : type || ''; }
    function assign(index, node, component) {
        if (index == null || index < 0 || index >= table.length || owner.has(index)) return;
        owner.set(index, node);
        if (component) componentTypes.set(index, component);
        queue.push(index);
    }
    for (let index = 0; index < table.length; index++) {
        const value = table[index];
        if (value && (value.__type__ === 'cc.Node' || value.__type__ === 'cc.Scene')) assign(index, index);
    }
    for (let index = 0; index < table.length; index++) {
        const value = table[index];
        if (!value || typeof value !== 'object') continue;
        const node = local(value.node);
        if (node != null && owner.has(node)) assign(index, node, componentName(value.__type__));
    }
    // Metadata objects belong to their referring node/component, rather than PrefabInfo.root.
    const skip = new Set(['_children', '_components', '_parent', 'node', 'root', 'prefabRootNode']);
    for (let cursor = 0; cursor < queue.length; cursor++) {
        const index = queue[cursor];
        const stack = [table[index]];
        while (stack.length) {
            const value = stack.pop();
            if (!value || typeof value !== 'object') continue;
            for (const [key, child] of Object.entries(value)) {
                if (skip.has(key) || !child || typeof child !== 'object') continue;
                const target = local(child);
                if (target != null) assign(target, owner.get(index), componentTypes.get(index));
                else stack.push(child);
            }
        }
    }
    function nodeName(index) {
        const node = table[index];
        if (typeof node._name === 'string' && node._name) return node._name;
        const infoIndex = local(node._prefab);
        const info = infoIndex == null ? null : table[infoIndex];
        const instanceIndex = info && local(info.instance);
        const instance = instanceIndex == null ? null : table[instanceIndex];
        if (instance && Array.isArray(instance.propertyOverrides)) {
            for (const reference of instance.propertyOverrides) {
                const overrideIndex = local(reference);
                const override = overrideIndex == null ? null : table[overrideIndex];
                const targetIndex = override && local(override.targetInfo);
                const target = targetIndex == null ? override && override.targetInfo : table[targetIndex];
                const ownTarget = target && Array.isArray(target.localID) && target.localID.length === 1 && info && target.localID[0] === info.fileId;
                if (ownTarget && Array.isArray(override.propertyPath) && override.propertyPath.length === 1 && override.propertyPath[0] === '_name' && typeof override.value === 'string') return override.value;
            }
        }
        const asset = info && info.asset && typeof info.asset.__uuid__ === 'string' && assetsByUuid.get(normalizeUuid(info.asset.__uuid__));
        return asset ? asset.name.replace(/\.[^.]+$/, '') : `(未命名节点#${index})`;
    }
    function nodePath(index) {
        if (paths.has(index)) return paths.get(index);
        const segments = [];
        const seen = new Set();
        let cursor = index;
        while (cursor != null && table[cursor] && !seen.has(cursor) && segments.length < 256) {
            seen.add(cursor);
            const value = table[cursor];
            if (value.__type__ !== 'cc.Node' && value.__type__ !== 'cc.Scene') break;
            segments.push(nodeName(cursor));
            cursor = local(value._parent);
        }
        const result = segments.reverse().join('/');
        paths.set(index, result);
        return result;
    }
    function nodeLocator(index) {
        if (locators.has(index)) return locators.get(index);
        const segments = [], seen = new Set();
        let cursor = index;
        while (cursor != null && table[cursor] && !seen.has(cursor) && segments.length < 256) {
            seen.add(cursor);
            const value = table[cursor];
            if (value.__type__ !== 'cc.Node' && value.__type__ !== 'cc.Scene') break;
            const segment = { name: nodeName(cursor), kind: value.__type__ === 'cc.Scene' ? 'scene' : 'node' };
            if (typeof value._id === 'string' && value._id) segment.nodeId = value._id;
            const infoIndex = local(value._prefab), info = infoIndex == null ? null : table[infoIndex];
            if (info && value.__type__ !== 'cc.Scene') {
                if (typeof info.fileId === 'string' && info.fileId) segment.fileId = info.fileId;
                const instanceIndex = local(info.instance), instance = instanceIndex == null ? null : table[instanceIndex];
                if (instance && typeof instance.fileId === 'string' && instance.fileId) segment.instanceFileId = instance.fileId;
                if (info.asset && typeof info.asset.__uuid__ === 'string') segment.assetUuid = normalizeUuid(info.asset.__uuid__);
                else if (local(info.asset) === 0 && table[0] && table[0].__type__ === 'cc.Prefab') segment.assetUuid = source.uuid;
            }
            segments.push(segment);
            cursor = local(value._parent);
        }
        const locator = { version: 1, segments: segments.reverse() };
        locators.set(index, locator);
        return locator;
    }
    return {
        componentName,
        location(index) {
            const nodeIndex = owner.get(index);
            const value = table[index];
            const result = { objectIndex: index };
            if (nodeIndex != null && table[nodeIndex]) {
                result.nodePath = nodePath(nodeIndex);
                result.nodeIndex = nodeIndex;
                result.nodeLocator = nodeLocator(nodeIndex);
                if (typeof table[nodeIndex]._id === 'string' && table[nodeIndex]._id) result.nodeId = table[nodeIndex]._id;
            }
            const component = componentTypes.get(index) || (value && local(value.node) != null ? componentName(value.__type__) : '');
            if (component) { result.component = component; result.componentType = component; }
            if (value && (value.__type__ === 'CCPropertyOverrideInfo' || value.__type__ === 'cc.PropertyOverrideInfo')) {
                const targetIndex = local(value.targetInfo);
                const target = targetIndex == null ? value.targetInfo : table[targetIndex];
                if (target && Array.isArray(target.localID)) result.prefabTarget = { localID: target.localID.slice() };
            }
            return result;
        }
    };
}

module.exports = { scanProject, normalizeUuid, scriptUuidFromType, DEFAULT_LIMITS };
