// Prepares tinymist's own preview page for display inside ModuTeX.
//
// tinymist embeds a self-contained preview page in its binary (~1.6MB, renderer wasm inlined) and
// serves it over loopback. That page IS the viewer: incremental SVG patching, ctrl+wheel zoom,
// keybindings, click-to-jump. Rather than reimplement any of it, we fetch it and show it.
//
// This is what tinymist's own VS Code extension does - it takes the same page, does a handful of
// string substitutions, and hands it to a webview. We follow that, with two differences: we serve
// the result from our own scheme (so we are not pointing a frame at an http origin), and we inject
// a small bridge so our pane can drive the viewer.
//
// Kept free of electron imports so it can be unit tested as plain string work.

/** how the prepared page should look and what it should talk to */
export interface PreparePageOptions {
	/** `host:port` of tinymist's data plane, e.g. `127.0.0.1:52145` */
	dataPlaneHost: string;
	/** page background, behind and around the paper */
	background: string;
	/** text colour for anything the page draws itself */
	foreground: string;
}

/**
 * The page derives its websocket address from its own URL:
 *
 *     new URL("/", window.location.href)   →   protocol http: → ws:
 *
 * That works when tinymist serves it, because the page and the socket share an origin. We serve it
 * from our own scheme, where the same expression yields no `ws:` at all and the viewer would sit
 * there forever with nothing to render. So the address gets pinned at prepare time.
 *
 * The raw asset inside the binary instead carries a literal `ws://127.0.0.1:23625` placeholder,
 * which is what the VS Code extension substitutes. Both forms are handled: which one we see depends
 * on whether the page came from the static server or straight from the binary.
 */
const DERIVED_WS = 'new URL("/", window.location.href)';
const PLACEHOLDER_WS = 'ws://127.0.0.1:23625';

/** Raised rather than returning a broken page: a silent miss here is a preview that never loads. */
export class PreviewPageError extends Error {}

/**
 * Colour the page through the variables it already exposes, and open a channel we can drive it
 * with.
 *
 * The bridge deliberately steers the viewer through its OWN keyboard handler rather than poking at
 * its internals: dispatching the ctrl+= it already listens for keeps its zoom ladder, its anchor
 * maths and its re-render path intact, and leaves us reading one value back out.
 */
