# Installation / 安裝

## Windows x64 — 0.2.1

Download from the [official Release](https://github.com/leo2783/ModuTeX/releases/tag/v0.2.1). Choose:

| File | Use | Requirements |
|---|---|---|
| `ModuTeX-Setup-0.2.1.exe` | Install with a wizard; launch from the Start menu. | Windows x64; no separate Node/npm/TeX installation. |
| `modutex-desktop-0.2.1.tgz` | Run the local package through npx. | Windows x64, Node.js 24.19.0, npm 11.17.0. |

請從官方 Release 下載檔案與同名 `.sha256`。EXE 提供安裝精靈及開始功能表捷徑；TGZ 透過 npx 執行，不會永久安裝 Windows 應用程式。兩者皆內建 Tectonic。

## Verify the download / 核對下載

In PowerShell, set `$download` to the EXE or TGZ filename. Only proceed if the checksum matches.
在下載資料夾開啟 PowerShell，將檔名設為 EXE 或 TGZ；核對成功後才執行。

```powershell
$download = 'ModuTeX-Setup-0.2.1.exe'
$expected = (Get-Content ".\$download.sha256").Split(' ')[0].ToLowerInvariant()
$actual = (Get-FileHash ".\$download" -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw 'Checksum mismatch; do not run this file' }
```

Double-click the verified EXE and follow the wizard. Uninstall through Windows Settings → Apps; document files and application settings are retained.
EXE 核對後雙擊並依精靈安裝。可由 Windows「設定 → 應用程式」解除安裝；文件與應用程式設定會保留。

For TGZ, verify `modutex-desktop-0.2.1.tgz` with the same steps, then run:
TGZ 核對後執行：

```powershell
npx --offline --yes --ignore-scripts --package .\modutex-desktop-0.2.1.tgz -- modutex
```

Initial extraction can take several minutes. `--ignore-scripts` blocks package installation scripts. The TGZ is not published to the npm registry.
首次解壓可能需要數分鐘；此命令使用下載的本機套件，不需要 npm registry 發布。

## Windows blocking / Windows 封鎖

The installer is unsigned; **Unknown publisher** or **Windows protected your PC** can appear. A matching checksum verifies the downloaded bytes, not publisher identity or absence of malware.
安裝程式尚未簽署，可能出現「未知的發行者」或「Windows 已保護您的電腦」。SHA-256 用於核對檔案完整性，不能取代發行者簽章或惡意程式檢查。

| Message / 情況 | Action / 處理 |
|---|---|
| SmartScreen: unrecognized app / 無法辨識的應用程式 | Confirm the official Release and checksum. If you trust the file and Windows offers it, choose **More info → Run anyway** / 核對來源與雜湊且信任檔案後，可選「其他資訊 → 仍要執行」。 |
| Downloaded file is blocked / 下載檔案被封鎖 | File **Properties → Unblock → Apply**, if available / 檔案「內容 → 解除封鎖 → 套用」，僅限有此選項時。 |
| Browser blocks an uncommon download / 瀏覽器封鎖不常見下載 | Inspect the download warning and source; keep it only after checking the official Release. Verify SHA-256 before launch / 先核對官方來源，保留下載後仍須核對 SHA-256。 |
| Antivirus reports malware, or checksum differs / 防毒警示或雜湊不符 | Stop; do not run. Report the exact warning and file version through GitHub Issues / 停止執行，回報警示與版本。 |
| Smart App Control or organization policy blocks execution / 智慧型應用程式控制或組織政策封鎖 | A Run anyway option may not exist. Contact your administrator or wait for a signed build / 可能無法略過，請聯絡管理員或等待簽署版本。 |

Do not disable system-wide antivirus or SmartScreen. TGZ still launches an executable and does not bypass these policies.
不要關閉全系統防毒或 SmartScreen；TGZ 內含的執行檔仍受 Windows 政策限制。

Microsoft references: [SmartScreen](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation), [downloaded-file blocking](https://support.microsoft.com/en-gb/windows/security/information-about-the-attachment-manager-in-microsoft-windows), [Smart App Control](https://support.microsoft.com/en-us/windows/security/threat-malware-protection/smart-app-control-frequently-asked-questions).

## First compilation / 首次編譯

Managed Tectonic downloads uncached resources from its configured bundle source. The first format build can take up to five minutes; subsequent compilations reuse the cache. New packages can require internet access again. A failure preserves the last successful PDF.
首次產生格式或遇到未快取資源時需要網路，最多可等待五分鐘；後續使用快取。加入新套件仍可能需要下載。失敗時會保留上一份成功 PDF。

See [compilation](COMPILATION.md), [editing](EDITING.md) and [known limitations](KNOWN_LIMITATIONS.md).