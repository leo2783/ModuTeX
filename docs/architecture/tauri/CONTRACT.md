# Tauri 共用契約

2026-10-24：Typst 已移出產品範圍，保留 LaTeX 與 Draft。

此契約固定後端與 adapter 的目標行為。對照基準為 [host-surface.json](host-surface.json)，來源 hash 隨基準保存。各區功能、來源與驗收案例見 [capability-inventory.json](capability-inventory.json)，其審查狀態與實作完成狀態分開記錄。

## 分層

| 邊界         | 規格                                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| 前端資料模型 | 沿用 `packages/frontend-contracts` 的 11 個 DesktopPort 方法及驗證器。Rust 不依賴 Electron／舊 contracts。 |
| 傳輸         | Tauri command 接收可驗證 DTO，adapter 明確轉回 owned Uint8Array。PDF 使用有上限的 binary 傳輸。            |
| 身分         | Rust 從可信視窗／webview 取得 owner。workspace、run、PTY、watch、preview ID 都只屬於建立者。               |
| 事件         | 綁 owner、資源 ID、generation。僅發送至目標視窗，解除／切換後丟棄遲到事件。                                |
| 錯誤         | 回傳穩定 code。檔案衝突、取消、逾時、缺工具與權限錯誤可區分。前端保留稿件／舊 PDF 並提供重試。             |

## DesktopPort 狀態

開啟工作區後才允許 list/read/write/watch/compile。`closeWorkspace` 立即撤銷新操作權限，再停止監看、取消編譯並完成資源清理。ID 撤銷後不可復用。最近文件 ID 由 host 解析，不能讓 renderer 藉此指定任意絕對路徑。

寫入以 bytes、expectedRevision、documentId／documentVersion 為單位。null revision 只允許新建。保存與編譯在重疊工作區互斥，保存失敗不得清掉 dirty。另存取消回 null，失敗不得遺留半份文件／圖片。

編譯狀態為 prepared → running → draining → settled。取消可重複呼叫，但只終止一次。draining 完成前不得啟動替代 run 或釋放檔案鎖。結果需匹配 workspace、entry、runId、documentVersion、savedRevision 及輸入快照。success 才有新 PDF。結果領取、取消及關窗的競態由 host 仲裁。

## 全功能擴充

| 契約群組        | 必須保留的能力                                                                                                     | 等效驗收                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| WorkspaceFiles  | tree／scan／search、stat、文字／binary、建立／移動／複製／重新命名、回收桶與可復原刪除、undo 清理、Explorer reveal | 真實多目錄專案操作、衝突／越界拒絕、取消／復原後 bytes 核對                          |
| SourceTools     | latexindent、SyncTeX 正向／反向查詢、主檔選擇                                                                      | 真工具執行、缺工具可辨識、來源與 PDF 位置對應                                        |
| CompileConfig   | Managed／System TeX、輸出 PDF／log 路徑、使用者自訂編譯 profile                                                    | 預設與自訂專案均能編譯，路徑設定反映實際輸出                                         |
| Terminal        | availability／spawn／input／resize／kill、data／exit                                                               | 真 ConPTY、Unicode、長輸出背壓、關窗清理                                             |
| Git             | status／show HEAD／init／stage／unstage／discard／commit／userName、diff 入口                                      | 真 repo。stage／unstage 空 paths 全選，discard 空 paths 拒絕。非 repo／無 HEAD／衝突 |
| Draft           | full compile、paragraph typeset、stop／takeover／preempted、save PDF、refs／bib／images                            | 真 LuaLaTeX、warm daemon、搶占、錯誤與退出清理                                       |
| WindowsSettings | schema／locale／zoom／選單、最大化／最小化／關閉、OS 開檔、工作區聚焦／還原                                        | 原生視窗操作、未存檔三路選擇、重啟與資料匯入                                         |
| MCP             | 狀態、啟停、workspace routing、12 個既有工具、HTTP 與 stdio compatibility bridge                                   | 真 client initialize／list／call、跨工作區、停用與逾時                               |

自訂命令由使用者在可信設定介面建立 profile，host 保存 executable／argv 或明確授權的 shell command。一般 compile request 只能選 profile ID。MCP 的 `set_compile_command` 保留獨立且預設關閉的許可，不能藉 `set_output_paths` 修改命令。擴充能力不開放一般 renderer 任意 IPC／shell。

MCP 工具名固定為 `get_editor_state`、`get_unsaved`、`get_diagnostics`、`open_file`、`show_diff`、`set_view_mode`、`synctex_to_line`、`set_main_file`、`compile`、`get_compile_config`、`set_output_paths`、`set_compile_command`。需要 UI 回覆的工具確認結果後回報，不把排入命令當成已完成。

### MCP 標準互通

以下為後續版本的 MCP 契約，本版不提供入口，也不納入發布驗收。

