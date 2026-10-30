# Document core

Rust 原始碼緩衝、交易、UTF-16 座標、LaTeX 結構、編輯投影及 SyncTeX 索引。`wasm` feature 提供瀏覽器介面，使用同一份核心實作。

原生驗證：

```powershell
cargo test --locked --release --manifest-path crates/document-core/Cargo.toml
cargo clippy --locked --release --manifest-path crates/document-core/Cargo.toml --all-targets -- -D warnings
```

WASM 驗證需要 `wasm32-unknown-unknown` 與 `wasm-bindgen-cli 0.2.126`：

```powershell
cargo build --locked --release --manifest-path crates/document-core/Cargo.toml --target wasm32-unknown-unknown --features wasm
wasm-bindgen --target web --out-dir .verification-artifacts/tauri/document-core-wasm apps/desktop-tauri/target/wasm32-unknown-unknown/release/modutex_document_core.wasm
$env:MODUTEX_DOCUMENT_CORE_WASM_DIR = '.verification-artifacts/tauri/document-core-wasm'
node --test crates/document-core/tests/wasm.test.mjs
```

SyncTeX 支援有界的純文字／gzip 索引及雙向查找；不支援的格式會回傳明確錯誤。PDF 介面整合另由桌面應用負責。
