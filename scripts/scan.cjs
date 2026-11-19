'use strict';
const fs = require('fs');
const path = require('path');
const { scanProject } = require('../lib/core');
const { writeReport } = require('../lib/report');
const projectPath = process.argv[2];
if (!projectPath || !fs.existsSync(path.join(projectPath, 'assets'))) {
    console.error('用法：npm run scan -- <Cocos 项目目录> [html|json]'); process.exitCode = 1;
} else scanProject({ projectPath: path.resolve(projectPath) }).then(result => {
    const report = writeReport(path.resolve(__dirname, '..'), result, process.argv[3] || 'html');
    console.log(JSON.stringify(result.summary, null, 2)); console.log(report.message);
}).catch(error => { console.error(error.message); process.exitCode = 1; });
