<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { Loader2, X } from '@lucide/svelte';
	import { diagramIdFromSource, diagramStatus, prepareDrawioVectorCopy, readDiagramSource, relinkDiagramSource } from './client';
	import { drawioExportData, isDrawioMetadataDirty, type ExistingDiagram } from './events';
	import { createDrawioSession } from './drawio-session';
	import type { FigureCoordinator, FigureOperationContext } from './figure-coordinator';
	import type { DiagramBundleStatusResult } from 'modutex-contracts';
	import { m } from '$lib/paraglide/messages';

	const EMPTY_DRAWIO_XML =
		'<mxfile host="modutex" version="24.7.17"><diagram id="page-1" name="Page-1"><mxGraphModel dx="1200" dy="800" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';

	interface Props {
		context: FigureOperationContext;
		coordinator: FigureCoordinator;
		existing?: ExistingDiagram | null;
		onClose: () => void;
	}

	let { context, coordinator, existing = null, onClose }: Props = $props();
	// svelte-ignore state_referenced_locally
	const initialExisting = existing;
	const initialId = initialExisting?.id ?? crypto.randomUUID();
	let id = $state(initialId);
	let selectedSourcePath = $state<string | null>(initialExisting?.sourcePath ?? null);
	let slug = $state(
		initialExisting
			? initialExisting.sourcePath
					.split('/')
					.at(-1)!
					.replace(new RegExp(`-${initialId}\\.drawio$`), '')
			: 'diagram'
	);
	let caption = $state(initialExisting?.caption ?? '');
	let label = $state(initialExisting?.label ?? '');
	let widthPercent = $state(initialExisting?.widthPercent ?? 100);
	let loading = $state(true);
	let saving = $state(false);
	let missing = $state(false);
	let closePrompt = $state(false);
	let error = $state<string | null>(null);
	let failedSaveStatus = $state<DiagramBundleStatusResult | null>(null);
	let failedSaveStatusUnavailable = $state(false);
	let contentDirty = $state(false);
	let editorReady = $state(false);
	let iframe = $state<HTMLIFrameElement>();
	let exportIframe = $state<HTMLIFrameElement>();
	let exportFrameEpoch = $state(0);
	let canvasRoot = $state<HTMLElement>();
	let closePromptRoot = $state<HTMLElement>();
	let firstField = $state<HTMLInputElement>();
	let promptFirstButton = $state<HTMLButtonElement>();
	let session: ReturnType<typeof createDrawioSession> | null = null;
	let destroyed = false;
	let previousFocus: HTMLElement | null = null;

	const sourcePath = $derived(selectedSourcePath ?? `assets/diagrams/${slug}-${id}.drawio`);
	const slugValid = $derived(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug));
	const metadataDirty = $derived(
		initialExisting
			? isDrawioMetadataDirty(initialExisting, { sourcePath: selectedSourcePath, caption, label, widthPercent })
			: slug !== 'diagram' || caption !== '' || label !== '' || widthPercent !== 100
	);
	const dirty = $derived(contentDirty || metadataDirty);
	const canSave = $derived(!loading && !saving && editorReady && slugValid && coordinator.isCurrent(context));

	$effect(() => {
		if (closePrompt) queueMicrotask(() => promptFirstButton?.focus());
	});

	function cleanError(cause: unknown): string {
		const code = cause instanceof Error ? cause.message : String(cause);
		if (code === 'DIAGRAM_ABORTED' || code === 'DIAGRAM_OPERATION_STALE') return m.diagram_operation_cancelled();
		if (code.endsWith('_UNAVAILABLE')) return m.diagram_drawio_not_ready();
		if (code.endsWith('_TIMEOUT')) return m.diagram_render_timeout();
		if (code === 'PAYLOAD_TOO_LARGE') return m.diagram_drawio_too_large();
		if (code === 'INVALID_DRAWIO_XML' || code === 'INVALID_SVG' || code.endsWith('_REJECTED') || code.endsWith('_FAILED')) {
			return m.diagram_export_failed();
		}
		return m.diagram_export_failed();
	}

	function bundleStateLabel(state: DiagramBundleStatusResult['state']): string {
		switch (state) {
			case 'missing':
				return m.diagram_bundle_state_missing();
			case 'stale':
				return m.diagram_bundle_state_stale();
			case 'ready':
				return m.diagram_bundle_state_ready();
			case 'error':
				return m.diagram_bundle_state_error();
		}
	}

	function assertCurrent(): void {
		if (context.signal.aborted || !coordinator.isCurrent(context)) throw new Error('DIAGRAM_OPERATION_STALE');
	}

	function makeSession(): ReturnType<typeof createDrawioSession> {
		if (!iframe) throw new Error('DIAGRAM_BRIDGE_UNAVAILABLE');
		return createDrawioSession({
			iframe,
			hostOrigin: `${location.protocol}//${location.host}`,
			onMessage: (message) => {
				if (editorReady && (message.action === 'save' || (message.action === 'exit' && message.modified))) contentDirty = true;
			}
		});
	}

	async function loadSession(xml: string): Promise<void> {
		assertCurrent();
		const validXml = drawioExportData(xml, 'xml');
		const created = makeSession();
		session = created;
		await created.load(validXml);
		assertCurrent();
		editorReady = true;
		contentDirty = false;
	}

	async function initialize(): Promise<void> {
		try {
			let source = EMPTY_DRAWIO_XML;
			if (initialExisting) {
				const status = await diagramStatus(initialExisting.sourcePath);
				assertCurrent();
				if (!status.source.exists) {
					missing = true;
					return;
				}
				const read = await readDiagramSource(initialExisting.sourcePath);
				assertCurrent();
				source = read.content;
			}
			await loadSession(source);
		} catch (cause) {
			if (!destroyed && !context.signal.aborted) error = cleanError(cause);
		} finally {
			if (!destroyed) loading = false;
		}
	}

	onMount(() => {
		previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		queueMicrotask(() => firstField?.focus());
		void initialize();
		const abort = () => {
			session?.dispose();
			session = null;
			editorReady = false;
		};
		context.signal.addEventListener('abort', abort, { once: true });
		return () => {
			destroyed = true;
			context.signal.removeEventListener('abort', abort);
			session?.dispose();
			session = null;
			previousFocus?.focus();
		};
	});

	async function relink(): Promise<void> {
		if (saving || destroyed || !coordinator.isCurrent(context)) return;
		error = null;
		loading = true;
		try {
			const selected = await relinkDiagramSource('drawio');
			assertCurrent();
			if (!selected) return;
			if (!coordinator.authorizeRelink(context, selected.relativePath)) throw new Error('DIAGRAM_OPERATION_STALE');
			const nextId = diagramIdFromSource(selected.relativePath, 'drawio');
			id = nextId;
			slug = selected.relativePath
				.split('/')
				.at(-1)!
				.replace(new RegExp(`-${nextId}\\.drawio$`), '');
			selectedSourcePath = selected.relativePath;
			missing = false;
			await loadSession(selected.content);
		} catch (cause) {
			if (!destroyed && !context.signal.aborted) error = cleanError(cause);
		} finally {
			if (!destroyed) loading = false;
		}
	}

	async function exportVectorSvg(xml: string): Promise<string> {
		const vectorXml = await prepareDrawioVectorCopy(xml);
		assertCurrent();
		exportFrameEpoch += 1;
		await tick();
		assertCurrent();
		if (!exportIframe) throw new Error('DIAGRAM_BRIDGE_UNAVAILABLE');
		const exportSession = createDrawioSession({
			iframe: exportIframe,
			hostOrigin: `${location.protocol}//${location.host}`,
			onMessage: () => {}
		});
		try {
			await exportSession.load(vectorXml);
			assertCurrent();
			const exported = await exportSession.exportSvg();
			assertCurrent();
			return drawioExportData(exported.data, 'svg');
		} finally {
			exportSession.dispose();
			exportFrameEpoch += 1;
		}
	}

	async function save(): Promise<void> {
		if (!canSave || !session || !slugValid) return;
		saving = true;
		error = null;
		failedSaveStatus = null;
		failedSaveStatusUnavailable = false;
		let publicationStarted = false;
		try {
			assertCurrent();
			const exported = await session.exportXml();
			assertCurrent();
			const xml = drawioExportData(exported.xml, 'xml');
			const svg = await exportVectorSvg(xml);
			assertCurrent();
			publicationStarted = true;
			const inserted = await coordinator.publishAndInsert(context, {
				sourcePath,
				source: xml,
				svg,
				caption,
				label: label.trim() || null,
				widthPercent
			});
			if (inserted) {
				contentDirty = false;
				onClose();
			}
		} catch (cause) {
			if (!destroyed && !context.signal.aborted) {
				error = cleanError(cause);
				if (publicationStarted && coordinator.isCurrent(context)) {
					try {
						const latestStatus = await diagramStatus(sourcePath);
						assertCurrent();
						failedSaveStatus = latestStatus;
					} catch {
						if (!destroyed && !context.signal.aborted && coordinator.isCurrent(context)) {
							failedSaveStatusUnavailable = true;
						}
					}
				}
			}
		} finally {
			if (!destroyed) saving = false;
		}
	}

	function close(choice?: 'save' | 'discard' | 'cancel'): void {
		if (choice === 'save') {
			closePrompt = false;
			void save();
			return;
		}
		if (choice === 'cancel') {
			closePrompt = false;
			return;
		}
		if (choice !== 'discard' && dirty) {
			closePrompt = true;
			return;
		}
		onClose();
	}

	function keydown(event: KeyboardEvent): void {
		if (event.key === 'Escape') {
			event.preventDefault();
			if (closePrompt) close('cancel');
			else close();
			return;
		}
		if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
			event.preventDefault();
			void save();
			return;
		}
		const root = closePrompt ? closePromptRoot : canvasRoot;
		if (event.key === 'Tab' && root) {
			const focusable = [...root.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), iframe, [tabindex="0"]')];
			const first = focusable[0];
			const last = focusable.at(-1);
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last?.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first?.focus();
			}
		}
	}
