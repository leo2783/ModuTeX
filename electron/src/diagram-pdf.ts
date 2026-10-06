import { randomUUID } from 'node:crypto';
import { app, BrowserWindow, session, type Session } from 'electron';
import { SVG_BYTE_LIMIT } from './diagram-svg';
import { diagramCpu, type DiagramCpu } from './diagram-cpu';

export type DiagramPdfProducerErrorCode = 'RENDER_ABORTED' | 'RENDER_TIMEOUT' | 'RENDER_FAILED' | 'PDF_TOO_LARGE' | 'CLEANUP_FAILED';
export class DiagramPdfProducerError extends Error {
	constructor(readonly code: DiagramPdfProducerErrorCode) {
		super(code);
		this.name = 'DiagramPdfProducerError';
	}
}
const DEADLINE_MS = 30_000;
const SCHEME = 'diagram-pdf';
// Electron has no Session.destroy(). A retired memory session can still dispatch
// queued native requests: never reopen its network by removing the last guard.
const denyRetiredRequest = (_details: Electron.OnBeforeRequestListenerDetails, callback: (response: Electron.CallbackResponse) => void) =>
	callback({ cancel: true });
const denyPermission = () => false;
const denyPermissionRequest: Parameters<Session['setPermissionRequestHandler']>[0] = (_wc, _permission, callback) => callback(false);

