# 前端記憶體與 I/O 競態

> 歷史實作／審查紀錄。下列測試數字與待辦反映早期改寫階段；現行功能、版本及目錄以[實作狀態](FRONTEND_REWRITE_STATUS.md)與[開發指南](../user/DEVELOPMENT.md)為準。

2026-10-08新增證據：實際Svelte PdfView＋PDF.js＋native canvas五項競態測試通過，latest頁/zoom以真像素驗證，初始inactive不render、resume只畫最新頁；render中dispose不發布晚到錯誤，loading task destroy一次；新bytes以真正unmount/remount建立新task。既有元件lifetime兩項亦已通過。這是Node/JSDOM client及in-process PDF worker證據，不是Chromium worker、真ResizeObserver/layout或Electron heap無洩漏驗收。測資：apps/frontend/tests/pdf-client-race.test.ts。

診斷／PDF 也綁定 CompileIdentity；來源版本變更後停止錯誤定位並標示 PDF stale，外部 PDF 不冒稱當前編譯。await save 結束後再檢查原 source／workspace／path／busy／lifetime，防止切檔後編譯錯文件；該 App 排程端到端回歸未完成。真引擎 5 項及前端 73 項通過，未知 included-file／column 不猜測。

App／renderer adapter 使用同一 AbortSignal；卸載撤銷 source／PDF ticket，拒絕晚到 list／read／write receipt，晚到選檔取得的 workspace 立即 close。compiler 發取消要求而非提早解除主行程 reservation，finished 後移除 abort listener。已提交磁碟 write 不保證取消回滾。真實 FrontendFiles 加排程 barrier 驗證 late open／read／write；前端最新 70 項通過，不代表 Electron IPC／App DOM／heap 完整驗收。

已修正：工作區 open 撤銷、Worker watchdog／重啟與視覺投影復原、跨視窗保存互斥，以及新版前端編譯／保存雙向互斥。編譯保護涵蓋重疊／巢狀工作區，自 initial revision read 至引擎清理及 PDF bytes 讀取才釋放。待處理：外部程序與敵對路徑替換、最終 check→rename，以及 Electron／IME／heap 驗收。

儲存綁定 workspace、path、documentId、documentVersion 與讀取時的 SHA-256 revision。主行程複製且限制輸入 bytes；來源 editor 使用 immutable snapshots，避免保存中的內容被後續輸入改變。真正敵對檔案系統競態與桌面端到端驗收仍未完成。

