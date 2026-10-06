// Geometry of the three resizable regions: the left sidebar, the TOC split inside it, and the
// PDF preview pane on the right. All three share the same shape (clamp, apply, persist once the
// gesture ends) and differ only in bounds and where the value is stored.
//
// The PDF pane is persisted as a FRACTION of window width rather than a pixel count, so the pane
// stays proportional across window sizes, and it is re-clamped on every window resize: a width
// saved on a wide screen must not squeeze the editor out in a small window.
import { browser } from '$lib/runtime';
import { updateSettings } from '$lib/settings';
import { startDrag, nudgeOnKey, clampTo, SNAP_SLACK } from '$lib/workspace/paneResize';

const PDF_FRACTION_KEY = 'texpile:pdfPaneFraction';
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 600;
const TOC_MIN = 0.1;
const TOC_MAX = 0.9;
const PDF_MIN = 280;
/** keep this much room for the editor no matter how wide the preview was saved */
const EDITOR_RESERVE = 360;

const clampSidebar = clampTo(SIDEBAR_MIN, SIDEBAR_MAX);
const clampToc = clampTo(TOC_MIN, TOC_MAX);

export class PaneLayout {
	sidebarWidth = $state(256);
	sidebarOpen = $state(true);
	/** one sidebar view at a time (VS Code activity-bar style) */
	sidebarView = $state<'explorer' | 'search' | 'scm'>('explorer');
	/** TOC share of the sidebar's lower region (0..1) */
	tocFraction = $state(0.5);
	splitEl = $state<HTMLDivElement>();

	pdfPaneOpen = $state(false);
	pdfPaneWidth = $state(480);
	/** a splitter is being dragged right now; panes that reflow expensively can freeze while it is true */
	paneDragging = $state(false);

	/** restore persisted geometry; call once at mount, after settings load */
	restore(s: { sidebarWidth?: number; sidebarOpen?: boolean; tocFraction?: number; pdfPaneOpen?: boolean }) {
		if (s.sidebarWidth !== undefined && s.sidebarWidth >= SIDEBAR_MIN && s.sidebarWidth <= SIDEBAR_MAX) this.sidebarWidth = s.sidebarWidth;
		if (s.sidebarOpen !== undefined) this.sidebarOpen = s.sidebarOpen;
		if (s.tocFraction !== undefined && s.tocFraction >= TOC_MIN && s.tocFraction <= TOC_MAX) this.tocFraction = s.tocFraction;
		if (browser && typeof window !== 'undefined') {
			const frac = parseFloat(localStorage.getItem(PDF_FRACTION_KEY) ?? '');
			this.pdfPaneWidth = this.clampPdf((frac > 0 && frac < 1 ? frac : 0.4) * window.innerWidth);
		}
		if (s.pdfPaneOpen !== undefined) this.pdfPaneOpen = s.pdfPaneOpen;
	}

	// --- sidebar ---

	setSidebarOpen = (open: boolean) => {
		this.sidebarOpen = open;
		updateSettings({ sidebarOpen: open });
	};

	toggleSidebar = () => this.setSidebarOpen(!this.sidebarOpen);

	/**
	 * Takes the RAW width the pointer is asking for, not a clamped one: the clamp is what would
	 * hide the pane having been dragged past its minimum, which is the whole signal here.
	 *
	 * The stored width is left alone while shut, so reopening restores the size you last chose
	 * rather than the minimum you happened to drag through.
	 */
	private setSidebar = (w: number) => {
		if (w < SIDEBAR_MIN - SNAP_SLACK) {
			if (this.sidebarOpen) this.setSidebarOpen(false);
			return;
		}
		if (!this.sidebarOpen) this.setSidebarOpen(true);
		this.sidebarWidth = clampSidebar(w);
	};
	private commitSidebar = () => updateSettings({ sidebarWidth: this.sidebarWidth });
	private resizeSidebarToBoundary = (boundary: 'min' | 'max') => {
		const nextOpen = boundary === 'max';
		const nextWidth = nextOpen ? clampSidebar(SIDEBAR_MAX) : this.sidebarWidth;
		if (this.sidebarOpen === nextOpen && this.sidebarWidth === nextWidth) return;

		this.sidebarOpen = nextOpen;
		this.sidebarWidth = nextWidth;
		updateSettings({ sidebarOpen: nextOpen, sidebarWidth: nextWidth });
	};

	startSidebarResize = (e: MouseEvent) => {
		const startX = e.clientX;
		// from shut, the drag measures out from the edge, so pulling the handle back into the window
		// is what reopens it - starting from the remembered width would snap it open on the first px
		const startW = this.sidebarOpen ? this.sidebarWidth : 0;
		startDrag(e, { compute: (ev) => startW + ev.clientX - startX, apply: this.setSidebar, commit: this.commitSidebar });
	};

