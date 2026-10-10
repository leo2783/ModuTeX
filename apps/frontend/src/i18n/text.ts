export type Language = 'zh-Hant' | 'en';
/** Locale is owned by the document view, not a process-global mutable dictionary. */
export function text(language: Language, traditionalChinese: string, english: string): string {
	return language === 'en' ? english : traditionalChinese;
}
