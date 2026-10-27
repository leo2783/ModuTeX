# 儲存格結構切換修復與測試報告

日期：2026-10-27。修復分支：`fix/notebook-cell-transitions`，基底為本機與 `origin/dev` 一致的 `074c5da6d107afd85ee9ca180dd6ea0bd5dc9f97`。

## 假設、重現與修正

先依使用者操作建立回歸案例，再修改程式。第一輪有 17 個案例失敗，分別重現新增兩格、Unicode 輸入後取得空內容，以及摘要多出前後空白行。

| 問題／追加假設                         | 測試發現                                                              | 修正                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 二級標題上方新增卻出現兩格             | 標題與摘要被當成需要雙 `\par` 隔開的正文                              | 共用 `boundaryBeforeText()`，依儲存格角色判定；邊界選單與工具列採同一規則               |
| 先打字再選摘要，文字消失               | 原生 ProseMirror 節點保留舊座標，但來源與 canonical projection 已前進 | `textStructureSelection()` 從目前投影擷取座標；交易層重新讀取來源內容                   |
| 摘要儲存格過大                         | 環境語法前後的換行被當成內容                                          | 投影排除每端一個語法換行，保留明確的 TeX 換行與內容空白；空摘要仍可輸入                 |
| 論文題目／正文／摘要反覆切換後狀態異常 | 舊編輯快照可能由取消操作寫回；空正文也可能失去儲存格邊界              | 結構提交後同步投影、重選轉換後的儲存格並更新取消起點；正文統一使用 `\par`               |
| 重複選同一結構                         | 累積來源換行與無效復原步驟                                            | 沿用現有相鄰換行；相同內容不建立交易變更                                                |
| 畫面更新但其他工具仍讀舊投影           | 延遲解析器測試中，`onProjection` 版本落後來源                         | 同步結構提交與 worker 回覆共用 `acceptProjection()`，統一版本檢查、摺疊、大綱及畫面發布 |
| Unicode 空白單獨成格                   | 廣義 `trim()` 會把部分使用者字元當成分隔符號                          | 只辨認 ASCII 來源分隔空白；保留 NBSP、全形空白與其他 Unicode 內容                       |

## 底層架構

[structure.ts](../../apps/frontend/src/features/source-editor/structure.ts) 集中處理六種結構的包裝、正文邊界、來源版本與內容範圍檢查、換行格式，以及前言題目移入正文。所有修改沿用 `sourcePatchTransaction()`、5 MiB 限制與既有 CodeMirror 復原記錄。

[SourceView.svelte](../../apps/frontend/src/features/source-editor/SourceView.svelte) 負責呼叫交易及發布投影；[view.ts](../../apps/frontend/src/features/visual-editor/view.ts) 負責選取、插入邊界與編輯階段；[schema.ts](../../apps/frontend/src/features/visual-editor/schema.ts) 負責語法到畫面的投影。一般輸入仍走既有增量更新，結構指令才立即解析並發布目前版本。

## 新增測試範圍

| 測試檔案                                                                              | 行為驗證                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [cell-transitions.test.ts](../../apps/frontend/tests/editor/cell-transitions.test.ts) | 50 個測試；含即時輸入座標、上方插入數量、摘要高度來源、空儲存格、取消、過期／外來選取、唯讀、5 MiB 邊界與前言題目搬移                                                                          |
| 同上：結構組合                                                                        | 正文、題目、摘要及三級標題共 36 個有向組合；9 種內容 × LF／CRLF／CR，共 27 組樣本逐一執行，檢查相鄰儲存格、游標與逐位元組復原／重做                                                            |
| 同上：Unicode                                                                         | 繁中、日韓文、擴展漢字、輔助平面音樂符號、ZWJ、膚色修飾、旗幟序列、variation selector、組合附加符號、印度文字、阿拉伯文／希伯來文、RTL 隔離字元、NBSP、零寬／全形空白及 Unicode 行／段分隔字元 |
| 同上：複合內容                                                                        | 巢狀粗斜體、行內公式、連續 TeX 換行、跳換結構後繼續輸入，以及保留未知語法儲存格                                                                                                                |
| [structure-client.test.ts](../../apps/frontend/tests/editor/structure-client.test.ts) | 編譯並掛載實際 Svelte `SourceView`，操作貼上與工具列；刻意延遲排程，仍使用實際 `ParserEngine` 與 Rust WASM 解析器；驗證發布版本、連續切換、取消及原始碼／視覺模式往返                          |
| [cell-transitions.e2e.mjs](../../apps/frontend/tests/e2e/cell-transitions.e2e.mjs)    | 真實 Edge 鍵盤、選單、二級標題上方新增一格、接續輸入、復原、模式切換與摘要實際尺寸                                                                                                             |

