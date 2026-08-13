import { beforeAll, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "../crypto";

beforeAll(() => {
  process.env.ENCRYPTION_KEY = "a".repeat(64); // 測試專用 key
});

describe("AES-256-GCM token 加密", () => {
  it("加密後可解密還原（roundtrip）", () => {
    const secret = "line-channel-access-token-測試";
    expect(decryptSecret(encryptSecret(secret))).toBe(secret);
  });

  it("同一明文兩次加密產生不同密文（IV 隨機）", () => {
    expect(encryptSecret("x")).not.toBe(encryptSecret("x"));
  });

  it("密文被竄改時拋錯（authTag 驗證）", () => {
    const stored = encryptSecret("secret");
    const parts = stored.split(":");
    const data = Buffer.from(parts[3], "base64");
    data[0] ^= 0xff;
    parts[3] = data.toString("base64");
    expect(() => decryptSecret(parts.join(":"))).toThrow();
  });

  it("格式錯誤時給明確錯誤", () => {
    expect(() => decryptSecret("not-encrypted")).toThrow(/格式錯誤/);
  });
});
