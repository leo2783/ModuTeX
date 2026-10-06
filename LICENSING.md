# ModuTeX 授權範圍

ModuTeX 桌面應用是 Texpile 的衍生作品，整體維持 `AGPL-3.0-only`，全文見 [LICENSE](./LICENSE)。未另列授權的專案檔案沿用此預設；第三方檔案保留各自授權，不因本文件而變更。

## Apache-2.0 原創工具

原創碼權利人於 2026-10-04 明確確認持有改授權權限，並授權下列兩個檔案使用 `Apache-2.0`，全文見 [LICENSES/Apache-2.0.txt](./LICENSES/Apache-2.0.txt)。此清單逐檔適用，不包含同目錄其他檔案。

| 檔案 | 範圍 |
|---|---|
| `scripts/vendor/vendor-manifest.mjs` | 獨立 vendor manifest schema／固定來源驗證工具 |
| `scripts/vendor/vendor-manifest.test.mjs` | 上述工具的原創測試；不變更所讀 fixture 或 vendor 的授權 |

這兩檔在固定上游 `8bf1ca1c318b64b2e9531247116d8d2d5dbe6d97` 不存在，新增於 `9ce5e11129a97f39684514b0a158942ee4f5f22b`，後續來源修正於 `133cb52b276282b63bea21f942aba5c1b556314d`。完整來源審查未見上游應用模組依賴或可見搬移片段；此結果不等同法律上的無侵權保證。

## 分發邊界

獨立重用這兩個原創工具可依 Apache-2.0。包含 AGPL 衍生程式的組合應用仍須遵守 AGPL；本文件不授予上游改授權權限，也不取消舊版本使用者已取得的授權。根 `package.json`、打包驗證與來源提供仍使用 `AGPL-3.0-only`。

Draw.io、Tectonic、Typst、圖片、字型、stencil 與 npm／Rust 套件不在此次改授權範圍；請保留其 LICENSE／NOTICE。後續候選與替換順序見 [來源盤點](./docs/licensing/AGPL_APACHE_INVENTORY_2026-10-04.md)。

依據：[AGPL 第 4–6 節](https://www.gnu.org/licenses/agpl-3.0.html)、[GNU 授權 FAQ](https://www.gnu.org/licenses/gpl-faq.en.html)、[Apache-2.0 第 4 節](https://www.apache.org/licenses/LICENSE-2.0)。
