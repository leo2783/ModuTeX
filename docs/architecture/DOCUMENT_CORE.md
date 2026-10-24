# 文件核心

`crates/document-core` 提供 Rust 原始碼模型、交易、LaTeX 結構解析、UTF-16 座標映射與 SyncTeX 查找。

| 位置                                               | 責任                                      |
| -------------------------------------------------- | ----------------------------------------- |
| `crates/document-core/src/source.rs`、`changes.rs` | 保留原始 bytes、BOM、換行與版本化交易     |
| `crates/document-core/src/parser.rs`               | 有資源上限的 LaTeX 結構解析，保留未知語法 |
| `crates/document-core/src/editor_projection.rs`    | 編輯器換行與來源座標映射                  |
| `crates/document-core/src/synctex.rs`              | 有界的 SyncTeX 解析與雙向查找             |
| `crates/document-core/src/wasm.rs`                 | 瀏覽器 WASM 介面                          |
| `apps/frontend/src/features/document-core`         | TypeScript 型別與 WASM 呼叫邊界           |

視覺編輯器、原始碼編輯器與 parser worker 使用同一份 Rust 核心。一份來源模型共用一條 undo/redo 記錄。

交易使用修改前的 UTF-16 座標，拒絕重疊、過期版本與切開 Unicode 字元的 patch。無修改儲存保留原始 bytes，未知指令不重新列印。

原生與 WASM 的建置、測試指令見 [crate 說明](../../crates/document-core/README.md)。完整產品操作見[開發指南](../user/DEVELOPMENT.md)。
