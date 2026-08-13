// Adapter 合約測試套件（規格 v1.1 修訂 4）：所有 adapter 都必須通過這一套測試。
// 用法（在 contract.test.ts）：
//   import { adapterContract } from "./contract";
//   adapterContract(lineOaAdapter, { validPayload: () => ({...}), fakeAccount: () => ({...}) });
//
// 合約內容：
//   1. capabilities 物件結構完整（平台差異用資料描述，前端據此渲染）
//   2. validate() 是純函式：不發網路請求、同輸入同輸出
//   3. validate() 對超長文字回傳 ERROR、對邊界值（達上限 90%）回傳 WARNING
//   4. publish() 失敗時拋出正規化的 PublishError，不外洩原始 API 錯誤與憑證

import { Platform, PublishTier, Surface } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { BOUNDARY_WARNING_RATIO, PublishError } from "../base";
import type {
  DecryptedAccount,
  PlatformAdapter,
  PublishPayload,
  TextCountingMode,
} from "../types";

export interface AdapterContractOptions {
  /** 產生一個該平台可通過預檢的最小合法 payload（surface 必須在 capabilities.surfaces 內） */
  validPayload: () => PublishPayload;
  /** 假帳號（假憑證即可；publish 失敗測試用，憑證字串會被拿來驗證不外洩） */
  fakeAccount: () => DecryptedAccount;
  /** 剛好達到主要上限 90%（邊界警告區）的內文；預設以 'a' 重複產生，X_WEIGHTED 平台必須自行提供 */
  bodyAtBoundary?: () => string;
  /** 超過主要上限的內文；預設以 'a' 重複產生，X_WEIGHTED 平台必須自行提供 */
  bodyOverLimit?: () => string;
  /**
   * 模擬平台 API 失敗。預設把 globalThis.fetch 換成回 500 的假實作；
   * SDK 不走 global fetch 的 adapter 需自行提供 stub，回傳還原函式。
   */
  simulatePlatformFailure?: () => () => void;
  /**
   * 會讓 publish() 失敗的 payload。不打網路的 adapter（如 FAKE 用
   * platformOpts.simulate 觸發失敗）用這個取代 fetch 攔截。
   */
  failingPayload?: () => PublishPayload;
}

const MODE_LIMIT_KEY: Record<TextCountingMode, "chars" | "utf8Bytes" | "utf16Units" | "weighted"> =
  {
    CHARS: "chars",
    UTF8_BYTES: "utf8Bytes",
    UTF16: "utf16Units",
    X_WEIGHTED: "weighted",
  };

/** 'a' 在 CHARS / UTF8_BYTES / UTF16 三種模式下的計數都是 1，可直接造出指定長度 */
function asciiBody(mode: TextCountingMode, count: number): string {
  if (mode === "X_WEIGHTED") {
    throw new Error("X_WEIGHTED 平台請在 options 提供 bodyAtBoundary / bodyOverLimit");
  }
  return "a".repeat(count);
}