function injection(opts: PreparePageOptions): string {
	return `
<style id="texpile-theme">
	/* !important is load-bearing: the page sets these as INLINE styles on <html> from its own
	   script, and an inline declaration beats any stylesheet rule that is not important. Without
	   it the pane keeps tinymist's grey no matter what we pass in. */
	:root {
		--typst-preview-background-color: ${opts.background} !important;
		--typst-preview-foreground-color: ${opts.foreground} !important;
	}
	/* The paper edge tinymist leaves out: its viewer fits every page to the pane width, stacks
	   them a mere 5px apart and paints them all white, so the surround we theme has almost
	   nowhere to show and the document reads as one endless white sheet. The page rect is an
	   SVG element, which means a stylesheet stroke can draw its edge - no reaching into the
	   viewer required. Coordinates inside the rect are scaled by 100 (INNER_RECT_UNIT in their
	   typst-doc.svg.mts), so 300 here is 3pt - sized for the OUTER half being all that reliably
	   shows, since the page's own content paints over the inner half. */
	rect.typst-page-inner {
		stroke: ${opts.foreground};
		stroke-opacity: 0.5;
		stroke-width: 300px;
	}
</style>
<script id="texpile-bridge">
(function () {
	var CHANNEL = 'texpile-preview';
	// Instrument the socket itself. The page creates it on window.load, which is after this script
	// parses, and its own error handling only console.logs - on the far side of an origin boundary.
	// A mixed-content block THROWS from the constructor, so that has to be caught here to be seen.
	var sock = { url: null, state: -1, threw: null, closeCode: null, closeReason: null };
	var Native = window.WebSocket;
	function WrappedWebSocket(url, protocols) {
		sock.url = String(url);
		sock.state = 0;
		var s;
		try {
			s = protocols === undefined ? new Native(url) : new Native(url, protocols);
		} catch (err) {
			sock.threw = String((err && err.name) || '') + ': ' + String((err && err.message) || err);
			throw err;
		}
		s.addEventListener('open', function () { sock.state = 1; });
		s.addEventListener('close', function (e) { sock.state = 3; sock.closeCode = e.code; sock.closeReason = e.reason; });
		return s;
	}
	WrappedWebSocket.prototype = Native.prototype;
	WrappedWebSocket.CONNECTING = 0; WrappedWebSocket.OPEN = 1; WrappedWebSocket.CLOSING = 2; WrappedWebSocket.CLOSED = 3;
	window.WebSocket = WrappedWebSocket;
	// The live viewer instance. tinymist pushes each one onto the container element, and appends
	// rather than replaces on reconnect, so the LAST entry is the current document.
	function view() {
		var c = document.getElementById('typst-container');
		var list = c && c.documents;
		if (!list || !list.length) return null;
		for (var i = list.length - 1; i >= 0; i--) if (list[i] && list[i].impl) return list[i];
		return null;
	}
	function zoomPercent() {
		var v = view();
		return v ? Math.round(v.impl.currentScaleRatio * 100) : null;
	}
	// their own shortcut: ctrl/cmd + '=' zooms in, '-' zooms out
	function step(dir) {
		var mac = /Mac|iPhone|iPad/.test(navigator.platform || '');
		var ev = new KeyboardEvent('keydown', {
			key: dir > 0 ? '=' : '-',
			ctrlKey: !mac,
			metaKey: mac,
			bubbles: true,
			cancelable: true
		});
		document.body.dispatchEvent(ev);
	}
	function reply(type, value) {
		try { parent.postMessage({ channel: CHANNEL, type: type, value: value }, '*'); } catch (e) {}
	}
	// The viewer draws an expanding circle for EVERY jump it handles. Right for a one-shot sync -
	// the circle is a "here is where you landed" cue for a deliberate action - but wrong for
	// follow, whose jumps are ambient. The two produce identical frames, so the viewer cannot
	// tell them apart; the EDITOR can, and it posts a 'quiet' message alongside every follow
	// scroll. Ripples landing inside the quiet window are removed before they draw; the scroll
	// itself is untouched. Watched on the scroll container only, where triggerRipple appends -
	// never the SVG subtree the renderer churns on every edit.
	var quietUntil = 0;
	var rippleHost = document.getElementById('typst-container-main');
	if (rippleHost) {
		new MutationObserver(function (muts) {
			for (var a = 0; a < muts.length; a++) {
				var nodes = muts[a].addedNodes;
				for (var b = 0; b < nodes.length; b++) {
					var n = nodes[b];
					if (n.nodeType === 1 && n.classList.contains('typst-jump-ripple') && Date.now() < quietUntil && n.parentNode) {
						n.parentNode.removeChild(n);
					}
				}
			}
		}).observe(rippleHost, { childList: true });
	}
	// Whatever goes wrong in here is invisible from the host - different origin, no shared console -
	// so a failure would otherwise present as a blank pane and nothing else. Forward it instead.
	window.addEventListener('error', function (e) {
		reply('error', String((e && e.message) || 'script error') + (e && e.filename ? ' @ ' + e.filename : ''));
	});
	window.addEventListener('unhandledrejection', function (e) {
		reply('error', 'unhandled rejection: ' + String((e && e.reason && e.reason.message) || (e && e.reason) || '?'));
	});
	// A blocked connection is silent otherwise: the page's own socket error handler only console.logs,
	// and that console is on the far side of an origin boundary.
	document.addEventListener('securitypolicyviolation', function (e) {
		reply('error', 'blocked by ' + e.violatedDirective + ': ' + (e.blockedURI || '?'));
	});
	/** enough to tell apart "page never loaded", "socket never opened" and "rendered nothing". */
	function status() {
		var v = view();
		return {
			pages: document.querySelectorAll('.typst-page').length,
			// from OUR wrapper, not from the page: it only publishes its socket once open, so asking it
			// cannot distinguish "never tried" from "tried and was refused"
			socket: sock.state,
			socketUrl: sock.url,
			socketThrew: sock.threw,
			closeCode: sock.closeCode,
			closeReason: sock.closeReason,
			origin: String(location.origin),
			secureContext: !!window.isSecureContext,
			viewer: !!v,
			initialized: v ? !!v.impl.moduleInitialized : false,
			zoom: zoomPercent()
		};
	}
	window.addEventListener('message', function (e) {
		var m = e.data;
		if (!m || typeof m !== 'object' || m.channel !== CHANNEL) return;
		if (m.type === 'zoom') { step(m.value); setTimeout(function () { reply('zoom', zoomPercent()); }, 0); }
		else if (m.type === 'quiet') quietUntil = Date.now() + (typeof m.value === 'number' ? m.value : 500);
		else if (m.type === 'query') reply('status', status());
	});
	// Report until the document is actually on screen, then stop. Reporting the whole status rather
	// than just "ready" is what makes a stuck preview say WHY it is stuck.
	var tries = 0;
	var t = setInterval(function () {
		var s = status();
		reply('status', s);
		if (s.pages > 0 || ++tries > 150) clearInterval(t);
	}, 200);
})();
</script>
`;
}

/**
 * Rewrite the served page so it can run inside our frame.
 *
 * Throws when the websocket address cannot be pinned - better a clear failure at start than a
 * preview pane that stays blank with no explanation.
 */
export function preparePreviewPage(html: string, opts: PreparePageOptions): string {
	// The texpile-* DOM ids and postMessage channel above are non-user-visible compatibility
	// identifiers. Renaming them would break the bundled preview bridge without changing any
	// product identity shown to users.
	if (!/^[\w.-]+:\d+$/.test(opts.dataPlaneHost)) {
		throw new PreviewPageError(`refusing a malformed data plane host: ${opts.dataPlaneHost}`);
	}

	let out = html;
	if (out.includes(DERIVED_WS)) {
		out = out.replace(DERIVED_WS, `new URL(${JSON.stringify(`http://${opts.dataPlaneHost}/`)})`);
	} else if (out.includes(PLACEHOLDER_WS)) {
		out = out.split(PLACEHOLDER_WS).join(`ws://${opts.dataPlaneHost}`);
	} else {
		throw new PreviewPageError('tinymist preview page has neither the derived nor the placeholder websocket address');
	}

	// last thing in the body, so the viewer's own script has already defined everything we reach for
	const inject = injection(opts);
	const close = out.lastIndexOf('</body>');
	return close >= 0 ? out.slice(0, close) + inject + out.slice(close) : out + inject;
}
