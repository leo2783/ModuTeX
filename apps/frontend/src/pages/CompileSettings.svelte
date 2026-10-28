<script lang="ts">
	import type { CompileConfig, CompileProfile, FileEntry, ReadReceipt, WorkspaceInfo } from '@modutex/frontend-contracts';
	import type { FileDesktopPort } from '../features/files/desktop.ts';
	import type { SourceDocument, SourcePatch } from '../features/document-core/core.ts';
	import { readSourceBytes } from '../features/files/read.ts';
	import { planPageMarginPatches, readPageMargins, type PageMarginsCm } from '../features/compile/page-margins.ts';
	import { text, type Language } from '../i18n/text.ts';
	import { readDocumentDate, planDocumentDatePatches, type DocumentDateMode } from '../features/compile/document-date.ts';
	import { planBilingualPatches } from '../features/compile/document-language.ts';

	interface MarginDraft { top: string; bottom: string; left: string; right: string }
	type MarginSnapshot =
		| { readonly kind: 'editor'; readonly workspaceId: string; readonly path: string; readonly documentId: string; readonly version: number }
		| { readonly kind: 'disk'; readonly workspaceId: string; readonly path: string; readonly receipt: ReadReceipt };

	let { desktop = null, workspace = null, entries = [], source = null, sourcePath = '', sourceDirty = false, sourceCommandDisabled = false,
	onApplySourcePatches = () => false, locale = 'zh-Hant' }: {
		desktop?: FileDesktopPort | null;
		workspace?: WorkspaceInfo | null;
		entries?: readonly FileEntry[];
		source?: SourceDocument | null;
		sourcePath?: string;
		sourceDirty?: boolean;
		sourceCommandDisabled?: boolean;
		onApplySourcePatches?: (identity: { readonly documentId: string; readonly version: number }, patches: readonly SourcePatch[]) => boolean;
		locale?: Language;
	} = $props();

	const t = (zh: string, en: string) => text(locale, zh, en);

	let config = $state<CompileConfig | null>(null);
	let busy = $state(false);
	let issue = $state('');
	let mainFile = $state('');
	let profile = $state<CompileProfile>('managed');
	let outputDir = $state('');
	let pdf = $state('');
	let log = $state('');
	let customCommand = $state('');
	let margins = $state<MarginDraft>({ top: '2', bottom: '2', left: '2', right: '2' });
	let marginBusy = $state(false);
	let marginIssue = $state('');
	let marginNote = $state('');
	let marginStale = $state(false);
	let marginTouched = $state(false);
	let marginSnapshot = $state.raw<MarginSnapshot | null>(null);
	let marginReadTicket = 0;
	let observedMarginTarget = '';
	let observedMarginSource = '';
	let dateMode = $state<DocumentDateMode>('none');
	let dateIssue = $state('');
	let dateNote = $state('');
	let dateBusy = $state(false);
	let dateTouched = false;
	let dateDocument = $state.raw<SourceDocument | null>(null);
	let languageBusy = $state(false);
	let languageIssue = $state('');
	let languageNote = $state('');
	async function applyBilingual() {
		const snapshot = marginSnapshot, document = dateDocument, port = desktop, owner = workspace;
		if (!snapshot || !document || !port || !owner || languageBusy || marginBusy || dateBusy || sourceCommandDisabled || marginStale || mainFile !== (config?.mainFile ?? '')) return;
		languageBusy = true; languageIssue = ''; languageNote = '';
		try {
			const patches = planBilingualPatches(document);
			if (snapshot.kind === 'editor') {
				if (!source || source.documentId !== document.documentId || source.version !== document.version || comparablePath(sourcePath) !== comparablePath(snapshot.path)) throw new Error('STALE_SOURCE');
				if (patches.length && !onApplySourcePatches({ documentId: document.documentId, version: document.version }, patches)) throw new Error('STALE_SOURCE');
			} else if (patches.length) {
				const updated = document.apply({ expectedVersion: document.version, patches }).document;
				await port.writeFile({ workspaceId: owner.id, path: snapshot.path, bytes: updated.toBytes(), expectedRevision: snapshot.receipt.revision, documentId: updated.documentId, documentVersion: updated.version });
			}
			languageNote = patches.length
				? t('中英文排版已套用。儲存後以託管引擎或 XeLaTeX 重新編譯。首次使用需下載字型與套件。', 'Chinese and English typesetting enabled. Save and recompile with the managed engine or XeLaTeX. Fonts and packages download on first use.')
				: t('文件已有中文排版設定，請依原始碼中的字型設定編譯。', 'The document already configures Chinese typesetting. Compile using its existing font settings.');
			await loadPageMargins(snapshot.path, source, !!source && comparablePath(sourcePath) === comparablePath(snapshot.path));
		} catch { languageIssue = t('未套用中英文排版。請重新載入；自訂前言請在原始碼調整。', 'Typesetting settings were not applied. Reload, or edit a custom preamble in source mode.'); }
		finally { languageBusy = false; }
	}
	function acceptDate(document: SourceDocument) {
		dateDocument = document;
		try { dateMode = readDocumentDate(document).mode; dateIssue = ''; }
		catch { dateIssue = t('無法安全判讀日期設定，請在原始碼調整。', 'Date settings cannot be read safely. Edit the source.'); }
	}
	async function applyDate() {
		const snapshot = marginSnapshot, document = dateDocument, port = desktop, owner = workspace;
		if (!snapshot || !document || !port || !owner || dateMode === 'custom' || dateBusy || sourceCommandDisabled || marginStale || mainFile !== (config?.mainFile ?? '')) return;
		dateBusy = true; dateIssue = ''; dateNote = '';
		try {
			const patches = planDocumentDatePatches(document,dateMode);
			if (snapshot.kind === 'editor') {
				if (!source || source.documentId !== document.documentId || source.version !== document.version || comparablePath(sourcePath) !== comparablePath(snapshot.path)) throw new Error('STALE_SOURCE');
				if (patches.length && !onApplySourcePatches({documentId:document.documentId,version:document.version},patches)) throw new Error('STALE_SOURCE');
			} else if (patches.length) {
				const updated = document.apply({expectedVersion:document.version,patches}).document;
				await port.writeFile({workspaceId:owner.id,path:snapshot.path,bytes:updated.toBytes(),expectedRevision:snapshot.receipt.revision,documentId:updated.documentId,documentVersion:updated.version});
			}
			dateNote = t('日期設定已套用至主文件；儲存並重新編譯後生效。', 'Date settings applied to the main file. Save and recompile.');
			dateTouched = false;
			await loadPageMargins(snapshot.path,source,!!source && comparablePath(sourcePath) === comparablePath(snapshot.path));
		} catch { dateIssue = t('日期未套用。文件可能已變更，請重新載入後再試。', 'Date was not applied. The file may have changed. Reload and try again.'); }
		finally { dateBusy = false; }
	}

	function comparablePath(value: string): string {
		return value.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '').replace(/\/{2,}/g, '/').toLowerCase();
	}

	function activeMainPath(): string {
		return mainFile || (sourcePath.toLowerCase().endsWith('.tex') ? sourcePath : '');
	}

	function displayCentimeters(value: number): string {
		return String(Number(value.toFixed(4)));
	}

	function acceptMarginReading(reading: ReturnType<typeof readPageMargins>) {
		margins = {
			top: displayCentimeters(reading.margins.top),
			bottom: displayCentimeters(reading.margins.bottom),
			left: displayCentimeters(reading.margins.left),
			right: displayCentimeters(reading.margins.right)
		};
		marginTouched = false;
		marginStale = false;
		marginIssue = '';
		const anyExplicit = Object.values(reading.explicitSides).some(Boolean);
		marginNote = reading.explicit
			? t('數值取自主 TeX 文件的 geometry 設定。', 'Values are read from the main TeX geometry settings.')
			: anyExplicit
				? t('主 TeX 只明確設定部分頁邊距。其他欄位顯示 2 cm，套用後會寫入。', 'The main TeX file defines only some margins. Other fields show 2 cm defaults, which will be written when applied.')
				: t('主 TeX 未明確設定頁邊距。欄位顯示 2 cm，套用後才會寫入。', 'The main TeX file has no explicit margins. Fields show 2 cm defaults, which take effect after applying.');
	}

	async function loadPageMargins(path: string, selectedSource: SourceDocument | null, isSelectedSource: boolean) {
		const ticket = ++marginReadTicket;
		const owner = workspace;
		const port = desktop;
		marginBusy = true;
		marginIssue = '';
		marginNote = '';
		if (!owner || !port || !path) {
			dateDocument = null;
			marginSnapshot = null;
			marginNote = t('請先選擇工作區主 TeX 文件。', 'Choose a main TeX file first.');
			marginBusy = false;
			return;
		}
		try {
			if (isSelectedSource && selectedSource) {
				const reading = readPageMargins(selectedSource.read());
				if (ticket !== marginReadTicket || workspace?.id !== owner.id) return;
				marginSnapshot = { kind: 'editor', workspaceId: owner.id, path,
					documentId: selectedSource.documentId, version: selectedSource.version };
				acceptMarginReading(reading);
				if (!dateTouched) acceptDate(selectedSource);
			} else {
				const receipt = await port.readFile({ workspaceId: owner.id, path });
				if (ticket !== marginReadTicket || workspace?.id !== owner.id ||
					receipt.workspaceId !== owner.id || comparablePath(receipt.path) !== comparablePath(path)) return;
				const document = readSourceBytes(receipt.bytes,
					receipt.documentId !== null && receipt.documentVersion !== null
						? { documentId: receipt.documentId, version: receipt.documentVersion }
						: undefined);
				const reading = readPageMargins(document.read());
				marginSnapshot = { kind: 'disk', workspaceId: owner.id, path, receipt };
				acceptMarginReading(reading);
				if (!dateTouched) acceptDate(document);
			}
		} catch (error) {
			if (ticket !== marginReadTicket) return;
			marginSnapshot = null;
			marginIssue = error instanceof Error && error.message === 'GEOMETRY_UNSUPPORTED'
				? t('無法安全判讀此文件的頁面設定。請在 TeX 原始碼中調整。', 'Page geometry cannot be read safely. Adjust it in the TeX source.')
				: t('無法讀取主 TeX 文件的頁邊距。請重新載入後再試。', 'Main TeX margins could not be read. Reload and try again.');
		} finally {
			if (ticket === marginReadTicket) marginBusy = false;
		}
	}

	$effect(() => {
		const path = activeMainPath();
		const ownerId = workspace?.id ?? '';
		const selectedSource = source;
		const isSelectedSource = !!selectedSource && comparablePath(path) === comparablePath(sourcePath);
		const targetKey = `${ownerId}|${comparablePath(path)}`;
		const sourceKey = isSelectedSource && selectedSource ? `${selectedSource.documentId}|${selectedSource.version}` : '';
		if (targetKey !== observedMarginTarget) {
			languageIssue = ''; languageNote = '';
			dateTouched = false; dateDocument = null; dateNote = '';
			observedMarginTarget = targetKey;
			observedMarginSource = sourceKey;
			marginTouched = false;
			marginStale = false;
			void loadPageMargins(path, selectedSource, isSelectedSource);
			return;
		}
		if (sourceKey !== observedMarginSource) {
			observedMarginSource = sourceKey;
			if (marginTouched) {
				marginStale = true;
				marginIssue = t('主文件已變更。請重新載入頁邊距後再套用。', 'The main file changed. Reload margins before applying.');
			} else void loadPageMargins(path, selectedSource, isSelectedSource);
		}
	});

	function updateMargin(side: keyof MarginDraft, event: Event) {
		margins = { ...margins, [side]: (event.currentTarget as HTMLInputElement).value };
		marginTouched = true;
		marginIssue = '';
	}

	function reloadMargins() {
		dateTouched = false;
		marginTouched = false;
		marginStale = false;
		void loadPageMargins(activeMainPath(), source,
			!!source && comparablePath(sourcePath) === comparablePath(activeMainPath()));
	}

	function numericMargins(): PageMarginsCm {
		const value = {
			top: Number(margins.top.trim()),
			bottom: Number(margins.bottom.trim()),
			left: Number(margins.left.trim()),
			right: Number(margins.right.trim())
		};
		for (const amount of Object.values(value)) {
			if (!Number.isFinite(amount) || amount <= 0 || amount > 50) throw new Error('INVALID_PAGE_MARGIN');
		}
		return value;
	}

	async function applyMargins() {
		if (!desktop || !workspace || !config || busy || marginBusy || marginStale || sourceCommandDisabled) return;
		let values: PageMarginsCm;
		try { values = numericMargins(); }
		catch {
			marginIssue = t('四邊頁邊距須為大於 0 且不超過 50 cm 的數值。', 'Each margin must be a number greater than 0 and no more than 50 cm.');
			return;
		}
		if (mainFile !== (config.mainFile ?? '')) {
			if (!await save()) return;
		}
		const path = activeMainPath();
		const snapshot = marginSnapshot;
		const owner = workspace;
		const port = desktop;
		if (!path || !snapshot || snapshot.workspaceId !== owner.id || comparablePath(snapshot.path) !== comparablePath(path)) {
			marginIssue = t('主文件已變更。請重新載入頁邊距後再套用。', 'The main file changed. Reload margins before applying.');
			marginStale = true;
			return;
		}
		marginBusy = true;
		marginIssue = '';
		try {
			if (snapshot.kind === 'editor') {
				const current = source;
				if (!current || comparablePath(sourcePath) !== comparablePath(path) ||
					current.documentId !== snapshot.documentId || current.version !== snapshot.version) throw new Error('STALE_SOURCE');
				const patches = planPageMarginPatches(current.read(), values, current.profile.preferredLineEnding);
				if (!onApplySourcePatches({ documentId: current.documentId, version: current.version }, patches)) throw new Error('STALE_SOURCE');
				marginTouched = false;
				marginNote = t('已套用至目前主文件草稿。變更可復原，並需儲存後編譯。', 'Applied to the current main-file draft. You can undo the change. Save before compiling.');
			} else {
				const receipt = snapshot.receipt;
				const document = readSourceBytes(receipt.bytes,
					receipt.documentId !== null && receipt.documentVersion !== null
						? { documentId: receipt.documentId, version: receipt.documentVersion }
						: undefined);
				const patches = planPageMarginPatches(document.read(), values, document.profile.preferredLineEnding);
				if (patches.length > 0) {
					const updated = document.apply({ expectedVersion: document.version, patches }).document;
					await port.writeFile({ workspaceId: owner.id, path, bytes: updated.toBytes(),
						expectedRevision: receipt.revision, documentId: updated.documentId, documentVersion: updated.version });
				}
				if (workspace?.id !== owner.id) return;
				marginNote = t('已依檔案版本更新主 TeX，未修改目前選取的文件。', 'The main TeX file was updated against its read revision. The selected document was not changed.');
				marginTouched = false;
			}
			await loadPageMargins(path, source, !!source && comparablePath(sourcePath) === comparablePath(path));
		} catch (error) {
			if (workspace?.id !== owner.id) return;
			marginIssue = error instanceof Error && (error.message === 'FILE_CHANGED' || error.message === 'FILE_CONFLICT' || error.message === 'STALE_SOURCE')
				? t('主文件已變更，沒有覆寫內容。請重新載入頁邊距後再試。', 'The main file changed and was not overwritten. Reload margins and try again.')
				: error instanceof Error && error.message === 'GEOMETRY_UNSUPPORTED'
					? t('無法安全修改此文件的頁面設定。請在 TeX 原始碼中調整。', 'Page geometry cannot be changed safely. Adjust it in the TeX source.')
					: t('頁邊距未套用。請重新載入後再試。', 'Margins were not applied. Reload and try again.');
			marginStale = true;
		} finally {
			marginBusy = false;
		}
	}

	function adopt(value: CompileConfig) {
		config = value;
		mainFile = value.mainFile ?? '';
		profile = value.profile;
		outputDir = value.outputDir ?? '';
		pdf = value.pdf ?? '';
		log = value.log ?? '';
		customCommand = value.customCommand ?? '';
	}

	async function load() {
		if (!desktop || !workspace) {
			config = null;
			return;
		}
		busy = true;
		issue = '';
		try {
			const next = await desktop.getCompileConfig(workspace.id);
			if (workspace?.id !== next.workspaceId) return;
			adopt(next);
		} catch {
			issue = t('無法讀取編譯設定。', 'Compile configuration could not be read.');
		} finally {
			busy = false;
		}
	}

	$effect(() => {
		const owner = workspace;
		const port = desktop;
		if (!owner || !port) {
			config = null;
			return;
		}
		let current = true;
		void port.getCompileConfig(owner.id).then((next) => {
			if (!current || workspace?.id !== next.workspaceId) return;
			adopt(next);
			issue = '';
		}).catch(() => {
			if (current) issue = t('無法讀取編譯設定。', 'Compile configuration could not be read.');
		});
		return () => { current = false; };
	});

	async function save(): Promise<boolean> {
		if (!desktop || !workspace || !config || busy) return false;
		busy = true;
		issue = '';
		let saved = false;
		try {
			const next = await desktop.updateCompileConfig({
				workspaceId: workspace.id,
				expectedRevision: config.revision,
				mainFile: mainFile || null,
				profile,
				outputDir: outputDir || null,
				pdf: pdf || null,
				log: log || null,
				customCommand: profile === 'custom' ? customCommand : null
			});
			if (workspace?.id === next.workspaceId) {
				adopt(next);
				saved = true;
			}
		} catch (error) {
			issue = error instanceof Error && error.message === 'CONFIG_CONFLICT'
				? t('設定已在其他地方變更。請重新載入後再儲存。', 'Configuration changed elsewhere. Reload before saving.')
				: t('設定未儲存。請檢查工作區相對路徑與既有目錄。', 'Configuration was not saved. Check workspace-relative paths and existing directories.');
		} finally {
			busy = false;
		}
		return saved;
	}

