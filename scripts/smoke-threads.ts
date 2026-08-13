// Threads adapter 完成定義（規格 v1.1 修訂 6）：真的在自己的 Threads 帳號發出一則貼文。
//
// 前置（一次性）：
//   1. developers.facebook.com 建 Meta App，選 Threads use case
//   2. Use cases → Customize → Settings 填 redirect URI：
//        http://localhost:3000/api/accounts/callback/threads
//   3. 把自己的 Threads 帳號加為 Threads Tester 並在 Threads App 接受邀請
//   4. .env 填 THREADS_APP_ID / THREADS_APP_SECRET（Threads 那組，不是 Facebook 的）
//   5. npm run dev → 登入 → 瀏覽器開 http://localhost:3000/api/accounts/connect/threads
//      完成授權（帳號會寫入 DB，token 加密）
//
// 執行：npm run smoke:threads
// 注意：每次執行都會真的發一篇公開貼文到你的 Threads。

import { JobStatus, Platform } from "@prisma/client";
import { prisma } from "../src/lib/db";
import { publishText } from "../src/lib/publish";

async function main() {
  const account = await prisma.socialAccount.findFirst({
    where: { platform: Platform.THREADS, isActive: true },
    orderBy: { createdAt: "asc" },
  });
  if (!account) {
    console.error(
      "找不到已連結的 Threads 帳號。請先完成 OAuth 連結（步驟見本檔案開頭註解）。"
    );
    process.exitCode = 1;
    return;
  }
  console.log(`使用帳號：${account.displayName}（threads user ${account.platformAccountId}）\n`);

  const stamp = new Date().toISOString();
  const result = await publishText(account, {
    text: `contenthub Threads adapter 驗收 🚀 ${stamp}`,
    idempotencyKey: `smoke-threads:${stamp}`,
  });

  const ok = result.job.status === JobStatus.PUBLISHED && !!result.job.externalPostId;
  console.log(`${ok ? "✅" : "❌"} 發布${ok ? "成功" : "失敗"}`);
  console.log(`   status         : ${result.job.status}`);
  console.log(`   attempts       : ${result.job.attempts}`);
  console.log(`   externalPostId : ${result.job.externalPostId ?? "-"}`);
  console.log(`   permalink      : ${result.job.externalUrl ?? "-"}`);
  if (!ok) {
    console.log(`   errorCode      : ${result.job.errorCode ?? "-"}`);
    console.log(`   errorMessage   : ${result.job.errorMessage ?? "-"}`);
  }
  process.exitCode = ok ? 0 : 1;
}

main()
  .catch((err) => {
    console.error("smoke-threads 執行失敗：", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