## 執行方式與結果

工作目錄為儲存庫根目錄。環境：Windows、Node.js 24.22.1、npm 11.19.1、Playwright 使用本機 Edge headless。

| 命令                                                                                                                                                                                | 結果                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `npm run frontend:test`                                                                                                                                                             | 453／453 通過；0 skipped                                              |
| `node --import ./apps/frontend/tests/helpers/document-core-wasm.mjs --test apps/frontend/tests/editor/cell-transitions.test.ts apps/frontend/tests/editor/structure-client.test.ts` | 新增 51／51 通過                                                      |
| `node --test --test-concurrency=1 apps/frontend/tests/e2e/cell-transitions.e2e.mjs apps/frontend/tests/e2e/editor-toolbar.e2e.mjs`                                                  | 2／2 通過；涵蓋既有文字格式、公式刪除／復原、接續換行與關閉對話框回歸 |
| `npm run frontend:check`                                                                                                                                                            | 0 errors、0 warnings                                                  |
| `npm run frontend:build`                                                                                                                                                            | 建置成功；既有大型 chunk 提示仍存在                                   |
| `node --test tests/scripts/source-no-emoji.test.mjs`                                                                                                                                | 2／2 通過；複合 Unicode 測試資料用 code point 建立                    |
| `git diff --check`                                                                                                                                                                  | 通過                                                                  |

第一次完整測試在沙箱內得到 448 通過、1 失敗，失敗原因為 Windows 沙箱禁止測試建立 symlink。該基礎設施測試在沙箱外重跑為 7／7 通過。最後完整測試與瀏覽器測試於沙箱外執行，未略過或放寬斷言。

摘要在 1280 × 800 與 640 × 800 視窗下，單行內容高度均為 **80.375 px**，行高 **27.2 px**，沒有水平溢位。已檢視兩張實際截圖。

本機證據位於 `.verification-artifacts/`：`cell-transition-suite-final.log`、`cell-transitions-tests.log`、`cell-transition-browser-final.log`、`cell-transition-browser.json`、`cell-transition-abstract-1280.png`、`cell-transition-abstract-640.png`、`cell-transition-check.log`、`cell-transition-build-final.log`、`cell-transition-source-policy.log`。

範圍界線：本次驗證前端與真實 Edge；未重新建置 Windows 安裝包，未以實體中文輸入法驗證 composition，未把所有 Unicode 碼位逐一窮舉。延遲解析器案例使用可控訊息排程，解析與來源交易仍為正式實作。瀏覽器連續復原依既有測試慣例等待目前投影可編輯後再發下一次按鍵。

## 已閱讀規範與上下文

專案文件：使用者提供的 `AGENTS.md`、`CONTRIBUTING.md`、`docs/user/DEVELOPMENT.md`、`docs/user/EDITING.md`、根目錄與前端 `package.json`、前端 `tsconfig.json`、相關既有測試及 `.github/workflows/tauri-frontend.yml`。

全域文件位於 `C:/Users/qet63/Desktop/ClineGlobal/`：

- `rules/AGENTS.md`、`rules/docs_rule.md`、`rules/commit_rule.md`。
- `role/Frontend_role.md`、`role/Tehcnical_role.md`、`role/interactive_technical_docs_architect_role.md`；互動文件設計流程不適用於本次測試報告。
- `method/method_map.md`、`method/check/git_workflow_checklist.md`、`method/check/method_maintenance_checklist.md`。
- `method/skills/method_folder_maintenance.md`、`method/skills/modutex_windows_native_verification.md`。
- `method/cache/modutex/modutex_test_authenticity_audit_2026-10-24.md`、`modutex_cell_drag_code_2026-10-11.md`、`modutex_cache.md`，以及 `method/memory/modutex/modutex_memory.md` 路由。

技能文件：`.agents/skills/impeccable/SKILL.md`、`reference/harden.md`、`reference/craft-floor.md`。僅修復既有互動及內容投影；沒有重新設計介面。技能工具另回報 surface brief 路徑解析警告與 v4.8.0 可更新提示，本次未改動技能或其設定。

已按照 method 規則維護 `method/cache/modutex/modutex_cell_transitions_2026-10-27.md`，並在既有 cache／專案 memory 索引新增連結；三份維護檔案均低於 100 行。未修改 `AGENTS.md` 或 `rules/`，未建立備份。
