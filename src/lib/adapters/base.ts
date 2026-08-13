// 共用工具：錯誤正規化、重試、文字度量（規格 §4 檔案結構 base.ts）

import type { TextCapability, TextCountingMode, ValidationIssue } from "./types";

export class PublishError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean = false,
    public readonly raw?: unknown
  ) {
    super(message);
    this.name = "PublishError";
  }
}

/** 把平台丟出的任意錯誤整理成 PublishError，讓 PublishJob 的 errorCode 有一致語彙 */
export function normalizeError(err: unknown): PublishError {
  if (err instanceof PublishError) return err;

  // fetch 逾時 / 中止：AbortSignal.timeout() reject 的是 DOMException
  // （name=TimeoutError / AbortError），沒有 status、也不匹配下方的訊息正則，
  // 若不特判會落到 UNKNOWN/non-retryable，架空「逾時可重試」的預期。
  const name = (err as { name?: unknown })?.name;
  if (name === "TimeoutError" || name === "AbortError") {
    const msg = err instanceof Error ? err.message : "請求逾時或被中止";
    return new PublishError("NETWORK_ERROR", `網路逾時：${msg}`, true, err);
  }

  // XRPC / fetch 類錯誤通常帶 status
  const status =
    typeof err === "object" && err !== null && "status" in err
      ? Number((err as { status: unknown }).status)
      : undefined;
  const message = err instanceof Error ? err.message : String(err);

  if (status === 401 || status === 403) {
    return new PublishError("AUTH_FAILED", `平台認證失敗：${message}`, false, err);
  }
  if (status === 429) {
    return new PublishError("RATE_LIMITED", `觸發平台流量限制：${message}`, true, err);
  }
  if (status !== undefined && status >= 500) {
    return new PublishError("UPSTREAM_ERROR", `平台伺服器錯誤（${status}）：${message}`, true, err);
  }
  if (status !== undefined && status >= 400) {
    return new PublishError("BAD_REQUEST", `平台拒絕請求（${status}）：${message}`, false, err);
  }
  // fetch 網路層失敗（DNS、斷線、timeout）
  if (err instanceof TypeError || /fetch failed|network|ECONNRE|ETIMEDOUT/i.test(message)) {
    return new PublishError("NETWORK_ERROR", `網路錯誤：${message}`, true, err);
  }
  return new PublishError("UNKNOWN", message, false, err);
}

export interface RetryOptions {
  attempts?: number; // 總嘗試次數（含第一次）
  baseDelayMs?: number;
}

/**
 * 只重試 retryable 的錯誤（5xx / 網路），指數退避。
 *
 * ⚠️ 絕對不要用來包「非冪等的平台寫入」（例如發文的 create 呼叫）：
 * 網路錯誤 / 5xx 可能發生在平台已收下請求之後，重試會在平台端發出重複貼文，
 * 而 DB 層的 idempotencyKey 擋不到這種平台端重複。發文類呼叫要嘛帶平台冪等
 * 機制（如自帶 rkey / client token），要嘛只對「確定未送達」的錯誤重試。
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  let lastError: PublishError | undefined;

  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = normalizeError(err);
      const isLast = i === attempts - 1;
      if (!lastError.retryable || isLast) throw lastError;
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** i));
    }
  }
  throw lastError; // 理論上到不了這裡
}

// ============ 文字度量（validate 用，純函式，不打網路）============

/** 以 Unicode grapheme cluster 計數（Threads 等「算字元」平台的字數單位） */
export function graphemeLength(text: string): number {
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** UTF-16 code units（JS 的 string.length；IG 等平台的計數單位） */
export function utf16Length(text: string): number {
  return text.length;
}

/** 依 countingMode 選用對應算法（規格 v1.1 修訂 3） */
export function countText(text: string, mode: TextCountingMode): number {
  switch (mode) {
    case "CHARS":
      return graphemeLength(text);
    case "UTF8_BYTES":
      return byteLength(text);
    case "UTF16":
      return utf16Length(text);
    case "X_WEIGHTED":
      // X 的加權演算法（URL=23、依 Unicode 區段權重 1/2）留待 X adapter 開工時
      // 依官方文件實作（規格 v1.1 修訂 6：開工前先查官方文件，不用記憶中的版本）
      throw new Error("X_WEIGHTED 計數尚未實作：實作 X adapter 時依官方 twitter-text 規則補上");
  }
}

/** limits 各欄位對應的計數模式與人類可讀單位 */
const LIMIT_MODES: {
  key: keyof TextCapability["limits"];
  mode: TextCountingMode;
  unit: string;
}[] = [
  { key: "chars", mode: "CHARS", unit: "字" },
  { key: "utf8Bytes", mode: "UTF8_BYTES", unit: "bytes" },
  { key: "utf16Units", mode: "UTF16", unit: "UTF-16 units" },
  { key: "weighted", mode: "X_WEIGHTED", unit: "加權字數" },
];

/** 邊界警告門檻：用量達上限的 90%（含）即回 WARNING（adapter 合約，contract.ts 會驗） */
export const BOUNDARY_WARNING_RATIO = 0.9;

/**
 * 依 TextCapability 檢查內文長度，所有 adapter 的 validate() 都應使用此函式：
 * - 超過任一有定義的上限 → ERROR（autoFixable: true，可截斷）
 * - 用量達上限 90%（含）但未超過 → WARNING（提醒接近上限）
 */
export function textLimitIssues(body: string, text: TextCapability): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const { key, mode, unit } of LIMIT_MODES) {
    const limit = text.limits[key];
    if (limit === undefined) continue;
    const count = countText(body, mode);
    if (count > limit) {
      issues.push({
        level: "ERROR",
        field: "body",
        message: `超過平台上限 ${limit} ${unit}（目前 ${count} ${unit}）`,
        autoFixable: true,
      });
    } else if (count >= Math.ceil(limit * BOUNDARY_WARNING_RATIO)) {
      issues.push({
        level: "WARNING",
        field: "body",
        message: `接近平台上限 ${limit} ${unit}（目前 ${count} ${unit}）`,
        autoFixable: false,
      });
    }
  }
  return issues;
}

/** 截斷到同時滿足 grapheme 與 byte 上限，結尾加 …（自動修正用） */
export function truncateToFit(text: string, maxGraphemes: number, maxBytes: number): string {
  if (graphemeLength(text) <= maxGraphemes && byteLength(text) <= maxBytes) return text;

  const ellipsis = "…";
  const segments = [
    ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
  ].map((s) => s.segment);

  let end = Math.min(segments.length, maxGraphemes - 1);
  let candidate = segments.slice(0, end).join("") + ellipsis;
  while (end > 0 && byteLength(candidate) > maxBytes) {
    end--;
    candidate = segments.slice(0, end).join("") + ellipsis;
  }
  return candidate;
}