- 協定、初始化、版本協商、通知及 transport 採官方 Rust SDK `rmcp`。不自行維護 MCP wire protocol 或要求專用 client。
- 同時交付標準 stdio 與 Streamable HTTP。stdio 提供可由 agent 啟動的 Rust 執行檔，stdout 僅協定訊息。不要求 Node.js。
- 保留 12 個工具與 host 權限／工作區隔離。內部 owner、generation 由 host 管理，外部 client 不需傳送私有欄位或私有握手。
- 標準 client 完成 initialize、tools/list、tools/call、通知、取消、斷線及重啟。以官方 SDK client、MCP Inspector 與 llama.cpp `llama-server` 分別驗證，記錄版本與結果。自己的 mock client 不算互通證據。
- llama.cpp 現行官方文件僅列 stdio MCP。使用 `mcpServers` 的 command／args 設定，驗證啟動列工具、退出、按需重啟後呼叫同一編輯器。其他支援標準 MCP 的 agent 沿用相同入口。
- 來源：[官方 Rust SDK](https://github.com/modelcontextprotocol/rust-sdk)、[llama.cpp MCP](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md#mcp-servers)。既有手寫協定候選不列為正式互通實作。

## 合併門檻

每個能力都需「舊來源／行為 → 新介面／實作 → 真實驗收」記錄。不同平台 API 可替換，使用者能力不可縮減。Draw.io 不在本契約。介面更動先更新此檔及對照案例，再交付實作 owner。

`node scripts/agents/tauri-surface.mjs --check` 比對固定來源／介面基準。新增或移除通道先審查功能對照，再使用 `--write-baseline` 更新。基準相符只代表盤點未漂移，功能等效仍由各項驗收確認。

## 前端 Tauri 檔案傳輸

`tauri-files.ts` 使用 `@tauri-apps/api` 2.12.4 的 `invoke`、`isTauri`、`listen`。`desktop.ts` 依官方 runtime 偵測選擇 adapter。引數與 DTO 使用 camelCase。owner 一律由 host 從呼叫 webview 取得。

| Command                                        | 引數                                        | 結果                                                                                            |
| ---------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `frontend_open_workspace`                      | `{kind: "file" \| "folder"}`                | `WorkspaceInfo \| null`                                                                         |
| `frontend_list_recent`                         | `{}`                                        | `RecentDocument[]`                                                                              |
| `frontend_open_recent`                         | `{id}`                                      | `WorkspaceInfo`                                                                                 |
| `frontend_remove_recent`                       | `{id}`                                      | `null`                                                                                          |
| `frontend_list_files`                          | `{workspaceId}`                             | `FileEntry[]`                                                                                   |
| `frontend_read_file`                           | `{file: FileRef}`                           | 非 PDF： `ReadReceipt` 含 `bytes: number[]`; PDF： `{workspaceId, path, revision, binaryToken}` |
| `frontend_take_file_pdf`                       | `{token}`                                   | 原始 `Uint8Array` IPC response                                                                  |
| `frontend_write_file`                          | `{request: WriteRequest}`                   | `WriteReceipt`                                                                                  |
| `frontend_save_as`                             | `{request: SaveAsRequest}`                  | `SaveAsReceipt \| null`; 未提供 `images` 時不補空值                                             |
| `frontend_watch_start` / `frontend_watch_stop` | `{workspaceId, subscriptionId, generation}` | `null`                                                                                          |
| `frontend_start_compile`                       | `{request: CompileRequest}`                 | `CompileIdentity`                                                                               |
| `frontend_compile_result`                      | `{runId}`                                   | 失敗／取消回 metadata。成功回 `{status, identity, log, diagnostics, pdfToken}`                  |
| `frontend_take_compile_pdf`                    | `{token}`                                   | 原始 `Uint8Array` IPC response                                                                  |
| `frontend_cancel_compile`                      | `{runId}`                                   | `null`                                                                                          |
| `frontend_close_workspace`                     | `{workspaceId}`                             | `null`                                                                                          |

非 PDF 讀取回傳最多 5 MiB 的密集 JSON byte array，adapter 逐項驗證後建立 owned `Uint8Array` 並套用共用驗證器。來源寫入／另存上限 5 MiB。圖片每張 5 MiB、整批 32 MiB。PDF 上限 32 MiB。

PDF read token 綁定 owner、workspace、path、revision 與同一次讀取的 bytes。compile token 綁定 owner、run ID、完整 compile identity 與 PDF 快照。token 單次消耗、短效、owner 撤銷即失效。host 發布前檢查大小與 PDF header。領取只接受 token，使用原始 binary IPC。

host 僅向所屬 webview 發送 `frontend://files/event`：`{subscriptionId, generation, event: FileEvent}`，以及 `frontend://files/error`：`{subscriptionId, generation, failure: FileWatchFailure}`。開始、停止與發送時均驗證 owner／workspace／subscription／generation。adapter 先註冊 listener，再 start。stop 等待進行中的 start，停止／取消／切換後丟棄遲到事件。

上述 Rust handler、ACL 與 owner 驗證仍須實作並通過真實 Tauri 驗收。adapter 測試不能代替 host 驗收。
