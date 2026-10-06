// The open file's buffers, and every way they can be edited.
//
// For a .tex file `texSource` is the single source of truth: the whole file, as raw text. The
// visual editor is a VIEW over it - entry parses into `visualDoc` + `docMeta`, every visual edit
// serializes straight back into `texSource`, and source mode binds to it directly. No rival copy
// can drift. Non-.tex text files bypass all that and edit `rawContent` directly.
import { get } from 'svelte/store';
import { isDirty } from '$lib/workspace/workspaceStore';
import { serializeLatexFile, type ParsedLatexFile } from '$lib/workspace/latexRoundtrip';
import { serializeMarkdownFile } from '$lib/markdown/roundtrip';
import { serializeTypstFile } from '$lib/typst/visual/roundtrip';
import { appendPreambleFrontmatter, replacePreambleFrontmatter } from '$lib/editor/extensions/raw-latex/frontmatterView';
import { basename, relativeTo, type Eol } from '$lib/workspace/fileSystem';
import type { Node as PMNode } from 'prosemirror-model';
import { addLatexPackage } from '$lib/workspace/packagePatch';

export type FileKind = 'tex' | 'md' | 'typ' | 'bib' | 'pdf' | 'image' | 'binary' | 'text' | null;
export type DocMeta = Pick<ParsedLatexFile, 'preamble' | 'postamble' | 'hadDocumentEnv'> | null;
export type PackageInsertionChoice = 'add-and-insert' | 'insert-without-package' | 'cancel';

const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|bmp|ico)$/i;
const BINARY_EXT = /\.(pdf|zip|gz|tar|otf|ttf|woff2?|eot|docx?|pptx?|xlsx?|bin)$/i;

export function fileKind(path: string | null): FileKind {
	if (!path) return null;
	if (/\.tex$/i.test(path)) return 'tex';
	if (/\.(md|markdown)$/i.test(path)) return 'md';
	if (/\.typ$/i.test(path)) return 'typ';
	if (/\.bib$/i.test(path)) return 'bib';
	if (/\.pdf$/i.test(path)) return 'pdf';
	if (IMAGE_EXT.test(path)) return 'image';
	if (BINARY_EXT.test(path)) return 'binary';
	return 'text';
}

/** kinds that parse into the visual (ProseMirror) editor and hold their source in texSource. */
export function hasVisualMode(kind: FileKind): kind is 'tex' | 'md' | 'typ' {
	return kind === 'tex' || kind === 'md' || kind === 'typ';
}

/** the dialect the parser / serializer should use for a structured kind. */
export function formatOf(kind: FileKind): 'tex' | 'md' | 'typ' {
	return kind === 'md' ? 'md' : kind === 'typ' ? 'typ' : 'tex';
}

/** kinds edited as raw text in the source editor, with no visual representation. */
export function isRawTextKind(kind: FileKind): kind is 'text' | 'bib' {
	return kind === 'text' || kind === 'bib';
}

/** Only edited/generated tables require dependency repair; opening a file or editing
 * an unrelated paragraph must not rewrite its preamble. Include the legacy serializer
 * fallback, which emits tabularx when no explicit table architecture is present. */
function hasChangedTabularxTable(previous: PMNode | null, next: PMNode): boolean {
	if (!previous || previous === next) return false;
	const previousTables: PMNode[] = [];
	previous.descendants((node) => {
		if (node.type.name !== 'table') return true;
		previousTables.push(node);
		return false;
	});
	const previousTableRefs = new Set(previousTables);
	let changed = false;
	next.descendants((node) => {
		if (changed) return false;
		if (node.type.name !== 'table') return true;
		const needsTabularx = node.attrs.env === 'tabularx' || !node.attrs.env || node.attrs.colspec == null;
		if (needsTabularx && !previousTableRefs.has(node) && !previousTables.some((table) => table.eq(node))) changed = true;
		return false;
	});
	return changed;
}

export interface DocumentBufferDeps {
	/** queue a debounced write of the given content */
	scheduleSave(path: string | null, content: string): void;
	/** drop a queued write (the buffer already matches disk) */
	discardQueuedSave(): void;
	/** write immediately, notifying the user; force bypasses the external-write guard (conflict
	 * modal's "keep mine", where the user has seen disk differs and chosen to overwrite) */
	writeNow(path: string, content: string, force?: boolean): void;
	/** re-parse into the visual doc after a wholesale source replacement */
	rebuildVisual(): void;
	isVisualMode(): boolean;
	/** the user is typing: a pending mode-switch scroll anchor is moot */
	clearPendingAnchor(): void;
}

export class DocumentBuffer {
	path = $state<string | null>(null);
	loadError = $state<string | null>(null);

