declare global {
	/** injected by Vite `define` from package.json. */
	const __APP_VERSION__: string;

	/** injected by Vite `define`: every released CHANGELOG.md entry, newest first. */
	const __WHATS_NEW__: { version: string; date?: string; notes: string[] }[];

	namespace App {
		interface DocMeta {
			title: string;
			folderId: string;
			docref: string;
			created: number;
			updated: number;
			contentPreview: string;
			ownerUserId?: string; // optional for back-compat
		}
		interface Folder {
			id: string;
			name: string;
			parent: string;
			children: string[];
		}
	}

	interface TexpileTerminalBridge {
		/** False if node-pty failed to load (needs `npm run electron:rebuild`). */
		available(): Promise<boolean>;
		/** Spawn or reuse a shell for `id` in `cwd`. `shell` is the executable's basename (e.g. "cmd.exe"). */
		spawn(opts: { id: string; cwd?: string; cols?: number; rows?: number }): Promise<{ ok: boolean; shell?: string; error?: string }>;
		/** Send keystrokes / a command (append '\r' to run). */
		write(id: string, data: string): void;
		resize(id: string, cols: number, rows: number): void;
		kill(id: string): void;
		/** Subscribe to output; returns an unsubscribe fn. */
		onData(cb: (msg: { id: string; data: string }) => void): () => void;
		/** Subscribe to shell exit; returns an unsubscribe fn. */
		onExit(cb: (msg: { id: string; code: number }) => void): () => void;
	}

	interface TinymistInfo {
		/** the command that was spawned: an absolute path, or the bare name when found on PATH */
		command: string;
		/** tinymist's own version, e.g. "0.15.2" */
		version: string;
		/** the Typst version its embedded compiler is - what actually builds the PDF */
		typstVersion: string;
		/** which candidate answered; there is no configured path (see typst-service.ts) */
		source: 'path' | 'managed';
	}

	interface ToolProbe {
		id: string;
		found: boolean;
		usable?: boolean;
		/** first informative line of the tool's own version output, when it gave one */
		detail?: string;
		/** the command probed, as spawned (a bare name means it came from PATH) */
		command: string;
	}

	interface TexpileTypstBridge {
		/** Locate tinymist; null when it isn't installed. */
		resolve(): Promise<TinymistInfo | null>;
		/** Probe every external program the app shells out to. */
		probeToolchain(): Promise<ToolProbe[]>;
		/** Fetch tinymist's preview page, theme it, re-serve it from typstpreview://. */
		preparePreview(host: string, background: string, foreground: string): Promise<{ ok: boolean; url?: string; error?: string }>;
		releasePreview(): void;
		/** Spawn `tinymist lsp` for this window, rooted at `root`. */
		startLsp(root: string | null): Promise<{ ok: boolean; info?: TinymistInfo; error?: string }>;
		/** Send one JSON-RPC message; the main process adds the Content-Length framing. */
		send(json: string): void;
		stopLsp(): void;
		/** Subscribe to server->client messages; returns an unsubscribe fn. */
		onMessage(cb: (json: string) => void): () => void;
		/** Subscribe to server exit; returns an unsubscribe fn. */
		onExit(cb: (code: number | null) => void): () => void;
	}

	interface Window {
		texpile: {
			debug: boolean;
		};
		/** DevTools helper for the caret-vanished reports; see lib/debug/focusDoctor.ts. */
		texpileFocusDoctor: () => Record<string, unknown>;
		MathfieldElement: typeof import('mathlive').MathfieldElement;
		mathVirtualKeyboard: import('mathlive').VirtualKeyboardInterface;
		/** Interactive terminal bridge (Electron only; undefined in the browser dev server). */
		texpileTerminal?: TexpileTerminalBridge;
		/** tinymist bridge (Electron only; undefined in the browser dev server). */
		texpileTypst?: TexpileTypstBridge;
	}
}

export {};
