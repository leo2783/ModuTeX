const { parentPort, workerData } = require('node:worker_threads');
if (workerData.input === 'error') throw new Error('owned worker fault');
if (workerData.input === 'exit') process.exit(0);
if (workerData.input === 'bad') parentPort.postMessage({ ok: true, result: { trusted: true } });
else if (workerData.input === 'bad-size') parentPort.postMessage({ ok: true, result: { svg: '<svg/>', widthPx: Infinity, heightPx: 100 } });
else setInterval(() => {}, 1000);
