/** Serial canvas ownership with a single replaceable pending request. */
export class PdfRenderQueue<T> {
	private pending: { value: T; version: number } | null = null;
	private version = 0;
	private running = false;
	private disposed = false;
	private readonly draw: (value: T, current: () => boolean) => Promise<void>;
	private readonly cancel: () => void;
	private readonly failed: () => void;
	constructor(draw: (value: T, current: () => boolean) => Promise<void>, cancel: () => void, failed: () => void) {
		this.draw = draw; this.cancel = cancel; this.failed = failed;
	}
	request(value: T): void {
		if (this.disposed) return;
		this.pending = { value, version: ++this.version };
		if (this.running) this.cancel();
		else void this.drain();
	}
	private async drain(): Promise<void> {
		this.running = true;
		try {
			while (!this.disposed && this.pending) {
				const item = this.pending; this.pending = null;
				const current = () => !this.disposed && item.version === this.version;
				try { await this.draw(item.value, current); }
				catch { if (current()) this.failed(); }
			}
		} finally { this.running = false; }
	}
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true; ++this.version; this.pending = null; this.cancel();
	}
	pause(): void {
		if (this.disposed) return;
		++this.version; this.pending = null; this.cancel();
	}
}
