import { env } from '$env/dynamic/public';
import { LOCALE_META } from '$lib/localeMeta';

export const PROJECT_REPOSITORY_URL = 'https://github.com/leo2783/latex';
export const PROJECT_ISSUES_URL = `${PROJECT_REPOSITORY_URL}/issues`;

export type SiteLocale = keyof typeof LOCALE_META;

export interface SiteLanguageAlternate {
	hreflang: SiteLocale | 'x-default';
	href: string;
}

/**
 * The static landing site must receive its official root https origin at build time as
 * PUBLIC_MODUTEX_SITE_ORIGIN. Leaving that variable unset intentionally disables external site URLs.
 */
export const SITE_ORIGIN = normalizeSiteOrigin(env.PUBLIC_MODUTEX_SITE_ORIGIN);

export function normalizeSiteOrigin(value: string | undefined): string | undefined {
	const candidate = value?.trim();
	if (!candidate) return undefined;

	let origin: URL;
	try {
		origin = new URL(candidate);
	} catch (cause) {
		throw new Error('PUBLIC_MODUTEX_SITE_ORIGIN must be an https origin without a path, query, or fragment.', { cause });
	}

	if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
		throw new Error('PUBLIC_MODUTEX_SITE_ORIGIN must be an https origin without a path, query, or fragment.');
	}

	return origin.origin;
}

export function localizedSitePath(path: string, locale: SiteLocale): string {
	if (!path.startsWith('/') || path.startsWith('//') || path.includes('?') || path.includes('#')) {
		throw new Error('Site paths must be root-relative paths without a query or fragment.');
	}

	const normalizedPath = path;
	if (locale === 'en') return normalizedPath;
	return `/${locale}${normalizedPath === '/' ? '/' : normalizedPath}`;
}

export function getSiteUrl(path: string, locale: SiteLocale = 'en'): string | undefined {
	if (!SITE_ORIGIN) return undefined;
	return new URL(localizedSitePath(path, locale), `${SITE_ORIGIN}/`).href;
}

export function getSiteLanguageAlternates(path: string): SiteLanguageAlternate[] {
	if (!SITE_ORIGIN) return [];

	const alternates: SiteLanguageAlternate[] = (Object.keys(LOCALE_META) as SiteLocale[]).flatMap((locale) => {
		const href = getSiteUrl(path, locale);
		return href ? [{ hreflang: locale, href }] : [];
	});
	const defaultHref = getSiteUrl(path, 'en');
	if (defaultHref) alternates.push({ hreflang: 'x-default', href: defaultHref });
	return alternates;
}
