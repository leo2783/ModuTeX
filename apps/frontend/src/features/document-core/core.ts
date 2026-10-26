import init, {
	EditorProjection as WasmEditorProjection,
	SourceChange as WasmSourceChange,
	SourceDocument as WasmSourceDocument,
	SynctexIndex,
	mapPositionJson as wasmMapPositionJson,
	parseSource as wasmParseSource,
	parseSourceWithLimits as wasmParseSourceWithLimits,
	pdfWrappedText as wasmPdfWrappedText,
	remapSpanJson as wasmRemapSpanJson
} from './generated/modutex_document_core.js';

await init({ module_or_path: new URL('./generated/modutex_document_core_bg.wasm', import.meta.url) });

export { SynctexIndex };

export type LineEnding = '\n' | '\r\n' | '\r';

export interface SourceProfile {
	readonly encoding: 'utf-8';
	readonly bom: boolean;
	readonly preferredLineEnding: LineEnding;
	readonly originalLineEndings: Readonly<{ lf: number; crlf: number; cr: number }>;
}

export type SourceErrorCode = 'ENCODING' | 'RANGE' | 'VERSION' | 'PATCH' | 'CONTENT' | 'ORIGIN';

export class SourceError extends Error {
	readonly code: SourceErrorCode;

	constructor(code: SourceErrorCode, message: string) {
		super(message);
		this.name = 'SourceError';
		this.code = code;
	}
}

export interface SourcePatch {
	readonly from: number;
	readonly to: number;
	readonly insert: string;
	readonly expected?: string;
}

export interface SourceSpan {
	readonly documentId: string;
	readonly from: number;
	readonly to: number;
	readonly version: number;
}

export interface SourceChange {
	readonly documentId: string;
	readonly beforeVersion: number;
	readonly afterVersion: number;
	readonly oldLength: number;
	readonly newLength: number;
	readonly patches: readonly SourcePatch[];
}

export interface SourceTransaction {
	readonly expectedVersion: number;
	readonly patches: readonly SourcePatch[];
}

export interface SourceUpdate {
	readonly document: SourceDocument;
	readonly change: SourceChange;
}

export type SyntaxKind = 'text' | 'comment' | 'heading' | 'format' | 'math' | 'environment' | 'raw';

export interface SyntaxNode {
	readonly kind: SyntaxKind;
	readonly span: SourceSpan;
	readonly name: string;
	readonly content: SourceSpan | null;
	readonly children: readonly SyntaxNode[];
}

export interface ParseIssue {
	readonly code: 'UNCLOSED' | 'MISMATCH' | 'DEPTH' | 'DYNAMIC_SYNTAX' | 'BUDGET';
	readonly offset: number;
}

export interface SourceProjection {
	readonly documentId: string;
	readonly version: number;
	readonly nodes: readonly SyntaxNode[];
	readonly issues: readonly ParseIssue[];
}

export interface ParseLimits {
	readonly maxNodes: number;
	readonly maxSteps: number;
}

export interface EditorPatch {
	readonly from: number;
	readonly to: number;
	readonly insert: string;
}

const sourceErrorCodes: ReadonlySet<SourceErrorCode> = new Set([
	'ENCODING',
	'RANGE',
	'VERSION',
	'PATCH',
	'CONTENT',
	'ORIGIN'
]);

function normalizeSourceError(error: unknown): never {
	if (typeof error === 'object' && error !== null) {
		const candidate = error as { readonly name?: unknown; readonly code?: unknown; readonly message?: unknown };
		if (candidate.name === 'SourceError' && sourceErrorCodes.has(candidate.code as SourceErrorCode)) {
			throw new SourceError(
				candidate.code as SourceErrorCode,
				typeof candidate.message === 'string' ? candidate.message : ''
			);
		}
	}
	throw error;
}

function wasmCall<T>(operation: () => T): T {
	try {
		return operation();
	} catch (error) {
		return normalizeSourceError(error);
	}
}

function freezeTree<T>(value: T): T {
	if (typeof value === 'object' && value !== null) {
		const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
		for (const child of children) freezeTree(child);
		Object.freeze(value);
	}
	return value;
}

function sourceHandle(document: SourceDocument): WasmSourceDocument {
	return (document as unknown as { readonly wasmHandle: WasmSourceDocument }).wasmHandle;
}

