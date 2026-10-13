/** Development-only loopback selection. Published application routing remains unchanged. */
export function frontendDevelopment(packaged: boolean, selection: string | undefined): boolean {
	return !packaged && selection === 'frontend';
}

/** Nonpackaged built frontend selection. Published application routing remains unchanged. */
export function frontendBuilt(packaged: boolean, selection: string | undefined): boolean {
	return !packaged && selection === 'frontend-built';
}

export const FRONTEND_DEVELOPMENT_URL = 'http://127.0.0.1:5174';
export const FRONTEND_BUILT_URL = 'app://frontend/index.html';

/** Allowed frontend route hash forms: #/, #/workbench, #/workspace, #/settings, #/help (lowercase slug), #/release-notes, #/release-notes/limitations */
export function isAllowedFrontendHash(hash: string): boolean {
	if (!hash || hash === '#' || hash === '#/') return true;
	if (hash === '#/workbench') return true;
	if (hash === '#/workspace') return true;
	if (hash === '#/settings') return true;
	if (hash === '#/release-notes') return true;
	if (hash === '#/release-notes/limitations') return true;
	if (/^#\/help(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)?$/.test(hash)) return true;
	return false;
}

/**
 * Exact host, path, query, credential and route matcher for the original frontend.
 * Pure helper safe for preload sandbox import (no node:fs or node:path).
 */
export function matchesFrontendHostURL(actualUrl: string, expectedUrl: string): boolean {
	if (typeof actualUrl !== 'string' || typeof expectedUrl !== 'string') return false;
	if (actualUrl.length > 8192 || actualUrl.endsWith('#')) return false;
	let actual: URL;
	let expected: URL;
	try {
		actual = new URL(actualUrl);
		expected = new URL(expectedUrl);
	} catch {
		return false;
	}
	if (actual.username || actual.password || expected.username || expected.password) return false;
	if (!['http:', 'app:'].includes(actual.protocol) || actual.protocol !== expected.protocol) return false;
	if (actual.host !== expected.host || actual.port !== expected.port) return false;
	if (actual.pathname !== expected.pathname) return false;
	if (actual.search || expected.search) return false;
	return isAllowedFrontendHash(actual.hash);
}

/** Shared document URL matcher used by sandbox preload. */
export function isFrontendRendererURL(rawUrl: string): boolean {
	return (
		matchesFrontendHostURL(rawUrl, FRONTEND_DEVELOPMENT_URL) ||
		matchesFrontendHostURL(rawUrl, FRONTEND_BUILT_URL)
	);
}
