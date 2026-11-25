'use strict';
const fs = require('fs');
const path = require('path');
const { CAVEAT } = require('./model');
const { USAGE_LABELS, CATEGORY_LABELS } = require('./usage');
const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
function outputDirectory(root) { return path.join(root, 'RIReports'); }
function table(headers, rows) {
    return `<div class="scroll"><table><thead><tr>${headers.map(value => `<th>${escape(value)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(value => `<td>${escape(value)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function formatBytes(value) {
    if (!Number.isFinite(value) || value < 0) return '不可用';
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let size = value, index = 0;
    while (size >= 1024 && index < units.length - 1) { size /= 1024; index++; }
    return `${size.toFixed(index ? 2 : 0)} ${units[index]}`;
}
function sizeSection(stats) {
    if (!stats) return '';
    const percentage = bytes => stats.totalBytes > 0 ? `${(bytes / stats.totalBytes * 100).toFixed(2)}%` : '0.00%';
    return `<h2>资源大小</h2><p>源文件总大小：<strong>${escape(formatBytes(stats.totalBytes))}</strong> · ${escape(stats.totalFiles)} 个源文件 · ${escape(stats.unknownFiles)} 个文件大小未知。</p>
<div class="notice">统计 assets/ 下源资源的磁盘字节，不含 .meta、目录、内置资源及构建产物。子资源不重复计入；构建包体、下载压缩大小和显存占用需要另行分析。${stats.partial ? ' 本次扫描不完整，大小统计可能有遗漏。' : ''}</div>
${table(['类型', '源文件数', '大小', '占比'], (stats.byType || []).map(item => [item.type, item.count, formatBytes(item.bytes), percentage(item.bytes)]))}
<h2>大于 50 KB 的源资源（&gt; 51,200 字节）</h2>
${table(['排名', '资源路径', '类型', '大小'], (stats.largestAssets || []).map((item, index) => [index + 1, item.url, item.type, formatBytes(item.size)]))}`;
}
function usageSection(usage) {
    if (!usage) return '';
    const stats = usage.stats;
    const pending = usage.items.filter(asset => asset.status !== 'referenced');
    return `<h2>未使用资源检测</h2><p>疑似未使用：${escape(stats.unused)} 项 · 已知源文件大小：${escape(formatBytes(stats.unusedBytes))} · 动态加载待确认：${escape(stats.dynamic)} 项 · 扫描不完整待确认：${escape(stats.unknown)} 项 · ${escape(stats.unknownSizeFiles)} 项候选大小未知。</p>
<div class="notice">按图片、音频和动画源文件统计，子资源不重复计入。所有场景、Prefab、脚本及其他类型资源均视为保守入口；从依赖链判断是否使用。音频还匹配脚本和配置中的文件名、去扩展名名称及路径；文本命中仅作为保守引用线索。resources / Bundle 及其依赖单独待确认。${stats.partial ? '扫描不完整，未找到引用的资源暂不列为疑似未使用。' : ''} 没有查到使用链不等于可安全删除。</div>
${table(['资源路径', '类型', '源文件大小', '状态', '判断依据'], pending.slice(0, 10000).map(asset => [asset.url, CATEGORY_LABELS[asset.category] || asset.type, asset.sizeKnown === true ? formatBytes(asset.size) : '不可用', USAGE_LABELS[asset.status], asset.reason]))}`;
}
function htmlReport(result, dirty = false) {
    const issues = result.issues.slice(0, 10000);
    const refs = result.references.slice(0, 10000);
    return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>资源 / Prefab 体检报告</title><style>body{font:14px/1.65 system-ui,sans-serif;background:#171b22;color:#e4e8ee;margin:32px auto;padding:0 24px;max-width:1400px}h1{font-size:26px}h2{margin-top:32px}p,small{color:#aeb9c9}.notice{padding:12px 16px;background:#242c38;border-left:3px solid #6aa8ff}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:13px}th,td{border-bottom:1px solid #354050;padding:9px;text-align:left;vertical-align:top;overflow-wrap:anywhere}th{background:#242c38;white-space:nowrap}code{color:#90bfff}</style>
<h1>资源 / Prefab 体检报告</h1><p>项目：${escape(result.projectPath)}<br>采集：${escape(result.scannedAt)}${dirty ? '<br>导出时资源已发生变化，请重新扫描获得最新结果。' : ''}</p><div class="notice">${escape(CAVEAT)}</div>
<h2>统计</h2>${table(['项目', '数量'], Object.entries(result.summary).map(([key, value]) => [key, value]))}
${sizeSection(result.sizeStats)}
${usageSection(result.usage)}
<h2>覆盖范围与限制</h2><ul>${(result.limitations || []).map(value => `<li>${escape(typeof value === 'string' ? value : JSON.stringify(value))}</li>`).join('')}</ul>
<h2>体检问题（${result.issues.length} 条）</h2>${table(['级别', '问题', '资源', '节点', '组件 / 属性', '目标 UUID'], issues.map(value => [value.severity, `${value.code}: ${value.message}`, value.sourceUrl, value.nodePath, [value.component, value.property].filter(Boolean).join(' / '), value.targetUuid]))}
<h2>静态引用（${result.references.length} 条）</h2>${table(['来源', '节点', '组件 / 属性', '目标', '类型'], refs.map(value => [value.sourceUrl, value.nodePath, [value.component, value.property].filter(Boolean).join(' / '), value.targetUrl || value.targetUuid, value.kind]))}
<p>体检问题、静态引用和未使用资源列表每类最多展示 10,000 条；大于 50 KB 的源资源列表完整展示。JSON 导出包含本次扫描保留的全部结果。</p></html>`;
}
function writeReport(root, result, format, dirty = false) {
    if (format !== 'json' && format !== 'html') throw new Error('仅支持 HTML 或 JSON 格式。');
    const directory = outputDirectory(root);
    // Avoid following a report-directory symlink outside this extension.
    if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw new Error('报告目录不能是符号链接。');
    fs.mkdirSync(directory, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(directory, `resource-inspection-${stamp}-${Math.random().toString(16).slice(2, 8)}.${format}`);
    const content = format === 'json' ? JSON.stringify({ ...result, staleAtExport: dirty }, null, 2) : htmlReport(result, dirty);
    fs.writeFileSync(file, content, { encoding: 'utf8', flag: 'wx' });
    return { path: file, message: `报告已导出：${file}` };
}
module.exports = { outputDirectory, htmlReport, writeReport, formatBytes };
