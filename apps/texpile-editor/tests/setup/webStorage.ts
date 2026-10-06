// Node 26 ships its own experimental `localStorage`/`sessionStorage` globals, and refuses to
// populate them unless the process was started with --localstorage-file. Because the globals
// already EXIST, vitest's jsdom environment skips installing jsdom's own storage over them, and a
// jsdom test sees `undefined` - which is what makes tests that persist workspace state fail on
// Node 26 while passing on the Node 24 that CI and .nvmrc pin.
//
// This puts a working Storage back for the jsdom environment only. It is jsdom's semantics, not a
// stub: same key coercion, same length/key(), same clear-on-nothing behaviour, all in memory and
// per test file.
import { beforeEach } from 'vitest';

class MemoryStorage implements Storage {
	private map = new Map<string, string>();

	get length(): number {
		return this.map.size;
	}
	key(index: number): string | null {
		return [...this.map.keys()][index] ?? null;
	}
	getItem(key: string): string | null {
		return this.map.has(String(key)) ? (this.map.get(String(key)) as string) : null;
	}
	setItem(key: string, value: string): void {
		this.map.set(String(key), String(value));
	}
	removeItem(key: string): void {
		this.map.delete(String(key));
	}
	clear(): void {
		this.map.clear();
	}
}

// `window` exists only under the jsdom environment; the node-environment tests get nothing, which
// is correct - they have no business touching web storage.
if (typeof window !== 'undefined' && typeof globalThis.localStorage === 'undefined') {
	for (const name of ['localStorage', 'sessionStorage'] as const) {
		const storage = new MemoryStorage();
		Object.defineProperty(globalThis, name, { value: storage, configurable: true, writable: true });
		if (globalThis !== (window as unknown as typeof globalThis)) {
			Object.defineProperty(window, name, { value: storage, configurable: true, writable: true });
		}
	}
	// each file gets a clean slate, matching the fresh document jsdom hands every test file
	beforeEach(() => {
		globalThis.localStorage.clear();
		globalThis.sessionStorage.clear();
	});
}
