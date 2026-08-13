import { describe, expect, it } from "vitest";
import {
  BOUNDARY_WARNING_RATIO,
  byteLength,
  countText,
  graphemeLength,
  normalizeError,
  PublishError,
  textLimitIssues,
  truncateToFit,
  utf16Length,
  withRetry,
} from "../base";
import type { TextCapability } from "../types";

describe("文字度量", () => {
  it("graphemeLength 以 grapheme cluster 計（emoji、中文）", () => {
    expect(graphemeLength("hello")).toBe(5);
    expect(graphemeLength("你好")).toBe(2);
    expect(graphemeLength("👨‍👩‍👧‍👦")).toBe(1); // ZWJ 家族 emoji 是 1 個 grapheme
  });

  it("byteLength 以 UTF-8 bytes 計", () => {
    expect(byteLength("abc")).toBe(3);
    expect(byteLength("你好")).toBe(6); // 中文每字 3 bytes
  });

  it("utf16Length 以 UTF-16 code units 計", () => {
    expect(utf16Length("abc")).toBe(3);
    expect(utf16Length("你好")).toBe(2);
    expect(utf16Length("𝔘")).toBe(2); // surrogate pair
  });

  it("countText 依 countingMode 分派", () => {
    expect(countText("你好", "CHARS")).toBe(2);
    expect(countText("你好", "UTF8_BYTES")).toBe(6);
    expect(countText("你好", "UTF16")).toBe(2);
  });

  it("X_WEIGHTED 未實作前呼叫要明確拋錯（X adapter 開工時依官方文件補）", () => {
    expect(() => countText("hi", "X_WEIGHTED")).toThrow(/X_WEIGHTED/);
  });
});

describe("textLimitIssues（adapter 合約的長度檢核）", () => {
  const cap: TextCapability = {
    limits: { chars: 100, utf8Bytes: 1000 },
    countingMode: "CHARS",
    supportsMarkdown: false,
    supportsHashtags: true,
    urlCountsAsChars: true,
  };

  it("超過上限 → ERROR（autoFixable）", () => {
    const issues = textLimitIssues("a".repeat(101), cap);
    expect(issues.some((i) => i.level === "ERROR" && i.autoFixable)).toBe(true);
  });

  it("達上限 90% → WARNING、不出 ERROR", () => {
    const issues = textLimitIssues("a".repeat(90), cap);
    expect(issues.filter((i) => i.level === "ERROR")).toEqual([]);
    expect(issues.some((i) => i.level === "WARNING")).toBe(true);
  });

  it("遠低於上限 → 無 issue", () => {
    expect(textLimitIssues("hello", cap)).toEqual([]);
  });

  it("多重上限同時檢查（grapheme 過了但 bytes 爆掉）", () => {
    // 100 個中文 = 100 graphemes（過）、300 bytes；340 個中文 = 340 chars 會爆 chars…
    // 改用 bytes 專用 case：limits 只設 utf8Bytes
    const bytesOnly: TextCapability = { ...cap, limits: { utf8Bytes: 30 } };
    const issues = textLimitIssues("你".repeat(11), bytesOnly); // 33 bytes
    expect(issues.some((i) => i.level === "ERROR")).toBe(true);
  });

  it("邊界門檻常數與合約一致", () => {
    expect(BOUNDARY_WARNING_RATIO).toBe(0.9);
  });
});

describe("truncateToFit", () => {
  it("同時滿足 grapheme 與 byte 上限，結尾加 …", () => {
    const out = truncateToFit("你".repeat(500), 300, 3000);
    expect(graphemeLength(out)).toBeLessThanOrEqual(300);
    expect(byteLength(out)).toBeLessThanOrEqual(3000);
    expect(out.endsWith("…")).toBe(true);
  });

  it("未超限時原樣返回", () => {
    expect(truncateToFit("hello", 300, 3000)).toBe("hello");
  });
});

describe("normalizeError", () => {
  it("401/403 → AUTH_FAILED（不可重試）", () => {
    const e = normalizeError({ status: 401, message: "bad token" });
    expect(e.code).toBe("AUTH_FAILED");
    expect(e.retryable).toBe(false);
  });

  it("429 → RATE_LIMITED（可重試）", () => {
    expect(normalizeError({ status: 429 }).code).toBe("RATE_LIMITED");
  });

  it("5xx → UPSTREAM_ERROR（可重試）", () => {
    const e = normalizeError({ status: 503, message: "unavailable" });
    expect(e.code).toBe("UPSTREAM_ERROR");
    expect(e.retryable).toBe(true);
  });

  it("網路層錯誤 → NETWORK_ERROR", () => {
    expect(normalizeError(new TypeError("fetch failed")).code).toBe("NETWORK_ERROR");
  });

  it("PublishError 原樣通過", () => {
    const original = new PublishError("CUSTOM", "x", false);
    expect(normalizeError(original)).toBe(original);
  });
});

describe("withRetry", () => {
  it("retryable 錯誤會重試到成功", async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw { status: 503, message: "flaky" };
        return "ok";
      },
      { attempts: 3, baseDelayMs: 1 }
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("不可重試的錯誤立即拋出", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw { status: 400, message: "bad request" };
        },
        { attempts: 3, baseDelayMs: 1 }
      )
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(calls).toBe(1);
  });
});