function wrapSourceDocument(handle: WasmSourceDocument, profile?: SourceProfile): SourceDocument {
	try {
		const Constructor = SourceDocument as unknown as new (
			wasmHandle: WasmSourceDocument,
			profile?: SourceProfile
		) => SourceDocument;
		return new Constructor(handle, profile);
	} catch (error) {
		handle.free();
		return normalizeSourceError(error);
	}
}

function parseChange(json: string): SourceChange {
	const value = JSON.parse(json) as {
		documentId: string;
		beforeVersion: number;
		afterVersion: number;
		oldLength: number;
		newLength: number;
		patches: Array<{ from: number; to: number; insert: string; expected?: string | null }>;
	};
	const patches = value.patches.map((patch) => {
		const { expected, ...plain } = patch;
		return expected == null ? plain : { ...plain, expected };
	});
	return freezeTree({ ...value, patches }) as SourceChange;
}

function changeJson(change: SourceChange): string {
	const patches = change.patches.map((patch) => {
		const result: { from: number; to: number; insert: string; expected?: string } = {
			from: patch.from,
			to: patch.to,
			insert: patch.insert
		};
		if (patch.expected !== undefined) result.expected = patch.expected;
		return result;
	});
	return JSON.stringify({
		documentId: change.documentId,
		beforeVersion: change.beforeVersion,
		afterVersion: change.afterVersion,
		oldLength: change.oldLength,
		newLength: change.newLength,
		patches
	});
}

function spanJson(span: SourceSpan): string {
	return JSON.stringify({
		documentId: span.documentId,
		from: span.from,
		to: span.to,
		version: span.version
	});
}

export class SourceDocument {
	readonly documentId: string;
	readonly version: number;
	readonly length: number;
	readonly byteLength: number;
	readonly profile: SourceProfile;
	private readonly wasmHandle: WasmSourceDocument;

	private constructor(wasmHandle: WasmSourceDocument, profile?: SourceProfile) {
		this.wasmHandle = wasmHandle;
		this.documentId = wasmHandle.documentId;
		this.version = wasmHandle.version;
		this.length = wasmHandle.length;
		this.byteLength = wasmHandle.byteLength;
		this.profile = profile ?? freezeTree(JSON.parse(wasmHandle.profileJson()) as SourceProfile);
		Object.freeze(this);
	}

	static open(input: Uint8Array): SourceDocument {
		return wrapSourceDocument(wasmCall(() => WasmSourceDocument.open(input)));
	}

	/** Open a parser snapshot with its supplied identity and version. */
	static openAt(input: Uint8Array, documentId: string, version: number): SourceDocument {
		return wrapSourceDocument(wasmCall(() => WasmSourceDocument.openAt(input, documentId, version)));
	}

	get pieceCount(): number {
		return this.wasmHandle.pieceCount;
	}

	read(from = 0, to = this.length): string {
		return wasmCall(() => this.wasmHandle.read(from, to));
	}

	toBytes(): Uint8Array {
		return wasmCall(() => this.wasmHandle.toBytes());
	}

	apply(transaction: SourceTransaction): SourceUpdate {
		const update = wasmCall(() => this.wasmHandle.apply(JSON.stringify(transaction)));
		let documentHandle: WasmSourceDocument | null = null;
		let changeHandle: WasmSourceChange | null = null;
		try {
			documentHandle = wasmCall(() => update.document);
			changeHandle = wasmCall(() => update.change);
			const change = parseChange(wasmCall(() => changeHandle!.toJson()));
			if (
				change.beforeVersion === this.version &&
				change.afterVersion === this.version &&
				change.patches.length === 0
			) {
				documentHandle.free();
				documentHandle = null;
				return Object.freeze({ document: this, change });
			}
			const ownedHandle = documentHandle;
			documentHandle = null;
			const document = wrapSourceDocument(ownedHandle, this.profile);
			return Object.freeze({ document, change });
		} catch (error) {
			return normalizeSourceError(error);
		} finally {
			documentHandle?.free();
			changeHandle?.free();
			update.free();
		}
	}

	restore(snapshot: SourceDocument, expectedVersion: number): SourceDocument {
		return wrapSourceDocument(
			wasmCall(() => this.wasmHandle.restore(sourceHandle(snapshot), expectedVersion)),
			this.profile
		);
	}

	acceptCurrent<T>(result: { readonly documentId: string; readonly version: number; readonly value: T }): T | null {
		return result.documentId === this.documentId && result.version === this.version ? result.value : null;
	}
}

function wrapEditorProjection(
	handle: WasmEditorProjection,
	document: SourceDocument
): EditorProjection {
	const Constructor = EditorProjection as unknown as new (
		wasmHandle: WasmEditorProjection,
		document: SourceDocument
	) => EditorProjection;
	return new Constructor(handle, document);
}

