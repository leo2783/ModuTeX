import type { SourceSpan } from '../document-core/core.ts';
const releases = new WeakMap<HTMLElement, () => void>();
type LayoutTask = (cells: ReadonlyMap<HTMLElement, ReadonlyMap<number, HTMLElement>>) => (() => void) | null;
const layouts = new WeakMap<Document, { tasks: Set<LayoutTask>; frame: number }>();
function scheduleLayout(doc: Document, task: LayoutTask): () => void {
	let batch = layouts.get(doc);
	if (!batch) { batch = { tasks: new Set(), frame: 0 }; layouts.set(doc, batch); }
	batch.tasks.add(task);
	const win = doc.defaultView!;
	if (!batch.frame) batch.frame = win.requestAnimationFrame(() => {
		batch!.frame = 0;
		const cells = new Map<HTMLElement, Map<number, HTMLElement>>();
		for (const node of doc.querySelectorAll<HTMLElement>('.ProseMirror [data-cell-index]')) {
			const root = node.closest<HTMLElement>('.ProseMirror')!;
			if (!cells.has(root)) cells.set(root, new Map());
			cells.get(root)!.set(Number(node.dataset.cellIndex), node);
		}
		// Read every rectangle before any style write, avoiding one forced layout per cell.
		const writes = [...batch!.tasks].map(read => read(cells)); batch!.tasks.clear();
		for (const write of writes) write?.();
	});
	return () => { batch!.tasks.delete(task); if (!batch!.tasks.size && batch!.frame) { win.cancelAnimationFrame(batch!.frame); batch!.frame = 0; } };
}
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
		const ordinal = nodes.findIndex(node => Number(node.dataset.cellIndex) === index);
		const nextIndex = Number(nodes[ordinal + 1]?.dataset.cellIndex ?? boundaries.at(-1)?.dataset.boundaryIndex ?? index + 1);
		const rectFor = (node: HTMLElement) => {
			const owner = node.dataset.cellIndex;
			const parts = [...root.querySelectorAll<HTMLElement>(`[data-cell-owner="${owner}"]`)];
			const first = node.getBoundingClientRect(), last = parts.at(-1)?.getBoundingClientRect() ?? first;
			return { top: first.top, height: last.bottom - first.top };
		};
		let boundary = index, y = event.clientY, moved = false, frame = 0;
		let scroll = root.parentElement;
		while (scroll && !/(auto|scroll)/.test(win.getComputedStyle(scroll).overflowY)) scroll = scroll.parentElement;
		const originalRect = nodes[ordinal] ? rectFor(nodes[ordinal]!) : undefined, originalScroll = scroll?.scrollTop ?? 0;
		root.classList.add('is-cell-picked-up'); root.style.setProperty('--cell-drag-x', '0px'); root.style.setProperty('--cell-drag-y', '-2px');
		const mark = () => {
			const target = nodes.find((node, i) => { const rect = i === ordinal && originalRect ? originalRect : rectFor(node); const correction = i === ordinal ? (scroll?.scrollTop ?? 0) - originalScroll : 0; return y < rect.top - correction + rect.height / 2; });
			boundary = target ? Number(target.dataset.cellIndex) : Number(boundaries.at(-1)?.dataset.boundaryIndex ?? session.cells.length);
			for (const node of boundaries) node.classList.toggle('is-drop-target', moved && Number(node.dataset.boundaryIndex) === boundary && boundary !== index && boundary !== nextIndex);
		};
		const cleanup = () => { win.cancelAnimationFrame(frame); win.removeEventListener('pointermove', move); win.removeEventListener('pointerup', up); win.removeEventListener('pointercancel', cancel); win.removeEventListener('keydown', key, true); win.removeEventListener('blur', cancel); boundaries.forEach(node => node.classList.remove('is-drop-target')); root.classList.remove('is-cell-dragging', 'is-cell-picked-up'); root.style.removeProperty('--cell-drag-x'); root.style.removeProperty('--cell-drag-y'); onCleanup(null); };
		const move = (e: PointerEvent) => { if (e.pointerId !== event.pointerId) return; if (!session.current()) { cleanup(); return; } e.preventDefault(); y = e.clientY; moved ||= Math.hypot(e.clientX - event.clientX, y - event.clientY) > 4; root.classList.toggle('is-cell-dragging', moved); root.style.setProperty('--cell-drag-x', `${Math.min(20, Math.max(-20, e.clientX - event.clientX))}px`); root.style.setProperty('--cell-drag-y', `${y - event.clientY + (scroll?.scrollTop ?? 0) - originalScroll}px`); mark(); };
		const cancel = () => cleanup();
		const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cleanup(); } };
		const up = (e: PointerEvent) => { if (e.pointerId !== event.pointerId) return; const area = root.getBoundingClientRect(), visible = scroll?.getBoundingClientRect() ?? area; const inside = e.clientX >= area.left - 24 && e.clientX <= area.right && e.clientY >= visible.top && e.clientY <= visible.bottom; const commit = moved && inside && session.current() && boundary !== index && boundary !== nextIndex; cleanup(); if (commit) session.commit(boundary); };
		const tick = () => { if (!session.current()) { cleanup(); return; } if (moved && scroll) { const rect = scroll.getBoundingClientRect(); const speed = y < rect.top + 40 ? -12 : y > rect.bottom - 40 ? 12 : 0; if (speed) { scroll.scrollTop += speed; root.style.setProperty('--cell-drag-y', `${y - event.clientY + scroll.scrollTop - originalScroll}px`); mark(); } } frame = win.requestAnimationFrame(tick); };
		onCleanup(cleanup); win.addEventListener('pointermove', move, { passive: false }); win.addEventListener('pointerup', up); win.addEventListener('pointercancel', cancel); win.addEventListener('keydown', key, true); win.addEventListener('blur', cancel); frame = win.requestAnimationFrame(tick);
	});
	const win = doc.defaultView!;
	let observer: ResizeObserver | null = null;
	let cancelLayout: (() => void) | null = null;
	const layout: LayoutTask = cells => {
		const root = handle.closest<HTMLElement>('.ProseMirror');
		const node = root ? cells.get(root)?.get(index) : null;
		if (!node) return null;
		const rect = node.getBoundingClientRect(), gutter = wrapper.getBoundingClientRect();
		if (!observer && win.ResizeObserver) { observer = new win.ResizeObserver(queue); observer.observe(node); }
		const top = `${rect.top - gutter.top}px`, height = `${Math.max(28, rect.height)}px`;
		return () => { if (handle.style.top !== top) handle.style.top = top; if (handle.style.height !== height) handle.style.height = height; };
	};
	const queue = () => { cancelLayout = scheduleLayout(doc, layout); };
	queue();
	releases.set(wrapper, () => { cancelLayout?.(); observer?.disconnect(); });
	wrapper.append(handle); return wrapper;
}
