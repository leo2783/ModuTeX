export const helpTopics = Object.freeze([
	{ id: 'getting-started', title: '開始使用' }, { id: 'editing', title: '編輯文件' },
	{ id: 'tables-math', title: '表格與公式' }, { id: 'compilation', title: 'PDF 編譯' },
	{ id: 'shortcuts', title: '快捷鍵' }, { id: 'installation', title: '0.1.0 安裝指南' },
	{ id: 'licenses', title: '授權範圍' }, { id: 'agpl', title: 'AGPL 全文' },
	{ id: 'apache', title: 'Apache 全文' }, { id: 'notices', title: '第三方聲明' }
] as const);
export type HelpTopic = typeof helpTopics[number]['id'];
export function helpTopic(hash: string): HelpTopic {
	const id = hash.slice('#/help/'.length);
	return helpTopics.find((topic) => topic.id === id)?.id ?? 'getting-started';
}
/** Original instructions match connected controls; no shell or legacy UI code. */
export const helpText: Readonly<Partial<Record<HelpTopic, string>>> = Object.freeze({
	'getting-started': '## 開啟文件\n使用工作台上方的「開啟文件」選擇 UTF-8 TeX 文件；桌面版也可開啟資料夾，從側欄選擇文件。\n## 儲存與預覽\n桌面版可儲存已開啟的文件並編譯 PDF。瀏覽器選檔不會授予磁碟寫入權限。\n開啟其他文件前，未儲存內容會要求確認；請先儲存需要保留的變更。',
	editing: '## 選擇模式\n- 原始碼：直接編輯 LaTeX，支援章節與環境折疊。\n- 視覺：編輯可辨識文字與行內格式；未知語法保留為 Raw LaTeX。\n- 對照：同時查看來源與視覺內容，兩者共用來源與復原歷史。\n## 找到章節\n側欄切換至「大綱」，選擇章節可定位文件。解析暫停時仍可編輯原始碼，並使用「重新解析」恢復大綱與視覺內容。\n## 保留未知語法\n視覺模式無法套用的修改不會覆寫來源。請切換原始碼模式編輯；修改後的大綱與視覺內容會重新更新。',
	'tables-math': '## 表格\n在原始碼、視覺或對照模式選擇「表格」。三線表可使用不加套件的等粗 hline，或預覽並確認加入 Booktabs；另有全框線與僅橫線樣式。可設定首列表頭、說明位置、表格寬度與欄寬比例。\n將游標放在本工具產生的表格內，選擇「編輯游標所在表格」；視覺表格也有編輯入口。未知欄位規格與自訂巨集請在原始碼修改。\n刪除含有內容的行列前會要求確認；面板關閉後保留本文件的草稿。\n## 公式與矩陣\n三種模式均提供公式與矩陣插入面板。矩陣每維為 1–10，可設定方陣或不同的行列數；縮小非空矩陣前會要求確認。\n矩陣以 base-LaTeX array 產生，不會自動加入套件。',
	compilation: '## 編譯 PDF\n桌面版開啟 TeX 文件後選擇「編譯 PDF」。未儲存變更會先保存；磁碟文件已被外部修改時，不覆寫也不繼續編譯。\n內建 Tectonic 缺少資源時從固定官方來源自動下載；首次編譯與新套件可能需要網路，後續使用本地快取。\n## 錯誤與取消\n- 編譯失敗或取消會保留上一份成功 PDF。\n- 具有明確入口檔名與行號的錯誤可選「前往原始碼」；文件版本改變後停止定位。\n- 其他錯誤請展開「TeX 編譯記錄」。\n- 文件修改後，預覽標示為上次編譯結果，需重新編譯更新。\n- 「取消編譯」會等待引擎結束，不代表立即釋放所有檔案與資源。',
	shortcuts: '## 文件\n- Ctrl+O／Command+O：開啟 TeX 文件。\n- Ctrl+S／Command+S：儲存目前桌面文件。\n- Ctrl+Enter／Command+Enter：編譯工作台文件；可在設定改為 Ctrl+Shift+B／Command+Shift+B 或停用。\n## 編輯器\n- Ctrl+Z／Command+Z：復原。\n- Ctrl+Shift+Z／Command+Shift+Z：重做。\n- Ctrl+Y／Command+Y：重做。\n- Escape：關閉目前插入面板，保留草稿。\n可使用 Tab 移至工具列按鈕，Enter 或 Space 啟動按鈕。',
	licenses: '## 桌面程式\nModuTeX 衍生自 Texpile；桌面程式與既有 Electron host 維持 AGPL-3.0-only。前端重寫不會自動改變完整應用的授權。\n## 新前端\n新寫的 renderer 與來源核心尚未完成獨立來源及授權審查；目前不宣稱已取得整體 Apache-2.0 授權。\n## Apache 例外\n既有 Apache-2.0 例外只適用於 scripts/vendor/vendor-manifest.mjs 與 scripts/vendor/vendor-manifest.test.mjs；不涵蓋其他程式或素材。\n## 第三方\n第三方元件維持各自授權；請閱讀「第三方聲明」及分發物附帶的 notices。'
});
