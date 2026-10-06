# ModuTeX

Windows 桌面 LaTeX 編輯器，提供視覺／原始碼編輯、表格工具、數學輸入與 PDF 預覽。內建 Tectonic 引擎；首次編譯或缺少套件時，會從固定來源下載 TeX 資源並快取。

## 啟動 0.1.0 套件

需要 Windows x64、Node.js 24.19.0 與 npm 11.17.0。隨附套件位於 `release/version-0.1.0/`，不是公開 npm registry 發布。

```powershell
cd release/version-0.1.0
npx --offline --yes --ignore-scripts --package .\modutex-desktop-0.1.0.tgz -- modutex
```

`--offline` 限制 npm 下載，不禁止編譯器下載缺少的 TeX 資源。先依 [安裝說明](docs/INSTALLATION.md) 核對 checksum。

## 從原始碼啟動

```powershell
npm ci
npm run electron:dev
```

最低靜態檢查為 `npm run verify:install-policy` 與 `npm run verify:vendor`。完整驗證入口為 `npm run verify:modutex`；正式套件需先建置桌面 payload，不能直接把原始碼 `npm pack` 當成可執行桌面版。

## 範圍與授權

- [已知限制](docs/KNOWN_LIMITATIONS.md)：延後功能與尚未完成的發布驗證。
- [來源與驗證](docs/SOURCE_ORIGIN.md)：固定 main commit、排除範圍與套件對應。
- [授權範圍](LICENSING.md)：整體衍生應用為 AGPL-3.0-only；僅明列的原創工具使用 Apache-2.0。第三方 LICENSE／NOTICE 保留。
