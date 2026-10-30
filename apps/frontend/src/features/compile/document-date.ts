import { parseSource, type SourceDocument, type SourcePatch } from '../document-core/core.ts';

export type DocumentDateMode = 'none' | 'iso' | 'slash' | 'day-first' | 'document' | 'custom';
// Numeric TeX primitives avoid binding date output to the interface or document language.
export const AUTOMATIC_DATE = '\\number\\year-\\ifnum\\month<10 0\\fi\\number\\month-\\ifnum\\day<10 0\\fi\\number\\day';
const year = '\\number\\year', month = '\\ifnum\\month<10 0\\fi\\number\\month', day = '\\ifnum\\day<10 0\\fi\\number\\day';
export const DATE_VALUES = {none:'', iso:AUTOMATIC_DATE, slash:`${year}/${month}/${day}`, 'day-first':`${day}/${month}/${year}`, document:'\\today'} as const;

export function numericDatePreview(raw: string, now = new Date()): string | null {
	const mode = (['iso','slash','day-first'] as const).find(key => raw === `\\date{${DATE_VALUES[key]}}`);
	if (!mode) return null;
	const y = String(now.getFullYear()), m = String(now.getMonth()+1).padStart(2,'0'), d = String(now.getDate()).padStart(2,'0');
	return mode === 'iso' ? `${y}-${m}-${d}` : mode === 'slash' ? `${y}/${m}/${d}` : `${d}/${m}/${y}`;
}

function dateField(source: SourceDocument) {
	const parsed = parseSource(source);
	const body = parsed.nodes.find(node => node.kind === 'environment' && node.name === 'document');
	if (!body) throw new Error('DATE_UNSUPPORTED');
	const fields = parsed.nodes.filter(node => node.span.to <= body.span.from && node.name === 'date');
	if (fields.length > 1) throw new Error('DATE_UNSUPPORTED');
	const field = fields[0];
	if (field && (!field.content || source.read(field.span.from, field.content.from) !== '\\date{' || source.read(field.content.to, field.span.to) !== '}')) throw new Error('DATE_UNSUPPORTED');
	return {body, field};
}

export function readDocumentDate(source: SourceDocument): {mode: DocumentDateMode; implicit: boolean} {
	const {field} = dateField(source);
	if (!field) return {mode:'document', implicit:true};
	const value = source.read(field.content!.from, field.content!.to);
	const mode = (Object.keys(DATE_VALUES) as (keyof typeof DATE_VALUES)[]).find(key => DATE_VALUES[key] === value) ?? 'custom';
	return {mode, implicit:false};
}

export function planDocumentDatePatches(source: SourceDocument, mode: Exclude<DocumentDateMode, 'custom'>): readonly SourcePatch[] {
	if (!Object.hasOwn(DATE_VALUES,mode)) throw new Error('DATE_UNSUPPORTED');
	const {body, field} = dateField(source);
	const value = DATE_VALUES[mode];
	if (field) {
		const from = field.content!.from, to = field.content!.to, expected = source.read(from,to);
		return expected === value ? [] : [{from,to,expected,insert:value}];
	}
	return [{from:body.span.from,to:body.span.from,expected:'',insert:`\\date{${value}}${source.profile.preferredLineEnding}`}];
}