	/** the whole .tex file, as raw text */
	texSource = $state('');
	/** non-.tex text files edit this directly */
	rawContent = $state('');
	docMeta = $state<DocMeta>(null);
	visualDoc = $state<PMNode | null>(null);
	/** the editor's current body doc; needed to re-serialize when an inline preamble-frontmatter
	 * field rewrites the preamble without touching the body */
	lastDoc = $state<PMNode | null>(null);

	eol = $state<Eol>('\n');
	/** the bytes we believe are on disk, for conflict detection and dirty tracking */
	diskBaseline = $state('');

	kind = $derived(fileKind(this.path));

	constructor(private deps: DocumentBufferDeps) {}

	/** the live buffer for whichever kind is open */
	get buffer(): string {
		return hasVisualMode(this.kind) ? this.texSource : this.rawContent;
	}

	/** serialize the visual doc back to source in the open file's dialect */
	private serializeFile(doc: PMNode): string {
		if (!this.docMeta) return this.texSource;
		if (this.kind === 'md') return serializeMarkdownFile(this.docMeta, doc);
		if (this.kind === 'typ') return serializeTypstFile(this.docMeta, doc);
		return serializeLatexFile(this.docMeta, doc);
	}

	/** display name: root-relative when we have a root, else just the basename */
	nameOf(root: string | null): string {
		if (!this.path) return '';
		return root ? relativeTo(root, this.path) : basename(this.path);
	}

	/** drop the open file's buffers. Per-file state must not leak into the next file. */
	close(): void {
		this.texSource = '';
		this.docMeta = null;
		this.visualDoc = null;
		this.rawContent = '';
		this.path = null;
	}

	/** install a .tex file's text; the visual doc is cleared and re-parsed separately */
	openTex(path: string, text: string, eol: Eol): void {
		this.eol = eol;
		this.texSource = text;
		this.docMeta = null;
		this.visualDoc = null;
		this.lastDoc = null;
		this.path = path;
		this.diskBaseline = text;
	}

	/** install a non-.tex text file (.bib and friends), which has no visual representation */
	openRaw(path: string, text: string, eol: Eol): void {
		this.eol = eol;
		this.rawContent = text;
		this.texSource = '';
		this.docMeta = null;
		this.visualDoc = null;
		this.path = path;
		this.diskBaseline = text;
	}

	/** image / binary / pdf: nothing to load, the viewer just needs the path */
	openOpaque(path: string): void {
		this.close();
		this.path = path;
	}

	/** install a freshly parsed document into the visual pane */
	adoptParsed(parsed: ParsedLatexFile): void {
		this.docMeta = { preamble: parsed.preamble, postamble: parsed.postamble, hadDocumentEnv: parsed.hadDocumentEnv };
		this.visualDoc = parsed.doc;
		this.lastDoc = parsed.doc;
	}

	/** a visual edit serializes straight into texSource, then saves */
	onVisualChange(doc: PMNode): void {
		if (!this.docMeta) return;
		const needsTabularx = this.kind === 'tex' && this.docMeta.hadDocumentEnv && hasChangedTabularxTable(this.lastDoc, doc);
		this.lastDoc = doc;
		this.texSource = this.serializeFile(doc);
		if (needsTabularx) {
			try {
				const patch = addLatexPackage(this.texSource, 'tabularx');
				if (patch.kind === 'insert' && patch.offset <= this.docMeta.preamble.length) {
					this.docMeta = {
						...this.docMeta,
						preamble: this.docMeta.preamble.slice(0, patch.offset) + patch.text + this.docMeta.preamble.slice(patch.offset)
					};
					this.texSource = patch.result;
				}
			} catch {
				// Unknown/indirect preambles stay byte-preserved. Existing compile diagnostics
				// explain the missing package; never guess where to inject executable TeX.
			}
		}
		// nodeviews settling on load (or an edit undone back to the saved bytes) fire a docChanged
		// transaction that serializes right back to disk: that isn't an unsaved change, so don't
		// flag the pristine file dirty or queue a no-op save that would nag on the next switch
		if (this.texSource === this.diskBaseline) {
			if (get(isDirty)) isDirty.set(false);
			this.deps.discardQueuedSave();
			return;
		}
		isDirty.set(true);
		this.deps.scheduleSave(this.path, this.texSource);
		this.deps.clearPendingAnchor();
	}

	/** inline preamble-frontmatter edit (\title/\author/\date): splice the new text into the
	 * preamble verbatim and re-serialize. Anything else in the preamble is Source-view territory. */
	editFrontmatter(kind: string, inner: string): void {
		if (!this.docMeta || !this.lastDoc || this.kind !== 'tex') return; // \title/\author is LaTeX-only
		this.docMeta = { ...this.docMeta, preamble: replacePreambleFrontmatter(this.docMeta.preamble, kind, inner) };
		this.texSource = serializeLatexFile(this.docMeta, this.lastDoc);
		isDirty.set(true);
		this.deps.scheduleSave(this.path, this.texSource);
	}

