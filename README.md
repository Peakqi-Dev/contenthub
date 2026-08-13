# contenthub — 多平台社群內容發布系統

一次撰寫 → AI 生成各平台變體 → 統一預檢 → 排程 → 分發。
自己的網站是唯一真實來源，其他平台都是分發端點。

**規格版本：v1.1**（2026-08-14 修訂）。核心架構決策（內容中樞、三層發布策略、Adapter Pattern + capability registry、Surface 列舉）不在開發中途推翻。

## 第一階段平台範圍（v1.1 修訂 2）

只做這六個，其餘一律不實作：**Facebook 粉專、Instagram、Threads、X、LINE OA、Medium（ASSISTED）**

Adapter 實作順序（v1.1，2026-08-14 二次修訂；一次只做一個）：

1. **Fake** — 架構驗證：不打外網，驗 job 狀態機、重試邏輯、冪等性 ✅
2. **Threads** — Meta 家族最小樣本
3. **meta/shared.ts + Facebook 粉專** — 容器模式 + token 刷新
4. **Instagram** — FEED / STORY / REEL，複用 shared.ts
5. **X** — 含 linkInComment 成本開關
6. **Medium** — ASSISTED（自家站發布 → Medium Import）
7. **LINE OA** — 推播計費，最後實作

每個 adapter 的工作紀律（v1.1 修訂 6）：開工前先讀該平台**官方文件**確認端點與參數；完成的定義不是測試綠燈，而是 `scripts/smoke-{platform}.ts` 真的在自己的帳號發出一則貼文。

**Sprint 0 驗收（`npm run smoke:fake`）**：執行後 DB 有一筆 PublishJob 狀態 `PUBLISHED`；重跑同一指令不會產生第二筆（冪等性生效）；模擬失敗時正確重試到 `maxAttempts=3` 後轉 `FAILED`。

Fake adapter 以 `platformOpts.simulate` 模擬失敗情境：`TIMEOUT`（逾時，可重試）/ `RATE_LIMIT`（429，可重試）/ `MEDIA_PROCESSING`（容器模式：回 containerId，輪詢兩次後 FINISHED）/ `TOKEN_EXPIRED`（401，不重試直接 FAILED）。發布紀錄寫入 `logs/fake-publish.log`。

> Meta 註記（v1.1 修訂 1）：自用（發到自己的粉專/IG）走 **Standard Access 即可，不需 App Review**。App Review 只在未來開放其他使用者時才需要。

## 技術棧

Next.js 15 (App Router) + TypeScript / PostgreSQL + Prisma 6 / Vitest

## 快速開始

```bash
npm install

# 1. 本地資料庫（或改用 Neon / Supabase，.env 換 DATABASE_URL 即可）
npx prisma dev -d -n content-hub --port 51213   # 啟動本地 Postgres
npx prisma migrate deploy                        # 套用 migration

# 2. 設定 .env（參考 .env.example）
#    ENCRYPTION_KEY：node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# 3. 測試與啟動
npm test          # vitest（含 adapter 合約測試）
npm run dev
```

注意：使用 `prisma dev` 本地資料庫時，DATABASE_URL 需帶 `pgbouncer=true`（它的 TCP 端點是 transaction-mode 代理），`.env.example` 有範例。

## Adapter 合約（v1.1 修訂 4，系統核心）

所有 adapter 必須通過 [contract.ts](src/lib/adapters/__tests__/contract.ts) 的共用測試套件：

1. `capabilities` 物件結構完整（平台差異用資料描述，不用 if-else）
2. `validate()` 是純函式：不發網路請求、同輸入同輸出（前端可即時呼叫）
3. `validate()` 對超長文字回傳 ERROR、對邊界值（達上限 90%）回傳 WARNING
4. `publish()` 失敗時拋出正規化的 `PublishError`，不外洩原始 API 錯誤與憑證

