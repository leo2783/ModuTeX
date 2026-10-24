// SPDX-License-Identifier: Apache-2.0
export const GIT_TEXT_PREVIEW_LIMIT: number;

export type GitBytesPreview =
	| {
			readonly kind: 'text';
			readonly text: string;
			readonly totalBytes: number;
			readonly displayedBytes: number;
			readonly truncated: boolean;
	  }
	| {
			readonly kind: 'binary';
			readonly totalBytes: number;
			readonly hex: string;
			readonly hexBytes: number;
			readonly truncated: boolean;
	  };

export function previewGitBytes(value: Uint8Array): GitBytesPreview;
