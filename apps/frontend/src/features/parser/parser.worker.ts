import type { ParserRequest } from './engine.ts';

const pending: ParserRequest[] = [];
let engine: import('./engine.ts').ParserEngine | undefined;
let initializationFailed = false;

self.onmessage = (event: MessageEvent<ParserRequest>) => {
	const request = event.data;
	if (engine) {
		self.postMessage(engine.handle(request));
	} else if (initializationFailed) {
		self.postMessage({ kind: 'error', seq: request?.seq ?? 0 });
	} else {
		pending.push(request);
	}
};

void import('./engine.ts')
	.then(({ ParserEngine }) => {
		const initialized = new ParserEngine();
		engine = initialized;
		for (const request of pending.splice(0)) self.postMessage(initialized.handle(request));
	})
	.catch(() => {
		initializationFailed = true;
		for (const request of pending.splice(0)) self.postMessage({ kind: 'error', seq: request?.seq ?? 0 });
	});
