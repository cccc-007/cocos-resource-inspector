'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const executable = process.argv[2];
if (!executable || !fs.existsSync(executable)) {
    console.error('用法：npm run check:editor -- <CocosCreator.exe 路径>');
    process.exitCode = 1;
} else {
    const result = spawnSync(path.resolve(executable), [path.join(__dirname, 'editor-smoke.cjs'), path.resolve(__dirname, '../dist/cocos-resource-inspector')], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) { console.error(result.error.message); process.exitCode = 1; }
    else if (result.status !== 0 || !String(result.stdout).includes('EDITOR_RUNTIME_SMOKE_OK')) process.exitCode = result.status || 1;
}
