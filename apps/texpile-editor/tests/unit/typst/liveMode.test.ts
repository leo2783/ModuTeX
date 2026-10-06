// When the Typst preview should be attached.
//
// This replaced a debounced full rebuild (recompile 700ms after you stopped typing). The preview
// renders the language server's in-memory document instead, so it is both faster and needs no save
// - there is no timer left in this path to test. What is worth pinning down is the ATTACH rule,
// because attaching is the expensive half: an executeCommand to the server, then a ~1.2MB wasm
// renderer that a LaTeX project must never pay for.
import { describe, it, expect } from 'vitest';

/** the guard as implemented in WorkspaceView's attach effect */
function shouldAttach(o: { kind: string; previewOn: boolean; paneOpen: boolean; root: string | null; guest: boolean }): boolean {
	return o.kind === 'typ' && o.previewOn && o.paneOpen && !!o.root && !o.guest;
}

const ON = { kind: 'typ', previewOn: true, paneOpen: true, root: 'C:/p', guest: false };

describe('when the Typst preview attaches', () => {
	it('attaches for a Typst file with the switch on and the pane open', () => {
		expect(shouldAttach(ON)).toBe(true);
	});

	it('does not attach for LaTeX or markdown', () => {
		// the renderer wasm is the cost being avoided here, not the compile
		expect(shouldAttach({ ...ON, kind: 'tex' })).toBe(false);
		expect(shouldAttach({ ...ON, kind: 'md' })).toBe(false);
	});

	it('does not attach when the Preview switch is off', () => {
		expect(shouldAttach({ ...ON, previewOn: false })).toBe(false);
	});

	it('waits for the pane: an invisible preview is all cost and no benefit', () => {
		expect(shouldAttach({ ...ON, paneOpen: false })).toBe(false);
	});

	it('needs a workspace root, since the server is rooted at one', () => {
		expect(shouldAttach({ ...ON, root: null })).toBe(false);
	});

	it('never attaches for a session guest, who has no local toolchain', () => {
		expect(shouldAttach({ ...ON, guest: true })).toBe(false);
	});
});
