// Preparing tinymist's preview page for our frame. Every failure here is a blank preview pane with
// no error, which is why the module throws rather than returning something almost-right.
import { describe, it, expect } from 'vitest';
import { preparePreviewPage, PreviewPageError } from '../../../../../electron/src/typst-preview-page';

const OPTS = { dataPlaneHost: '127.0.0.1:52145', background: '#131316', foreground: '#e4e4e7' };

/** the shape the static server serves: the socket address is derived from the page's own URL */
const SERVED = `<html><body><script>
function retrieveWsArgs() {
  let urlObject = new URL("/", window.location.href);
  urlObject.protocol = urlObject.protocol.replace("https:", "wss:").replace("http:", "ws:");
  return { url: urlObject.href };
}
</script></body></html>`;

/** the shape embedded in the binary: a literal placeholder the VS Code extension substitutes */
const RAW = `<html><body><script>const u = "ws://127.0.0.1:23625";</script></body></html>`;

describe('pinning the websocket address', () => {
	it('replaces the derived URL, so the socket does not follow our own scheme', () => {
		// served from typstpreview://, `new URL("/", location.href)` yields no ws: at all and the
		// viewer would sit forever with nothing to render
		const out = preparePreviewPage(SERVED, OPTS);
		expect(out).not.toContain('window.location.href');
		expect(out).toContain('new URL("http://127.0.0.1:52145/")');
	});

	it('substitutes the placeholder form when the page came from the binary', () => {
		const out = preparePreviewPage(RAW, OPTS);
		expect(out).toContain('ws://127.0.0.1:52145');
		expect(out).not.toContain('23625');
	});

	it('throws when neither form is present rather than serving a page that cannot connect', () => {
		expect(() => preparePreviewPage('<html><body>nothing</body></html>', OPTS)).toThrow(PreviewPageError);
	});

	it('rejects a malformed data plane host', () => {
		expect(() => preparePreviewPage(SERVED, { ...OPTS, dataPlaneHost: 'evil.example.com' })).toThrow(PreviewPageError);
		expect(() => preparePreviewPage(SERVED, { ...OPTS, dataPlaneHost: '127.0.0.1' })).toThrow(PreviewPageError);
	});
});

describe('the injected payload', () => {
	it('sets the theme variables the page already consumes', () => {
		const out = preparePreviewPage(SERVED, OPTS);
		expect(out).toContain('--typst-preview-background-color: #131316');
		expect(out).toContain('--typst-preview-foreground-color: #e4e4e7');
	});

	it('marks the theme important, or the page overrides it from its own script', () => {
		// measured: the page sets these as inline styles on <html>, and an inline declaration beats
		// any stylesheet rule that is not important. Dropping !important silently restores their grey.
		const out = preparePreviewPage(SERVED, OPTS);
		expect(out).toMatch(/--typst-preview-background-color:\s*#131316\s*!important/);
		expect(out).toMatch(/--typst-preview-foreground-color:\s*#e4e4e7\s*!important/);
	});

	it('strokes the page rect, or two white pages on a light surround read as one sheet', () => {
		// measured: the viewer stacks pages 5pt apart with no border of their own (tinymist keeps
		// theirs commented out), so the page break is invisible without this edge
		const out = preparePreviewPage(SERVED, OPTS);
		expect(out).toMatch(/rect\.typst-page-inner\s*\{[^}]*stroke:\s*#e4e4e7/);
	});

	it('swallows the jump ripple inside a quiet window, or follow strobes a circle per keystroke', () => {
		// the viewer draws one expanding circle per jump frame and cannot tell follow from a
		// one-shot sync; the editor can, and posts `quiet` alongside every follow scroll. The
		// bridge must both accept that message and remove ripples arriving inside the window.
		const out = preparePreviewPage(SERVED, OPTS);
		expect(out).toContain('typst-jump-ripple');
		expect(out).toContain('MutationObserver');
		expect(out).toContain("m.type === 'quiet'");
	});

	it('adds the bridge, since a framed page has no other way to be driven', () => {
		const out = preparePreviewPage(SERVED, OPTS);
		expect(out).toContain('texpile-bridge');
		expect(out).toContain('texpile-preview');
	});

	it('injects inside the body, after the viewer has defined itself', () => {
		const out = preparePreviewPage(SERVED, OPTS);
		expect(out.indexOf('texpile-bridge')).toBeGreaterThan(out.indexOf('retrieveWsArgs'));
		expect(out.indexOf('texpile-bridge')).toBeLessThan(out.lastIndexOf('</body>'));
	});

	it('still appends when there is no closing body tag', () => {
		const out = preparePreviewPage('<script>new URL("/", window.location.href)</script>', OPTS);
		expect(out).toContain('texpile-bridge');
	});

	it('leaves the rest of the page untouched', () => {
		// it is a 1.6MB page we did not write; the less we rewrite, the less can rot
		const out = preparePreviewPage(SERVED, OPTS);
		expect(out).toContain('urlObject.protocol.replace("https:", "wss:")');
	});
});