	/** Add a new simple title/author/date command without rebuilding or normalizing other preamble bytes. */
	addFrontmatter(kind: string, inner: string): boolean {
		if (!this.docMeta || !this.lastDoc || this.kind !== 'tex' || !this.docMeta.hadDocumentEnv) return false;
		const preamble = appendPreambleFrontmatter(this.docMeta.preamble, kind, inner, this.eol);
		if (preamble == null) return false;
		this.docMeta = { ...this.docMeta, preamble };
		this.texSource = serializeLatexFile(this.docMeta, this.lastDoc);
		isDirty.set(true);
		this.deps.scheduleSave(this.path, this.texSource);
		this.deps.clearPendingAnchor();
		return true;
	}

	/** Resolve the missing-package prompt without bypassing the authoritative source buffer. */
	resolvePackageInsertion(packageName: string, choice: PackageInsertionChoice): 'insert' | 'cancel' {
		if (choice === 'cancel') return 'cancel';
		if (choice === 'add-and-insert') this.addPackage(packageName);
		return 'insert';
	}

	/** Patch one declaration into the current preamble and keep its parsed metadata in lockstep. */
	addPackage(packageName: string): void {
		if (this.kind !== 'tex') throw new Error('This file has no editable LaTeX preamble.');
		if (this.docMeta && !this.docMeta.hadDocumentEnv) throw new Error('This file has no editable LaTeX preamble.');
		if (this.docMeta && !this.texSource.startsWith(this.docMeta.preamble)) {
			throw new Error('The LaTeX source changed while its preamble was being edited.');
		}
		const patch = addLatexPackage(this.texSource, packageName);
		if (patch.kind === 'already-present') return;
		if (this.docMeta && patch.offset > this.docMeta.preamble.length) throw new Error('Package insertion escaped the LaTeX preamble.');

		// Source-first documents have not been parsed, so keep the single splice as the authoritative
		// edit rather than parsing/re-serializing unknown macros or body bytes just to add a package.
		if (this.docMeta) {
			this.docMeta = {
				...this.docMeta,
				preamble: this.docMeta.preamble.slice(0, patch.offset) + patch.text + this.docMeta.preamble.slice(patch.offset)
			};
		}
		this.texSource = patch.result;
		isDirty.set(true);
		this.deps.scheduleSave(this.path, patch.result);
		this.deps.clearPendingAnchor();
	}

	/** Apply a verified preamble-only splice without reserializing or changing the document body. */
	applyPreamblePatch(expectedSource: string, originalPreamble: string, nextSource: string, nextPreamble: string): boolean {
		if (this.kind !== 'tex' || this.texSource !== expectedSource || !expectedSource.startsWith(originalPreamble)) return false;
		if (!nextSource.startsWith(nextPreamble)) return false;
		if (expectedSource.slice(originalPreamble.length) !== nextSource.slice(nextPreamble.length)) return false;
		if (this.docMeta && this.docMeta.preamble !== originalPreamble) return false;

		if (this.docMeta) this.docMeta = { ...this.docMeta, preamble: nextPreamble };
		this.texSource = nextSource;
		isDirty.set(true);
		this.deps.scheduleSave(this.path, nextSource);
		this.deps.clearPendingAnchor();
		return true;
	}

	/** a source edit IS texSource, write it verbatim */
	onTexInput(v: string): void {
		this.texSource = v;
		isDirty.set(true);
		this.deps.scheduleSave(this.path, v);
	}

	onRawInput(v: string): void {
		this.rawContent = v;
		isDirty.set(true);
		this.deps.scheduleSave(this.path, v);
	}

	/** replace the whole source (formatter, disk reload, history step) and re-derive the views */
	replaceSource(text: string, opts: { dirty: boolean }): void {
		this.texSource = text;
		if (opts.dirty) {
			isDirty.set(true);
			this.deps.scheduleSave(this.path, text);
		}
		if (this.deps.isVisualMode()) this.deps.rebuildVisual();
	}

	/** manual save (Ctrl/Cmd+S or the Save button); autosave handles the rest.
	 * image / binary kinds have nothing to write. */
	save(force = false): void {
		this.deps.discardQueuedSave(); // drop the queued debounce; we're writing the current content now
		if (!this.path) return;
		if (hasVisualMode(this.kind)) this.deps.writeNow(this.path, this.texSource, force);
		else if (isRawTextKind(this.kind)) this.deps.writeNow(this.path, this.rawContent, force);
	}
}
