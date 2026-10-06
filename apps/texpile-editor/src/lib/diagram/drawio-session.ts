import { validateDrawioMessage, type ValidatedDrawioMessage, DRAWIO_SOURCE_LIMIT } from '../../../../../electron/src/drawio-message-bridge';
import { RELAY_ORIGIN, RELAY_URL, SESSION_DEADLINE, boundedText, record } from '../../../../../electron/src/drawio-message-relay';

export interface DrawioSessionOptions {
	iframe: HTMLIFrameElement;
	hostOrigin: string;
	onMessage: (message: ValidatedDrawioMessage) => void;
}
export function createDrawioSession({ iframe, hostOrigin, onMessage }: DrawioSessionOptions) {
	if (hostOrigin !== `${location.protocol}//${location.host}`) throw new Error('INVALID_HOST_ORIGIN');
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	const nonce = btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
	let stopped = false,
		bootstrap = false,
		initialized = false,
		loads = 0;
	let pending:
		| {
				action: 'load' | 'export';
				format?: 'xml' | 'svg';
				resolve: (value: ValidatedDrawioMessage) => void;
				reject: (error: Error) => void;
				timer: ReturnType<typeof setTimeout>;
		  }
		| undefined;
	let queued: { action: 'load'; xml: string } | undefined;
	const startup = setTimeout(() => dispose(), SESSION_DEADLINE);
	const send = (action: object) => iframe.contentWindow?.postMessage({ ...action, nonce }, RELAY_ORIGIN);
	const dispose = () => {
		if (stopped) return;
		clearTimeout(startup);
		send({ type: 'dispose' });
		stopped = true;
		window.removeEventListener('message', listener);
		window.removeEventListener('pagehide', dispose);
		iframe.removeEventListener('load', navigated);
		if (pending) {
			clearTimeout(pending.timer);
			pending.reject(new Error('SESSION_DISPOSED'));
			pending = undefined;
		}
		queued = undefined;
	};
	const navigated = () => {
		if (++loads > 1) dispose();
	};
	const listener = (event: MessageEvent<unknown>) => {
		if (stopped || event.source !== iframe.contentWindow || event.origin !== RELAY_ORIGIN) return;
		try {
			const r = record(event.data);
			if (!bootstrap && r.type === 'relay-ready' && Object.keys(r).length === 1) {
				bootstrap = true;
				send({ type: 'bootstrap' });
				return;
			}
			if (!bootstrap) return;
			const m = validateDrawioMessage(event.data, nonce);
			if (m.action === 'export' && (typeof m.xml !== 'string' || typeof m.data !== 'string' || (m.format !== 'xml' && m.format !== 'svg')))
				return;
			if (m.action === 'init') {
				if (initialized) return;
				initialized = true;
				clearTimeout(startup);
				if (queued) {
					send(queued);
					queued = undefined;
				}
			}
			if (!initialized) return;
			if (pending && m.action === pending.action && (pending.action === 'load' || m.format === pending.format)) {
				clearTimeout(pending.timer);
				const current = pending;
				pending = undefined;
				current.resolve(m);
			}
			onMessage(m);
		} catch {
			console.warn('[security] dropped Draw.io host message');
		}
	};
	const request = (
		action: { action: 'load'; xml: string } | { action: 'export'; format: 'xml' | 'svg' }
	): Promise<ValidatedDrawioMessage> => {
		if (stopped || pending || (action.action === 'export' && !initialized)) return Promise.reject(new Error('SESSION_NOT_READY'));
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending = undefined;
				reject(new Error('DRAWIO_TIMEOUT'));
				dispose();
			}, SESSION_DEADLINE);
			pending = { action: action.action, ...('format' in action ? { format: action.format } : {}), resolve, reject, timer };
			if (initialized) send(action);
			else if (action.action === 'load') queued = action;
		});
	};
	window.addEventListener('message', listener);
	iframe.addEventListener('load', navigated);
	window.addEventListener('pagehide', dispose, { once: true });
	iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
	iframe.src = RELAY_URL;
	return {
		async load(xml: string): Promise<void> {
			boundedText(xml, DRAWIO_SOURCE_LIMIT);
			await request({ action: 'load', xml });
		},
		async exportXml(): Promise<{ xml: string }> {
			const m = await request({ action: 'export', format: 'xml' });
			return { xml: m.xml! };
		},
		async exportSvg(): Promise<{ xml: string; data: string; format: 'svg' }> {
			const m = await request({ action: 'export', format: 'svg' });
			return { xml: m.xml!, data: m.data!, format: 'svg' };
		},
		dispose
	};
}
