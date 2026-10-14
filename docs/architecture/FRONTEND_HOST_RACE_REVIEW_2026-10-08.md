# 前端與主行程 I/O 競態審查 (2026-10-08)

> 歷史實作／審查紀錄。下列測試數字與待辦反映早期改寫階段；現行功能、版本及目錄以[實作狀態](FRONTEND_REWRITE_STATUS.md)與[開發指南](../user/DEVELOPMENT.md)為準。

本文件依據審查規範針對 ModuTeX 0.2.0 在真實檔案系統與主行程 I/O 邊界上的競態條件進行靜態推論審查。

---

## 1. 審查範圍與檢查來源

本審查僅對靜態原始碼與合約進行深度推論，**未執行任何自動化測試或執行期動態驗證**（測試套件維持未執行狀態）：
- `electron/src/frontend-files.ts`（工作區管理、路徑解析、atomic write、save-as、list）
- `electron/src/frontend-compile.ts`（編譯生命週期、reservation、取消與結果領取）
- `electron/src/main.ts`（IPC 委派、視窗生命週期、watchFiles、closed 清理）
- `apps/frontend/src/features/files/desktop.ts`（Renderer preload 介面包裝、AbortSignal 傳播、取消處理）
- `apps/frontend/src/App.svelte`（前端工作區切換、儲存、編譯排程、生命週期管理）
- `packages/frontend-contracts/src/types.ts`（合約定義）
- `packages/frontend-contracts/src/validate.ts`（合約執行期驗證）
- `docs/architecture/FRONTEND_IO_CONCURRENCY.md`（先前版本架構承諾）

---

## 2. 既有修復與已知架構限制（靜態確認）

### A. 既有修復項目（Confirmed Handled）
1. **已捨棄檢視的過期結果遞送（Aborted-view stale delivery）：**
   - `desktop.ts`：在 `compile` 中立即對 `finished` 掛載 `catch(() => {})`，並在 Promise 解析時透過 `assertActive()` 擋下過期回呼。
   - `App.svelte`：使用 `compileTicket` 與 `previewTicket` 序號過濾晚到成功結果，若 `source.version` 或 ticket 不符則拒絕套用 PDF。
2. **工作區 Open 撤銷與孤兒 Token 清理：**
   - `frontend-files.ts`：使用物件引用標記 `opening` 與 `authority`，在並行 open 或 close 介入時使得舊 open 拋出 `STALE_WORKSPACE`，且 `finally` 區塊僅在自身 marker 未變時清除，不干擾較新的 open。

### B. 已知架構局限性（Known Limitations，無跨進程 OS 原語）
1. **非作業系統層級之原子 CAS（OS CAS）：**
   - `frontend-files.ts` 採用「讀取 revision -> wx 寫入臨時檔 -> fsync -> 再次讀取比對 dev/ino/mtime -> rename」的二重檢驗機制。這僅能在進程內部保證序列化，外部程式若於 rename 前微秒級替換檔案，作業系統層面仍存在 TOCTOU 窗口。
2. **缺乏 OS `openat` / 檔案描述元路徑定錨（Path Anchoring）：**
   - Node.js 在 Windows/POSIX 上未全面暴露基於 file descriptor 的目錄定錨（directory fd / `openat`），因此路徑組裝後進行 `fs.realpath` 與 `contained()` 檢查時，符號連結／junction 替換競態無法在單一 syscall 內完成。

---

## 3. 靜態推論之架構競態與缺陷（Static Inferences）

> [!NOTE]
> 本節問題皆為架構靜態推論（Static Inferences），**非經由新執行測試實證（Not Newly Demonstrated）**。

### 缺陷 1：Included-file 於編譯期間遭外部修改，缺乏相依檔案版本保護
- **精確位置：**
  - `electron/src/frontend-compile.ts#L33-L35`
  - `electron/src/frontend-compile.ts#L48-L49`
  - `electron/src/frontend-files.ts#L80-L89`
