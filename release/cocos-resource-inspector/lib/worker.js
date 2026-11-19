'use strict';
const { parentPort, workerData } = require('worker_threads');
const { scanProject } = require('./core');
let lastProgress = 0;
scanProject({
    ...workerData,
    onProgress(progress) {
        const now = Date.now();
        if (now - lastProgress >= 120 || (progress.done ?? progress.completed) === progress.total) {
            lastProgress = now;
            parentPort.postMessage({ type: 'progress', progress: { ...progress, done: progress.done ?? progress.completed,
                message: progress.message || progress.current || '正在扫描…' } });
        }
    },
}).then(result => parentPort.postMessage({ type: 'result', result }), error => {
    parentPort.postMessage({ type: 'error', error: error.message || String(error) });
});
