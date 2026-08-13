import { Platform, PublishTier, Surface } from "@prisma/client";
import { BOUNDARY_WARNING_RATIO, normalizeError, PublishError } from "./base";
import type {
  DecryptedAccount,
  PlatformAdapter,
  PlatformCapabilities,
  PublishPayload,
  PublishResult,
  ValidationIssue,
} from "./types";

// Threads adapter（規格 v1.1 順序 2，Meta 家族最小樣本）。
// 官方文件查證日 2026-08-14（developers.facebook.com/docs/threads）：
//   發文：POST /{user-id}/threads（media_type=TEXT, text）→ container id
//         → GET /{container-id}?fields=status 輪詢至 FINISHED
//         → POST /{user-id}/threads_publish（creation_id）→ media id
//         → GET /{media-id}?fields=permalink
//   限制：500 字/帖（官方未明定計算單位，emoji 按 UTF-8 bytes）、連結最多 5 個、
//         250 篇/24h 滾動（回覆另計 1,000）；發布前查 threads_publishing_limit
//   token：長效 60 天；滿 24 小時後可 refresh（th_refresh_token）
//
// ⚠️ 重試安全：threads_publish 之前的步驟（額度、建 container、輪詢 status）失敗
// 都可安全重試——重跑 publish() 會重建 container，未發布的舊 container 24h 後過期。
// 但 threads_publish 送出後結果不明時絕不能自動重試，否則平台端出現重複貼文，
// 故該呼叫及其後的失敗一律標 non-retryable。

const GRAPH_BASE = "https://graph.threads.net/v1.0";
const MAX_CHARS = 500;
const MAX_LINKS = 5; // 2025-12-22 起超過 5 個連結的貼文直接失敗（官方公告）
const FETCH_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 2_000;
const MAX_POLLS = 15; // ~30 秒，對齊官方「平均等 30 秒」建議；TEXT 實務上立即 FINISHED

const capabilities: PlatformCapabilities = {
  platform: Platform.THREADS,
  publishTier: PublishTier.AUTO_API,
  surfaces: [Surface.FEED],

  text: {
    // 官方只寫「500 characters、emoji 按 UTF-8 bytes 計」，未明定 grapheme/code point；
    // 以 grapheme（CHARS）計並靠 90% 邊界警告留安全餘量
    limits: { chars: MAX_CHARS },
    countingMode: "CHARS",
    supportsMarkdown: false,
    supportsHashtags: true, // 僅第一個 # 會成為 topic tag
    urlCountsAsChars: true,
  },

  media: {
    requiresPublicUrl: true, // Meta 家族只吃公開 URL（本 adapter 尚未實作媒體）
    supportsDirectUpload: false,
    image: null, // 媒體上限待實作媒體時查證後補
    video: null,
  },

  limits: {
    postsPer24h: 250, // 滾動 24 小時；回覆另計 1,000
    requestsPerMinute: null,
    notes:
      "250 篇/24h（滾動，回覆另計）。發布前會查 threads_publishing_limit。連結每帖最多 5 個。媒體上傳尚未實作（Sprint 後續）。",
  },

  requiresAppReview: false, // 自用：app 角色（admin/developer/Threads Tester）不需審查
  costPerPost: { currency: "USD", base: 0 },
};

// ============ Graph API helpers（meta/shared.ts 於 FB adapter 時抽出）============

interface GraphErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
  };
}

/** Graph 風格錯誤 → PublishError（190=token 失效、4=呼叫量超限、10=權限） */
function graphError(status: number, body: GraphErrorBody, context: string): PublishError {
  const e = body.error;
  const detail = e?.message ? `${e.message}（code ${e.code ?? "?"}）` : `HTTP ${status}`;
  if (e?.code === 190) {
    return new PublishError("AUTH_FAILED", `${context}：token 失效或過期，請重新連結帳號。${detail}`, false);
  }
  if (e?.code === 4 || status === 429) {
    return new PublishError("RATE_LIMITED", `${context}：觸發平台流量限制。${detail}`, true);
  }
  if (e?.code === 10) {
    return new PublishError("PERMISSION_DENIED", `${context}：權限不足（需 threads_content_publish）。${detail}`, false);
  }
  if (status >= 500) {
    return new PublishError("UPSTREAM_ERROR", `${context}：平台伺服器錯誤。${detail}`, true);
  }
  return new PublishError("BAD_REQUEST", `${context}：平台拒絕請求。${detail}`, false);
}

