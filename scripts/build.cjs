'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist', 'cocos-resource-inspector');
const includes = ['main.js', 'scene.js', 'lib', 'panels', 'static', 'README.md', 'LICENSE'];
const files = [];
function collect(relative) {
    const full = path.join(root, relative), stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error(`不打包符号链接：${relative}`);
    if (stat.isDirectory()) for (const child of fs.readdirSync(full).sort()) collect(path.join(relative, child));
    else {
        if (relative.endsWith('.js')) new vm.Script(fs.readFileSync(full, 'utf8'), { filename: relative });
        files.push(relative);
    }
}
includes.forEach(collect);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
delete manifest.scripts; delete manifest.devDependencies;
if (path.resolve(output) !== path.resolve(root, 'dist', manifest.name) || !path.resolve(output).startsWith(root + path.sep)) throw new Error('构建目录校验失败');
for (const target of [path.dirname(output), output]) if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('构建目录不能是符号链接');
if (fs.existsSync(output)) fs.rmSync(output, { recursive: true });
fs.mkdirSync(output, { recursive: true });
for (const relative of files) {
    const target = path.join(output, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, relative), target);
}
fs.writeFileSync(path.join(output, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(`构建完成：${output}（${files.length + 1} 个文件，无运行时依赖）`);
