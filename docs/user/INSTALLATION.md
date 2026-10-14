# 開發版 0.2.0-dev.0（Windows x64）

需要 Node.js 24.19 或更新、npm 11.17 或更新。下載同一份 dev build 的 tgz 與 sha256，先確認雜湊，再於下載資料夾執行：

```powershell
$expected = (Get-Content .\modutex-desktop-0.2.0-dev.0.tgz.sha256).Split(' ')[0].ToLowerInvariant()
$actual = (Get-FileHash .\modutex-desktop-0.2.0-dev.0.tgz -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw 'Checksum mismatch' }
npx --offline --yes --ignore-scripts --package .\modutex-desktop-0.2.0-dev.0.tgz -- modutex
```

這會開啟打包的新前端，不需要 Vite 或完整 TeX 安裝；首次未快取編譯可能需要網路。此版使用獨立 dev 設定資料夾。不是 npm registry 發布、EXE 安裝包或穩定 0.2.0 正式版。

以下保留既有 0.1.0 與原始碼啟動說明。

# 啟動桌面版

## 本地 0.1.0 套件

需求：Windows x64、Node.js 24.19.0、npm 11.17.0。套件與 checksum 位於 `release/version-0.1.0/`；尚未公開發布到 npm registry。

在該目錄核對檔案：

```powershell
$expected = (Get-Content .\modutex-desktop-0.1.0.tgz.sha256).Split(' ')[0].ToLowerInvariant()
$actual = (Get-FileHash .\modutex-desktop-0.1.0.tgz -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw '套件 checksum 不符，請勿啟動' }
npx --offline --yes --ignore-scripts --package .\modutex-desktop-0.1.0.tgz -- modutex
```

套件不是 EXE 安裝程式；`npx` 執行桌面 launcher，不是永久安裝。`--ignore-scripts` 禁止套件安裝腳本。Node／npm 版本不符時，先安裝指定版本，不要跳過檢查。

## PDF 編譯

工作區選擇 Managed Tectonic。引擎已內建，缺少資源時自動從 `https://relay.fullyjustified.net/default_bundle_v33.tar` 下載；首次仍需網路。快取位於應用 userData 下的 `tectonic-cache`，已快取資源可離線使用。

首次產生格式可能較慢，期限為 5 分鐘；一般編譯期限為 120 秒。取消或失敗不應取代上一份成功 PDF。新增套件可能需要補下載，不代表每次重新下載整套 TeX。

若舊工作區仍選用 System TeX，請手動切換 Managed Tectonic。自訂指令不會被自動覆寫。System TeX 需自行安裝；MiKTeX 的 latexmk 另需 Perl。

## 開發啟動

在儲存庫根目錄使用相同 Node／npm 版本：

```powershell
npm ci
npm run electron:dev
```

若顯示找不到 `concurrently`，表示依賴未安裝完成；請先確認 `npm ci` 成功。

## 安全設定

MCP 預設關閉，只監聽 loopback；自訂指令另有權限設定。

其他使用限制見 [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md)。
