'use strict';
exports.load = function () {};
exports.unload = function () {};

function identity(value) {
    if (typeof value !== 'string') return '';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return value.toLowerCase();
    const head = value.length === 22 ? 2 : value.length === 23 ? 5 : 0;
    if (!head || !new RegExp(`^[0-9a-f]{${head}}[A-Za-z0-9+/]+$`, 'i').test(value)) return value;
    const base64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let hex = value.slice(0, head).toLowerCase();
    for (let index = head; index < value.length; index += 2) hex += ((base64.indexOf(value[index]) << 6) | base64.indexOf(value[index + 1])).toString(16).padStart(3, '0');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const stable = segment => !!(segment.fileId || segment.instanceFileId);
function validLocator(locator) {
    return locator && locator.version === 1 && Array.isArray(locator.segments) && locator.segments.length > 0 && locator.segments.length <= 256
        && locator.segments.every(segment => segment && typeof segment === 'object' && typeof segment.name === 'string'
            && ['nodeId', 'fileId', 'instanceFileId', 'assetUuid'].every(key => segment[key] === undefined || typeof segment[key] === 'string'));
}
function prefabMatches(node, segment) {
    const info = node.prefab || node._prefab;
    if (!info) return false;
    if (segment.fileId && info.fileId !== segment.fileId) return false;
    if (segment.instanceFileId && (!info.instance || info.instance.fileId !== segment.instanceFileId)) return false;
    if (segment.assetUuid && identity(info.asset && (info.asset._uuid || info.asset.uuid)) !== identity(segment.assetUuid)) return false;
    return true;
}
function matchSegment(record, segment, sceneRoot) {
    // query-current-scene verifies the source. The editor may regenerate its
    // Scene UUID independently of the UUID serialized in the source file.
    if (segment.kind === 'scene') return record.node === sceneRoot;
    if (segment.nodeId && identity(record.node.uuid) === identity(segment.nodeId)) return true;
    if (stable(segment)) return prefabMatches(record.node, segment);
    if (segment.nodeId) return false;
    return record.node.name === segment.name;
}
function matchesAncestry(record, segments, root) {
    let cursor = record;
    for (let index = segments.length - 1; index >= 0; index--) {
        if (!cursor || !matchSegment(cursor, segments[index], root)) return false;
        cursor = cursor.parent;
    }
    // Prefab isolation can prepend both a Scene and a Canvas wrapper. The
    // source root and all descendants still have to match their own identities.
    return true;
}
function legacyPath(record) {
    const names = [];
    for (let cursor = record; cursor; cursor = cursor.parent) names.push(cursor.node.name);
    return names.reverse();
}
function resolvePrefabTarget(owner, localID) {
    const matches = new Map(), queue = [{ node: owner, namespace: [] }], seen = new Set();
    for (let index = 0; index < queue.length; index++) {
        const { node, namespace } = queue[index];
        if (!node || node.isValid === false || seen.has(node)) continue;
        if (seen.size >= 100000) return [];
        seen.add(node);
        const info = node.prefab || node._prefab;
        const scope = node !== owner && info && info.instance && info.instance.fileId ? [...namespace, info.instance.fileId] : namespace;
        if (scope.length >= localID.length || !scope.every((id, position) => id === localID[position])) continue;
        const targetId = localID[localID.length - 1];
        if (scope.length === localID.length - 1) {
            if (info && info.fileId === targetId) matches.set(node.uuid, node);
            for (const component of node.components || node._components || []) {
                if (component && component.isValid !== false && component.__prefab && component.__prefab.fileId === targetId) {
                    const target = component.node || node;
                    if (target.isValid !== false) matches.set(target.uuid, target);
                }
            }
        }
        for (const child of node.children || []) queue.push({ node: child, namespace: scope });
    }
    return [...matches.values()];
}
exports.methods = {
    async findNode(options) {
        if (!options || typeof options !== 'object' || typeof options.sourceUuid !== 'string' || !options.sourceUuid
            || (options.nodeLocator !== undefined && !validLocator(options.nodeLocator))
            || (options.nodeId !== undefined && typeof options.nodeId !== 'string')
            || (options.prefabTarget !== undefined && (!options.prefabTarget || !Array.isArray(options.prefabTarget.localID)
                || !options.prefabTarget.localID.length || options.prefabTarget.localID.length > 256 || !options.prefabTarget.localID.every(id => typeof id === 'string' && id)))
            || (!options.nodeLocator && !options.nodeId && (typeof options.nodePath !== 'string' || !options.nodePath))) {
            return { message: '节点定位信息无效，请重新扫描项目。' };
        }
        const { director } = require('cc');
        const expectedRoot = director.getScene();
        const current = await Editor.Message.request('scene', 'query-current-scene');
        const root = director.getScene();
        if (!root) return { message: '当前没有打开的场景或 Prefab。' };
        if (root !== expectedRoot) return { message: '定位期间打开的资源发生了切换，请在当前资源中重新点击定位。' };
        const currentUuid = typeof current === 'string' ? current : current && (current.uuid || current.assetUuid);
        if (!currentUuid || identity(currentUuid) !== identity(options.sourceUuid)) {
            return { message: '请先在编辑器打开这条记录所属的场景或 Prefab，再点击定位节点。' };
        }
        const records = [{ node: root, parent: null }], seen = new Set([root]);
        for (let index = 0; index < records.length; index++) {
            for (const child of records[index].node.children || []) {
                if (!child || child.isValid === false || seen.has(child)) continue;
                if (records.length >= 100000) return { message: '当前层级过大，无法完整确认节点身份，请缩小打开的资源范围。' };
                seen.add(child); records.push({ node: child, parent: records[index] });
            }
        }
        const segments = options.nodeLocator && options.nodeLocator.segments;
        const nodeId = options.nodeId || (segments && segments[segments.length - 1].nodeId);
        let matches = nodeId ? records.filter(record => identity(record.node.uuid) === identity(nodeId)) : [];
        if (!matches.length && segments) {
            const leaf = segments[segments.length - 1];
            if (stable(leaf) || leaf.kind === 'scene' || !nodeId) matches = records.filter(record => matchesAncestry(record, segments, root));
        } else if (!matches.length && !nodeId && typeof options.nodePath === 'string') {
            const desired = options.nodePath.replace(/^\//, '');
            matches = records.filter(record => {
                const names = legacyPath(record);
                return names.join('/') === desired || (record.node !== root && names.slice(1).join('/') === desired);
            });
        }
        const unique = [...new Map(matches.filter(record => record.node.isValid !== false).map(record => [record.node.uuid, record.node])).values()];
        if (unique.length !== 1) return { message: unique.length ? '存在多个符合身份的节点，无法唯一定位。请在层级面板中确认实例。' : '未找到与扫描记录身份一致的节点。请确认已打开对应资源，保存后重新扫描。' };
        let selected = unique[0];
        if (options.prefabTarget) {
            const targets = resolvePrefabTarget(selected, options.prefabTarget.localID);
            if (targets.length !== 1) return { message: targets.length ? '实例覆盖的目标存在歧义，无法唯一定位具体节点。' : '实例覆盖的目标节点或组件已不存在，请保存资源后重新扫描。' };
            selected = targets[0];
        }
        const selectedRecord = records.find(record => record.node === selected);
        return { uuid: selected.uuid, nodePath: selectedRecord ? legacyPath(selectedRecord).join('/') : undefined };
    },
};
