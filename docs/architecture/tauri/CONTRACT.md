# Tauri 共用契約

此契約固定後端與 adapter 的目標行為；對照基準為 [host-surface.json](host-surface.json)，來源 hash 隨基準保存。

## 分層

| 邊界 | 規格 |
|---|---|
| 前端資料模型 | 沿用 `packages/frontend-contracts` 的 11 個 DesktopPort 方法及驗證器；Rust 不依賴 Electron／舊 contracts。 |
| 傳輸 | Tauri command 接收可驗證 DTO，adapter 明確轉回 owned Uint8Array；PDF 使用有上限的 binary 傳輸。 |
| 身分 | Rust 從可信視窗／webview 取得 owner；workspace、run、PTY、watch、preview ID 都只屬於建立者。 |
| 事件 | 綁 owner、資源 ID、generation；僅發送至目標視窗，解除／切換後丟棄遲到事件。 |
| 錯誤 | 回傳穩定 code；檔案衝突、取消、逾時、缺工具與權限錯誤可區分。前端保留稿件／舊 PDF 並提供重試。 |

## DesktopPort 狀態

開啟工作區後才允許 list/read/write/watch/compile。`closeWorkspace` 立即撤銷新操作權限，再停止監看、取消編譯並完成資源清理；ID 撤銷後不可復用。最近文件 ID 由 host 解析，不能讓 renderer 藉此指定任意絕對路徑。

寫入以 bytes、expectedRevision、documentId／documentVersion 為單位；null revision 只允許新建。保存與編譯在重疊工作區互斥，保存失敗不得清掉 dirty。另存取消回 null，失敗不得遺留半份文件／圖片。

編譯狀態為 prepared → running → draining → settled。取消可重複呼叫，但只終止一次；draining 完成前不得啟動替代 run 或釋放檔案鎖。結果需匹配 workspace、entry、runId、documentVersion、savedRevision 及輸入快照；success 才有新 PDF。結果領取、取消及關窗的競態由 host 仲裁。

## 全功能擴充

| 契約群組 | 必須保留的能力 | 等效驗收 |
|---|---|---|
| WorkspaceFiles | tree／scan／search、stat、文字／binary、建立／移動／複製／重新命名、回收桶與可復原刪除、undo 清理、Explorer reveal | 真實多目錄專案操作、衝突／越界拒絕、取消／復原後 bytes 核對 |
| SourceTools | latexindent、SyncTeX 正向／反向查詢、主檔選擇 | 真工具執行、缺工具可辨識、來源與 PDF 位置對應 |
| CompileConfig | Managed／System TeX／Typst、輸出 PDF／log 路徑、使用者自訂編譯 profile | 預設與自訂專案均能編譯，路徑設定反映實際輸出 |
| Terminal | availability／spawn／input／resize／kill、data／exit | 真 ConPTY、Unicode、長輸出背壓、關窗清理 |
| Git | status／show HEAD／init／stage／unstage／discard／commit／userName、diff 入口 | 真 repo，包括空 paths 的既有全選語意、非 repo／無 HEAD／衝突 |
| Typst | 解析／管理 tinymist、LSP stdio、preview／follow／release | 真編譯／LSP／預覽、重啟、切換 owner 及停止 |
| Draft | full compile、paragraph typeset、stop／takeover／preempted、save PDF、refs／bib／images | 真 LuaLaTeX、warm daemon、搶占、錯誤與退出清理 |
| WindowsSettings | schema／locale／zoom／選單、最大化／最小化／關閉、OS 開檔、工作區聚焦／還原 | 原生視窗操作、未存檔三路選擇、重啟與資料匯入 |
| MCP | 狀態、啟停、workspace routing、12 個既有工具、HTTP 與 stdio compatibility bridge | 真 client initialize／list／call、跨工作區、停用與逾時 |

自訂命令由使用者在可信設定介面建立 profile，host 保存 executable／argv 或明確授權的 shell command；一般 compile request 只能選 profile ID。MCP 的 `set_compile_command` 保留獨立且預設關閉的許可，不能藉 `set_output_paths` 修改命令。擴充能力不開放一般 renderer 任意 IPC／shell。

MCP 工具名固定為 `get_editor_state`、`get_unsaved`、`get_diagnostics`、`open_file`、`show_diff`、`set_view_mode`、`synctex_to_line`、`set_main_file`、`compile`、`get_compile_config`、`set_output_paths`、`set_compile_command`。需要 UI 回覆的工具確認結果後回報，不把排入命令當成已完成。

## 合併門檻

每個能力都需「舊來源／行為 → 新介面／實作 → 真實驗收」記錄；不同平台 API 可替換，使用者能力不可縮減。Draw.io 不在本契約。介面更動先更新此檔及對照案例，再交付實作 owner。

`node scripts/agents/tauri-surface.mjs --check` 比對固定來源／介面基準。新增或移除通道先審查功能對照，再使用 `--write-baseline` 更新；基準相符只代表盤點未漂移，功能等效仍由各項驗收確認。