	resizeSidebarByKey = (e: KeyboardEvent) => {
		if (e.key === 'Home' || e.key === 'End') {
			e.preventDefault();
			this.resizeSidebarToBoundary(e.key === 'Home' ? 'min' : 'max');
			return;
		}
		nudgeOnKey(e, {
			keys: ['ArrowLeft', 'ArrowRight'],
			step: 16,
			// shut, the handle sits one step below the snap point, so one press outward opens it
			current: () => (this.sidebarOpen ? this.sidebarWidth : SIDEBAR_MIN - SNAP_SLACK),
			apply: this.setSidebar,
			commit: this.commitSidebar
		});
	};

	// --- TOC split ---

	private setToc = (f: number) => (this.tocFraction = clampToc(f));
	private commitToc = () => updateSettings({ tocFraction: this.tocFraction });

	startTocResize = (e: MouseEvent) => {
		const rect = this.splitEl?.getBoundingClientRect();
		// drag up = taller TOC; measured against the split container, so it is a fraction not a delta
		startDrag(e, { compute: (ev) => (rect ? (rect.bottom - ev.clientY) / rect.height : null), apply: this.setToc, commit: this.commitToc });
	};

	resizeTocByKey = (e: KeyboardEvent) =>
		nudgeOnKey(e, {
			keys: ['ArrowDown', 'ArrowUp'],
			step: 0.02,
			current: () => this.tocFraction,
			apply: this.setToc,
			commit: this.commitToc
		});

	// --- PDF preview pane ---

	/** cap: whatever is left after the sidebar, keeping room for the editor */
	private pdfMaxWidth(): number {
		const win = typeof window !== 'undefined' ? window.innerWidth : 1280;
		return Math.max(320, win - (this.sidebarOpen ? this.sidebarWidth : 0) - EDITOR_RESERVE);
	}

	clampPdf = (w: number) => Math.min(this.pdfMaxWidth(), Math.max(PDF_MIN, w));

	setPdfPaneOpen = (open: boolean) => {
		this.pdfPaneOpen = open;
		updateSettings({ pdfPaneOpen: open });
	};

	togglePdfPane = () => this.setPdfPaneOpen(!this.pdfPaneOpen);

	/** raw, unclamped - see setSidebar; the two panes snap on the same rule */
	private setPdfWidth = (w: number) => {
		if (w < PDF_MIN - SNAP_SLACK) {
			if (this.pdfPaneOpen) this.setPdfPaneOpen(false);
			return;
		}
		if (!this.pdfPaneOpen) this.setPdfPaneOpen(true);
		this.pdfPaneWidth = this.clampPdf(w);
	};
	private savePdfFraction = () => {
		if (browser && typeof window !== 'undefined') localStorage.setItem(PDF_FRACTION_KEY, String(this.pdfPaneWidth / window.innerWidth));
	};
	private resizePdfToBoundary = (boundary: 'min' | 'max') => {
		if (boundary === 'min' && !this.pdfPaneOpen) return;
		const nextWidth = this.clampPdf(boundary === 'min' ? PDF_MIN : Number.POSITIVE_INFINITY);
		const opening = boundary === 'max' && !this.pdfPaneOpen;
		if (!opening && nextWidth === this.pdfPaneWidth) return;

		if (opening) this.setPdfPaneOpen(true);
		this.pdfPaneWidth = nextWidth;
		this.savePdfFraction();
	};

	/** re-clamp when the window shrinks so the preview can't squeeze the editor out */
	reclampPdf = () => {
		this.pdfPaneWidth = this.clampPdf(this.pdfPaneWidth);
	};

	startPdfResize = (e: MouseEvent) => {
		const startX = e.clientX;
		// shut, measure out from the window edge so dragging the rail inwards is what reopens it
		const startW = this.pdfPaneOpen ? this.pdfPaneWidth : 0;
		// drag left = wider
		startDrag(e, {
			compute: (ev) => startW - (ev.clientX - startX),
			apply: this.setPdfWidth,
			commit: this.savePdfFraction,
			onState: (d) => (this.paneDragging = d)
		});
	};

	// left = wider, so ArrowRight is the one that shrinks
	resizePdfByKey = (e: KeyboardEvent) => {
		if (e.key === 'Home' || e.key === 'End') {
			e.preventDefault();
			this.resizePdfToBoundary(e.key === 'Home' ? 'min' : 'max');
			return;
		}
		nudgeOnKey(e, {
			keys: ['ArrowRight', 'ArrowLeft'],
			step: 16,
			current: () => (this.pdfPaneOpen ? this.pdfPaneWidth : PDF_MIN - SNAP_SLACK),
			apply: this.setPdfWidth,
			commit: this.savePdfFraction
		});
	};
}
