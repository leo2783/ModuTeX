export const FONT_SIZES = ['tiny', 'scriptsize', 'footnotesize', 'small', 'normalsize', 'large', 'Large', 'LARGE', 'huge', 'Huge'] as const;
export type FontSize = (typeof FONT_SIZES)[number];
export const PARAGRAPH_ALIGNMENTS = ['auto', 'left', 'center', 'right'] as const;
export type ParagraphAlignment = (typeof PARAGRAPH_ALIGNMENTS)[number];
export const ALIGNMENT_DECLARATIONS = { left: 'raggedright', center: 'centering', right: 'raggedleft' } as const;
export const FONT_SIZE_EM: Record<FontSize, number> = {
	tiny: 0.5,
	scriptsize: 0.7,
	footnotesize: 0.8,
	small: 0.9,
	normalsize: 1,
	large: 1.2,
	Large: 1.44,
	LARGE: 1.728,
	huge: 2.074,
	Huge: 2.488
};
export function isFontSize(value: unknown): value is FontSize {
	return typeof value === 'string' && (FONT_SIZES as readonly string[]).includes(value);
}
export function isParagraphAlignment(value: unknown): value is ParagraphAlignment {
	return typeof value === 'string' && (PARAGRAPH_ALIGNMENTS as readonly string[]).includes(value);
}
