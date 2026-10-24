// SPDX-License-Identifier: Apache-2.0
// Strictly typed DTOs and contracts for the native Draft workflow.

import type { CompileIdentity, Diagnostic, WriteReceipt } from '@modutex/frontend-contracts';
import type { SourceDocument } from '../document-core/core.ts';
import type { Language } from '../../i18n/text.ts';

export type DraftMode = 'full' | 'paragraph';

export type DraftStatus = 'success' | 'failure' | 'cancelled' | 'preempted';

export type DraftErrorCode =
	| 'WORKSPACE_DENIED'
	| 'WORKSPACE_BUSY'
	| 'STALE_WORKSPACE'
	| 'ENGINE_UNAVAILABLE'
	| 'INVALID_REQUEST'
	| 'INPUT_TOO_LARGE'
	| 'TIMED_OUT'
	| 'CANCELLED'
	| 'CLEANUP_UNPROVEN'
	| 'RESOURCE_EXHAUSTED'
	| 'IO_FAILED'
	| 'INTERNAL';

export interface DraftError {
	readonly code: DraftErrorCode;
	readonly message: string;
}

export interface DraftCompileRequest {
	readonly workspaceId: string;
	readonly entryPath: string;
	readonly documentId: string;
	readonly documentVersion: number;
	readonly savedRevision: string;
}

export interface DraftSourceRange {
	readonly startByte: number;
	readonly endByte: number;
}

export interface DraftParagraphRequest {
	readonly workspaceId: string;
	readonly entryPath: string;
	readonly documentId: string;
	readonly documentVersion: number;
	readonly savedRevision: string;
	readonly range: DraftSourceRange;
	readonly source: string;
}

export interface DraftWorkspaceRequest {
	readonly workspaceId: string;
}

export interface DraftSavePdfRequest {
	readonly workspaceId: string;
	readonly runId: string;
	readonly path: string;
	readonly expectedRevision: string | null;
}

export interface DraftGeometry {
	readonly paperWidthPt: number;
	readonly paperHeightPt: number;
	readonly columnWidthPt: number;
	readonly footSkipPt: number;
	readonly marginLeftPt: number;
	readonly marginRightPt: number;
	readonly marginTopPt: number;
	readonly marginBottomPt: number;
}

export interface DraftRenderableRecord {
	readonly kind: string;
	readonly xPt: number;
	readonly yPt: number;
	readonly widthPt: number;
	readonly heightPt: number;
	readonly text: string | null;
	readonly fontId: number | null;
}

export interface DraftPageRecord {
	readonly number: number;
	readonly widthPt: number;
	readonly heightPt: number;
	readonly shipoutBaselineHeightPt: number;
	readonly unsupportedContentReasons: readonly string[];
	readonly renderableRecords: readonly DraftRenderableRecord[];
}

export interface DraftReference {
	readonly key: string;
	readonly label: string;
	readonly page: string | null;
}

export interface DraftBibliographyEntry {
	readonly key: string;
	readonly citationLabel: string | null;
	readonly text: string;
}

export interface DraftImageReference {
	readonly path: string;
	readonly page: number | null;
}

export interface DraftDocumentResult {
	readonly identity: CompileIdentity;
	readonly mode: DraftMode;
	readonly status: DraftStatus;
	readonly elapsedMs: number;
	readonly pageCount: number;
	readonly renderableRecordCount: number;
	readonly passCount: number;
	readonly bibliographyPassCount: number;
	readonly geometry: DraftGeometry;
	readonly pages: readonly DraftPageRecord[];
	readonly references: readonly DraftReference[];
	readonly bibliography: readonly DraftBibliographyEntry[];
	readonly images: readonly DraftImageReference[];
	readonly unsupportedContentReasons: readonly string[];
	readonly pdfFallback: boolean;
	readonly diagnostics: readonly Diagnostic[];
	readonly log: string;
	readonly failure: string | null;
	readonly pdfToken?: string;
}

export interface DraftStopReceipt {
	readonly stopped: boolean;
}

export interface DraftTakeoverReceipt {
	readonly preempted: boolean;
}

export interface DraftSavedPdfReceipt {
	readonly write: WriteReceipt;
}

export interface DraftResultWithPdf extends DraftDocumentResult {
	readonly pdfBytes?: Uint8Array;
}

export interface DraftPanelProps {
	document: SourceDocument | null;
	workspaceId: string | null;
	entryPath: string | null;
	revision: string | null;
	dirty?: boolean;
	active?: boolean;
	locale?: Language;
	selection?: { from: number; to: number } | null;
	getSelection?: () => { readonly from: number; readonly to: number } | null;
	onSave?: () => Promise<boolean>;
	onResult?: (result: DraftDocumentResult, pdfBytes?: Uint8Array) => void;
	onError?: (error: DraftError | Error) => void;
}
