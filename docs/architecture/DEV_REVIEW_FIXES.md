# dev 0.2.0 審查修正

審查來源：`ModuTeX_0.2.0_dev_Code_Review_Tauri_Migration (1).md`，固定基準 `aac20e6`。
本次修正 Electron 0.2.0 的已確認缺陷與測試缺口；報告中的 Tauri 計畫屬後續工作。

## 問題與修正

| 問題 | 修改 | 行為驗證 |
|---|---|---|
| PR 綠燈未包含新前端測試 | `verify:modutex` 與 Linux/Windows PR 關卡執行 `frontend:check`、`frontend:test`；同時加入共用套件測試 | 政策拒絕移除/skip/continue-on-error；真 npm 故障注入非零退出並阻擋後續 gate |
| Parser reset 雙重複製全文 | 直接轉移 `toBytes()` 的新 buffer | 5 MiB 真 Worker；reset allocation detached，原文件 BOM/CRLF bytes 不變 |
| CRLF 位移重複線性掃描 | 以 lower-bound 二分搜尋計算被移除斷點數 | 同 transaction 合併 1/8/128/1,024 個邊界；完整座標與 Undo/Redo |
| 新段落定位物化全文 | 從 transaction 插入長度限定 marker 搜尋範圍，驗證後才 dispatch | 首尾、中間、非空替換、LF/CRLF、多個既有 par、禁止全文 read、Undo/Redo |
| 每個 watch 事件重新列舉樹 | 每個 pending batch 共用清單；等待 I/O 時保留未處理及較新事件 | 50 個封包只列舉 2 次；真檔案衝突、刪除重建、own save、切換及卸載 |
| Watch 啟動可能漏掉基準內變更 | 訂閱就緒後重新同步；busy 時保留排程 | 阻擋 startup，先改磁碟再建立 host baseline；讀入最新內容 |
| 鍵入全量重建 decorations | 成功驗證 source receipt 後 map 舊 decorations | DOM identity、游標、locale/readOnly、拖曳與 source roundtrip |
| 拖曳把手逐格查詢／讀寫排版 | 單一 RAF 共用 cell inventory；全部讀 rectangle 後寫 style | Resize coalescing、一次列舉、讀先於寫、dispose 取消 RAF/observer |
| 大型程式碼同步 parse/token DOM | 超過 100,000 UTF-16 units 保留完整純文字，停止自動高亮 | 完整字串保留、無執行 HTML、取消後新草稿可用 |
| performance 測試名稱誤導 | 改為 `visual-dom-stability.test.ts`，另增真 Chrome benchmark/CPU profile | 100/500/2,000 cells，每尺寸 20 筆 typing/selection 樣本 |
| Launcher 只有 regex 驗證 | 以真 Node EXE 作 stub binary 執行產生的 launcher | 空白/中文/特殊字元 argv、cwd、指定 env 過濾、缺 binary 非零退出 |
| Help 導覽寫死舊版 | 中英文改為安裝指南；渲染內容驗證 dev tgz 指令 | 真 Svelte SSR/client navigation |
| npm 負向 audit 測試受網路影響 | 無 lockfile 案例使用真 npm 的 offline mode | 真 shell 非零退出，JSON error 保留 |

## 驗證收據

本機新前端 367/367、Chrome UI 20/20、CI/fault injection 13/13、launcher 19/19、
document-core 126/126、frontend-contracts 30/30 通過。型別檢查 0 errors、2 個既有 layout warnings。
本機紀錄位於 `.verification-artifacts/review-*.log` 與 `review-*.json`；遠端 CI 狀態以 PR 為準。
新前端全套、共用套件、CI/launcher、型別檢查及真 Chrome UI 分別執行，不以靜態政策測試取代 UI 行為。

Chrome 155／Windows 10.0.26200／Ryzen 5900HX，2,000 cells 的 typing P95：
初次量測約 73 ms，修正後約 45 ms。掛載長任務由約 14.8 秒降為約 220 ms。
量測隔離 VisualEditor 的同步 source receipt 路徑，排除 App、Worker 排程、IME 與原生 Electron；
每份 JSON 含機器、heap、DOM mutations、long tasks 與 CPU self-samples。
同機 8,192 pieces 的單字元 read P95 約 0.059 ms；未因此改寫 SourceDocument 結構。

## 尚無足夠證據的建議

報告沒有證明 PDF/圖片永久洩漏，或 watch 後端排序是主要瓶頸；本次不以推測改寫它們。
2,000 cells 仍有長任務，後續可用同一 benchmark 評估更大的 ProseMirror/virtualization 改動。
目前沒有核准的延遲／heap 門檻，也沒有 native Electron/IME 的等價效能基準。
App controller 拆分、完整 mutation campaign、100 次 PDF/圖片 heap snapshot 與 Tauri G0–G7
需要獨立驗收，不能宣稱本次已完成遷移或證明所有測試有效。
