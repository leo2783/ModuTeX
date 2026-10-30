// SPDX-License-Identifier: Apache-2.0
// Typed narrow Tauri IPC transport for native Draft commands and PDF retrieval.

import { invoke } from '@tauri-apps/api/core';
import { parseCompileIdentity } from '@modutex/frontend-contracts';
import type {
	DraftCompileRequest,
	DraftDocumentResult,
	DraftError,
	DraftErrorCode,
	DraftParagraphRequest,
	DraftResultWithPdf,
	DraftSavedPdfReceipt,
	DraftSavePdfRequest,
	DraftStopReceipt,
	DraftTakeoverReceipt,
	DraftWorkspaceRequest
} from './types.ts';

const MAX_PDF_BYTES = 32 * 1024 * 1024;

const commands = {
	compile: 'frontend_draft_compile',
	typesetParagraph: 'frontend_draft_typeset_paragraph',
	stop: 'frontend_draft_stop',
	takeover: 'frontend_draft_takeover',
	savePdf: 'frontend_draft_save_pdf',
	takeFilePdf: 'frontend_take_file_pdf'
} as const;

export function normalizeDraftError(error: unknown): DraftError {
	if (typeof error === 'object' && error !== null) {
		const candidate = error as Record<string, unknown>;
		if (typeof candidate.code === 'string' && typeof candidate.message === 'string') {
			return {
				code: candidate.code as DraftErrorCode,
				message: candidate.message
			};
		}
		if (typeof candidate.message === 'string') {
			return {
				code: 'INTERNAL',
				message: candidate.message
			};
		}
	}
	if (typeof error === 'string') {
		return {
			code: 'INTERNAL',
			message: error
		};
	}
	return {
		code: 'INTERNAL',
		message: 'Unknown draft execution failure'
	};
}

function toOwnedPdfBytes(value: unknown): Uint8Array {
	if (typeof value !== 'object' || value === null) {
		throw new Error('Invalid binary PDF response');
	}

	let bytes: Uint8Array;

	if (Array.isArray(value)) {
		const len = value.length;
		if (len > MAX_PDF_BYTES) {
			throw new Error('PDF_TOO_LARGE');
		}
		bytes = new Uint8Array(len);
		for (let i = 0; i < len; i++) {
			const b = value[i];
			if (typeof b !== 'number' || !Number.isInteger(b) || b < 0 || b > 255) {
				throw new Error('Invalid byte in binary PDF response');
			}
			bytes[i] = b;
		}
	} else if (value instanceof Uint8Array) {
		if (value.byteLength > MAX_PDF_BYTES) {
			throw new Error('PDF_TOO_LARGE');
		}
		bytes = new Uint8Array(value.byteLength);
		bytes.set(value);
	} else if (value instanceof ArrayBuffer) {
		if (value.byteLength > MAX_PDF_BYTES) {
			throw new Error('PDF_TOO_LARGE');
		}
		bytes = new Uint8Array(value.byteLength);
		bytes.set(new Uint8Array(value));
	} else if (ArrayBuffer.isView(value)) {
		if (value.byteLength > MAX_PDF_BYTES) {
			throw new Error('PDF_TOO_LARGE');
		}
		bytes = new Uint8Array(value.byteLength);
		bytes.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
	} else {
		throw new Error('Invalid binary PDF response');
	}

	if (bytes.length < 5 || bytes[0] !== 0x25 || bytes[1] !== 0x50 || bytes[2] !== 0x44 || bytes[3] !== 0x46 || bytes[4] !== 0x2d) {
		throw new Error('PDF_HEADER');
	}

	return bytes;
}

export async function takeFilePdf(token: string): Promise<Uint8Array> {
	const raw = await invoke<unknown>(commands.takeFilePdf, { token });
	return toOwnedPdfBytes(raw);
}

export async function compileDraft(request: DraftCompileRequest): Promise<DraftResultWithPdf> {
	try {
		const result = await invoke<DraftDocumentResult>(commands.compile, { request });
		parseCompileIdentity(result.identity, request);
		let pdfBytes: Uint8Array | undefined;
		if (result.pdfToken) {
			pdfBytes = await takeFilePdf(result.pdfToken);
		}
		return { ...result, pdfBytes };
	} catch (error) {
		throw normalizeDraftError(error);
	}
}

export async function typesetParagraph(
	request: DraftParagraphRequest
): Promise<DraftResultWithPdf> {
	try {
		const result = await invoke<DraftDocumentResult>(commands.typesetParagraph, { request });
		parseCompileIdentity(result.identity, request);
		let pdfBytes: Uint8Array | undefined;
		if (result.pdfToken) {
			pdfBytes = await takeFilePdf(result.pdfToken);
		}
		return { ...result, pdfBytes };
	} catch (error) {
		throw normalizeDraftError(error);
	}
}

export async function stopDraft(workspaceId: string): Promise<DraftStopReceipt> {
	try {
		const request: DraftWorkspaceRequest = { workspaceId };
		return await invoke<DraftStopReceipt>(commands.stop, { request });
	} catch (error) {
		throw normalizeDraftError(error);
	}
}

export async function takeoverDraft(workspaceId: string): Promise<DraftTakeoverReceipt> {
	try {
		const request: DraftWorkspaceRequest = { workspaceId };
		return await invoke<DraftTakeoverReceipt>(commands.takeover, { request });
	} catch (error) {
		throw normalizeDraftError(error);
	}
}

export async function saveDraftPdf(request: DraftSavePdfRequest): Promise<DraftSavedPdfReceipt> {
	try {
		return await invoke<DraftSavedPdfReceipt>(commands.savePdf, { request });
	} catch (error) {
		throw normalizeDraftError(error);
	}
}
