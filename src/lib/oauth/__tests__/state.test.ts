import { beforeAll, describe, expect, it } from "vitest";
import { signOAuthState, verifyOAuthState } from "../state";

beforeAll(() => {
  process.env.AUTH_SECRET = "test-secret-for-oauth-state";
});

describe("OAuth state 簽章（規格追加 §4）", () => {
  it("sign → verify roundtrip，帶回 userId / platform", () => {
    const state = signOAuthState({ userId: "user-1", platform: "THREADS", redirectTo: "/accounts" });
    const payload = verifyOAuthState(state);
    expect(payload.userId).toBe("user-1");
    expect(payload.platform).toBe("THREADS");
    expect(payload.redirectTo).toBe("/accounts");
    expect(payload.nonce).toBeTruthy();
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("內容被竄改 → 驗證失敗", () => {
    const state = signOAuthState({ userId: "user-1" });
    const [body, sig] = state.split(".");
    const tampered = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), userId: "user-2" })
    ).toString("base64url");
    expect(() => verifyOAuthState(`${tampered}.${sig}`)).toThrow(/簽章驗證失敗/);
  });

  it("簽章被竄改 → 驗證失敗", () => {
    const state = signOAuthState({ userId: "user-1" });
    const [body] = state.split(".");
    expect(() => verifyOAuthState(`${body}.AAAA${"B".repeat(39)}`)).toThrow(/簽章驗證失敗/);
  });

  it("過期 state → 驗證失敗", () => {
    const state = signOAuthState({ userId: "user-1" }, -10);
    expect(() => verifyOAuthState(state)).toThrow(/已過期/);
  });

  it("缺 userId 不能簽", () => {
    expect(() => signOAuthState({ userId: "" })).toThrow(/userId/);
  });

  it("垃圾輸入 → 格式錯誤", () => {
    expect(() => verifyOAuthState("not-a-state")).toThrow(/格式錯誤/);
    expect(() => verifyOAuthState("")).toThrow(/格式錯誤/);
  });

  it("同 payload 兩次簽出的 state 不同（nonce）", () => {
    expect(signOAuthState({ userId: "u" })).not.toBe(signOAuthState({ userId: "u" }));
  });
});
