import { describe, expect, it } from 'vitest';
import {
	frontendDevelopment,
	FRONTEND_DEVELOPMENT_URL,
	frontendBuilt,
	FRONTEND_BUILT_URL,
	isAllowedFrontendHash,
	matchesFrontendHostURL,
	isFrontendRendererURL
} from '../src/frontend-development';

describe('original frontend development routing', () => {
	it('requires explicit development selection', () => {
		expect(frontendDevelopment(false, 'frontend')).toBe(true);
		for (const selection of [undefined, '', 'legacy', 'FRONTEND', 'http://example.com']) {
			expect(frontendDevelopment(false, selection)).toBe(false);
		}
	});
	it('cannot change a packaged application through its environment', () => {
		expect(frontendDevelopment(true, 'frontend')).toBe(false);
	});
	it('pins the renderer to its own loopback port', () => {
		expect(new URL(FRONTEND_DEVELOPMENT_URL).origin).toBe('http://127.0.0.1:5174');
	});
});

describe('nonpackaged built frontend routing', () => {
	it('requires explicit built selection', () => {
		expect(frontendBuilt(false, 'frontend-built')).toBe(true);
		for (const selection of [undefined, '', 'legacy', 'frontend', 'FRONTEND-BUILT', 'http://example.com']) {
			expect(frontendBuilt(false, selection)).toBe(false);
		}
	});
	it('cannot change a packaged application through its environment', () => {
		expect(frontendBuilt(true, 'frontend-built')).toBe(false);
	});
	it('pins built URL to app://frontend/index.html with exact structure', () => {
		const parsed = new URL(FRONTEND_BUILT_URL);
		expect(parsed.protocol).toBe('app:');
		expect(parsed.host).toBe('frontend');
		expect(parsed.port).toBe('');
		expect(parsed.pathname).toBe('/index.html');
	});
});

describe('precise frontend route and host matcher', () => {
	it('accepts strictly defined route hashes and rejects unapproved forms', () => {
		for (const valid of [
			'',
			'#',
			'#/',
			'#/workbench',
			'#/workspace',
			'#/settings',
			'#/help',
			'#/help/keyboard-shortcuts',
			'#/help/getting-started',
			'#/release-notes',
			'#/release-notes/limitations'
		]) {
			expect(isAllowedFrontendHash(valid)).toBe(true);
		}
		for (const invalid of [
			'#/unknown',
			'#/workbench/subview',
			'#/workspace/extra',
			'#/settings/profile',
			'#/help/',
			'#/help/UpperCase',
			'#/help/nested/slug',
			'#/release-notes/unknown',
			'#arbitrary'
		]) {
			expect(isAllowedFrontendHash(invalid)).toBe(false);
		}
	});

	it('matches real dev and built host URLs with valid routes only', () => {
		expect(matchesFrontendHostURL('http://127.0.0.1:5174/#/workbench', FRONTEND_DEVELOPMENT_URL)).toBe(true);
		expect(matchesFrontendHostURL('app://frontend/index.html#/workbench', FRONTEND_BUILT_URL)).toBe(true);
		expect(matchesFrontendHostURL('app://frontend/index.html#/settings', FRONTEND_BUILT_URL)).toBe(true);
		expect(matchesFrontendHostURL('app://frontend/index.html#/help/shortcuts', FRONTEND_BUILT_URL)).toBe(true);

		// Rejects credentials, unexpected port, query, foreign host, document mismatch
		expect(matchesFrontendHostURL('http://user:pass@127.0.0.1:5174/#/workbench', FRONTEND_DEVELOPMENT_URL)).toBe(false);
		expect(matchesFrontendHostURL('app://frontend:8080/index.html#/workbench', FRONTEND_BUILT_URL)).toBe(false);
		expect(matchesFrontendHostURL('http://localhost:5174/#/workbench', FRONTEND_DEVELOPMENT_URL)).toBe(false);
		expect(matchesFrontendHostURL('app://bundle/index.html#/workbench', FRONTEND_BUILT_URL)).toBe(false);
		expect(matchesFrontendHostURL('app://frontend/other.html#/workbench', FRONTEND_BUILT_URL)).toBe(false);
		expect(matchesFrontendHostURL('app://frontend/index.html?token=1#/workbench', FRONTEND_BUILT_URL)).toBe(false);
		expect(matchesFrontendHostURL('app://frontend/index.html#/forbidden', FRONTEND_BUILT_URL)).toBe(false);
	});

	it('preload matcher validates both valid dev and built URLs', () => {
		expect(isFrontendRendererURL('http://127.0.0.1:5174/')).toBe(true);
		expect(isFrontendRendererURL('http://127.0.0.1:5174/#/workbench')).toBe(true);
		expect(isFrontendRendererURL('app://frontend/index.html')).toBe(true);
		expect(isFrontendRendererURL('app://frontend/index.html#/workbench')).toBe(true);
		expect(isFrontendRendererURL('app://frontend:5174/index.html')).toBe(false);
		expect(isFrontendRendererURL('app://bundle/index.html')).toBe(false);
	});
});
