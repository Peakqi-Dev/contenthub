import type { MediaAsset, PublishJob, SocialAccount, Variant } from "@prisma/client";
import { ContentStatus, JobStatus, Prisma } from "@prisma/client";
import { getAdapter } from "./adapters";
import { normalizeError, PublishError } from "./adapters/base";
import type { DecryptedAccount, PublishPayload, PublishResult } from "./adapters/types";
import { decryptSecret } from "./crypto";
import { prisma } from "./db";

// 發布執行器。Sprint 0 由 route handler 同步呼叫（純文字幾秒內完成）；
// Sprint 3 起改由 Vercel Workflows 呼叫同一個函式（規格 §7）。

export function decryptAccount(account: SocialAccount): DecryptedAccount {
  return {
    id: account.id,
    platform: account.platform,
    platformAccountId: account.platformAccountId,
    displayName: account.displayName,
    accessToken: decryptSecret(account.accessToken),
    refreshToken: account.refreshToken ? decryptSecret(account.refreshToken) : undefined,
    meta: (account.meta as Record<string, unknown> | null) ?? null,
  };
}

export async function toPayload(
  variant: Variant,
  assets?: MediaAsset[]
): Promise<PublishPayload> {
  const resolved =
    assets ??
    (variant.assetIds.length > 0
      ? await prisma.mediaAsset.findMany({ where: { id: { in: variant.assetIds } } })
      : []);
  // 依 assetIds 原始順序排列（findMany 不保證順序）
  const byId = new Map(resolved.map((a) => [a.id, a]));
  const ordered = variant.assetIds
    .map((id) => byId.get(id))
    .filter((a): a is MediaAsset => a !== undefined);

  return {
    surface: variant.surface,
    body: variant.body,
    assets: ordered.map((a) => ({
      url: a.blobUrl,
      kind: a.kind,
      width: a.width ?? undefined,
      height: a.height ?? undefined,
      durationSec: a.durationSec ?? undefined,
    })),
    linkInComment: variant.linkInComment,
    platformOpts: (variant.platformOpts as Record<string, unknown> | null) ?? undefined,
  };
}

/**
 * 執行一個 PublishJob：認領 → 預檢 → 發布 → 回寫結果。
 * 冪等：只認領 PENDING / QUEUED 的 job；已在處理或已完成的 job 直接回傳現狀。
 */
export async function executePublishJob(jobId: string): Promise<PublishJob> {
  // 原子認領，防止同一個 job 被並行執行兩次
  const claimed = await prisma.publishJob.updateMany({
    where: { id: jobId, status: { in: [JobStatus.PENDING, JobStatus.QUEUED] } },
    data: {
      status: JobStatus.PROCESSING,
      startedAt: new Date(),
      attempts: { increment: 1 },
    },
  });
  if (claimed.count === 0) {
    return prisma.publishJob.findUniqueOrThrow({ where: { id: jobId } });
  }

  const job = await prisma.publishJob.findUniqueOrThrow({
    where: { id: jobId },
    include: { variant: { include: { account: true } } },
  });

  try {
    const adapter = getAdapter(job.variant.account.platform);
    const payload = await toPayload(job.variant);

    // 預檢（純函式），結果快取到 Variant.validationState
    const issues = adapter.validate(payload);
    await prisma.variant.update({
      where: { id: job.variantId },
      data: { validationState: issues as unknown as Prisma.InputJsonValue },
    });
    if (issues.some((i) => i.level === "ERROR")) {
      return await markFailed(
        job.id,
        "VALIDATION_FAILED",
        issues
          .filter((i) => i.level === "ERROR")
          .map((i) => i.message)
          .join("；")
      );
    }

    const account = decryptAccount(job.variant.account);
    const result = await adapter.publish(payload, account);

    // 發布已成功。之後的 DB 回寫失敗絕不能把 job 標成 FAILED——
    // 貼文已在平台上線，標 FAILED 會誘使重發造成平台端重複貼文。
    return await recordSuccess(job.id, job.variant.contentPieceId, result);
  } catch (err) {
    const e = normalizeError(err);
    return markFailed(job.id, e.code, e.message);
  }
}

async function recordSuccess(
  jobId: string,
  contentPieceId: string,
  result: PublishResult
): Promise<PublishJob> {
  const data = {
    status: JobStatus.PUBLISHED,
    externalPostId: result.externalPostId,
    externalUrl: result.externalUrl,
    containerId: result.containerId,
    errorCode: null,
    errorMessage: null,
    completedAt: new Date(),
  } as const;

  // 回寫重試最多 3 次（連線池抖動等暫時性 DB 錯誤）
  let lastError: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      const [updated] = await prisma.$transaction([
        prisma.publishJob.update({ where: { id: jobId }, data }),
        prisma.contentPiece.update({
          where: { id: contentPieceId },
          data: { status: ContentStatus.PUBLISHED },
        }),
      ]);
      return updated;
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  // 回寫徹底失敗：大聲留 log（含 externalPostId 供人工對帳），job 留在 PROCESSING
  // 等後續 Sprint 的對帳機制回收，絕不標 FAILED。
  console.error(
    `[publish] job ${jobId} 已在平台發布成功但 DB 回寫失敗，` +
      `externalPostId=${result.externalPostId} externalUrl=${result.externalUrl ?? "-"}`,
    lastError
  );
  throw new PublishError(
    "RECORD_WRITE_FAILED",
    `貼文已發布（${result.externalPostId}）但 DB 回寫失敗，請人工確認`,
    false,
    lastError
  );
}

async function markFailed(
  jobId: string,
  errorCode: string,
  errorMessage: string
): Promise<PublishJob> {
  return prisma.publishJob.update({
    where: { id: jobId },
    data: {
      status: JobStatus.FAILED,
      errorCode,
      errorMessage,
      completedAt: new Date(),
    },
  });
}
