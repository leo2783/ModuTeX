# 編譯輸入清單：獨立審查

> 歷史實作／審查紀錄。下列測試數字與待辦反映早期改寫階段；現行功能、版本及目錄以[實作狀態](FRONTEND_REWRITE_STATUS.md)與[開發指南](../user/DEVELOPMENT.md)為準。

## 82dc1350 已審查整合，待執行

2026-10-08：完整閱讀 artifact `82dc1350-0ec1-4049-99d7-c3f26aedfd17` 的51,291字元，六份patch均已套用；不代表測試通過。以Codebase Memory CLI核對目前compiler基準及drain，未重新索引。

- managed-compile增加可選的main-process `validateBeforePublish`：在stage已生成／驗證PDF但destination尚未替換時執行；舊三參數呼叫不變，gate失敗／取消仍走既有stage清理與owner釋放。
- FrontendCompiler捕捉本地輸入manifest，在發布前與PDF bytes配送前重新驗證。AbortController取消停住的驗證；既有cancel drain、reservation release及result identity保留。
- ordinary檔案output／.git／node_modules不再因名稱略過；output排除限工作區根的實際目錄，nested output仍是輸入。held FD、逐層身份、有限entry／bytes保留。
- 新integration六項使用真ManagedTectonic與fresh workspace：內容變更／新增／移除／同bytes替換都先生成前次PDF，再要求完整disk bytes保留；取消gate後立即真編譯及真正TeX失敗後保留PDF／释放reservation。
- root將runtime config收錄新檔，`fileParallelism:false`保留所有舊測試且避免共享cache並行；helper的兩個新barrier以operation completion race觀察提前錯誤，避免尚未到barrier的reject無人接收。
- root把catch訊息改成「編譯輸入已變更，本次結果未載入。請重新編譯。」：gate後到publication之間仍有pathname變更窗口，最後驗證可拒收bytes，不能保證已發布磁碟產物回滾或OS CAS。

Luna2原Node30936已終止且completed usage可查。watch／table兩項仍活，暫不執行本地build/test/index/GUI，不commit/push。新runtime需实际串行結果，不能沿用舊11項當本批通過證據。

審查範圍：Codebase Memory CLI `get_code_snippet` 的現有 `frontend-compile-inputs.ts` 完整來源，399 行。只做靜態審查，沒有重新索引、執行測試或宣稱 runtime 通過。Luna2 正在回傳此模組與 compiler 的修正版，尚未收件。

## 補丁必要檢查

1. `isExcludedName` 在 `lstat` 前跳過同名項目：目前不區分目錄與一般檔案。排除應限於真正的既定產物／依賴目錄；可作輸入的普通檔案不能只因名稱是 `output` 就忽略。加真 filesystem 測資：建立檔案 `output`、capture、改內容，`assertCurrent` 必須拒絕；並保留真正 output 目錄的排除案例。不要改成常數測試或猜測 macro。
2. 根目錄最後驗證不能替代每層父路徑與 captured directory identity。父目錄在 traversal barrier 後被 junction／其他 inode 替換，應在進入目錄及讀檔前後拒絕；不能讀了外部內容才僅以根 identity 判定安全。
3. 真 Managed Tectonic 在編譯及 PDF 配送 barrier 期間的 included-file 修改、加入、移除、相同 bytes 的 inode 替換，須拒絕舊 PDF；維持既有取消 drain、reservation 釋放、owner 及前次成功 PDF 行為。
4. Tectonic 本身生成的輸出不得使所有成功編譯都被判 stale；排除須和實際固定產物位置相符，不擴大成任意檔名白名單。
5. 保留 depth／entry／file／total bytes 限制；未知資料與路徑失敗明確拒絕，不恢復 unbounded scan。依 Node 路徑 API 的檢查不能宣稱 OS 原子 CAS 或一致性快照。

## 收件與返工

- Luna2 artifact `6e8e8e69-c2e8-471e-b65a-d179594861bd` 已 completed；完整輸出33,875字元，所有patch均未套用。
- 父路徑／held-FD檢查及PDF配送前manifest驗證有實作提案，但第1項同名普通檔排除仍未修；只新增一個真引擎included-file內容修改案例，未覆盖新增／移除／相同bytes身份替換。
- 新integration測試只等待第2次barrier，如果真引擎提前失敗會等到長timeout；需立即觀察result並與barrier作有上限race，保證釋放與await teardown。
- 要求取消發生於manifest驗證期間的真競態回歸，避免取消被驗證錯誤轉成failure。
- 同lane2續派 `compile-inputs-recovery-review-20261008`，沿用完整stateless來源history，仍最多四項。已查證Node9096／parent34572存活；不使用舊PID。
- Usage：input20,424（cache_write20,162、cached0）、output62,251（reasoning53,585）。首次cache寫入，不宣稱本次命中；token紀錄不是帳戶現金餘額。

## 證據邊界

- 第 1 項是可從控制流確認的檢查缺口，尚未以新行為測試證明影響。
- 既有 17 項 helper 測試不代替 compiler 接線及 included-file stale PDF 驗收。
- 等四項工作者停止後才串行執行驗證；本次審查沒有新 runtime 結果。