async function graphFetch<T>(
  url: string,
  init: RequestInit,
  context: string
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    throw normalizeError(err);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  if (!res.ok) throw graphError(res.status, body as GraphErrorBody, context);
  return body as T;
}

const qs = (params: Record<string, string>) => new URLSearchParams(params).toString();

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function countLinks(text: string): number {
  return (text.match(/https?:\/\/\S+/gi) ?? []).length;
}

// Threads 的 500 字上限：官方原文「emoji 按 UTF-8 bytes 計」，一般字元算 1。
// 純 grapheme 計數會漏放近上限、含大量 emoji 的貼文（平台端 byte 膨脹後超標）。
const textEncoder = new TextEncoder();
function threadsWeightedLength(text: string): number {
  let total = 0;
  for (const { segment } of new Intl.Segmenter(undefined, {
    granularity: "grapheme",
  }).segment(text)) {
    total += /\p{Extended_Pictographic}/u.test(segment)
      ? textEncoder.encode(segment).length
      : 1;
  }
  return total;
}

// ============ Adapter ============

export const threadsAdapter: PlatformAdapter = {
  capabilities,

  validate(payload: PublishPayload): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    if (payload.surface !== Surface.FEED) {
      issues.push({
        level: "ERROR",
        field: "surface",
        message: `Threads 僅支援一般貼文（FEED），不支援 ${payload.surface}`,
        autoFixable: false,
      });
    }

    if (!payload.body.trim()) {
      issues.push({
        level: "ERROR",
        field: "body",
        message: "內文不可為空",
        autoFixable: false,
      });
    }

    // emoji-aware 長度檢查（見 threadsWeightedLength）；純 ASCII 時等同 grapheme 計數
    const weighted = threadsWeightedLength(payload.body);
    if (weighted > MAX_CHARS) {
      issues.push({
        level: "ERROR",
        field: "body",
        message: `內容長度約 ${weighted}（Threads 對 emoji 按位元組計），超過上限 ${MAX_CHARS}`,
        autoFixable: true,
      });
    } else if (weighted >= Math.ceil(MAX_CHARS * BOUNDARY_WARNING_RATIO)) {
      issues.push({
        level: "WARNING",
        field: "body",
        message: `接近 Threads 上限 ${MAX_CHARS}（目前約 ${weighted}，emoji 按位元組計）`,
        autoFixable: false,
      });
    }

    const links = countLinks(payload.body);
    if (links > MAX_LINKS) {
      issues.push({
        level: "ERROR",
        field: "body",
        message: `Threads 每帖最多 ${MAX_LINKS} 個連結（目前 ${links} 個），超過會直接發布失敗`,
        autoFixable: false,
      });
    }

    if (payload.assets.length > 0) {
      issues.push({
        level: "ERROR",
        field: "assets",
        message: "Threads adapter 目前僅支援純文字，媒體上傳尚未實作",
        autoFixable: false,
      });
    }

    if (payload.linkInComment) {
      issues.push({
        level: "WARNING",
        field: "linkInComment",
        message: "Threads 發文免費，連結不需移到留言，此設定會被忽略",
        autoFixable: false,
      });
    }

    return issues;
  },

  async publish(payload: PublishPayload, account: DecryptedAccount): Promise<PublishResult> {
    const fatal = this.validate(payload).filter((i) => i.level === "ERROR");
    if (fatal.length > 0) {
      throw new PublishError("VALIDATION_FAILED", fatal.map((i) => i.message).join("；"), false);
    }

    const userId = account.platformAccountId; // Threads user id
    const token = account.accessToken;

    // 1. 額度檢查（規格 §5：發布前先查，不要硬猜）
    const quota = await graphFetch<{
      data?: { quota_usage?: number; config?: { quota_total?: number } }[];
    }>(
      `${GRAPH_BASE}/${userId}/threads_publishing_limit?${qs({
        fields: "quota_usage,config",
        access_token: token,
      })}`,
      { method: "GET" },
      "額度查詢"
    );
    const usage = quota.data?.[0]?.quota_usage;
    const total = quota.data?.[0]?.config?.quota_total ?? 250;
    if (typeof usage === "number" && usage >= total) {
      throw new PublishError(
        "RATE_LIMITED",
        `Threads 24 小時發文額度已用盡（${usage}/${total}），請稍後再試`,
        true
      );
    }

    // 2. 建立 TEXT container（此呼叫失敗可安全重試：未發布的 container 24h 後自動過期）
    const container = await graphFetch<{ id: string }>(
      `${GRAPH_BASE}/${userId}/threads`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: qs({ media_type: "TEXT", text: payload.body, access_token: token }),
      },
      "建立貼文容器"
    );
    const containerId = container.id;

    // 3. 輪詢 container 狀態至 FINISHED（TEXT 通常立即完成）。
    //    此階段貼文尚未發布，失敗不會造成平台端重複：
    //    - 單次網路抖動（retryable）：續 poll，不讓一次波動就 FAILED
    //    - 明確錯誤（token/權限）或 ERROR/EXPIRED/逾時：貼文未發布，訊息如實說明
    //    這些失敗留 retryable 由 executePublishJob 決定是否重跑整個 publish
    //    （重跑會重建 container，未發布的舊 container 24h 過期，無害）。
    let status = "IN_PROGRESS";
    for (let i = 0; i < MAX_POLLS; i++) {
      let s: { status?: string; error_message?: string };
      try {
        s = await graphFetch(
          `${GRAPH_BASE}/${containerId}?${qs({ fields: "status,error_message", access_token: token })}`,
          { method: "GET" },
          "查詢容器狀態"
        );
      } catch (err) {
        const e = normalizeError(err);
        if (e.retryable) {
          await delay(POLL_INTERVAL_MS); // 網路抖動：續 poll
          continue;
        }
        throw new PublishError(e.code, `${e.message}（查詢容器狀態失敗，貼文未發布）`, e.retryable, err);
      }
      status = s.status ?? "IN_PROGRESS";
      if (status === "FINISHED" || status === "PUBLISHED") break;
      if (status === "ERROR" || status === "EXPIRED") {
        throw new PublishError(
          "MEDIA_PROCESSING_FAILED",
          `Threads 容器處理失敗（${status}${s.error_message ? `：${s.error_message}` : ""}），貼文未發布`,
          false
        );
      }
      await delay(POLL_INTERVAL_MS);
    }
    if (status !== "FINISHED" && status !== "PUBLISHED") {
      throw new PublishError(
        "MEDIA_PROCESSING_TIMEOUT",
        `等待 Threads 容器處理逾時（container ${containerId}），貼文未發布，可重試`,
        true
      );
    }

    // ── threads_publish 起：一旦送出，結果不明時絕不可自動重試（會重複發文）──
    let mediaId: string;
    try {
      const published = await graphFetch<{ id: string }>(
        `${GRAPH_BASE}/${userId}/threads_publish`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: qs({ creation_id: containerId, access_token: token }),
        },
        "發布貼文"
      );
      mediaId = published.id;
    } catch (err) {
      const e = normalizeError(err);
      throw new PublishError(
        e.code,
        `${e.message}（container ${containerId}，請先到 Threads 確認是否已發布再手動重試）`,
        false, // 結果不明，一律不自動重試
        err
      );
    }

    // 4. 取 permalink（已發布成功，失敗不致命）
    let permalink: string | undefined;
    try {
      const media = await graphFetch<{ permalink?: string }>(
        `${GRAPH_BASE}/${mediaId}?${qs({ fields: "permalink", access_token: token })}`,
        { method: "GET" },
        "查詢貼文連結"
      );
      permalink = media.permalink;
    } catch {
      // permalink 拿不到就留空，media id 已足以人工追查
    }

    return {
      externalPostId: mediaId,
      externalUrl: permalink,
      containerId,
      raw: { containerId, mediaId, permalink },
    };
  },

  async refreshCredentials(account: DecryptedAccount) {
    // 長效 token：60 天有效，滿 24 小時後可 refresh（token 健康檢查 cron 用，Sprint 3）
    const refreshed = await graphFetch<{ access_token: string; expires_in?: number }>(
      `https://graph.threads.net/refresh_access_token?${qs({
        grant_type: "th_refresh_token",
        access_token: account.accessToken,
      })}`,
      { method: "GET" },
      "刷新 token"
    );
    return {
      accessToken: refreshed.access_token,
    } satisfies Partial<DecryptedAccount>;
  },
};
