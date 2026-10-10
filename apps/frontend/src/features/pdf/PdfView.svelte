<script lang="ts">
	import { onMount } from 'svelte';
	import workerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url';
	import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy, RenderTask } from 'pdfjs-dist';
	import { PdfRenderQueue } from './render-queue.ts';
	import { text, type Language } from '../../i18n/text.ts';
	let { bytes, active = true, locale = 'zh-Hant', onError, onPageCount }: {
		bytes: Uint8Array; active?: boolean; locale?: Language; onError: (message: string) => void; onPageCount: (count: number) => void;
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
	$effect(() => { if (active) schedule?.(); else pause?.(); });
	function changePage(value: number) {
		if (!Number.isInteger(value) || value < 1 || value > count) return;
		pageNumber = value; schedule?.();
	}
	onMount(() => {
		let disposed = false;
		let document: PDFDocumentProxy | undefined;
		let loading: PDFDocumentLoadingTask | undefined;
		let destroyPromise: Promise<void> | undefined;
		const destroyLoading = () => {
			if (!loading) return Promise.resolve();
			return (destroyPromise ??= loading.destroy());
		};
		let render: RenderTask | undefined;
		let resizeFrame = 0;
		const queue = new PdfRenderQueue<{ page: number; zoom: string }>(async (request, current) => {
			if (!document || !current()) return;
			let page: PDFPageProxy | undefined;
			try {
				page = await document.getPage(request.page);
				if (!current()) return;
				const base = page.getViewport({ scale: 1 });
				if (!Number.isFinite(base.width) || !Number.isFinite(base.height) || base.width <= 0 || base.height <= 0)
					throw new Error('PDF_SIZE');
				const ratio = Math.min(window.devicePixelRatio || 1, 2);
				const requestedScale = request.zoom === 'fit' ? Math.max(1, target.clientWidth - 48) / base.width : Number(request.zoom) / 100;
				const scale = Math.min(requestedScale, 4096 / (base.width * ratio), 4096 / (base.height * ratio));
				const viewport = page.getViewport({ scale });
				canvas.width = Math.ceil(viewport.width * ratio); canvas.height = Math.ceil(viewport.height * ratio);
				canvas.style.width = viewport.width + 'px'; canvas.style.height = viewport.height + 'px';
				const context = canvas.getContext('2d');
				if (!context) throw new Error('CANVAS');
				render = page.render({ canvas, canvasContext: context, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
				await render.promise;
				if (current()) { displayedPage = request.page; busy = false; }
			} finally {
				render = undefined;
				page?.cleanup();
			}
		}, () => render?.cancel(), () => { busy = false; onError('PDF_RENDER'); });
		schedule = () => {
			if (!document || disposed || !active) return;
			busy = true; queue.request({ page: pageNumber, zoom });
		};
		pause = () => { cancelAnimationFrame(resizeFrame); queue.pause(); };
		void import('pdfjs-dist').then(async ({ getDocument, GlobalWorkerOptions }) => {
			if (disposed) return;
			GlobalWorkerOptions.workerSrc = workerUrl;
			loading = getDocument({ data: new Uint8Array(bytes), enableXfa: false, stopAtErrors: true,
				disableAutoFetch: true, disableStream: true, useSystemFonts: true, maxImageSize: 16777216 });
			const pdf = await loading.promise;
			if (disposed) { await destroyLoading(); return; }
			document = pdf; count = pdf.numPages; onPageCount(count); schedule?.();
		}).catch(() => { if (!disposed) { busy = false; onError('PDF_LOAD'); } });
		const observer = new ResizeObserver(() => {
			cancelAnimationFrame(resizeFrame);
			resizeFrame = requestAnimationFrame(() => { if (zoom === 'fit') schedule?.(); });
		});
		observer.observe(target);
		return () => {
			disposed = true; schedule = undefined; pause = undefined; observer.disconnect(); cancelAnimationFrame(resizeFrame);
			queue.dispose(); void destroyLoading().catch(() => {});
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
		<canvas bind:this={canvas} aria-label={displayedPage ? t('PDF 第 ' + displayedPage + ' 頁', 'PDF page ' + displayedPage) : t('PDF 預覽', 'PDF preview')}></canvas>
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
