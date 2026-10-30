<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
	import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
	import { PdfRenderQueue } from './render-queue.ts';
	import { LocalPdfDataReader } from './local-pdf-data.ts';
	import { text, type Language } from '../../i18n/text.ts';
	let {
		bytes,
		active = true,
		locale = 'zh-Hant',
		reveal,
		onPoint,
		onError,
		onPageCount,
		onRendered
	}: {
		bytes: Uint8Array;
		active?: boolean;
		locale?: Language;
		reveal?: { page: number; x: number; y: number; requestId: number };
		onPoint?: (point: { page: number; x: number; y: number }) => void;
		onError: (message: string) => void;
		onPageCount: (count: number) => void;
		onRendered?: () => void;
	} = $props();
	const t = (traditionalChinese: string, english: string) => text(locale, traditionalChinese, english);
	let target: HTMLDivElement;
	let canvas: HTMLCanvasElement;
	let busy = $state(true);
	let count = $state(0);
	let pageNumber = $state(1);
	let displayedPage = $state(0);
	let zoom = $state('fit');
	let schedule: (() => void) | undefined;
	let pause: (() => void) | undefined;
	let disposed = false;
	let currentViewport: ReturnType<PDFPageProxy['getViewport']> | undefined;
	let requestedRenderId = 0;
	let displayedRenderId = 0;
	let lastHandledRevealId: number | undefined;
	let activeBytes: Uint8Array | undefined;
	let replaceBytes: ((nextBytes: Uint8Array, obsoleteRevealId?: number) => void) | null = null;
	let observedBytes: Uint8Array | undefined;
	let observedRevealId: number | undefined;
	let observedProps = false;
	function revealRequestId(value: typeof reveal): number | undefined {
		return value && typeof value.requestId === 'number' && Number.isSafeInteger(value.requestId)
			? value.requestId
			: undefined;
	}
	$effect(() => {
		const nextBytes = bytes;
		const nextRevealId = revealRequestId(reveal);
		untrack(() => {
			const first = !observedProps;
			const bytesChanged = first || observedBytes !== nextBytes;
			const previousRevealId = observedRevealId;
			const revealChanged = nextRevealId !== previousRevealId;
			const obsoleteRevealId = first || (revealChanged && nextRevealId !== undefined)
				? undefined
				: previousRevealId;
			observedProps = true;
			observedBytes = nextBytes;
			observedRevealId = nextRevealId;
			if (bytesChanged) replaceBytes?.(nextBytes, obsoleteRevealId);
		});
	});
	function extractViewBox(viewport: ReturnType<PDFPageProxy['getViewport']> | undefined) {
		if (!viewport) return undefined;
		const box = viewport.viewBox;
		if (!Array.isArray(box) || box.length < 4) return undefined;
		const x1 = box[0];
		const y1 = box[1];
		const x2 = box[2];
		const y2 = box[3];
		if (
			typeof x1 !== 'number' ||
			typeof y1 !== 'number' ||
			typeof x2 !== 'number' ||
			typeof y2 !== 'number' ||
			!Number.isFinite(x1) ||
			!Number.isFinite(y1) ||
			!Number.isFinite(x2) ||
			!Number.isFinite(y2)
		) {
			return undefined;
		}
		const minX = Math.min(x1, x2);
		const maxX = Math.max(x1, x2);
		const minY = Math.min(y1, y2);
		const maxY = Math.max(y1, y2);
		const pageWidth = maxX - minX;
		const pageHeight = maxY - minY;
		if (pageWidth <= 0 || pageHeight <= 0) return undefined;
		return { minX, maxX, minY, maxY, pageWidth, pageHeight };
	}
	function tryReveal() {
		if (!active || disposed || activeBytes !== bytes) return;
		const req = reveal;
		if (!req) return;
		if (typeof req.requestId !== 'number' || !Number.isSafeInteger(req.requestId)) return;
		if (lastHandledRevealId !== undefined && req.requestId <= lastHandledRevealId) return;
		if (
			typeof req.page !== 'number' || !Number.isSafeInteger(req.page) ||
			typeof req.x !== 'number' || !Number.isFinite(req.x) ||
			typeof req.y !== 'number' || !Number.isFinite(req.y)
		) {
			lastHandledRevealId = req.requestId;
			return;
		}
		if (req.page < 1) {
			lastHandledRevealId = req.requestId;
			return;
		}
		if (!count) return;
		if (req.page > count) {
			lastHandledRevealId = req.requestId;
			return;
		}
		if (pageNumber !== req.page) {
			pageNumber = req.page;
			schedule?.();
			return;
		}
		if (busy || displayedPage !== req.page || displayedRenderId !== requestedRenderId || !currentViewport) {
			return;
		}
		const box = extractViewBox(currentViewport);
		if (!box) {
			lastHandledRevealId = req.requestId;
			return;
		}
		if (req.x < 0 || req.x > box.pageWidth || req.y < 0 || req.y > box.pageHeight) {
			lastHandledRevealId = req.requestId;
			return;
		}
		if (!target || !canvas) return;
		const targetRect = target.getBoundingClientRect();
		const canvasRect = canvas.getBoundingClientRect();
		if (targetRect.width <= 0 || targetRect.height <= 0 || canvasRect.width <= 0 || canvasRect.height <= 0) return;
		lastHandledRevealId = req.requestId;
		const pdfX = box.minX + req.x;
		const pdfY = box.maxY - req.y;
		const [vx, vy] = currentViewport.convertToViewportPoint(pdfX, pdfY);
		const cssX = currentViewport.width > 0 ? (vx / currentViewport.width) * canvasRect.width : vx;
		const cssY = currentViewport.height > 0 ? (vy / currentViewport.height) * canvasRect.height : vy;
		const pointX = canvasRect.left - targetRect.left - target.clientLeft + target.scrollLeft + cssX;
		const pointY = canvasRect.top - targetRect.top - target.clientTop + target.scrollTop + cssY;
		target.scrollLeft = Math.max(0, pointX - target.clientWidth / 2);
		target.scrollTop = Math.max(0, pointY - target.clientHeight / 2);
	}
	function emitPointAtClient(clientX: number, clientY: number) {
		if (!onPoint || !active || disposed || activeBytes !== bytes || busy || !currentViewport || displayedPage < 1) return;
		if (displayedPage !== pageNumber || displayedRenderId !== requestedRenderId) return;
		const rect = canvas.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return;
		const cssX = clientX - rect.left;
		const cssY = clientY - rect.top;
		const vx = (cssX / rect.width) * currentViewport.width;
		const vy = (cssY / rect.height) * currentViewport.height;
		if (!Number.isFinite(vx) || !Number.isFinite(vy)) return;
		if (vx < 0 || vx > currentViewport.width || vy < 0 || vy > currentViewport.height) return;
		const [pdfX, pdfY] = currentViewport.convertToPdfPoint(vx, vy);
		if (!Number.isFinite(pdfX) || !Number.isFinite(pdfY)) return;
		const box = extractViewBox(currentViewport);
		if (!box) return;
		const x = pdfX - box.minX;
		const y = box.maxY - pdfY;
		if (x < 0 || x > box.pageWidth || y < 0 || y > box.pageHeight) return;
		onPoint({ page: displayedPage, x, y });
	}
	function handleCanvasClick(event: MouseEvent) {
		emitPointAtClient(event.clientX, event.clientY);
	}
	function handleCanvasKeyDown(event: KeyboardEvent) {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			if (!target || !canvas) return;
			const targetRect = target.getBoundingClientRect();
			const canvasRect = canvas.getBoundingClientRect();
			if (targetRect.width <= 0 || targetRect.height <= 0 || canvasRect.width <= 0 || canvasRect.height <= 0) return;
			const visibleLeft = Math.max(targetRect.left, canvasRect.left);
			const visibleRight = Math.min(targetRect.right, canvasRect.right);
			const visibleTop = Math.max(targetRect.top, canvasRect.top);
			const visibleBottom = Math.min(targetRect.bottom, canvasRect.bottom);
			const clientX = visibleLeft < visibleRight ? (visibleLeft + visibleRight) / 2 : canvasRect.left + canvasRect.width / 2;
			const clientY = visibleTop < visibleBottom ? (visibleTop + visibleBottom) / 2 : canvasRect.top + canvasRect.height / 2;
			emitPointAtClient(clientX, clientY);
		}
	}
	$effect(() => { if (active) schedule?.(); else pause?.(); });
	$effect(() => {
		if (active && reveal) {
			untrack(() => tryReveal());
		}
	});
	function changePage(value: number) {
		if (!Number.isInteger(value) || value < 1 || value > count) return;
		pageNumber = value; schedule?.();
	}
	onMount(() => {
		disposed = false;
		let document: PDFDocumentProxy | undefined;
		let loading: PDFDocumentLoadingTask | undefined;
		let render: RenderTask | undefined;
		let loadGeneration = 0;
		let documentBytes: Uint8Array | undefined;
		let resizeFrame = 0;
		const queue = new PdfRenderQueue<{ id: number; page: number; zoom: string }>(async (request, current) => {
			const pdf = document, generation = loadGeneration;
			if (!pdf || documentBytes !== bytes || !current() || disposed || !active || request.id !== requestedRenderId) return;
			let page: PDFPageProxy | undefined;
			let renderCanvas: HTMLCanvasElement | undefined;
			let task: RenderTask | undefined;
			try {
				page = await pdf.getPage(request.page);
				if (!current() || disposed || !active || request.id !== requestedRenderId ||
					document !== pdf || documentBytes !== bytes || generation !== loadGeneration) return;
				const base = page.getViewport({ scale: 1 });
				if (!Number.isFinite(base.width) || !Number.isFinite(base.height) || base.width <= 0 || base.height <= 0)
					throw new Error('PDF_SIZE');
				const ratio = Math.min(window.devicePixelRatio || 1, 2);
				const requestedScale = request.zoom === 'fit' ? Math.max(1, target.clientWidth - 48) / base.width : Number(request.zoom) / 100;
				const scale = Math.min(requestedScale, 4096 / (base.width * ratio), 4096 / (base.height * ratio));
				const viewport = page.getViewport({ scale });
				renderCanvas = canvas.ownerDocument.createElement('canvas');
				renderCanvas.width = Math.ceil(viewport.width * ratio);
				renderCanvas.height = Math.ceil(viewport.height * ratio);
				const context = renderCanvas.getContext('2d');
				if (!context) throw new Error('CANVAS');
				task = page.render({ canvas: renderCanvas, canvasContext: context, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
				render = task;
				await task.promise;
				if (current() && !disposed && active && request.id === requestedRenderId &&
					document === pdf && documentBytes === bytes && generation === loadGeneration) {
					const displayContext = canvas.getContext('2d');
					if (!displayContext) throw new Error('CANVAS');
					canvas.width = renderCanvas.width;
					canvas.height = renderCanvas.height;
					canvas.style.width = viewport.width + 'px';
					canvas.style.height = viewport.height + 'px';
					displayContext.drawImage(renderCanvas, 0, 0);
					displayedPage = request.page;
					displayedRenderId = request.id;
					currentViewport = viewport;
					busy = false;
					tryReveal();
					onRendered?.();
				}
			} finally {
				if (render === task) render = undefined;
				if (renderCanvas) {
					renderCanvas.width = 0;
					renderCanvas.height = 0;
				}
				page?.cleanup();
			}
		}, () => render?.cancel(), () => {
			busy = false;
			currentViewport = undefined;
			onError('PDF_RENDER');
		});
		schedule = () => {
			if (!document || documentBytes !== bytes || disposed || !active) return;
			busy = true;
			currentViewport = undefined;
			const id = ++requestedRenderId;
			queue.request({ id, page: pageNumber, zoom });
		};
		pause = () => { cancelAnimationFrame(resizeFrame); currentViewport = undefined; queue.pause(); };
		replaceBytes = (nextBytes, obsoleteRevealId) => {
			const generation = ++loadGeneration;
			activeBytes = nextBytes;
			const oldLoading = loading;
			loading = undefined;
			document = undefined;
			documentBytes = undefined;
			queue.pause();
			requestedRenderId++;
			busy = true;
			count = 0;
			currentViewport = undefined;
			if (obsoleteRevealId !== undefined &&
				(lastHandledRevealId === undefined || obsoleteRevealId > lastHandledRevealId)) {
				lastHandledRevealId = obsoleteRevealId;
			}
			if (oldLoading) void oldLoading.destroy().catch(() => {});
			const isCurrentLoad = () => !disposed && generation === loadGeneration &&
				activeBytes === nextBytes && bytes === nextBytes;
			void import('pdfjs-dist').then(async ({ getDocument, GlobalWorkerOptions }) => {
				if (!isCurrentLoad()) return;
				GlobalWorkerOptions.workerSrc = workerUrl;
				const task = getDocument({ data: new Uint8Array(nextBytes), enableXfa: false, stopAtErrors: true,
					BinaryDataFactory: LocalPdfDataReader, cMapPacked: true, useWorkerFetch: false,
					disableAutoFetch: true, disableStream: true, useSystemFonts: true, maxImageSize: 16777216 });
				loading = task;
				const pdf = await task.promise;
				if (!isCurrentLoad() || loading !== task) return;
				document = pdf;
				documentBytes = nextBytes;
				count = pdf.numPages;
				onPageCount(count);
				if (count > 0) pageNumber = Math.min(Math.max(pageNumber, 1), count);
				const req = reveal;
				const requestId = revealRequestId(req);
				if (req && requestId !== undefined && typeof req.page === 'number' && Number.isSafeInteger(req.page)) {
					if (lastHandledRevealId === undefined || requestId > lastHandledRevealId) {
						if (req.page >= 1 && req.page <= count) {
							pageNumber = req.page;
						} else {
							lastHandledRevealId = requestId;
						}
					}
				}
				schedule?.();
			}).catch(() => {
				if (!isCurrentLoad()) return;
				const failedLoading = loading;
				loading = undefined;
				if (failedLoading) void failedLoading.destroy().catch(() => {});
				document = undefined;
				documentBytes = undefined;
				busy = false;
				currentViewport = undefined;
				onError('PDF_LOAD');
			});
		};
		if (!observedProps) {
			observedProps = true;
			observedBytes = bytes;
			observedRevealId = revealRequestId(reveal);
		}
		replaceBytes(bytes);
		let observedWidth = target.clientWidth;
		const observer = new ResizeObserver(() => {
			const width = target.clientWidth;
			if (width === observedWidth) return;
			observedWidth = width;
			cancelAnimationFrame(resizeFrame);
			resizeFrame = requestAnimationFrame(() => { if (zoom === 'fit') schedule?.(); });
		});
		observer.observe(target);
		return () => {
			disposed = true;
			loadGeneration++;
			activeBytes = undefined;
			currentViewport = undefined;
			schedule = undefined;
			pause = undefined;
			replaceBytes = null;
			observer.disconnect();
			cancelAnimationFrame(resizeFrame);
			queue.dispose();
			const oldLoading = loading;
			loading = undefined;
			document = undefined;
			documentBytes = undefined;
			if (oldLoading) void oldLoading.destroy().catch(() => {});
		};
	});
</script>

<div class="pdf-view">
	<div class="pdf-controls" role="group" aria-label={t('PDF 頁面與縮放', 'PDF page and zoom')}>
		<button class="text-button" onclick={() => changePage(pageNumber - 1)} disabled={!count || pageNumber === 1}>{t('上一頁', 'Previous page')}</button>
		<label>{t('頁碼', 'Page')} <input type="number" min="1" max={count || 1} value={pageNumber} disabled={!count}
			onchange={(event) => { changePage(event.currentTarget.valueAsNumber); event.currentTarget.value = String(pageNumber); }} /></label>
		<span class="page-total">/ {count || '—'}</span>
		<button class="text-button" onclick={() => changePage(pageNumber + 1)} disabled={!count || pageNumber === count}>{t('下一頁', 'Next page')}</button>
		<label class="zoom">{t('縮放', 'Zoom')} <select bind:value={zoom} onchange={() => schedule?.()} disabled={!count}>
			<option value="fit">{t('符合寬度', 'Fit width')}</option><option value="50">50%</option><option value="75">75%</option>
			<option value="100">100%</option><option value="150">150%</option><option value="200">200%</option>
		</select></label>
	</div>
	<div class="pdf-scroll" bind:this={target} aria-busy={busy}>
		<canvas
			bind:this={canvas}
			role={onPoint ? 'button' : undefined}
			tabindex={onPoint ? 0 : undefined}
			onclick={onPoint ? handleCanvasClick : undefined}
			onkeydown={onPoint ? handleCanvasKeyDown : undefined}
			aria-label={displayedPage ? t('PDF 第 ' + displayedPage + ' 頁', 'PDF page ' + displayedPage) : t('PDF 預覽', 'PDF preview')}
		></canvas>
	</div>
</div>

<style>
	.pdf-view { height: 100%; display: flex; flex-direction: column; min-height: 0; }
	.pdf-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; padding: 6px 12px; border-bottom: 1px solid var(--line); background: var(--canvas); font-size: 13px; }
	label { display: flex; align-items: center; gap: 5px; }
	input, select { min-height: 30px; border: 1px solid var(--line); border-radius: 4px; background: var(--surface); color: var(--ink); padding: 3px 5px; }
	input { width: 64px; font-variant-numeric: tabular-nums; }
	.page-total { font-variant-numeric: tabular-nums; }
	.zoom { margin-left: auto; }
	.pdf-scroll { flex: 1; min-height: 0; overflow: auto; padding: 24px; background: var(--canvas); }
	canvas { display: block; margin: 0 auto; background: white; box-shadow: 0 3px 14px #00000012; }
</style>
