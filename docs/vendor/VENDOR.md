# 第三方版本與離線驗證

`vendor/vendor-lock.json` 固定 Draw.io 31.1.8（Apache 核心）與 Tectonic 0.17.0（MIT）的 archive URL、名稱、SHA-256、notices。實際條款見 `vendor/notices`；Draw.io 不納入新 Tauri 核心。

validator 拒絕未知欄位、路徑穿越／重複、可變 URL、錯誤 hash 與 notices 越界。測試：`node --test scripts/vendor/vendor-manifest.test.mjs`。

## 驗證與安裝

- `node scripts/verify-vendor.mjs`：檢查已保留目錄／檔案、拒絕 symlink／額外路徑；核對 Draw.io 3378 檔 tree inventory、Tectonic 2 檔 inventory、PE／hash／notices。不自動下載。
- 指定 `--archive-dir` 可驗現有 archive；`--cache-dir --download` 明確下載，單獨 `--cache-dir` 走離線。`--artifact` 需搭配目錄；不完整或遭修改的 cache 直接失敗，不自動覆蓋。解壓前再次驗 hash 與來源 sidecar。
- 安裝 Tectonic：`node scripts/vendor/tectonic-vendor.mjs install --archive <verified-cache>/tectonic-0.17.0-x86_64-pc-windows-msvc.zip`。

## 固定證據

| 產物 | SHA-256／大小 |
|---|---|
| 2026-09-30 Tectonic archive | `f61ce51f0b0ade1015b7de7ef368541c5424e9756ecbd0d7af97d6d48030845f`，21060223 bytes |
| `vendor/tectonic/windows-x64/tectonic.exe` | `99ffcfdbf1ebf8bdda9e791942e3d06aedb12463fddc33f07de6f5211c8bf08d` |

lock metadata、實際 bytes 與執行結果各自驗證；Tauri 的真引擎啟停證據見[遷移計畫](../architecture/TAURI_APACHE_MIGRATION_PLAN_2026-10-17.md)。