| 位置 | 已實作的保護 | 證據／剩餘邊界 |
| --- | --- | --- |
| Settings storage | 每個已知欄位使用獨立 v1 key；晚到 storage event 不信任 payload，重新讀取實際值；卸載移除 listener；損壞欄位不覆蓋其他有效設定 | 真 jsdom localStorage／StorageEvent／零 quota 測試；不同欄位不互相覆蓋，同欄位採最後寫入值。不是多欄位原子交易或跨機器同步 |
| 工作台切頁／PDF pause | 不重建已開啟 editor；隱藏 editor 拒絕寫入及 Escape 搶焦點；PDF pause 撤銷 publication、清空 pending，resume 等舊 draw 結束後才能取得畫布 | 4 項 queue 測試通過；切頁保留一份已開啟文件是刻意行為，不能當成 heap 已回收或 Electron 驗收 |
| `electron/src/frontend-files.ts` | 工作區 root dev／inode、relative path、junction 拒絕、讀取前後身份／大小／時間比對 | 真實檔案測試；Node 路徑 API 不提供完整 openat／directory-handle anchoring |
| 同上 `write` | 同 owner 一筆；跨視窗共享 parent dev／inode＋目的檔名鎖，Windows 檔名折疊大小寫；讀 revision、wx 暫存、sync、再讀 revision／身份、rename；finally 釋放鎖 | 真實跨 owner 同檔互斥、不同檔並行、成功／revision conflict 後可再次保存；不是外部程序鎖或 OS CAS，路徑替換窗口仍存在 |
| 同上 `write` finally | 僅在工作區仍有效時移除自己的隨機暫存檔 | 撤銷／根替換後可能保留孤立暫存檔，不能沿變更路徑刪除；後續需安全回收 |
| `apps/frontend/src/App.svelte` | 接受 read/list 回覆前檢查 owner／ticket；save receipt 綁定文件版本；保存期間禁止切文件 | 端到端 IPC／切文件 GUI 驗收待完成 |
| `source-editor/state.ts` | 保真 immutable snapshot、最多 200 個 history transaction、saved checkpoint 不清空 undo | 11 項前端測試（含 6 項直接 CodeMirror state）；大文件 heap 回收尚未量測 |
| `source-editor/SourceView.svelte`／`visual-editor/view.ts` | 保存期間 readOnly，undo／redo 也拒絕；視覺交易綁定來源版本；過期投影禁止寫入；卸載 destroy EditorView | 真 DOM／MutationObserver／Ctrl+Z、重複 dispose 與晚到 sync 測試通過；Electron keyboard／IME／close、heap 仍待驗收 |
| 公式／矩陣插入 | 捕捉文件／版本／選取範圍，過期即拒絕；面板開啟暫停來源輸入，套用走同一來源交易與 undo | 真 CodeMirror 測試保留 BOM／混合 EOL／未知來源並精確 undo；縮小確認、草稿關閉重開、IME／焦點仍待 GUI |
| Parser Worker | 真正 module Worker；一次一筆傳輸、64 筆佇列／5 MiB 插入量上限；版本過濾；訊息 watchdog；卸載或逾時 terminate；重新解析保留同一 CodeMirror state | 3 項真正 Worker thread 測試，含阻塞、逾時／晚到回覆、重複 dispose、replacement Worker 解析失聯後的最新來源；DOM invalidate／復原不清空 undo；瀏覽器 heap、重新解析按鈕與 5 MiB 桌面操作仍待驗證 |
| Parser 計算上限 | 最多 32,768 節點／8,000,000 掃描步數，超限回退完整 Raw，來源不改寫 | 核心 budget 測試通過；目前是 idle 後在 Worker 全文解析，不是增量子樹 parser |
| PDF worker／畫布 | 翻頁／縮放使用單畫布序列佇列，取消舊 render 並等待結束；最多一筆待渲染要求。每頁 cleanup；卸載 cancel animation frame、disconnect observer、destroy loading task | 3 項佇列測試＋真正 PDF.js Node build／native canvas 的兩頁縮放像素驗證；Chromium／heap 仍待驗收，不宣稱已無洩漏 |
| `electron/src/frontend-compile.ts` | owner 限一筆 run／單次領取；初次讀取前 reserve 工作區，與新版前端 writes／重疊工作區編譯互斥；engine.run 完整清理及 PDF capture 後 finally release；取消不提早解除 | 真 Tectonic 4 項整合測試，含另一 owner 編譯中保存被拒絕；真 filesystem 雙向互斥／巢狀 roots／idempotent release；外部 included files、legacy API、path replacement 與完整 publication 安全仍待審查 |
| 編譯 UI／PDF | 文件版本及 preview ticket 防止晚到結果覆蓋；failure／cancel 保留 PDF，晚到 PDF loading task destroy | 真引擎已證明失敗保留磁碟 PDF與取消；renderer heap 回收、鍵盤／切文件桌面驗收未完成 |

write 的非 null revision 用於既有 `.tex`；null 表示目的必須不存在，以已 sync 暫存檔 hard-link 排他建立，不覆寫現有目的。Save As 由原生 picker 取得主程序路徑，寫入成功才發布新 workspace，保留來源與 undo。open／close／Save As 的 authority token 撤銷晚到操作，commit syscall 前再次驗證；失敗 open finally 只清除自己的 marker。已開始 syscall 不保證回滾，也不是 OS CAS。詳見 [另存新檔](FRONTEND_SAVE_AS.md)。

2026-10-07 本輪競態複核：21 項真實 filesystem、40 項前端測試通過，0 skip；涵蓋並行開檔／保存、編譯 reservation、真正 Worker 阻塞／復原及 DOM／PDF teardown。121 項核心與 5 項真引擎測試為先前證據，本輪未重跑。正式建置包含 parser.worker chunk。這些不是遠端 CI 或完整 GUI／安全／資源回收驗收。

最新複核：真 filesystem 21 項及前端 66 項通過，含過期視覺來源交易、多步原始座標、Worker timeout／dispose、PDF pause／resume 單 owner 與 storage 晚到事件。filesystem 使用既有 Vitest 設定；Node 直跑因無副檔名 import 無法載入，不更改測試門檻。check／production 產物測試通過；未量測 Electron heap，外部改檔的最後 check→rename 與路徑替換窗口仍未解決。
