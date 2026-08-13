// Sprint 0 驗收（規格 v1.1 二次修訂）：
//   1. 執行後 DB 有一筆 PublishJob 狀態 PUBLISHED
//   2. 重跑同一指令不會產生第二筆（冪等性生效）
//   3. 模擬失敗時正確重試到 maxAttempts（3 次）後轉 FAILED
// 另加驗：token 過期不重試（attempts=1）、容器模式輪詢後 PUBLISHED。
//
// 執行：npm run smoke:fake

import { randomUUID } from "node:crypto";
import { JobStatus, Platform, PublishTier } from "@prisma/client";
import { encryptSecret } from "../src/lib/crypto";
import { prisma } from "../src/lib/db";
import { publishText } from "../src/lib/publish";

const SUCCESS_KEY = "smoke-fake-publish"; // 固定 key：重跑同一指令必須 dedup
const FAST = { retryDelayMs: 20, pollIntervalMs: 20 };

let failures = 0;
function check(name: string, ok: boolean, detail: string) {
  console.log(`${ok ? "✅" : "❌"} ${name} — ${detail}`);
  if (!ok) failures++;
}

async function main() {
  // 0. 準備 FAKE 帳號（假憑證，加密後入庫）
  const account = await prisma.socialAccount.upsert({
    where: {
      platform_platformAccountId: {
        platform: Platform.FAKE,
        platformAccountId: "fake-local",
      },
    },
    create: {
      platform: Platform.FAKE,
      publishTier: PublishTier.AUTO_API,
      displayName: "Fake 測試帳號",
      platformAccountId: "fake-local",
      accessToken: encryptSecret("fake-token"),
      scopes: [],
      healthStatus: "OK",
      lastHealthCheckAt: new Date(),
    },
    update: { isActive: true },
  });
  console.log(`帳號就緒：${account.displayName}（${account.id}）\n`);

  // 前次執行若在發布中途被中斷，固定 key 的 job 會殘留 PROCESSING/AWAITING_MEDIA
  // （PENDING 的殘留由 publishText 的 dedup 路徑自動重新驅動，不用處理）。
  // 這是測試 job，直接清掉重來。
  const stale = await prisma.publishJob.findUnique({
    where: { idempotencyKey: SUCCESS_KEY },
  });
  if (stale && (stale.status === JobStatus.PROCESSING || stale.status === JobStatus.AWAITING_MEDIA)) {
    await prisma.publishJob.delete({ where: { id: stale.id } });
    console.log(`（清除前次中斷殘留的 ${stale.status} job：${stale.id}）\n`);
  }

  // 1. 成功發布（固定 idempotencyKey）
  const first = await publishText(account, {
    text: "smoke-fake：成功路徑測試貼文",
    idempotencyKey: SUCCESS_KEY,
    executeOpts: FAST,
  });
  check(
    "驗收 1：PublishJob 狀態 PUBLISHED",
    first.job.status === JobStatus.PUBLISHED,
    `status=${first.job.status} externalPostId=${first.job.externalPostId ?? "-"}` +
      (first.deduplicated ? "（本輪為重跑，取自既有 job）" : "")
  );

  // 2. 重跑同一指令 → 不產生第二筆
  const second = await publishText(account, {
    text: "smoke-fake：成功路徑測試貼文",
    idempotencyKey: SUCCESS_KEY,
    executeOpts: FAST,
  });
  const countForKey = await prisma.publishJob.count({
    where: { idempotencyKey: SUCCESS_KEY },
  });
  check(
    "驗收 2：冪等性（重跑不產生第二筆）",
    second.deduplicated && second.job.id === first.job.id && countForKey === 1,
    `deduplicated=${second.deduplicated} 同一 job=${second.job.id === first.job.id} DB 筆數=${countForKey}`
  );

  // 3. 可重試失敗（RATE_LIMIT）→ 重試到 maxAttempts=3 後 FAILED
  const fail = await publishText(account, {
    text: "smoke-fake：失敗路徑（rate limit）",
    platformOpts: { simulate: "RATE_LIMIT" },
    idempotencyKey: `smoke-fake-fail:${randomUUID()}`,
    executeOpts: FAST,
  });
  check(
    "驗收 3：可重試失敗 → 嘗試 3 次後 FAILED",
    fail.job.status === JobStatus.FAILED &&
      fail.job.attempts === 3 &&
      fail.job.errorCode === "RATE_LIMITED",
    `status=${fail.job.status} attempts=${fail.job.attempts} errorCode=${fail.job.errorCode}`
  );

  // 4.（加驗）不可重試失敗（TOKEN_EXPIRED）→ 不重試，attempts=1
  const auth = await publishText(account, {
    text: "smoke-fake：失敗路徑（token 過期）",
    platformOpts: { simulate: "TOKEN_EXPIRED" },
    idempotencyKey: `smoke-fake-auth:${randomUUID()}`,
    executeOpts: FAST,
  });
  check(
    "加驗：不可重試失敗 → 立即 FAILED（attempts=1）",
    auth.job.status === JobStatus.FAILED &&
      auth.job.attempts === 1 &&
      auth.job.errorCode === "AUTH_FAILED",
    `status=${auth.job.status} attempts=${auth.job.attempts} errorCode=${auth.job.errorCode}`
  );

  // 5.（加驗）容器模式（MEDIA_PROCESSING）→ 輪詢後 PUBLISHED
  const media = await publishText(account, {
    text: "smoke-fake：容器模式（媒體處理中）",
    platformOpts: { simulate: "MEDIA_PROCESSING" },
    idempotencyKey: `smoke-fake-media:${randomUUID()}`,
    executeOpts: FAST,
  });
  check(
    "加驗：容器模式輪詢 → PUBLISHED（含 containerId）",
    media.job.status === JobStatus.PUBLISHED && !!media.job.containerId,
    `status=${media.job.status} containerId=${media.job.containerId ?? "-"}`
  );

  // 清掉隨機 key 測項（3–5）產生的資料，避免重複執行時堆積；成功測項（固定 key）
  // 刻意保留，跨次冪等驗證靠它。
  const cleanupIds = [fail, auth, media]
    .map((o) => o.contentPieceId)
    .filter((id): id is string => !!id);
  if (cleanupIds.length > 0) {
    await prisma.contentPiece.deleteMany({ where: { id: { in: cleanupIds } } });
  }

  console.log(
    failures === 0 ? "\n🎉 Sprint 0 驗收全數通過" : `\n💥 ${failures} 項未通過`
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((err) => {
    console.error("smoke-fake 執行失敗：", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
