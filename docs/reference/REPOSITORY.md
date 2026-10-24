# 儲存庫配置

| 路徑                          | 責任                                      |
| ----------------------------- | ----------------------------------------- |
| `apps/frontend/src`           | Svelte 介面與編輯器                       |
| `apps/desktop-tauri/src`      | Tauri 命令、Rust 服務、平台操作與應用狀態 |
| `crates/document-core/src`    | Rust 文件核心，提供原生與 WASM 介面       |
| `packages/frontend-contracts` | 前後端實際共用的型別與驗證契約            |
| `landing`                     | 專案網站                                  |
| `scripts`                     | 建置、分發與授權工具                      |
| `tests/scripts`               | 工具測試與原生桌面 E2E                    |
| `tests/integration`           | 跨模組整合測試                            |
| `vendor`                      | 固定版本的第三方執行元件與原始授權        |
| `docs`                        | 使用指南、架構契約與來源記錄              |

各 app 與 crate 的程式放在 `src`，測試放在同層 `tests`。派工工具與驗證產物只留在本機。

目前桌面版本為 0.3.0。舊 Electron 與 Texpile 前端已移除。TS 文件核心與舊契約完成替換後，依遷移計畫另批刪除。

命令見[開發指南](../user/DEVELOPMENT.md)，授權範圍見 [LICENSING](../../LICENSING.md)。