function wrapEditorResult(handle: WasmEditorProjection, previous: SourceDocument): EditorProjection {
	let documentHandle: WasmSourceDocument | null = null;
	let ownedDocument: SourceDocument | null = null;
	try {
		documentHandle = wasmCall(() => handle.document);
		let document: SourceDocument;
		if (
			documentHandle.documentId === previous.documentId &&
			documentHandle.version === previous.version
		) {
			documentHandle.free();
			documentHandle = null;
			document = previous;
		} else {
			const ownedHandle = documentHandle;
			documentHandle = null;
			document = wrapSourceDocument(ownedHandle, previous.profile);
			ownedDocument = document;
		}
		const result = wrapEditorProjection(handle, document);
		ownedDocument = null;
		return result;
	} catch (error) {
		documentHandle?.free();
		if (ownedDocument) sourceHandle(ownedDocument).free();
		handle.free();
		return normalizeSourceError(error);
	}
}

export class EditorProjection {
	readonly document: SourceDocument;
	readonly length: number;
	readonly editorCorrections: readonly EditorPatch[];
	private readonly wasmHandle: WasmEditorProjection;

	private constructor(wasmHandle: WasmEditorProjection, document: SourceDocument) {
		this.wasmHandle = wasmHandle;
		this.document = document;
		this.length = wasmHandle.length;
		this.editorCorrections = freezeTree(
			JSON.parse(wasmHandle.editorCorrectionsJson()) as EditorPatch[]
		);
		Object.freeze(this);
	}

	static open(document: SourceDocument): { readonly projection: EditorProjection; readonly text: string } {
		const handle = wasmCall(() => WasmEditorProjection.open(sourceHandle(document)));
		try {
			const text = wasmCall(() => handle.text());
			const projection = wrapEditorProjection(handle, document);
			return Object.freeze({ projection, text });
		} catch (error) {
			handle.free();
			return normalizeSourceError(error);
		}
	}

	toSource(position: number): number {
		return wasmCall(() => this.wasmHandle.toSource(position));
	}

	apply(patches: readonly EditorPatch[], expectedVersion: number): EditorProjection {
		const handle = wasmCall(() => this.wasmHandle.apply(JSON.stringify(patches), expectedVersion));
		return wrapEditorResult(handle, this.document);
	}

	restore(snapshot: EditorProjection): EditorProjection {
		const handle = wasmCall(() => this.wasmHandle.restore(snapshot.wasmHandle));
		return wrapEditorResult(handle, this.document);
	}
}

export function mapPosition(
	change: SourceChange,
	position: number,
	bias: 'before' | 'after' = 'after'
): number {
	return wasmCall(() => wasmMapPositionJson(changeJson(change), position, bias));
}

export function remapSpan(change: SourceChange, span: SourceSpan): SourceSpan | null {
	const result = JSON.parse(
		wasmCall(() => wasmRemapSpanJson(changeJson(change), spanJson(span)))
	) as SourceSpan | null;
	return result === null ? null : freezeTree(result);
}

function parseWithHandle(handle: WasmSourceDocument, limits?: ParseLimits): SourceProjection {
	const projection = wasmCall(() =>
		limits === undefined
			? wasmParseSource(handle)
			: wasmParseSourceWithLimits(handle, limits.maxNodes, limits.maxSteps)
	);
	try {
		return reconstructCompactProjection(projection);
	} finally {
		projection.free();
	}
}

export function parseSource(
	document: Pick<SourceDocument, 'read' | 'documentId' | 'version'>,
	limits?: ParseLimits
): SourceProjection {
	if (
		limits !== undefined &&
		![limits.maxNodes, limits.maxSteps].every((value) => Number.isSafeInteger(value) && value > 0)
	) {
		throw new RangeError('Invalid parse budget');
	}
	if (document instanceof SourceDocument) return parseWithHandle(sourceHandle(document), limits);

	const handle = wasmCall(() =>
		WasmSourceDocument.openAt(
			new TextEncoder().encode(document.read()),
			document.documentId,
			document.version
		)
	);
	try {
		return parseWithHandle(handle, limits);
	} finally {
		handle.free();
	}
}

export { projectionIsCurrent } from './projection-state.ts';

const compactSyntaxKinds: readonly SyntaxKind[] = [
	'text',
	'comment',
	'heading',
	'format',
	'math',
	'environment',
	'raw'
];
const compactNodeWordCount = 8;
const compactRootParent = 0xffff_ffff;

