# G1 原型探針驗證指南

## 測試夾具環境變數
```powershell
$env:MODUTEX_G1_PDF = "C:\path\to\valid_fixture.pdf" # 需為 16 bytes 至 32MiB 之合法 PDF
$env:MODUTEX_G1_UNTRUSTED_WINDOW = "1"              # 設為 1 建立無權限之隔離測試視窗
```

## 建置時 TAURI_CONFIG 覆寫
此設定於編譯時嵌入；保留 main capability 並注入僅限 main 的測試權限：
```powershell
$env:TAURI_CONFIG = '{"app":{"security":{"capabilities":["main",{"identifier":"g1-probes","windows":["main"],"permissions":["allow-prototype-bytes","allow-prototype-pdf"]}]}}}'
```

## 建置與執行指令
```powershell
npm run frontend:build:tauri
cargo build --locked --release --manifest-path apps/desktop-tauri/Cargo.toml --features g1-prototypes
```

在儲存庫根目錄執行下列命令；輸出目錄須不存在，其父目錄須存在：
```powershell
$taskRoot = (Resolve-Path .).Path
cargo run --locked --manifest-path apps/desktop-tauri/Cargo.toml --features g1-prototypes --example tectonic_probe -- "$taskRoot\vendor\tectonic\windows-x64\tectonic.exe" "$taskRoot\.verification-artifacts\tauri\engine-new"
cargo run --locked --manifest-path apps/desktop-tauri/Cargo.toml --features g1-prototypes --example pty_probe -- "$taskRoot\.verification-artifacts\tauri\pty-new"
```

## G1 關卡檢驗
1. 二進位 IPC：對 main 視窗調用 prototype_bytes，驗證 <=5MiB 原始二進位回傳與拒絕 JSON。
2. PDF 串流：驗證 prototype_pdf 於無環境變數回傳 PROBE_PDF_UNAVAILABLE，有夾具時回傳 16 bytes..32MiB PDF。
3. 視窗隔離：驗證 g1-untrusted 視窗因未授權與 non-main 遭 host 拒絕。
4. 引擎／PTY：核對實際 PDF、取消回收、Unicode marker、resize、child reaped 與 reader joined 收據。

`g1-prototypes` 僅供原型驗證；預設建置只註冊 host_health。