</script>

<svelte:window onkeydown={keydown} />

<section
	bind:this={canvasRoot}
	class="bg-surface-50-950 border-surface-300-700 absolute inset-0 z-40 flex min-h-0 min-w-0 flex-col overflow-hidden rounded-md border shadow-xl"
	aria-labelledby="drawio-canvas-title"
	aria-busy={loading || saving}
>
	<header class="border-surface-200-800 flex min-h-12 items-center justify-between gap-3 border-b px-4">
		<div class="min-w-0">
			<h2 id="drawio-canvas-title" class="truncate font-semibold">
				{initialExisting ? m.diagram_edit_drawio() : m.diagram_new_drawio()}
			</h2>
			<p class="text-surface-500 truncate text-xs">{sourcePath}</p>
		</div>
		<button class="btn-icon shrink-0" type="button" aria-label={m.prefs_close_aria()} onclick={() => close()} disabled={saving}>
			<X class="size-4" />
		</button>
	</header>

	<div class="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(230px,290px)_1fr]">
		<section
			class="border-surface-200-800 flex flex-col gap-3 overflow-y-auto border-b p-3 lg:border-r lg:border-b-0"
			aria-label={m.diagram_drawio_editor()}
		>
			<label class="flex flex-col gap-1 text-sm">
				<span>{m.diagram_name()}</span>
				<input bind:this={firstField} class="input" bind:value={slug} maxlength="64" disabled={Boolean(initialExisting) || saving} />
				{#if !slugValid}<small class="text-error-600">{m.diagram_name_rule()}</small>{/if}
			</label>
			<label class="flex flex-col gap-1 text-sm">
				<span>{m.diagram_caption()}</span>
				<input class="input" bind:value={caption} maxlength="500" disabled={saving} />
			</label>
			<label class="flex flex-col gap-1 text-sm">
				<span>{m.diagram_label()}</span>
				<input class="input" bind:value={label} maxlength="120" disabled={saving} />
			</label>
			<label class="flex flex-col gap-1 text-sm">
				<span class="flex justify-between"><span>{m.diagram_width()}</span><span>{widthPercent}%</span></span>
				<input class="range" type="range" min="10" max="100" step="5" bind:value={widthPercent} disabled={saving} />
			</label>
			{#if missing}
				<div class="border-warning-300 bg-warning-50 text-warning-900 rounded border p-3 text-sm" role="status">
					<p>{m.diagram_source_missing()}</p>
					<button class="btn preset-tonal mt-2" type="button" onclick={() => void relink()} disabled={saving}>
						{m.diagram_relink()}
					</button>
				</div>
			{/if}
		</section>

		<section class="relative flex min-h-[260px] min-w-0 flex-col bg-white" aria-label={m.diagram_drawio_editor()}>
			{#if loading}
				<div
					class="text-surface-700-200 absolute inset-0 z-10 flex flex-col items-center justify-center bg-surface-50-950/90 p-5 text-center"
					role="status"
				>
					<Loader2 class="size-6 animate-spin" aria-hidden="true" />
					<p class="mt-3 text-sm">{m.diagram_loading_source()}</p>
				</div>
			{/if}
			{#if error}
				<p class="border-warning-300 bg-warning-50 text-warning-900 absolute inset-x-3 top-3 z-20 rounded border p-3 text-sm" role="alert">
					{error}
				</p>
			{/if}
			{#if failedSaveStatus}
				<p
					class="border-warning-300 bg-warning-50 text-warning-900 absolute inset-x-3 top-20 z-20 rounded border p-3 text-sm"
					role="status"
				>
					{m.diagram_status_after_failed_save({ state: bundleStateLabel(failedSaveStatus.state) })}
				</p>
			{:else if failedSaveStatusUnavailable}
				<p
					class="border-warning-300 bg-warning-50 text-warning-900 absolute inset-x-3 top-20 z-20 rounded border p-3 text-sm"
					role="status"
				>
					{m.diagram_status_refresh_failed()}
				</p>
			{/if}
			<iframe
				bind:this={iframe}
				class="h-full min-h-[260px] w-full flex-1 border-0"
				referrerpolicy="no-referrer"
				title={m.diagram_drawio_editor()}
				aria-label={m.diagram_drawio_editor()}
			></iframe>
		</section>
	</div>

	<footer class="border-surface-200-800 flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2">
		<p class="text-surface-500 min-w-0 flex-1 text-xs" role="status">
			{#if saving}{m.diagram_saving()}{:else if !editorReady && !loading}{m.diagram_drawio_not_ready()}{:else}{m.diagram_canvas_offline_note()}{/if}
		</p>
		<div class="flex shrink-0 justify-end gap-2">
			<button class="btn preset-tonal" type="button" onclick={() => close()} disabled={saving}>{m.comments_cancel()}</button>
			<button class="btn preset-filled" type="button" onclick={() => void save()} disabled={!canSave}>
				{saving ? m.diagram_saving() : m.comments_save()}
			</button>
		</div>
	</footer>
</section>

{#key exportFrameEpoch}
	<iframe
		bind:this={exportIframe}
		class="pointer-events-none fixed left-[-200vw] top-0 h-[768px] w-[1024px] opacity-0"
		aria-hidden="true"
		tabindex="-1"
		title={m.diagram_drawio_editor()}
	></iframe>
{/key}

{#if closePrompt}
	<div class="absolute inset-0 z-50 flex items-center justify-center bg-black/45 p-4" role="presentation">
		<div
			bind:this={closePromptRoot}
			class="bg-surface-50-950 border-surface-300-700 w-full max-w-md rounded-lg border p-5 shadow-2xl"
			role="alertdialog"
			aria-modal="true"
			aria-labelledby="drawio-unsaved-title"
			aria-describedby="drawio-unsaved-body"
		>
			<h3 id="drawio-unsaved-title" class="text-lg font-semibold">{m.diagram_unsaved_title()}</h3>
			<p id="drawio-unsaved-body" class="text-surface-600-400 mt-2 text-sm">{m.diagram_unsaved_body()}</p>
			<div class="mt-5 flex justify-end gap-2">
				<button bind:this={promptFirstButton} class="btn preset-tonal" type="button" onclick={() => close('cancel')}
					>{m.comments_cancel()}</button
				>
				<button class="btn preset-tonal" type="button" onclick={() => close('discard')}>{m.diagram_discard()}</button>
				<button class="btn preset-filled" type="button" onclick={() => close('save')} disabled={!canSave}>{m.comments_save()}</button>
			</div>
		</div>
	</div>
{/if}
