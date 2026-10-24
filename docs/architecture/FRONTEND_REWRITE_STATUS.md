# 前端狀態與驗收證據

更新：2026-10-18。產品版本以 package 與[開發指南](../user/DEVELOPMENT.md)為準（目前 0.2.1）；共享 private 套件獨立版本。正式 Electron renderer 為 `apps/frontend`；Tauri 尚在原型驗收，未完成正式切換。

## 已有能力與剩餘工作

來源／可視化共用 SourceDocument，包含格式、公式／矩陣、表格／欄寬、程式碼、圖片、Raw、章節導向／原始碼折疊、新文件、最近文件、另存、關窗保存、編譯診斷、取消與 PDF。精確限制見[編輯器規格](FRONTEND_VISUAL_SOURCE.md)與[桌面契約](FRONTEND_CONTRACTS.md)。

- Electron 外部檔案替換競態、完整大型文件原生量測與來源／分發閉包仍需完成。
- Typst／Draft／終端機／Git／MCP 的新版入口與 Tauri 等效功能依[遷移計畫](TAURI_APACHE_MIGRATION_PLAN_2026-10-17.md)驗收；Draw.io 排除並預留未來 plugin。
- 已知使用限制只維護於[使用指南](../user/KNOWN_LIMITATIONS.md)，不在日期文件重複列待辦。

## 歷史驗證（各列只代表當時範圍）

| 日期／批次                                          | 已記錄結果                                                                      | 範圍或未通過項                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 10-10 主路徑                                        | host guard 104、engine 18、browser 7、native Electron 1、production 3           | startup 102068 bytes，小於 102400 門檻                                                          |
| 10-11 notebook → inline → math → interaction → drag | unit 333 → 334 → 338 → 340 → 344；GUI 7 → 8 → 11 → 12 → 13                      | 191 個公式模板另有引擎驗證                                                                      |
| 10-12 圖片與關窗                                    | frontend 344；GUI 16／16；close 8／8                                            | panel 批次 344／345，watch 單項重跑 1／1，不能當整套通過                                        |
| 10-13 dev／release readiness                        | 345／348、346／348；targeted 11 通過                                            | watch 失敗仍在該批證據中；Electron 400、identity 7、legacy 1878（17 skip）、Typst 10 為其他範圍 |
| aac20e6 dev review                                  | frontend 367／367、Chrome 20、CI／fault 13、launcher 19、core 126、contracts 30 | 兩項 layout warnings；改善 table 首次 draft、caret／PDF race 與取消清理                         |

沒有重新執行的舊測試不標為當前通過；本機收據留在 `.verification-artifacts`，版本來源見[儲存庫紀錄](../reference/REPOSITORY.md)。

## 效能基線與限制

2026-10-07T17:13 Node／JSDOM 的 replace／insert／delete：100 KiB 為 6.1478／5.1791／4.1911 ms；1 MiB 為 53.4554／59.1389／52.1147 ms。5 MiB 該次走 Raw，沒有驗證完整 visual parser。active heap 約 112／438／115 MB，非 peak heap；原生 5 MiB visual／heap 待驗。

重現入口：`node --expose-gc apps/frontend/tests/performance/editor-benchmark.ts`。後續 2k cell typing p95 約 73→45 ms、load 14.8 s→220 ms，只量測 VisualEditor receipt，未涵蓋 App／Worker／原生 IME。

2026-10-08 Windows 有 BUGCHECK 119／116／10e 與 GPU scheduler／AMD／NVIDIA WER 紀錄，根因未定；保留環境證據，不將其推定為程式錯誤。舊 worker 數量限制已由本次六槽調度取代。
