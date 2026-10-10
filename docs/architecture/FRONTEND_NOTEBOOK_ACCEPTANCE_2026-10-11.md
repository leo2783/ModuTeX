# Notebook 前端修正 2026-10-11

本輪修正使用者否決的前端互動；沿用既有後端與 IPC。前輪紀錄見 [品質驗收](./FRONTEND_UX_ACCEPTANCE_2026-10-11.md)，不能以當時通過的測試代替以下行為驗收。

| 問題 | 修正與驗證 |
| --- | --- |
| 每次輸入跳更新提示 | 移除 ParserClient 固定 120ms debounce；單一 in-flight、背壓與版本檢查保留。正常輸入不插入狀態段落，解析失敗仍明確提示。 |
| 畫面跟不上輸入 | `advanceVisual` 同步推進來源與畫面；重用已掛載公式。真 Chrome 17 次輸入均在 input 事件內顯示，原公式 DOM 保持同一實例。 |
| 空白與按鈕位移 | 文字視覺排版折疊 TeX 空白，原始碼 bytes 保留；插入邊界 hover 不改高度／margin，正常點擊無需 force。 |
| 非 notebook 操作 | 每格可選取、在上／下方新增、上下移動、刪除；文字直接編輯，有完成與取消。文字取消只還原該格，其他來源不改。 |
| 狀態不能關閉 | 文字完成結束選取；文字取消恢復編輯前內容；公式／矩陣／表格面板取消不寫入。切換模式關閉面板。 |
| matrix 退步 | 沿用使用者原創 0.1.0 `matrixResize.ts` 的 parser，保留巢狀 cell；支援六種括號與既有 base array。已有矩陣可重新開啟 grid。 |
| 視覺化暴露 LaTeX／多加鍵盤 | 正常公式操作使用 MathLive；移除鍵盤入口與原生 toggle/menu，keyboard policy 為 manual。來源模式及載入失敗保留備援。 |

## 效能證據

真 Chrome、單一 browser、disable-gpu、1280×850 測試文件：最後版本 input 到下一 frame 中位數 8.9ms、P95 17.6ms。這是小文件的單次量測，不能外推為 5 MiB 文件效能保證。

原 120ms 等待是程式內固定延遲；未以舊版的實測耗時比較。背景 parser 仍有實際工作成本，不能將移除提示宣稱為零解析成本。

MathLive 只在需要時載入；載入後重用元件同步更新。保持既有 100 KiB startup JS 門檻、實際 lazy chunks、本地字型與 notice closure，production 3／3 通過。

## 驗證

- 真 GUI：`notebook-gui-delivery-final.log`，7／7；包含 matrix 重新編輯／取消與原 array 原始碼保留、無數學鍵盤、文字取消／完成、插入與 undo、表格取消、儲存格上下移動、刪除取消／接受／undo、深淺色與說明導覽。
- 重點測試：`notebook-focused-release.log`，10／10；真來源交易、版本、精確 bytes、共用 undo、矩陣 session 與真 ParserEngine ack。
- 視覺交易：`notebook-visual-final.log`，7／7。JSDOM 不驗收字型／geometry；實際渲染由 Chrome 覆蓋。
- 全套回歸：`notebook-regression-delivery.log`，333／333，0 skip。先前失敗與重跑結果保留，沒有提高 timeout 或以 mock 代替 I/O。
- 型別檢查：0 errors、兩項既有 WorkbenchLayout 警告。Electron 標題列 X 的實體點擊未新增自動驗收；沿用前輪同一 beforeunload 路徑的限制紀錄。

驗證檔均位於 `.verification-artifacts/`；畫面為 `workbench-blocks-light-20261011.png` 與 dark 對應檔。

## 來源與派工

使用者於本對話明確確認 0.1.0 matrix 作者為自己，授權直接沿用。`apps/frontend/src/features/math/matrix.ts` 重用原 parser 並新增新版 grid／array 適配，沒有 import legacy UI。此紀錄不是完整應用授權結論。

使用者同時確認後來的表格概念與程式碼為其原創，可沿用成熟實作；不把這些原創內容當作第三方 AGPL 阻礙。新版目前使用共享 `tables/source.ts`、`column-resize.ts` 與 `TablePanel.svelte`，這項作者確認不表示已搬入全部舊表格程式。第三方 legacy UI 仍分開記錄。

真 AGY3：blocks `7c26ac1b-9e39-4107-97db-9673669bd362`、workbench `ed4bf4c6-d5f2-4a87-a3b0-80af5aae8361`、math `36efbba5-0b14-4c43-8fad-5d5fbe96dd9a`。math 首次 command 被拒、無 patch，不計交付；同 conversation 改精確 read_file 後取得有效 patch。Root 審查後整合並修正失敗。

真 API Luna3：`cb031536-ea53-4247-8da7-8beecb62220c`、`e4291dfb-cfa7-45c3-8226-abfbc79a0e76`、`456af1db-34d8-4724-b3ab-cff6442b3468`。前兩份有可執行測試；第三份是可操作審查，comment-only test 未加入。收據保留 cache usage，不當作官網帳單。

所有外部 workers 停止後才串行 GUI。Root 未提交 legacy 搬遷、生成檔或後端重寫。