- **機制與邊界釐清：**
  - **跨 Frontend 寫入防護存在：** 當編譯開始時，`FrontendCompiler.start` 呼叫 `files.reserveCompilation(request.workspaceId)`，已在進程層級將該 `root` 加入全域 `compilationRoots`。任何其他前端視窗若嘗試對該 root 及其子路徑執行 `writeGuarded`，皆會被 `[...compilationRoots].some(...)` 阻擋並拋出 `BUSY`；同視窗於 `main.ts` 中觸發 `frontend:write` 時，亦會主動呼叫 `frontendCompiler.cancelOwner` 撤銷進行中的編譯。
  - **實質風險所在：** 缺陷僅在於 **TeX 多檔案專案中的相依被包含檔（如 `\input{sub.tex}`）在外部行程遭變更**，或編譯器在執行中讀取到外部修改的殘破狀態。由於主程序僅於編譯前後驗證 `request.entryPath` 的 revision，若只有 sub-file 被外部修改而 entryPath 未變，系統將無法察覺並成功發布不一致的 PDF。

### 缺陷 2：Workspace Close 與 Write 競態中的暫存檔孤兒化與路徑安全邊界
- **精確位置：**
  - `electron/src/frontend-files.ts#L56-L61`
  - `electron/src/frontend-files.ts#L100-L105`
  - `electron/src/frontend-files.ts#L257-L260`
- **機制與安全邊界：**
  - 當前端呼叫 `close()` 時，`this.current = null` 與 `this.authority = {}`。
  - 若此時 `writeGuarded` 正處於非同步 I/O 階段，於 `finally` 區塊中執行 `this.assertRoot(session)` 時會因 `this.current === null` 拋出 `STALE_WORKSPACE`，跳入 catch 導致 `fs.unlink(temporary)` 被跳過，殘留孤立的 `.modutex-save-*.tmp` 暫存檔。
  - **重要安全考量：** 雖然存在暫存檔孤兒化，但**不能簡單直接對實體路徑執行 `fs.unlink`**！`assertRoot` 驗證了 `session.root` 及其所在裝置（device/inode）未被篡改且非符號連結。若在工作區已被關閉、目錄可能被外部重新掛載或替換為符號連結的情境下盲目 unlink 實體 path，將引入任意檔案刪除的安全漏洞。因此清理必須在確保 root / parent 目錄身份（inode）與無 link 穿越的防護下進行。單純將 `close` 改為 `closeAsync` 並等待 pending writes，若內部未先確認 root 驗證邏輯與安全邊界，無法解決 `assertRoot` 拋出例外造成的清理中斷。

### 缺陷 3：編譯取消（Cancel）生命週期邊界與併發狀態釋放
- **精確位置：**
  - `electron/src/frontend-compile.ts#L24-L28`
  - `electron/src/frontend-compile.ts#L37-L60`
  - `electron/src/frontend-compile.ts#L69-L82`
- **機制與狀態分析：**
  - 在 `FrontendCompiler.cancel` 中，僅將 `active.cancelled = true` 並發送 `this.engine.cancelOwner(owner)`（發後不理）。
  - 底層編譯子程序（Tectonic）需要時間退出，只有當其結束後，`active.result` 的 `finally` 區塊才會執行 `releaseCompilation?.()` 釋放工作區鎖定。
  - **生命週期缺口：**
    1. **前期啟動競態：** 若呼叫 `cancel` 時，`start()` 尚在讀取檔案或準備建立 `active.result`（尚未掛載 `active.result` Promise），單純 `await active.result` 會直接略過等待。
    2. **Map 釋放與消費衝突：** `runs.delete(owner)` 目前僅在 `result()` 被消費完成或 `cancelOwner()` 被主動呼叫時觸發。若 cancel 被 await，取消完成後該 owner 依然存在於 `this.runs` 中，後續的 `start()` 仍會因 `this.runs.has(owner)` 拋出 `BUSY`。
    3. **並行 result 領取：** 若取消時剛好有並行的 `result()` 在讀取，必須保證狀態轉換與清理不會引發重複消費或死鎖。

### 缺陷 4：`watchFiles` 在 DesktopPort 中宣告但在 Preload 中未轉發
- **精確位置：**
  - `packages/frontend-contracts/src/types.ts#L97`
  - `electron/src/preload.ts#L11-L24`
