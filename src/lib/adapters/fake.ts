import { appendFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Platform, PublishTier, Surface } from "@prisma/client";
import { PublishError, textLimitIssues } from "./base";
import type {
  DecryptedAccount,
  PlatformAdapter,
  PlatformCapabilities,
  PublishPayload,
  PublishResult,
  ValidationIssue,
} from "./types";

// Fake adapter（規格 v1.1 順序 1）：架構驗證用，不打任何外部網路。
// 用途：驗證 job 狀態機、重試邏輯、冪等性（Sprint 0 驗收標準 scripts/smoke-fake.ts）。
//
// 以 platformOpts.simulate 模擬失敗情境：
//   TIMEOUT           模擬逾時 → NETWORK_ERROR（可重試）
//   RATE_LIMIT        模擬 429 → RATE_LIMITED（可重試）
//   MEDIA_PROCESSING  模擬 Meta 式容器模式：回傳 containerId，pollStatus 兩次 PROCESSING 後 FINISHED
//   TOKEN_EXPIRED     模擬 401 → AUTH_FAILED（不可重試，job 應立即 FAILED）

export const SIMULATE_VALUES = [
  "TIMEOUT",
  "RATE_LIMIT",
  "MEDIA_PROCESSING",
  "TOKEN_EXPIRED",
] as const;
export type FakeSimulate = (typeof SIMULATE_VALUES)[number];

const LOG_DIR = path.join(process.cwd(), "logs");
const LOG_FILE = path.join(LOG_DIR, "fake-publish.log");

const capabilities: PlatformCapabilities = {
  platform: Platform.FAKE,
  publishTier: PublishTier.AUTO_API,
  surfaces: [Surface.FEED, Surface.STORY],

  text: {
    limits: { chars: 500, utf8Bytes: 5000 },
    countingMode: "CHARS",
    supportsMarkdown: false,
    supportsHashtags: true,
    urlCountsAsChars: true,
  },

  media: {
    requiresPublicUrl: false,
    supportsDirectUpload: true,
    image: {
      maxCount: 4,
      formats: ["image/jpeg", "image/png", "image/webp"],
      maxBytes: 5_000_000,
      aspectRatios: [],
    },
    video: null,
  },

  limits: {
    postsPer24h: null,
    requestsPerMinute: null,
    notes:
      "架構驗證用假平台，不打外部網路。platformOpts.simulate 可模擬 TIMEOUT / RATE_LIMIT / MEDIA_PROCESSING / TOKEN_EXPIRED。",
  },

  requiresAppReview: false,
  costPerPost: { currency: "USD", base: 0 },
};

// 容器輪詢狀態（模擬 Meta 媒體處理）：containerId → 還要回幾次 PROCESSING
const containerCountdown = new Map<string, number>();

function getSimulate(payload: PublishPayload): FakeSimulate | undefined {
  const v = payload.platformOpts?.simulate;
  return SIMULATE_VALUES.includes(v as FakeSimulate) ? (v as FakeSimulate) : undefined;
}

function writeLog(entry: Record<string, unknown>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  console.log(`[fake-adapter] ${line}`);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, line + "\n", "utf8");
  } catch {
    // 唯讀檔案系統（如 serverless）時只留 console log
  }
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const fakeAdapter: PlatformAdapter = {
  capabilities,

  validate(payload: PublishPayload): ValidationIssue[] {
    const issues: ValidationIssue[] = [];

    if (!capabilities.surfaces.includes(payload.surface)) {
      issues.push({
        level: "ERROR",
        field: "surface",
        message: `FAKE 僅支援 ${capabilities.surfaces.join(" / ")}，不支援 ${payload.surface}`,
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

    issues.push(...textLimitIssues(payload.body, capabilities.text));

    const imageCap = capabilities.media.image;
    if (imageCap && payload.assets.length > imageCap.maxCount) {
      issues.push({
        level: "ERROR",
        field: "assets",
        message: `媒體數量超過上限 ${imageCap.maxCount}（目前 ${payload.assets.length}）`,
        autoFixable: false,
      });
    }

    const rawSimulate = payload.platformOpts?.simulate;
    if (rawSimulate !== undefined && !SIMULATE_VALUES.includes(rawSimulate as FakeSimulate)) {
      issues.push({
        level: "ERROR",
        field: "platformOpts.simulate",
        message: `simulate 必須是 ${SIMULATE_VALUES.join(" / ")}`,
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

    const simulate = getSimulate(payload);
    await delay(20); // 模擬一點網路延遲

    switch (simulate) {
      case "TIMEOUT":
        throw new PublishError("NETWORK_ERROR", "模擬逾時：平台無回應", true);
      case "RATE_LIMIT":
        throw new PublishError("RATE_LIMITED", "模擬 429：觸發平台流量限制", true);
      case "TOKEN_EXPIRED":
        throw new PublishError("AUTH_FAILED", "模擬 401：token 已過期", false);
      default:
        break;
    }

    const id = randomUUID();
    const result: PublishResult = {
      externalPostId: `fake:${id}`,
      externalUrl: `https://fake.invalid/post/${id}`,
      raw: { id, simulate: simulate ?? null },
    };

    if (simulate === "MEDIA_PROCESSING") {
      const containerId = `fake-container:${id}`;
      containerCountdown.set(containerId, 2); // 前兩次輪詢回 PROCESSING
      result.containerId = containerId;
    }

    writeLog({
      account: account.displayName,
      surface: payload.surface,
      simulate: simulate ?? null,
      externalPostId: result.externalPostId,
      body: payload.body.slice(0, 100),
    });

    return result;
  },

  async pollStatus(containerId: string): Promise<"PROCESSING" | "FINISHED" | "ERROR"> {
    const remaining = containerCountdown.get(containerId);
    if (remaining === undefined) return "ERROR"; // 不認得的容器
    if (remaining > 0) {
      containerCountdown.set(containerId, remaining - 1);
      return "PROCESSING";
    }
    containerCountdown.delete(containerId);
    return "FINISHED";
  },
};
