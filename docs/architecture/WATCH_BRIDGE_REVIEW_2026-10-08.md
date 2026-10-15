# Watch bridge 收件審查

> 歷史實作／審查紀錄。下列測試數字與待辦反映早期改寫階段；現行功能、版本及目錄以[實作狀態](FRONTEND_REWRITE_STATUS.md)與[開發指南](../user/DEVELOPMENT.md)為準。

## efe60b1e 已審查整合，未驗證

後續測資負載修正：`electron/tests/frontend-watch.test.ts` 與 `apps/frontend/tests/desktop-watch-lifetime.test.ts` 以每批32筆真正writeFile依序建立fixture，取代一次Promise.all建立4097／2049筆；檔案數、完整overflow／entry-limit斷言均不變。這是限制queued I/O的程式修改，不是記憶體峰值或GPU穩定性驗證。未執行測試，不改timeout／門檻或略過案例。

2026-10-08 12:37後：完整閱讀 `efe60b1e-f201-4632-8ed9-4f2c6de723f3` 的56,990字元並套用七檔：types、desktop、watch服務、main、preload及兩份真filesystem測資。正式IPC接線已寫入，不等於已運行／GUI接線完成。

- 閒置時每五秒檢查既有目錄身份；完整樹reconciliation改為每60秒，OS通知合併後有界掃描。遺失通知仍可能延後60秒，不宣稱即時可靠或零I/O。
- root修正 `owned(fs.opendir())` 在取得handle後撤權而throw、handle未進finally的洩漏路徑：先取得resource、進入try/finally才assertLive；close只忽略ERR_DIR_CLOSED。
- .git／node_modules排除移到lstat／link檢查後，僅排除真目錄；nested檔案刪除中的ENOENT／ENOTDIR採原有最多四次重掃，不直接當永久監看失敗。
- desktop測資重開／close後更新current workspace ID，下一項overflow測試不再使用已撤權的owner。
- buffer／tree limits維持明確終止，不悄悄丟事件。測資大量檔案建立仍須串行驗證時觀察磁碟成本；主代理未增加worker、worktree或全庫索引。

12:31已查無剩餘四項程序，皆有stdout交付。隨後compile-input測試啟動遭自動核准服務用量上限阻擋，命令未執行；提示14:14再試，不是測試失敗或unsafe裁決。沒有換工具／移工作目錄繞過核准，所有本批新測試仍未跑。表格與font交付需獨立程式審查；App訂閱／復原文案、真Electron與完整F0–F5仍未驗收。無commit/push／native操作。

## 2936da2d 完整交付檢查

2026-10-08：已完整讀取 `2936da2d-c30f-4b14-b06b-a725583c4884` 的28,542字元輸出，patch header僅包含types.ts、desktop.ts、新frontend-watch.ts。沒有 main.ts、preload.ts 或任何測試；前一版2777從未套用，不能默認沿用其缺漏檔案。因此新版NativeFiles呼叫缺少同份正式IPC接線／測資證據，整份仍未採用。BigIntStats欄位已改成dev/ino，是提案修正，不是runtime通過。

控制流仍每秒auditRoot→scheduleScan→完整有界scanTree；既有35ms debounce不減少閒置時每秒掃描。後續須輕量身份稽核、通知合併與有界遺失通知reconciliation，不以取消安全監看或降低案例達標。scanTree在lstat前跳過.git/node_modules、directory.close吞所有錯誤，須由實作交付說明精確排除與資源關閉邊界，不能聲稱任意link皆已拒絕。

同lane1 Node34088／parent28904已確認存活，12:25續派要求明確包含main/preload與真filesystem轉送測資；不重啟、不追加第五項。本輪沒有測試／build／index／native操作、patch套用或commit/push。

Artifact：`2777a8dd-2fcc-427c-817f-0ba332ac453e`，completed，輸出44,934字元，完整閱讀。所有patch均未套用，沒有新測試通過。

## 拒收原因

- `sameNode` 使用 `device/inode`，多處卻傳入 Node BigIntStats 的 `dev/ino`；欄位不匹配會讓根目錄驗證失敗。修正版必須統一身分轉換並跑真正fs.watch開啟／新增／修改／刪除案例。
- `reportWatchFailure` 使用全域 ErrorEvent／原始代碼，不是可復原的訂閱錯誤通道。主代理決定最小相容契約：watchFiles新增可選第三參數onError、限定FileWatchFailure union及runtime驗證，不引入假FileEvent。App顯示接線另行審查，不提前宣稱GUI完成。
- renderer測資只有假baseNative，未以真FrontendWatch／FrontendFiles背書事件；須改真正檔案系統與公開轉送barrier，沿用既有測試框架。受控非法envelope測試可測驗證，但不能代替真事件或原生Electron驗收。
- 保留bounded tree/watchers／overflow終止而不丟事件／撤權、晚到start、workspace重開與所有權清理；不採skip安全測資。

## 有效返工

- 原lane1 Node16952及parent30596已查無程序。
- 同lane1 stateless continuation task `watch-recovery-review-20261008`：已查證Node33212／parent34560。
- 專屬範圍：watch服務、main/preload、desktop適配與新watch測資；新增types/validate的上述最小契約。compiler/helper/font/table唯讀。
- 尚未生成正式接線或驗收結果，無commit/push／native操作。

## AGY 寫入阻礙

- font conversation cb9b3570-553c-488e-83f4-56ad71abca3c：ReplaceFileContent需要write_file，被headless auto-denied，response空。
- table conversation 478b772b-d40c-4629-8d07-a1743d6f6537：WriteToFile同樣被拒，response空。兩個SUCCESS均不是交付成功。
- 專屬project只新增asset-origins.mjs／asset-origins.test.mjs／table-edit-roundtrip-client.test.ts三條精確write_file；原17條deny維持，沒有skip-permissions或新增命令允許。
- 帶通用命令規則的初次patch被自動審查拒絕，未套用；改為僅三條精確寫入後成功。代理shell禁令仍由任務明確指定，不能稱作已新增系統全面command deny。
- 原兩AGY程序已查無；續接相同conversation，現font PID24368／parent20576，table PID27572／parent26456。未以empty SUCCESS宣稱實作完成。