- **機制：**
  - `DesktopPort` 合約定義了 `watchFiles` 介面，但 `preload.ts` 的 `modutexFiles` 橋接中未暴露該通道。目前監聽功能尚未對接至新架構。

---

## 4. 具體修復方案架構建議（Architectural Recommendations）

### 方案 1：安全暫存檔清理與寫入排空（Safe Drain & Guarded Unlink）
為解決暫存檔殘留同時維護路徑安全，應遵循下列架構原則：
1. **保留 Root/Parent 身份驗證與 Link Guards：** 清理暫存檔時，仍必須透過驗證父層目錄的 dev/ino 並且確認不包含符號連結，禁止直接無防護 unlink 裸路徑。
2. **追蹤進行中寫入（Pending Writes Tracking）：** 在 `FrontendFiles` 內部維護進行中寫入的操作計數或 Promise 集合。
3. **安全排空通道：** 在關閉工作區時，提供可等待的排空邏輯，讓正在進行的寫入安全撤銷或完成暫存檔的合規清除，而非直接使 session 失效導致 `assertRoot` 拒絕清理。

### 方案 2：編譯取消的全生命週期確定性排空（Deterministic Compile Cancel Drain）
`cancel` 需涵蓋完整的生命週期清理：
1. **前期啟動保護：** 若在 `start()` 的非同步準備階段觸發取消，需能等待該初始化流程安全退出。
2. **等待引擎終止與釋放鎖定：** `cancel()` 應等待底層子程序結束並觸發 `releaseCompilation()`。
3. **確定性清理 Map 狀態：** 取消確定結束後，必須安全釋放 `this.runs.get(owner)`，確保下一次 `start()` 不會因殘留的 run 狀態誤報 `BUSY`。
4. **協調並行 Result：** 若 `result()` 正在等待，應確保取消結果（status: `'cancelled'`）可正確交付，或在清理時標記狀態避免重複拋出非預期例外。

---

## 5. 確定性真檔案系統測試設計原則（Test Design Guidelines）

> [!IMPORTANT]
> 任何針對上述競態的測試案例，**必須使用真實檔案系統（Real FS Barrier）**，禁止使用虛構的立即觸發或空測試主體（Empty Body）：

1. **避免假競爭（No Immediate Race False Positives）：**
   - 不得在發起寫入後「同步立即」呼叫 `close()` 並假設暫存檔已建立。在真實檔案系統上，非同步 `write()` 可能尚未走到 `fs.open('wx')` 即被中斷。
   - 必須透過確定性的真檔案系統同步點（例如透過可控的檔案系統延遲或確定步驟進入寫入臨界區後）再觸發關閉，以驗證暫存檔是否安全清除且無孤兒殘留。
2. **完整驗證斷言：**
   - 測試必須實際檢查磁碟上的暫存檔檔名模式（如 `.modutex-save-*.tmp`），驗證在異常中止後無殘留，且原始目標檔案內容未遭毀損。
   - 編譯取消重啟測試必須實際等待取消排空完成後，發起第二次 `start()` 並斷言其成功取得全新的 `runId`。

---

## 6. 審查結論（Final Verdict）

**Status: Review Revised（審查已校正）**
- **已修正過度宣稱：** 釐清所有識別之缺陷皆為靜態推論，未經實測跑過，絕非 Newly Demonstrated。
- **已校正並行寫入防護事實：** `reserveCompilation` 確實已在進程層級阻擋跨前端視窗對該 root 的寫入，同視窗寫入亦會主動取消編譯；多檔案問題核心在於未被追蹤之 sub-file 的外部檔案系統變更。
- **已確立暫存檔清理安全邊界：** 否定直接 unlink 實體 path 的危險方案，重申必須保留 root/parent inode 身份比對與 link guard。
- **已補足 Cancel 排空生命週期：** 明確指出取消等待除了 await result 外，尚需涵蓋前期啟動階段等待、`this.runs` Map 釋放以及與並行 `result()` 的協調。
