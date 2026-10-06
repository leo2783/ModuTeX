import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, '../../../..');
const locales = ['en', 'de', 'zh-Hans', 'zh-Hant'] as const;
const keys = ['section_fold', 'section_unfold'] as const;

function messages(locale: (typeof locales)[number]): Record<string, string> {
	return JSON.parse(readFileSync(resolve(app, `messages/${locale}.json`), 'utf8')) as Record<string, string>;
}

describe('section folding labels', () => {
	it.each(locales)('%s provides concise fold and unfold labels', (locale) => {
		const localeMessages = messages(locale);
		for (const key of keys) {
			expect(localeMessages[key]?.trim(), `${locale}:${key}`).toBeTruthy();
			expect(localeMessages[key]).not.toContain('\n');
		}
	});

	it('keeps the two folding keys aligned across every production locale', () => {
		for (const locale of locales) {
			const localeMessages = messages(locale);
			expect(
				keys.filter((key) => !(key in localeMessages)),
				locale
			).toEqual([]);
		}
	});
});
