# 前端測試入口

`run-tests.mjs` 遞迴找出 `tests` 內的 `.test.ts`，按名稱排序、串行執行，單一 Node heap 上限 512 MiB。排除 `helpers`、`performance`、`production` 與 symlink；空測試集合回傳非零，子程序失敗會傳回呼叫端。

```powershell
node apps/frontend/scripts/run-tests.mjs
node apps/frontend/scripts/run-tests.mjs tests/infrastructure
```

第二個參數相對於 `apps/frontend`。巢狀測試啟動獨立 Node 時移除 `NODE_TEST_CONTEXT`，避免子程序只載入測試而未執行。

`.test.mjs` 的 production 與 browser 測試須明確執行，不包含在預設集合；此入口不代表 GUI 或效能驗收。
