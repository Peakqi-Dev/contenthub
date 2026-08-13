// 共用工具：錯誤正規化、重試、文字度量（規格 §4 檔案結構 base.ts）

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

/** 只重試 retryable 的錯誤（5xx / 網路），指數退避 */
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

// ============ 文字度量（validate 用，純函式）============

/** 以 Unicode grapheme cluster 計數（Bluesky / Threads 等平台的字數單位） */
export function graphemeLength(text: string): number {
  return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;
}

export function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
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
