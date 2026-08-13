import { AtpAgent, RichText } from "@atproto/api";
import { Platform, PublishTier, Surface } from "@prisma/client";
import {
  byteLength,
  graphemeLength,
  normalizeError,
  PublishError,
  truncateToFit,
  withRetry,
} from "./base";
import type {
  DecryptedAccount,
  PlatformAdapter,
  PlatformCapabilities,
  PublishPayload,
  PublishResult,
  ValidationIssue,
} from "./types";

// Bluesky（AT Protocol）：免費、無 app review，是驗證整套架構的第一個 adapter。
// 官方限制（docs.bsky.app，2026-08 查證）：
//   文字：300 graphemes / 3,000 UTF-8 bytes
//   寫入 points 制：5,000 points/hr、35,000 points/day，CREATE = 3 points
//   createSession：30 次/5 分鐘、300 次/天 → session 必須快取重用，不能每次發文都 login

const MAX_GRAPHEMES = 300;
const MAX_BYTES = 3000;
const DEFAULT_SERVICE = "https://bsky.social";

const capabilities: PlatformCapabilities = {
  platform: Platform.BLUESKY,
  publishTier: PublishTier.AUTO_API,
  surfaces: [Surface.FEED],

  text: {
    maxLength: MAX_GRAPHEMES, // 單位：grapheme
    supportsMarkdown: false,
    supportsHashtags: true, // 以 facet 標記
    urlCountsAsChars: true,
  },

  media: {
    requiresPublicUrl: false,
    supportsDirectUpload: true, // uploadBlob；Sprint 0 尚未實作
    image: {
      maxCount: 4,
      formats: ["image/jpeg", "image/png", "image/webp"],
      maxBytes: 1_000_000,
      aspectRatios: [], // 不限比例
    },
    video: null, // 平台支援短影片，但本系統尚未實作，數值待查證後補
  },

  limits: {
    postsPer24h: 11_666, // 35,000 points/day ÷ 3 points/create，實務上碰不到
    requestsPerMinute: null,
    notes:
      "寫入採 points 制：5,000/hr、35,000/day（CREATE=3）。createSession 30 次/5 分鐘，session 會在程序內快取重用。媒體上傳 Sprint 0 未實作。",
  },

  requiresAppReview: false,
  costPerPost: { currency: "USD", base: 0 },
};

// ============ session 快取（模組層，同一程序內重用，避開 createSession 限制）============

const agentCache = new Map<string, AtpAgent>();

function serviceUrl(account: DecryptedAccount): string {
  const fromMeta = account.meta?.service;
  return typeof fromMeta === "string" && fromMeta ? fromMeta : DEFAULT_SERVICE;
}

async function loginAgent(account: DecryptedAccount): Promise<AtpAgent> {
  const agent = new AtpAgent({ service: serviceUrl(account) });
  try {
    // platformAccountId 存 DID（最穩定，不受改 handle 影響）；app password 存於 accessToken（解密後）
    await agent.login({
      identifier: account.platformAccountId,
      password: account.accessToken,
    });
  } catch (err) {
    const e = normalizeError(err);
    throw new PublishError(
      e.code === "RATE_LIMITED" ? "RATE_LIMITED" : "AUTH_FAILED",
      `Bluesky 登入失敗（${account.displayName}）：${e.message}`,
      e.retryable,
      err
    );
  }
  agentCache.set(account.id, agent);
  return agent;
}

function isAuthExpired(err: unknown): boolean {
  const status =
    typeof err === "object" && err !== null && "status" in err
      ? Number((err as { status: unknown }).status)
      : undefined;
  return status === 401;
}

// ============ Adapter ============

export const blueskyAdapter: PlatformAdapter = {
  capabilities,

  validate(payload: PublishPayload): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    if (payload.surface !== Surface.FEED) {
      issues.push({
        level: "ERROR",
        field: "surface",
        message: `Bluesky 僅支援一般貼文（FEED），不支援 ${payload.surface}`,
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

    const graphemes = graphemeLength(payload.body);
    if (graphemes > MAX_GRAPHEMES) {
      issues.push({
        level: "ERROR",
        field: "body",
        message: `超過 Bluesky 上限 ${MAX_GRAPHEMES} 字（目前 ${graphemes} 字，以 grapheme 計）`,
        autoFixable: true,
      });
    }

    const bytes = byteLength(payload.body);
    if (bytes > MAX_BYTES) {
      issues.push({
        level: "ERROR",
        field: "body",
        message: `超過 Bluesky 上限 ${MAX_BYTES} bytes（目前 ${bytes} bytes）`,
        autoFixable: true,
      });
    }

    if (payload.assets.length > 0) {
      issues.push({
        level: "ERROR",
        field: "assets",
        message: "Bluesky adapter 目前僅支援純文字（Sprint 0），媒體上傳尚未實作",
        autoFixable: false,
      });
    }

    if (payload.linkInComment) {
      issues.push({
        level: "WARNING",
        field: "linkInComment",
        message: "Bluesky 發文免費，連結不需移到留言，此設定會被忽略",
        autoFixable: false,
      });
    }

    const langs = payload.platformOpts?.langs;
    if (langs !== undefined && (!Array.isArray(langs) || langs.length > 3)) {
      issues.push({
        level: "ERROR",
        field: "platformOpts.langs",
        message: "langs 需為字串陣列且最多 3 個語言代碼（如 [\"zh-TW\"]）",
        autoFixable: false,
      });
    }

    return issues;
  },

  autoFix(payload: PublishPayload): PublishPayload {
    return {
      ...payload,
      body: truncateToFit(payload.body, MAX_GRAPHEMES, MAX_BYTES),
    };
  },

  async publish(payload: PublishPayload, account: DecryptedAccount): Promise<PublishResult> {
    // 防禦性再驗一次：發布路徑不信任呼叫端已跑過 validate
    const fatal = this.validate(payload).filter((i) => i.level === "ERROR");
    if (fatal.length > 0) {
      throw new PublishError(
        "VALIDATION_FAILED",
        fatal.map((i) => i.message).join("；"),
        false
      );
    }

    let agent = agentCache.get(account.id) ?? (await loginAgent(account));

    // RichText 自動偵測連結/mention/hashtag 的 facets（mention 解析需要 agent）
    const rt = new RichText({ text: payload.body });
    await rt.detectFacets(agent);

    const langs = payload.platformOpts?.langs as string[] | undefined;
    const record = {
      text: rt.text,
      facets: rt.facets,
      ...(langs && langs.length > 0 ? { langs } : {}),
      createdAt: new Date().toISOString(),
    };

    const res = await withRetry(async () => {
      try {
        return await agent.post(record);
      } catch (err) {
        // 快取的 session 過期：重新登入一次再試
        if (isAuthExpired(err)) {
          agentCache.delete(account.id);
          agent = await loginAgent(account);
          return await agent.post(record);
        }
        throw err;
      }
    });

    // uri 形如 at://did:plc:xxx/app.bsky.feed.post/3kabc123
    const rkey = res.uri.split("/").pop();
    const did = agent.session?.did ?? account.platformAccountId;

    return {
      externalPostId: res.uri,
      externalUrl: `https://bsky.app/profile/${did}/post/${rkey}`,
      raw: res,
    };
  },
};
