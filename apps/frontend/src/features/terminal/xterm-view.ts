// SPDX-License-Identifier: Apache-2.0
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export interface TerminalViewHandlers {
	onInput(data: string): void;
	onResize(cols: number, rows: number): void;
}

export interface TerminalView {
	write(bytes: Uint8Array): Promise<void>;
	fit(): void;
	focus(): void;
	size(): { readonly cols: number; readonly rows: number };
	reset(): void;
	dispose(): void;
}

export function createXtermView(
	host: HTMLElement,
	handlers: TerminalViewHandlers
): TerminalView {
	const rootStyle = window.getComputedStyle(document.documentElement);
	const terminal = new Terminal({
		cursorBlink: true,
		fontFamily: 'Consolas, "Cascadia Mono", monospace',
		fontSize: 13,
		scrollback: 10000,
		theme: {
			background: rootStyle.getPropertyValue('--surface').trim() || '#ffffff',
			foreground: rootStyle.getPropertyValue('--ink').trim() || '#24292e',
			cursor: rootStyle.getPropertyValue('--accent').trim() || '#3d617b',
			selectionBackground: rootStyle.getPropertyValue('--selection').trim() || '#e3ebf1'
		}
	});
	const fitAddon = new FitAddon();
	terminal.loadAddon(fitAddon);
	terminal.open(host);

	let disposed = false;
	const inputSubscription = terminal.onData((data) => handlers.onInput(data));
	const resizeSubscription = terminal.onResize(({ cols, rows }) => {
		handlers.onResize(cols, rows);
	});
	const fit = () => {
		if (disposed) return;
		try {
			fitAddon.fit();
		} catch {
			// A zero-sized or temporarily hidden panel is fitted on the next resize.
		}
	};
	const resizeObserver = typeof ResizeObserver === 'undefined'
		? null
		: new ResizeObserver(fit);
	resizeObserver?.observe(host);
	window.addEventListener('resize', fit);
	fit();

	return {
		write(bytes) {
			return new Promise((resolve) => {
				if (disposed) {
					resolve();
					return;
				}
				terminal.write(bytes, resolve);
			});
		},
		fit,
		focus() {
			if (!disposed) terminal.focus();
		},
		size() {
			return {
				cols: Math.max(1, Math.min(65535, terminal.cols)),
				rows: Math.max(1, Math.min(65535, terminal.rows))
			};
		},
		reset() {
			if (!disposed) terminal.reset();
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			resizeObserver?.disconnect();
			window.removeEventListener('resize', fit);
			inputSubscription.dispose();
			resizeSubscription.dispose();
			terminal.dispose();
		}
	};
}
