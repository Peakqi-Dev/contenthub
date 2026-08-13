import type {
  MediaAsset,
  PublishJob,
  SocialAccount,
  Variant,
} from "@prisma/client";
import { ContentStatus, JobStatus, Prisma, Surface } from "@prisma/client";
import { getAdapter } from "./adapters";
import { normalizeError, PublishError } from "./adapters/base";
import type {
  DecryptedAccount,
  PlatformAdapter,
  PublishPayload,
  PublishResult,
} from "./adapters/types";
import { decryptSecret } from "./crypto";
import { prisma } from "./db";

// 發布執行器。Sprint 0 由 route handler / smoke 腳本同步呼叫；
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
  ownerUserId: string,
  assets?: MediaAsset[]
): Promise<PublishPayload> {
  const resolved =
    assets ??
    (variant.assetIds.length > 0
      ? await prisma.mediaAsset.findMany({
          // 防禦性租戶過濾：assetIds 目前沒有任何寫入點（恆為空陣列），
          // 但未來 variant 編輯/媒體上傳進來時，這裡保證撈不到別人的資產
          where: { id: { in: variant.assetIds }, userId: ownerUserId },
        })
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

export interface ExecuteOptions {
  /** 重試間隔基數（毫秒），實際為 baseMs * attempts；測試用小值 */
  retryDelayMs?: number;
  /** 容器模式輪詢間隔（毫秒） */
  pollIntervalMs?: number;
  /** 容器模式最大輪詢次數 */
  maxPolls?: number;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 執行一個 PublishJob：認領 → 預檢 → 發布（含 job 層級重試）→ 容器輪詢 → 回寫結果。
 *
 * - 冪等：只認領 PENDING / QUEUED 的 job；已在處理或已完成的 job 直接回傳現狀。
 * - 重試：retryable 錯誤最多嘗試 maxAttempts 次（attempts 逐次寫回 DB），
 *   之後轉 FAILED；不可重試的錯誤（如 AUTH_FAILED）立即 FAILED。
 *   ⚠️ 真實平台 adapter 註冊前必須讓 publish() 對平台端冪等（或把「結果不明」
 *   的錯誤標為不可重試），否則重試會發出重複貼文——見 base.ts withRetry 的警告。
 * - 容器模式：publish 回傳 containerId 時，job 進 AWAITING_MEDIA 並輪詢
 *   pollStatus 直到 FINISHED / ERROR / 逾時。
 */
export async function executePublishJob(
  jobId: string,
  opts: ExecuteOptions = {}
): Promise<PublishJob> {
  const retryDelayMs = opts.retryDelayMs ?? 1000;

  // 原子認領，防止同一個 job 被並行執行兩次
  const claimed = await prisma.publishJob.updateMany({
    where: { id: jobId, status: { in: [JobStatus.PENDING, JobStatus.QUEUED] } },
    data: { status: JobStatus.PROCESSING, startedAt: new Date() },
  });
  if (claimed.count === 0) {
    return prisma.publishJob.findUniqueOrThrow({ where: { id: jobId } });
  }

  const job = await prisma.publishJob.findUniqueOrThrow({
    where: { id: jobId },
    include: { variant: { include: { account: true } } },
  });

  // 認領成功後、呼叫 adapter.publish 之前的任何例外都必須轉 FAILED——
  // 此時平台端保證沒有貼文，標 FAILED 安全；若讓例外冒出，job 會永久卡在
  // PROCESSING（認領條件只吃 PENDING/QUEUED）並燒掉 idempotencyKey。
  let adapter: PlatformAdapter;
  let payload: PublishPayload;
  let account: DecryptedAccount;
  try {
    adapter = getAdapter(job.variant.account.platform);
    payload = await toPayload(job.variant, job.variant.account.userId);

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

    account = decryptAccount(job.variant.account);
  } catch (err) {
    const e = normalizeError(err);
    return markFailed(job.id, e.code, e.message);
  }

  // 發布（job 層級重試）：try 只包「發布嘗試」本身
  let attempts = job.attempts;
  let result: PublishResult | undefined;
  while (result === undefined) {
    attempts++;
    try {
      await prisma.publishJob.update({ where: { id: job.id }, data: { attempts } });
      result = await adapter.publish(payload, account);
    } catch (err) {
      const e = normalizeError(err);
      if (!e.retryable || attempts >= job.maxAttempts) {
        return markFailed(job.id, e.code, e.message);
      }
      await delay(retryDelayMs * attempts);
    }
  }

  // ── 從這裡開始平台端已確定收下請求：任何本地失敗都絕不能重呼叫 publish ──

  // 容器模式（Meta 系 / FAKE 模擬）：輪詢直到媒體處理完成
  if (result.containerId && adapter.pollStatus) {
    // AWAITING_MEDIA 是顯示用中繼狀態：寫入失敗不致命，留 log 續走輪詢
    try {
      await prisma.publishJob.update({
        where: { id: job.id },
        data: { status: JobStatus.AWAITING_MEDIA, containerId: result.containerId },
      });
    } catch (err) {
      console.error(`[publish] job ${job.id} 寫入 AWAITING_MEDIA 失敗（不影響輪詢）`, err);
    }
    const polled = await pollUntilDone(adapter, result.containerId, account, opts);
    if (polled !== "FINISHED") {
      // 容器未完成發布（真平台此時尚未 media_publish，無公開貼文）→ FAILED 安全
      return markFailed(
        job.id,
        polled === "ERROR" ? "MEDIA_PROCESSING_FAILED" : "MEDIA_PROCESSING_TIMEOUT",
        polled === "ERROR" ? "平台媒體處理失敗" : "等待平台媒體處理逾時"
      );
    }
  }

  // 發布已成功。之後的 DB 回寫失敗絕不能把 job 標成 FAILED——
  // 貼文已在平台上線，標 FAILED 會誘使重發造成平台端重複貼文。
  return recordSuccess(job.id, job.variant.contentPieceId, result);
}

async function pollUntilDone(
  adapter: ReturnType<typeof getAdapter>,
  containerId: string,
  account: DecryptedAccount,
  opts: ExecuteOptions
): Promise<"FINISHED" | "ERROR" | "TIMEOUT"> {
  const maxPolls = opts.maxPolls ?? 30;
  const pollIntervalMs = opts.pollIntervalMs ?? 2000;
  for (let i = 0; i < maxPolls; i++) {
    try {
      const s = await adapter.pollStatus!(containerId, account);
      if (s === "FINISHED") return "FINISHED";
      if (s === "ERROR") return "ERROR";
    } catch (err) {
      // 單次輪詢拋錯（網路抖動）視為仍在處理，繼續輪詢
      console.error(`[publish] pollStatus 第 ${i + 1} 次拋錯，視為處理中`, err);
    }
    if (i < maxPolls - 1) await delay(pollIntervalMs);
  }
  return "TIMEOUT";
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
      await delay(500 * (i + 1));
    }
  }
  // 回寫徹底失敗：大聲留 log（含 externalPostId 供人工對帳），job 留在原狀態
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

// ============ 建立 + 立即執行（route 與 smoke 腳本共用）============

export interface PublishTextInput {
  text: string;
  title?: string;
  surface?: Surface;
  platformOpts?: Prisma.InputJsonValue;
  /** 不給則用預設 `${variantId}:${scheduledAt ISO}`（每次呼叫都是新 job） */
  idempotencyKey?: string;
  executeOpts?: ExecuteOptions;
}

/**
 * PublishJob.idempotencyKey 是全域唯一，但 PublishJob 不存 userId（租戶歸屬經
 * parent 繼承）。client 自訂的 key 一律加租戶前綴存放，否則不同 user 用同一個
 * key 會互相碰撞（B 可佔住 A 的 key，甚至經 dedup 讀到 A 的 job）。
 */
export function tenantIdempotencyKey(userId: string, clientKey: string): string {
  return `u:${userId}:${clientKey}`;
}

export interface PublishTextOutcome {
  deduplicated: boolean;
  job: PublishJob;
  contentPieceId?: string;
  variantId?: string;
  validation?: unknown;
}

/**
 * 建立 ContentPiece → Variant → PublishJob 並同步執行。
 * 冪等：同 idempotencyKey 重複呼叫（含併發）回傳既有 job，不重發。
 */
export async function publishText(
  account: SocialAccount,
  input: PublishTextInput
): Promise<PublishTextOutcome> {
  // client 自訂 key 加租戶前綴（見 tenantIdempotencyKey 的說明）
  const storedKey = input.idempotencyKey
    ? tenantIdempotencyKey(account.userId, input.idempotencyKey)
    : null;

  // 冪等 fast path
  if (storedKey) {
    const existing = await prisma.publishJob.findUnique({
      where: { idempotencyKey: storedKey },
    });
    if (existing) return resumeDeduplicated(existing, input);
  }

  const scheduledAt = new Date();
  let created: { jobId: string; variantId: string; contentPieceId: string };
  try {
    created = await prisma.$transaction(async (tx) => {
      const contentPiece = await tx.contentPiece.create({
        data: {
          userId: account.userId, // 租戶歸屬跟著帳號走
          title: input.title?.trim() || input.text.slice(0, 50),
          sourceText: input.text,
          status: ContentStatus.READY,
        },
      });
      const variant = await tx.variant.create({
        data: {
          contentPieceId: contentPiece.id,
          accountId: account.id,
          surface: input.surface ?? Surface.FEED,
          body: input.text,
          platformOpts: input.platformOpts,
        },
      });
      const job = await tx.publishJob.create({
        data: {
          variantId: variant.id,
          scheduledAt,
          // 規格 §7：idempotencyKey 必填，預設 `${variantId}:${scheduledAt ISO}`
          idempotencyKey: storedKey ?? `${variant.id}:${scheduledAt.toISOString()}`,
        },
      });
      return { jobId: job.id, variantId: variant.id, contentPieceId: contentPiece.id };
    });
  } catch (err) {
    // 併發同 key：後到者撞 unique 約束（P2002）→ 回傳既有 job，維持冪等合約
    if (
      storedKey &&
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      const existing = await prisma.publishJob.findUnique({
        where: { idempotencyKey: storedKey },
      });
      if (existing) return resumeDeduplicated(existing, input);
    }
    throw err;
  }

  const job = await executePublishJob(created.jobId, input.executeOpts);
  const variant = await prisma.variant.findUnique({
    where: { id: created.variantId },
    select: { validationState: true },
  });

  return {
    deduplicated: false,
    job,
    contentPieceId: created.contentPieceId,
    variantId: created.variantId,
    validation: variant?.validationState ?? null,
  };
}

/**
 * dedup 命中時的處理：既有 job 若還沒被執行（前次呼叫在建立 job 後、認領前
 * 中斷），重新驅動它——否則同 key 的重試永遠拿回一個不會動的 PENDING job。
 * executePublishJob 的原子認領保證併發下只有一方會真正執行。
 */
async function resumeDeduplicated(
  existing: PublishJob,
  input: PublishTextInput
): Promise<PublishTextOutcome> {
  if (existing.status === JobStatus.PENDING || existing.status === JobStatus.QUEUED) {
    return {
      deduplicated: true,
      job: await executePublishJob(existing.id, input.executeOpts),
    };
  }
  return { deduplicated: true, job: existing };
}
