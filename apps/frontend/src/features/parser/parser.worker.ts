import { ParserEngine, type ParserRequest } from './engine.ts';
const engine = new ParserEngine();
self.onmessage = (event: MessageEvent<ParserRequest>) => { self.postMessage(engine.handle(event.data)); };