export function adapterContract(adapter: PlatformAdapter, opts: AdapterContractOptions) {
  const caps = adapter.capabilities;
  const mode = caps.text.countingMode;
  const primaryLimit = caps.text.limits[MODE_LIMIT_KEY[mode]];

  const boundaryBody = () =>
    opts.bodyAtBoundary?.() ??
    asciiBody(mode, Math.ceil((primaryLimit ?? 0) * BOUNDARY_WARNING_RATIO));
  const overBody = () => opts.bodyOverLimit?.() ?? asciiBody(mode, (primaryLimit ?? 0) + 1);

  describe(`${caps.platform} adapter 合約`, () => {
    it("capabilities 結構完整", () => {
      expect(Object.values(Platform)).toContain(caps.platform);
      expect(Object.values(PublishTier)).toContain(caps.publishTier);

      expect(caps.surfaces.length).toBeGreaterThan(0);
      for (const s of caps.surfaces) expect(Object.values(Surface)).toContain(s);

      // 至少要有一個文字上限，且主要計數模式對應的上限必須有定義
      const definedLimits = Object.entries(caps.text.limits).filter(([, v]) => v !== undefined);
      expect(definedLimits.length).toBeGreaterThan(0);
      expect(primaryLimit, `countingMode=${mode} 對應的 limits.${MODE_LIMIT_KEY[mode]} 必須有值`)
        .toBeTypeOf("number");
      for (const [key, v] of definedLimits) {
        expect(Number.isInteger(v) && (v as number) > 0, `limits.${key} 需為正整數`).toBe(true);
      }
      expect(caps.text.supportsMarkdown).toBeTypeOf("boolean");
      expect(caps.text.supportsHashtags).toBeTypeOf("boolean");
      expect(caps.text.urlCountsAsChars).toBeTypeOf("boolean");

      expect(caps.media.requiresPublicUrl).toBeTypeOf("boolean");
      expect(caps.media.supportsDirectUpload).toBeTypeOf("boolean");
      for (const m of [caps.media.image, caps.media.video]) {
        if (m === null) continue;
        expect(m.formats.length).toBeGreaterThan(0);
        expect(m.maxBytes).toBeGreaterThan(0);
        expect(Array.isArray(m.aspectRatios)).toBe(true);
      }

      expect(caps.limits.notes).toBeTypeOf("string");
      expect(caps.requiresAppReview).toBeTypeOf("boolean");
    });

    it("validate() 是純函式：不發網路請求、同輸入同輸出", () => {
      const originalFetch = globalThis.fetch;
      const calls: string[] = [];
      globalThis.fetch = ((...args: unknown[]) => {
        calls.push(String(args[0]));
        throw new Error("validate() 不得發出網路請求");
      }) as typeof fetch;
      try {
        const payload = opts.validPayload();
        const snapshot = JSON.stringify(payload);
        const a = adapter.validate(payload);
        const b = adapter.validate(payload);
        expect(a).toEqual(b);
        expect(JSON.stringify(payload), "validate() 不得修改傳入的 payload").toBe(snapshot);
        adapter.validate({ ...opts.validPayload(), body: overBody() });
      } finally {
        globalThis.fetch = originalFetch;
      }
      expect(calls, "validate() 期間發出了網路請求").toEqual([]);
    });

    it("validate() 對合法 payload 不回傳 ERROR，且 issue 結構完整", () => {
      const issues = adapter.validate(opts.validPayload());
      for (const i of issues) {
        expect(["ERROR", "WARNING"]).toContain(i.level);
        expect(i.field).toBeTypeOf("string");
        expect(i.message).toBeTypeOf("string");
        expect(i.autoFixable).toBeTypeOf("boolean");
      }
      expect(issues.filter((i) => i.level === "ERROR")).toEqual([]);
    });

    it("validate() 對超長文字回傳 ERROR", () => {
      const issues = adapter.validate({ ...opts.validPayload(), body: overBody() });
      expect(issues.some((i) => i.level === "ERROR" && i.field === "body")).toBe(true);
    });

    it(`validate() 對邊界值（達上限 ${BOUNDARY_WARNING_RATIO * 100}%）回傳 WARNING 而非 ERROR`, () => {
      const issues = adapter.validate({ ...opts.validPayload(), body: boundaryBody() });
      expect(issues.filter((i) => i.level === "ERROR")).toEqual([]);
      expect(issues.some((i) => i.level === "WARNING" && i.field === "body")).toBe(true);
    });

    it("publish() 失敗時拋出正規化的 PublishError，不外洩原始 API 錯誤與憑證", async () => {
      const account = opts.fakeAccount();
      const restore =
        opts.simulatePlatformFailure?.() ??
        (() => {
          const originalFetch = globalThis.fetch;
          globalThis.fetch = (async () =>
            new Response(JSON.stringify({ message: "internal error" }), {
              status: 500,
            })) as typeof fetch;
          return () => {
            globalThis.fetch = originalFetch;
          };
        })();
      let thrown: unknown;
      try {
        await adapter.publish(opts.failingPayload?.() ?? opts.validPayload(), account);
      } catch (err) {
        thrown = err;
      } finally {
        restore();
      }
      expect(thrown, "publish() 失敗時必須拋錯").toBeDefined();
      expect(thrown).toBeInstanceOf(PublishError);
      const e = thrown as PublishError;
      expect(e.code).toBeTypeOf("string");
      expect(e.code.length).toBeGreaterThan(0);
      // 憑證絕不能出現在錯誤訊息（會進 DB 的 errorMessage 與 log）
      expect(e.message).not.toContain(account.accessToken);
      if (account.refreshToken) {
        expect(e.message).not.toContain(account.refreshToken);
      }
    });
  });
}
