import type { SourceSpan } from '@modutex/document-core';
const releases = new WeakMap<HTMLElement, () => void>();
export function disposeCellDragHandle(element: HTMLElement): void { releases.get(element)?.(); releases.delete(element); }

/** Pointer dragging stays separate from text selection and ProseMirror's content drag. */
export function cellDragHandle(doc: Document, index: number, enabled: boolean, label: string,
	capture: () => { cells: SourceSpan[]; current(): boolean; commit(boundary: number): void } | null,
	onCleanup: (cleanup: (() => void) | null) => void): HTMLElement {
	const wrapper = doc.createElement('div'); wrapper.className = 'cell-drag-gutter'; wrapper.contentEditable = 'false';
	const handle = doc.createElement('button'); handle.type = 'button'; handle.className = 'cell-drag-handle'; handle.disabled = !enabled;
	handle.title = label; handle.setAttribute('aria-label', `${label} ${index + 1}`);
	handle.innerHTML = '<svg width="16" height="20" viewBox="0 0 16 20" aria-hidden="true"><g fill="currentColor"><circle cx="5" cy="5" r="1.5"/><circle cx="11" cy="5" r="1.5"/><circle cx="5" cy="10" r="1.5"/><circle cx="11" cy="10" r="1.5"/><circle cx="5" cy="15" r="1.5"/><circle cx="11" cy="15" r="1.5"/></g></svg>';
	handle.addEventListener('pointerdown', event => {
		if (event.button !== 0 || handle.disabled) return;
		event.preventDefault(); event.stopPropagation();
		const root = handle.closest<HTMLElement>('.ProseMirror'), win = doc.defaultView, session = capture();
		if (!session || !root || !win) return;
		const nodes = [...root.querySelectorAll<HTMLElement>('[data-cell-index]')], boundaries = [...root.querySelectorAll<HTMLElement>('[data-boundary-index]')];
		let boundary = index, y = event.clientY, moved = false, frame = 0;
		let scroll = root.parentElement;
		while (scroll && !/(auto|scroll)/.test(win.getComputedStyle(scroll).overflowY)) scroll = scroll.parentElement;
		const originalRect = nodes[index]?.getBoundingClientRect(), originalScroll = scroll?.scrollTop ?? 0;
		root.classList.add('is-cell-picked-up'); root.style.setProperty('--cell-drag-x', '0px'); root.style.setProperty('--cell-drag-y', '-2px');
		const mark = () => {
			boundary = nodes.findIndex((node, i) => { const rect = i === index && originalRect ? originalRect : node.getBoundingClientRect(); const correction = i === index ? (scroll?.scrollTop ?? 0) - originalScroll : 0; return y < rect.top - correction + rect.height / 2; });
			if (boundary < 0) boundary = session.cells.length;
			for (const node of boundaries) node.classList.toggle('is-drop-target', moved && Number(node.dataset.boundaryIndex) === boundary && boundary !== index && boundary !== index + 1);
		};
		const cleanup = () => { win.cancelAnimationFrame(frame); win.removeEventListener('pointermove', move); win.removeEventListener('pointerup', up); win.removeEventListener('pointercancel', cancel); win.removeEventListener('keydown', key, true); win.removeEventListener('blur', cancel); boundaries.forEach(node => node.classList.remove('is-drop-target')); root.classList.remove('is-cell-dragging', 'is-cell-picked-up'); root.style.removeProperty('--cell-drag-x'); root.style.removeProperty('--cell-drag-y'); onCleanup(null); };
		const move = (e: PointerEvent) => { if (e.pointerId !== event.pointerId) return; if (!session.current()) { cleanup(); return; } e.preventDefault(); y = e.clientY; moved ||= Math.hypot(e.clientX - event.clientX, y - event.clientY) > 4; root.classList.toggle('is-cell-dragging', moved); root.style.setProperty('--cell-drag-x', `${Math.min(20, Math.max(-20, e.clientX - event.clientX))}px`); root.style.setProperty('--cell-drag-y', `${y - event.clientY + (scroll?.scrollTop ?? 0) - originalScroll}px`); mark(); };
		const cancel = () => cleanup();
		const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cleanup(); } };
		const up = (e: PointerEvent) => { if (e.pointerId !== event.pointerId) return; const area = root.getBoundingClientRect(), visible = scroll?.getBoundingClientRect() ?? area; const inside = e.clientX >= area.left - 24 && e.clientX <= area.right && e.clientY >= visible.top && e.clientY <= visible.bottom; const commit = moved && inside && session.current() && boundary !== index && boundary !== index + 1; cleanup(); if (commit) session.commit(boundary); };
		const tick = () => { if (!session.current()) { cleanup(); return; } if (moved && scroll) { const rect = scroll.getBoundingClientRect(); const speed = y < rect.top + 40 ? -12 : y > rect.bottom - 40 ? 12 : 0; if (speed) { scroll.scrollTop += speed; root.style.setProperty('--cell-drag-y', `${y - event.clientY + scroll.scrollTop - originalScroll}px`); mark(); } } frame = win.requestAnimationFrame(tick); };
		onCleanup(cleanup); win.addEventListener('pointermove', move, { passive: false }); win.addEventListener('pointerup', up); win.addEventListener('pointercancel', cancel); win.addEventListener('keydown', key, true); win.addEventListener('blur', cancel); frame = win.requestAnimationFrame(tick);
	});
	const cell = () => handle.closest('.ProseMirror')?.querySelector<HTMLElement>(`[data-cell-index="${index}"]`);
	const win = doc.defaultView!;
	let observer: ResizeObserver | null = null;
	const layout = () => { const node = cell(); if (!node) return; const rect = node.getBoundingClientRect(), gutter = wrapper.getBoundingClientRect(); handle.style.top = `${rect.top - gutter.top}px`; handle.style.height = `${Math.max(28, rect.height)}px`; };
	const frame = win.requestAnimationFrame(() => { layout(); const node = cell(); if (node && win.ResizeObserver) { observer = new win.ResizeObserver(layout); observer.observe(node); } });
	releases.set(wrapper, () => { win.cancelAnimationFrame(frame); observer?.disconnect(); });
	wrapper.append(handle); return wrapper;
}
