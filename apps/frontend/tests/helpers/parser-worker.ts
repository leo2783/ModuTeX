import { parentPort, workerData } from 'node:worker_threads';
import { ParserEngine, type ParserRequest } from '../../src/features/parser/engine.ts';
const engine = new ParserEngine();
let requests = 0;
parentPort!.on('message', (request: ParserRequest) => {
	// Fault injection blocks a real thread after its first genuine engine reply.
	if (workerData?.stallAfterFirstReply && requests++ > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
	parentPort!.postMessage(engine.handle(request));
});
