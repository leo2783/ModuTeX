import type { PackageInsertionChoice } from '$lib/workspace/documentBuffer.svelte';

export type PackagePromptChoice = PackageInsertionChoice;
export type PromptedLatexPackage = 'graphicx' | 'amsmath' | 'booktabs' | 'arydshln' | 'xcolor' | 'geometry';

export interface PackagePromptRequest {
	id: number;
	packageName: PromptedLatexPackage;
	canAdd: boolean;
}

interface PendingRequest {
	id: number;
	resolve: (choice: PackagePromptChoice) => void;
	removeAbortListener: () => void;
}

/** Owns the one live package decision shown by the workspace-level prompt. */
export class PackagePromptController {
	active = $state<PackagePromptRequest | null>(null);
	private pending: PendingRequest | null = null;
	private nextId = 0;

	ask(packageName: PromptedLatexPackage, canAdd: boolean, signal: AbortSignal): Promise<PackagePromptChoice | null> {
		if (signal.aborted || this.pending) return Promise.resolve(null);

		const id = ++this.nextId;
		return new Promise((resolve) => {
			const cancel = () => this.resolve(id, 'cancel');
			signal.addEventListener('abort', cancel, { once: true });
			this.pending = {
				id,
				resolve,
				removeAbortListener: () => signal.removeEventListener('abort', cancel)
			};
			this.active = { id, packageName, canAdd };
		});
	}

	resolve(id: number, choice: PackagePromptChoice): void {
		const pending = this.pending;
		if (!pending || pending.id !== id) return;
		if (choice === 'add-and-insert' && !this.active?.canAdd) return;

		this.pending = null;
		this.active = null;
		pending.removeAbortListener();
		pending.resolve(choice);
	}

	cancel(): void {
		const pending = this.pending;
		if (pending) this.resolve(pending.id, 'cancel');
	}
}