/** Genuine vector printing only. This producer never reads or publishes workspace files. */
export async function renderDiagramSvgToPdf(
	svg: string,
	signal: AbortSignal,
	cpu: DiagramCpu = diagramCpu
): Promise<{ pdf: Uint8Array; widthPx: number; heightPx: number }> {
	if (signal.aborted) throw new DiagramPdfProducerError('RENDER_ABORTED');
	const started = performance.now();
	const validated = await cpu.validate(svg, signal);
	if (signal.aborted) throw new DiagramPdfProducerError('RENDER_ABORTED');
	let win: BrowserWindow | undefined;
	let contents: Electron.WebContents | undefined;
	let ownedSession: Session | undefined;
	let handled = false;
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let rejectStopped!: (error: DiagramPdfProducerError) => void;
	let result: { pdf: Uint8Array; widthPx: number; heightPx: number } | undefined;
	let failure: DiagramPdfProducerError | undefined;
	const interruption = new Promise<never>((_resolve, reject) => {
		rejectStopped = reject;
	});
	const fail = (code: DiagramPdfProducerErrorCode) => {
		if (stopped) return;
		stopped = true;
		rejectStopped(new DiagramPdfProducerError(code));
		if (win && !win.isDestroyed()) win.destroy();
	};
	const abort = () => fail('RENDER_ABORTED');
	const crash = () => fail('RENDER_FAILED');
	const denyNavigation = (event: Electron.Event) => {
		event.preventDefault();
		fail('RENDER_FAILED');
	};
	const denyDownload = (event: Electron.Event) => {
		event.preventDefault();
		fail('RENDER_FAILED');
	};
	signal.addEventListener('abort', abort, { once: true });
	const remaining = DEADLINE_MS - (performance.now() - started);
	timer = setTimeout(() => fail('RENDER_TIMEOUT'), Math.max(0, remaining));
	try {
		const work = async () => {
			await app.whenReady();
			if (stopped || signal.aborted) throw new DiagramPdfProducerError('RENDER_ABORTED');
			if (performance.now() - started >= DEADLINE_MS) throw new DiagramPdfProducerError('RENDER_TIMEOUT');
			const id = randomUUID();
			const url = `${SCHEME}://render/${id}`;
			ownedSession = session.fromPartition(`diagram-pdf-${id}`, { cache: false });
			ownedSession.setPermissionCheckHandler(denyPermission);
			ownedSession.setPermissionRequestHandler(denyPermissionRequest);
			ownedSession.on('will-download', denyDownload);
			win = new BrowserWindow({
				show: false,
				width: 800,
				height: 600,
				webPreferences: {
					session: ownedSession,
					nodeIntegration: false,
					nodeIntegrationInWorker: false,
					nodeIntegrationInSubFrames: false,
					contextIsolation: true,
					sandbox: true,
					javascript: false,
					webviewTag: false,
					plugins: false,
					webSecurity: true,
					allowRunningInsecureContent: false,
					backgroundThrottling: false,
					devTools: false
				}
			});
			contents = win.webContents;
			if (stopped || signal.aborted) throw new DiagramPdfProducerError('RENDER_ABORTED');
			const frame = contents;
			contents.setWindowOpenHandler(() => {
				fail('RENDER_FAILED');
				return { action: 'deny' };
			});
			contents.on('will-navigate', denyNavigation);
			contents.on('will-frame-navigate', denyNavigation);
			contents.on('will-redirect', denyNavigation);
			contents.on('will-attach-webview', denyNavigation);
			contents.on('render-process-gone', crash);
			contents.on('did-fail-load', crash);
			win.on('closed', crash);
			let requestAccepted = false;
			ownedSession.webRequest.onBeforeRequest((details, callback) => {
				const allowed =
					!stopped &&
					!requestAccepted &&
					details.url === url &&
					details.method === 'GET' &&
					details.resourceType === 'mainFrame' &&
					details.webContentsId === frame.id;
				if (allowed) requestAccepted = true;
				callback({ cancel: !allowed });
			});
			const { widthPx, heightPx } = validated;
			const html = `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:${widthPx / 96}in ${heightPx / 96}in;margin:0}html,body{margin:0;padding:0;width:${widthPx}px;height:${heightPx}px}body>svg{display:block;width:${widthPx}px;height:${heightPx}px}</style></head><body>${validated.svg}</body></html>`;
			let served = false;
			ownedSession.protocol.handle(SCHEME, (request) => {
				if (stopped || served || request.url !== url || request.method !== 'GET') return new Response(null, { status: 403 });
				served = true;
				return new Response(html, {
					headers: {
						'Content-Type': 'text/html; charset=utf-8',
						'Content-Security-Policy':
							"default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
						'X-Content-Type-Options': 'nosniff'
					}
				});
			});
			handled = true;
			await win.loadURL(url);
			if (stopped || signal.aborted || !served || win.isDestroyed() || contents.getURL() !== url)
				throw new DiagramPdfProducerError('RENDER_FAILED');
			const pdf = await contents.printToPDF({
				pageSize: { width: widthPx / 96, height: heightPx / 96 },
				preferCSSPageSize: true,
				margins: { top: 0, bottom: 0, left: 0, right: 0 },
				printBackground: true,
				displayHeaderFooter: false,
				scale: 1
			});
			if (stopped || signal.aborted) throw new DiagramPdfProducerError('RENDER_ABORTED');
			if (performance.now() - started >= DEADLINE_MS) throw new DiagramPdfProducerError('RENDER_TIMEOUT');
			if (!pdf.byteLength) throw new DiagramPdfProducerError('RENDER_FAILED');
			if (pdf.byteLength > SVG_BYTE_LIMIT) throw new DiagramPdfProducerError('PDF_TOO_LARGE');
			return { pdf: new Uint8Array(pdf), widthPx, heightPx };
		};
		result = await Promise.race([work(), interruption]);
	} catch (error) {
		failure = error instanceof DiagramPdfProducerError ? error : new DiagramPdfProducerError('RENDER_FAILED');
	} finally {
		stopped = true;
		clearTimeout(timer);
		signal.removeEventListener('abort', abort);
		const cleanupFailures: DiagramPdfProducerError[] = [];
		const cleanup = async (operation: () => void | Promise<void>) => {
			try {
				await operation();
			} catch {
				cleanupFailures.push(new DiagramPdfProducerError('CLEANUP_FAILED'));
			}
		};
		await cleanup(() => {
			win?.removeListener('closed', crash);
			contents?.removeListener('will-navigate', denyNavigation);
			contents?.removeListener('will-frame-navigate', denyNavigation);
			contents?.removeListener('will-redirect', denyNavigation);
			contents?.removeListener('will-attach-webview', denyNavigation);
			contents?.removeListener('render-process-gone', crash);
			contents?.removeListener('did-fail-load', crash);
			if (win && !win.isDestroyed()) win.destroy();
		});
		if (ownedSession) {
			const ses = ownedSession;
			// Replace the render closure with a static tombstone before any asynchronous
			// teardown. Queued and late native requests remain denied after return.
			await cleanup(() => ses.webRequest.onBeforeRequest(denyRetiredRequest));
			await cleanup(() => {
				if (handled) ses.protocol.unhandle(SCHEME);
			});
			await cleanup(() => {
				ses.removeListener('will-download', denyDownload);
			});
			await cleanup(() => ses.closeAllConnections());
		}
		if (cleanupFailures.length) throw new AggregateError(failure ? [failure, ...cleanupFailures] : cleanupFailures, 'CLEANUP_FAILED');
	}
	if (failure) throw failure;
	if (!result) throw new DiagramPdfProducerError('RENDER_FAILED');
	return result;
}