</script>

<section class="compile-settings-section" aria-labelledby="compile-settings-title">
	<div class="settings-container">
		<header class="settings-header">
			<h2 id="compile-settings-title" tabindex="-1">{t('編譯設定', 'Compile settings')}</h2>
		</header>
		{#if !desktop}
			<p class="settings-status" role="status">{t('此執行環境不支援桌面編譯設定。', 'Desktop compile configuration is unavailable in this runtime.')}</p>
		{:else if !workspace}
			<p class="settings-status" role="status">{t('設定編譯設定檔前，請先開啟工作區。', 'Open a workspace before configuring its compile profile.')}</p>
		{:else}
			{#if issue}<p class="settings-alert" role="alert">{issue}</p>{/if}
			<section class="settings-section" aria-labelledby="workspace-profile-heading">
				<fieldset class="settings-fieldset" disabled={busy || !config}>
					<legend class="settings-legend">
						<h3 id="workspace-profile-heading">{t('工作區設定檔', 'Workspace profile')}</h3>
					</legend>
					<div class="fields-stack">
						<div class="form-row two-cols">
							<label for="compile-main-file" class="form-field">
								<span class="field-label">{t('主 TeX 文件', 'Main TeX file')}</span>
								<select id="compile-main-file" bind:value={mainFile}>
									<option value="">{t('選擇主文件', 'Choose a main file')}</option>
									{#each entries.filter((entry) => entry.kind === 'file' && entry.path.toLowerCase().endsWith('.tex')) as entry}
										<option value={entry.path}>{entry.path}</option>
									{/each}
								</select>
							</label>
							<label for="compile-profile" class="form-field">
								<span class="field-label">{t('編譯引擎設定檔', 'Engine profile')}</span>
								<select id="compile-profile" bind:value={profile}>
									<option value="managed">{t('內建引擎', 'Managed')}</option>
									<option value="system">{t('系統 TeX', 'System TeX')}</option>
									<option value="custom" disabled={config ? !config.canSetCommand : true}>{t('使用者授權自訂命令', 'User-authorized custom command')}</option>
								</select>
							</label>
		</div>
						<label for="compile-output-dir" class="form-field">
							<span class="field-label">{t('輸出目錄（必須已存在於工作區內）', 'Output directory (must already exist in the workspace)')}</span>
							<input id="compile-output-dir" bind:value={outputDir} autocomplete="off" spellcheck="false" />
						</label>
						<div class="form-row two-cols">
							<label for="compile-pdf-path" class="form-field">
								<span class="field-label">{t('PDF 路徑（選用，覆寫預設輸出目錄）', 'PDF path (optional, overrides the output-directory default)')}</span>
								<input id="compile-pdf-path" bind:value={pdf} autocomplete="off" spellcheck="false" />
							</label>
							<label for="compile-log-path" class="form-field">
								<span class="field-label">{t('記錄路徑（選用，覆寫預設輸出目錄）', 'Log path (optional, overrides the output-directory default)')}</span>
								<input id="compile-log-path" bind:value={log} autocomplete="off" spellcheck="false" />
							</label>
						</div>
						{#if profile === 'custom'}
							<label for="compile-custom-command" class="form-field">
								<span class="field-label">{t('受信任的命令範本，使用 {main} 與 {out} 預留位置', 'Trusted command template. Use {main} and {out} placeholders.')}</span>
								<input id="compile-custom-command" bind:value={customCommand} maxlength="4096" autocomplete="off" spellcheck="false" />
							</label>
						{/if}
					</div>
				</fieldset>
				<footer class="settings-actions">
					<button type="button" class="primary" onclick={save} disabled={busy || !config}>{t('儲存工作區編譯設定', 'Save workspace compile settings')}</button>
					<button type="button" onclick={load} disabled={busy}>{t('重新載入設定', 'Reload configuration')}</button>
				</footer>
			</section>
			<section class="settings-section" aria-labelledby="document-language-heading">
				<h3 id="document-language-heading">{t('中英文排版', 'Chinese and English typesetting')}</h3>
				<p>{t('新文件已支援中英文混排。既有文件可加入 CTEX 與 Fandol 中文字型，保留英文標題樣式。請使用託管引擎或 XeLaTeX；首次使用需下載套件與字型。', 'New documents support mixed Chinese and English. Add CTEX and Fandol Chinese fonts to an existing document while keeping English heading styles. Use the managed engine or XeLaTeX. Packages and fonts download on first use.')}</p>
				{#if languageIssue}<p role="alert" class="settings-alert">{languageIssue}</p>{/if}
				{#if languageNote}<p role="status" class="settings-status">{languageNote}</p>{/if}
				<footer class="settings-actions">
					<button type="button" class="primary" onclick={applyBilingual} disabled={!dateDocument || !marginSnapshot || marginBusy || dateBusy || languageBusy || busy || marginStale || sourceCommandDisabled || mainFile !== (config?.mainFile ?? '')}>{t('啟用中英文排版', 'Enable Chinese and English')}</button>
				</footer>
			</section>
			<section class="settings-section" aria-labelledby="document-date-heading">
				<h3 id="document-date-heading">{t('文件日期', 'Document date')}</h3>
				<p>{t('自動日期會在每次編譯時更新。數字格式不依介面或文件語言變更；新模板預設不顯示日期。', 'Automatic dates update on each compilation. Numeric formats are independent of interface and document language. New templates hide dates by default.')}</p>
				<label class="form-field" for="document-date-mode"><span class="field-label">{t('自動帶入日期', 'Automatic date')}</span>
					<select id="document-date-mode" value={dateMode} onchange={event => { dateMode = event.currentTarget.value as DocumentDateMode; dateTouched = true; dateNote = ''; }} disabled={!dateDocument || marginBusy || dateBusy || !!dateIssue}>
						<option value="none">{t('不顯示日期', 'Hide date')}</option>
						<option value="iso">{t('自動日期：YYYY-MM-DD', 'Automatic: YYYY-MM-DD')}</option>
						<option value="slash">{t('自動日期：YYYY/MM/DD', 'Automatic: YYYY/MM/DD')}</option>
						<option value="day-first">{t('自動日期：DD/MM/YYYY', 'Automatic: DD/MM/YYYY')}</option>
						<option value="document">{t('自動日期：依文件設定', 'Automatic: document format')}</option>
						{#if dateMode === 'custom'}<option value="custom" disabled>{t('保留現有自訂日期', 'Keep existing custom date')}</option>{/if}
					</select>
				</label>
				{#if dateIssue}<p role="alert" class="settings-alert">{dateIssue}</p>{/if}
				{#if dateNote}<p role="status" class="settings-status">{dateNote}</p>{/if}
				<footer class="settings-actions">
					<button type="button" class="primary" onclick={applyDate} disabled={!dateDocument || !marginSnapshot || marginBusy || dateBusy || busy || marginStale || sourceCommandDisabled || dateMode === 'custom' || !!dateIssue || mainFile !== (config?.mainFile ?? '')}>{t('套用日期設定', 'Apply date settings')}</button>
					<button type="button" onclick={reloadMargins} disabled={marginBusy || dateBusy}>{t('重新載入', 'Reload')}</button>
				</footer>
			</section>
			<section class="settings-section margin-settings" aria-labelledby="page-margins-heading">
				<header class="margin-settings-header">
					<h3 id="page-margins-heading">{t('頁邊距', 'Page margins')}</h3>
					<p>{t('調整主 TeX 文件的 geometry 頁邊距。', 'Set the geometry margins in the main TeX file.')}</p>
				</header>
				{#if marginIssue}<p class="settings-alert" role="alert">{marginIssue}</p>{/if}
				{#if marginNote}<p class="settings-status" role="status">{marginBusy ? t('正在讀取主文件頁邊距…', 'Reading main-file margins…') : marginNote}</p>{/if}
				{#if marginSnapshot?.kind === 'editor' && sourceDirty}
					<p class="settings-status">{t('主文件草稿有未儲存修改。套用會加入可復原的編輯交易，儲存後才能編譯。', 'The main-file draft has unsaved edits. Applying adds an undoable editor transaction. Save before compiling.')}</p>
				{:else if marginSnapshot?.kind === 'disk'}
					<p class="settings-status">{t('套用時會比對主文件版本，並保留目前選取的文件。', 'Applying checks the main-file revision and keeps the selected document unchanged.')}</p>
				{/if}
				<div class="form-row margins" role="group" aria-label={t('四邊頁邊距', 'Four page margins')}>
					<label for="compile-margin-top" class="form-field">
						<span class="field-label">{t('上頁邊距 (cm)', 'Top margin (cm)')}</span>
						<input id="compile-margin-top" type="number" min="0.01" max="50" step="0.1" value={margins.top} oninput={(event) => updateMargin('top', event)} disabled={marginBusy || !config || !marginSnapshot || marginStale} />
					</label>
					<label for="compile-margin-bottom" class="form-field">
						<span class="field-label">{t('下頁邊距 (cm)', 'Bottom margin (cm)')}</span>
						<input id="compile-margin-bottom" type="number" min="0.01" max="50" step="0.1" value={margins.bottom} oninput={(event) => updateMargin('bottom', event)} disabled={marginBusy || !config || !marginSnapshot || marginStale} />
					</label>
					<label for="compile-margin-left" class="form-field">
						<span class="field-label">{t('左頁邊距 (cm)', 'Left margin (cm)')}</span>
						<input id="compile-margin-left" type="number" min="0.01" max="50" step="0.1" value={margins.left} oninput={(event) => updateMargin('left', event)} disabled={marginBusy || !config || !marginSnapshot || marginStale} />
					</label>
					<label for="compile-margin-right" class="form-field">
						<span class="field-label">{t('右頁邊距 (cm)', 'Right margin (cm)')}</span>
						<input id="compile-margin-right" type="number" min="0.01" max="50" step="0.1" value={margins.right} oninput={(event) => updateMargin('right', event)} disabled={marginBusy || !config || !marginSnapshot || marginStale} />
					</label>
				</div>
				<footer class="settings-actions">
				<button type="button" class="primary" onclick={applyMargins} disabled={busy || marginBusy || sourceCommandDisabled || !config || !marginSnapshot || marginStale}>{t('套用頁邊距', 'Apply margins')}</button>
					<button type="button" onclick={reloadMargins} disabled={marginBusy}>{t('重新載入頁邊距', 'Reload margins')}</button>
				</footer>
			</section>
		{/if}
	</div>
</section>

<style>
	.compile-settings-section {
		min-width: 0;
		max-width: 840px;
		margin: 28px 0;
	}
	.settings-container {
		min-width: 0;
	}
	.settings-header {
		margin-bottom: 24px;
		min-width: 0;
	}
	h2 {
		margin: 0;
		padding-bottom: 12px;
		font-size: 18px;
		font-weight: 650;
		border-bottom: 1px solid var(--line);
		min-width: 0;
		overflow-wrap: break-word;
		color: var(--ink);
	}
	h3 {
		margin: 0;
		padding-bottom: 12px;
		font-size: 16px;
		font-weight: 650;
		border-bottom: 1px solid var(--line);
		min-width: 0;
		overflow-wrap: break-word;
		color: var(--ink);
	}
	.settings-section {
		margin: 28px 0;
		min-width: 0;
	}
	.margin-settings-header p {
		margin: 8px 0 16px;
		color: var(--muted);
		font-size: 13px;
		line-height: 1.5;
	}
	.settings-fieldset {
		border: none;
		margin: 0;
		padding: 0;
		min-width: 0;
	}
	.settings-legend {
		display: block;
		width: 100%;
		padding: 0;
		margin: 0 0 20px;
		min-width: 0;
	}
	h2:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
		border-radius: 2px;
	}
	.fields-stack {
		display: flex;
		flex-direction: column;
		gap: 20px;
		min-width: 0;
	}
	.form-row.two-cols {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 16px;
		min-width: 0;
	}
	.form-row.margins {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 12px;
		min-width: 0;
	}
	.form-field {
		display: flex;
		flex-direction: column;
		gap: 8px;
		min-width: 0;
	}
	.field-label {
		font-size: 13px;
		font-weight: 600;
		color: var(--ink);
		line-height: 1.4;
		min-width: 0;
		overflow-wrap: break-word;
		word-break: break-word;
	}
	input,
	select {
		color: var(--ink);
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: 4px;
		min-height: 36px;
		padding: 6px 10px;
		min-width: 0;
		width: 100%;
		box-sizing: border-box;
		font: inherit;
		font-size: 14px;
	}
	input:focus-visible,
	select:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.settings-actions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 12px;
		margin-top: 28px;
		padding-top: 20px;
		border-top: 1px solid var(--line);
		min-width: 0;
	}
	.settings-actions button {
		min-height: 36px;
		padding: 7px 16px;
		font: inherit;
		font-size: 14px;
		font-weight: 500;
		border-radius: 4px;
		cursor: pointer;
		min-width: 0;
	}
	.settings-actions button.primary {
		color: var(--surface);
		background: var(--accent);
		border: 1px solid var(--accent);
	}
	.settings-actions button.primary:hover:not(:disabled) {
		filter: brightness(1.08);
	}
	.settings-actions button:disabled {
		opacity: 0.48;
		cursor: not-allowed;
	}
	.settings-alert {
		margin: 0 0 20px;
		padding: 10px 14px;
		border-radius: 4px;
		border: 1px solid var(--error);
		background: var(--surface);
		color: var(--error);
		font-size: 14px;
		line-height: 1.5;
		overflow-wrap: break-word;
	}
	.settings-status {
		color: var(--muted);
		line-height: 1.6;
		margin: 16px 0;
		font-size: 14px;
		overflow-wrap: break-word;
	}
	@media (max-width: 680px) {
		.form-row.two-cols {
			grid-template-columns: minmax(0, 1fr);
			gap: 20px;
		}
		.form-row.margins {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.settings-actions {
			flex-direction: column;
			align-items: stretch;
		}
		.settings-actions button {
			width: 100%;
			text-align: center;
		}
	}
</style>
