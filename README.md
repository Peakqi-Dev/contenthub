# content-hub — 多平台社群內容發布系統

一次撰寫 → AI 生成各平台變體 → 統一預檢 → 排程 → 分發。
自己的網站是唯一真實來源，其他平台都是分發端點。

**目前進度：Sprint 0**（Prisma schema + migration、PlatformAdapter 介面 + capability registry、Bluesky adapter）。
完整規格見開發規格書；四個核心架構決策（內容中樞、三層發布策略、Adapter Pattern、Surface 列舉）不在開發中途推翻。

## 技術棧

Next.js 15 (App Router) + TypeScript / PostgreSQL + Prisma 6 / @atproto/api

## 快速開始

```bash
npm install

# 1. 本地資料庫（或改用 Neon / Supabase，.env 換 DATABASE_URL 即可）
npx prisma dev -d -n content-hub --port 51213   # 啟動本地 Postgres
npx prisma migrate deploy                        # 套用 migration

# 2. 設定 .env（參考 .env.example）
#    ENCRYPTION_KEY：node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
#    BLUESKY_IDENTIFIER / BLUESKY_APP_PASSWORD：
#    Bluesky 設定 → Privacy and Security → App Passwords（不要用主密碼）

# 3. 連結 Bluesky 帳號（驗證憑證後加密存入 DB）
npm run connect:bluesky

# 4. 啟動並發文
npm run dev
curl -X POST http://localhost:3000/api/publish \
  -H "Content-Type: application/json" \
  -d '{"text": "hello from content-hub"}'
```

注意：使用 `prisma dev` 本地資料庫時，DATABASE_URL 需帶 `pgbouncer=true`（它的 TCP 端點是 transaction-mode 代理），`.env.example` 有範例。

## API（Sprint 0）

| 方法 | 路徑 | 說明 |
|---|---|---|
| POST | `/api/publish` | 立即發布：建立 ContentPiece + Variant + PublishJob，同步執行，回傳完整 job 紀錄。body：`text`（必填）、`title`、`accountId`、`langs`、`idempotencyKey`（同 key 重打回傳既有 job，不重發） |
| GET | `/api/jobs?status=&from=&to=` | 發布任務清單（含變體與帳號摘要） |
| GET | `/api/accounts` | 已連結帳號與健康狀態（永不回傳 token） |
| GET | `/api/capabilities` | Capability matrix（前端快取用） |

回應狀態：`201` 發布成功（job.externalUrl 是 Bluesky 貼文連結）、`422` 預檢失敗（`validation` 內有逐項中文訊息）、`502` 平台端失敗（`job.errorCode` / `errorMessage` 有正規化錯誤）。

規格 §8 的其餘路由（`/api/content`、`/api/schedule`、cron dispatcher、OAuth 連結流程）屬 Sprint 1–3。

## 架構速覽

```
src/lib/adapters/
  types.ts      PlatformAdapter 介面 + PlatformCapabilities（平台差異用資料描述，不用 if-else）
  base.ts       共用工具：錯誤正規化（PublishError）、重試、grapheme/byte 計數、截斷
  bluesky.ts    Bluesky adapter（300 graphemes / 3000 bytes、session 快取、免 app review）
  index.ts      registry：加新平台 = 實作 adapter + 登記一行
src/lib/
  publish.ts    發布執行器：原子認領 job → 預檢 → 發布 → 回寫（Sprint 3 起由 Workflow 呼叫同一函式）
  crypto.ts     AES-256-GCM，token 落 DB 前必須加密
  db.ts         PrismaClient singleton
prisma/
  schema.prisma SocialAccount / ContentPiece / Variant / MediaAsset / PublishJob / GenerationRun
  migrations/   0_init
scripts/
  connect-bluesky.ts  連結 Bluesky 帳號（Bluesky 免審核；OAuth 流程是 Sprint 1 的 Meta 家族才需要）
```

設計重點：

- `validate()` 是純函式、不打網路，前端可即時呼叫。
- 每個 PublishJob 必有 `idempotencyKey`（預設 `${variantId}:${scheduledAt ISO}`），job 認領用原子 `updateMany` 防並行重發。
- Bluesky session 會在程序內快取重用（createSession 限 30 次/5 分鐘）。
- `SocialAccount.userId` 已預留（目前固定 `"local"`），未來多租戶是加功能不是重寫。

## 常用指令

```bash
npm run dev              # 開發伺服器
npm run build            # production build
npm run typecheck        # tsc --noEmit
npm run db:migrate       # prisma migrate deploy
npm run db:studio        # Prisma Studio
npm run connect:bluesky  # 連結/更新 Bluesky 帳號
```
