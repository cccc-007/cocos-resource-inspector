'use strict';
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const name = 'cocos-resource-inspector';
const source = path.join(root, 'dist', name);
const output = path.join(root, 'release');
const entries = [];
function collect(relative) {
    const full = path.join(source, relative), stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error(`不打包符号链接：${relative}`);
    if (stat.isDirectory()) for (const child of fs.readdirSync(full).sort()) collect(path.join(relative, child));
    else entries.push({ name: Buffer.from(`${name}/${relative.split(path.sep).join('/')}`, 'utf8'), data: fs.readFileSync(full) });
}
collect('');
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) { let value = i; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; crcTable[i] = value >>> 0; }
function crc32(bytes) { let value = 0xffffffff; for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; }
const local = [], central = []; let offset = 0;
for (const entry of entries) {
    const size = entry.data.length, crc = crc32(entry.data), header = Buffer.alloc(30), directory = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(23857, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(size, 18); header.writeUInt32LE(size, 22); header.writeUInt16LE(entry.name.length, 26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt16LE(23857, 14); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(size, 20); directory.writeUInt32LE(size, 24); directory.writeUInt16LE(entry.name.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(header, entry.name, entry.data); central.push(directory, entry.name); offset += header.length + entry.name.length + size;
}
const directory = Buffer.concat(central), end = Buffer.alloc(22);
if (entries.length > 65535 || offset + directory.length > 0xffffffff) throw new Error('归档超出 ZIP32 上限');
end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
if (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink()) throw new Error('发布目录不能是符号链接');
fs.mkdirSync(output, { recursive: true });
const zip = Buffer.concat([...local, directory, end]), target = path.join(output, name + '.zip');
fs.writeFileSync(target, zip);
console.log(`安装包：${target}（${entries.length} 个文件，${zip.length} 字节）`);