interface CompactNodeBuilder {
	readonly index: number;
	readonly node: {
		readonly kind: SyntaxKind;
		readonly span: SourceSpan;
		readonly name: string;
		readonly content: SourceSpan | null;
		readonly children: SyntaxNode[];
	};
}

function invalidCompactProjection(): never {
	throw new TypeError('Invalid document-core compact projection');
}

function finishCompactNode(pending: CompactNodeBuilder): void {
	Object.freeze(pending.node.children);
	Object.freeze(pending.node);
}

function reconstructCompactProjection(projection: {
	readonly documentId: string;
	readonly version: number;
	compactNodes(): Uint32Array;
	compactNamesJson(): string;
	issuesJson(): string;
}): SourceProjection {
	const documentId = projection.documentId;
	const version = projection.version;
	if (typeof documentId !== 'string' || !Number.isSafeInteger(version) || version < 0) {
		return invalidCompactProjection();
	}

	const records = projection.compactNodes();
	if (!(records instanceof Uint32Array) || records.length % compactNodeWordCount !== 0) {
		return invalidCompactProjection();
	}
	const namesPayload: unknown = JSON.parse(projection.compactNamesJson());
	if (!Array.isArray(namesPayload)) return invalidCompactProjection();
	const names = namesPayload as unknown[];
	const issuesPayload: unknown = JSON.parse(projection.issuesJson());
	if (!Array.isArray(issuesPayload)) return invalidCompactProjection();
	const issues = issuesPayload as ParseIssue[];

	const roots: SyntaxNode[] = [];
	const ancestors: CompactNodeBuilder[] = [];
	const nodeCount = records.length / compactNodeWordCount;
	for (let index = 0; index < nodeCount; index++) {
		const offset = index * compactNodeWordCount;
		const kind = compactSyntaxKinds[records[offset]!];
		const from = records[offset + 1]!;
		const to = records[offset + 2]!;
		const hasContent = records[offset + 3]!;
		const contentFrom = records[offset + 4]!;
		const contentTo = records[offset + 5]!;
		const parentIndex = records[offset + 6]!;
		const nameIndex = records[offset + 7]!;
		if (
			kind === undefined ||
			from > to ||
			(hasContent !== 0 && hasContent !== 1) ||
			(hasContent === 0 && (contentFrom !== 0 || contentTo !== 0)) ||
			(hasContent === 1 &&
				(contentFrom < from || contentFrom > contentTo || contentTo > to)) ||
			(parentIndex !== compactRootParent && parentIndex >= index)
		) {
			return invalidCompactProjection();
		}
		const name = names[nameIndex];
		if (typeof name !== 'string') return invalidCompactProjection();

		const span = Object.freeze({ documentId, from, to, version });
		const content =
			hasContent === 1
				? Object.freeze({ documentId, from: contentFrom, to: contentTo, version })
				: null;
		const node: CompactNodeBuilder['node'] = {
			kind,
			span,
			name,
			content,
			children: []
		};

		if (parentIndex === compactRootParent) {
			while (ancestors.length > 0) finishCompactNode(ancestors.pop()!);
			roots.push(node);
		} else {
			let parent: CompactNodeBuilder | undefined;
			while (ancestors.length > 0) {
				const current = ancestors[ancestors.length - 1]!;
				if (current.index === parentIndex) {
					parent = current;
					break;
				}
				finishCompactNode(ancestors.pop()!);
			}
			if (!parent) return invalidCompactProjection();
			parent.node.children.push(node);
		}
		ancestors.push({ index, node });
	}
	while (ancestors.length > 0) finishCompactNode(ancestors.pop()!);

	for (let index = 0; index < issues.length; index++) {
		const issue = issues[index];
		if (typeof issue !== 'object' || issue === null) return invalidCompactProjection();
		Object.freeze(issue);
	}
	Object.freeze(issues);
	Object.freeze(roots);
	return Object.freeze({ documentId, version, nodes: roots, issues });
}

export function pdfWrappedText(bytes: Uint8Array): Uint8Array {
	const output = wasmCall(() => wasmPdfWrappedText(bytes));
	if (output.byteLength === bytes.byteLength) {
		let equal = true;
		for (let index = 0; index < output.byteLength; index++) {
			if (output[index] !== bytes[index]) {
				equal = false;
				break;
			}
		}
		if (equal) return bytes;
	}
	return output;
}