文字長度採**多重計數模式**（v1.1 修訂 3）：`text.limits` 可同時定義 `chars`（grapheme）/ `utf8Bytes` / `utf16Units` / `weighted`（X 加權）多種上限，`countingMode` 指定主要模式，`validate()` 依模式選用對應算法（見 [base.ts](src/lib/adapters/base.ts) 的 `countText` / `textLimitIssues`）。

新平台上線流程：實作 `PlatformAdapter` → 在 [contract.test.ts](src/lib/adapters/__tests__/contract.test.ts) 掛上 `adapterContract()` → 在 [index.ts](src/lib/adapters/index.ts) registry 登記 → `scripts/smoke-{platform}.ts` 實發驗證。

## API（目前）

| 方法 | 路徑 | 說明 |
|---|---|---|
| POST | `/api/publish` | 立即發布：建立 ContentPiece + Variant + PublishJob，同步執行，回傳完整 job 紀錄。body：`text`（必填）、`title`、`accountId`、`surface`、`platformOpts`、`idempotencyKey`（同 key 重打回傳既有 job，不重發；併發同 key 亦安全） |
| GET | `/api/jobs?status=&from=&to=` | 發布任務清單（含變體與帳號摘要） |
| GET | `/api/accounts` | 已連結帳號與健康狀態（永不回傳 token） |
| GET | `/api/capabilities` | Capability matrix（前端快取用） |

回應狀態：`201` 發布成功、`422` 預檢失敗（`validation` 內有逐項中文訊息）、`502` 平台端失敗（`job.errorCode` / `errorMessage` 為正規化錯誤）。

規格 §8 的其餘路由（`/api/content`、`/api/schedule`、cron dispatcher、OAuth 連結流程）屬後續 Sprint。

## 架構速覽

```
src/lib/adapters/
  types.ts       PlatformAdapter 介面 + PlatformCapabilities（多重計數模式）
  base.ts        共用工具：錯誤正規化（PublishError）、重試、countText / textLimitIssues、截斷
  index.ts       registry：加新平台 = 實作 adapter + 過合約測試 + 登記一行
  __tests__/
    contract.ts  ★ 所有 adapter 必過的共用合約測試套件
src/lib/
  publish.ts     發布執行器：原子認領 job → 預檢 → 發布 → 回寫
  crypto.ts      AES-256-GCM，token 落 DB 前必須加密
prisma/          schema + migrations（SocialAccount / ContentPiece / Variant / MediaAsset / PublishJob / GenerationRun）
```

設計重點：

- 每個 PublishJob 必有 `idempotencyKey`（預設 `${variantId}:${scheduledAt ISO}`）；job 認領用原子 `updateMany` 防並行重發；併發同 key 建立會被 unique 約束擋下並回傳既有 job。
- **發布成功後的 DB 回寫失敗不會把 job 標成 FAILED**（貼文已上線，標 FAILED 會誘使重發）；回寫重試 3 次，仍失敗則 job 留在 PROCESSING 並大聲留 log 供人工對帳。
- `withRetry` 明文禁止包「非冪等的平台寫入」——網路錯誤可能發生在平台已收下請求之後，重試會發出重複貼文。
- `SocialAccount.userId` 已預留（目前固定 `"local"`），未來多租戶是加功能不是重寫。

已知限制（後續 Sprint 處理）：process 中斷時 job 可能停留在 PROCESSING，需等排程/對帳機制（Sprint 3）回收。

## 常用指令

```bash
npm run dev              # 開發伺服器
npm test                 # vitest（合約測試 + 單元測試）
npm run build            # production build
npm run typecheck        # tsc --noEmit
npm run db:migrate       # prisma migrate deploy
npm run db:studio        # Prisma Studio
```

## 部署（Vercel）

1. GitHub repo 連上 Vercel 專案（此 repo：`Peakqi-Dev/contenthub`）。
2. 環境變數：`DATABASE_URL`（Neon / Supabase 等雲端 Postgres）、`ENCRYPTION_KEY`。
3. `postinstall` 已配置 `prisma generate`；首次部署前對雲端 DB 跑 `npx prisma migrate deploy`。
