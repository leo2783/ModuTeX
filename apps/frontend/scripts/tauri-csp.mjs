// SPDX-License-Identifier: Apache-2.0
const browserConnect = "connect-src 'self' ws://127.0.0.1:5174;";
const tauriConnect = "connect-src 'self' ipc: http://ipc.localhost;";
const tauriDevConnect = "connect-src 'self' ipc: http://ipc.localhost ws://127.0.0.1:5174;";
const browserFrame = "frame-src 'none'";
const pdfMagic = Buffer.from([0x25, 0x50, 0x44, 0x46]);
const sniffWindowBytes = 1024;

export function tauriCspPlugin(mode, command = 'build') {
	if (mode !== 'tauri') return [];
	const connect = command === 'serve' ? tauriDevConnect : tauriConnect;
	return [
		{
			name: 'tauri-ipc-csp',
			transformIndexHtml(html) {
				if (html.split(browserConnect).length !== 2) throw new Error('TAURI_CSP_TEMPLATE_CHANGED');
				if (html.split(browserFrame).length !== 2) throw new Error('TAURI_CSP_TEMPLATE_CHANGED');
				return html.replace(browserConnect, connect);
			},
			generateBundle(_options, bundle) {
				for (const [fileName, item] of Object.entries(bundle)) {
					if (!fileName.endsWith('.js') && !fileName.endsWith('.mjs')) continue;
					const content = item.type === 'chunk' ? item.code : item.source;
					const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
					if (bytes.subarray(0, sniffWindowBytes).includes(pdfMagic)) {
						throw new Error(`TAURI_JS_PDF_MIME_HAZARD:${fileName}`);
					}
				}
			}
		}
	];
}
