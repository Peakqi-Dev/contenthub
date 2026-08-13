// 每個已註冊的 adapter 都必須在這裡呼叫 adapterContract() 掛上合約測試。
// 下面的計數斷言是守門員：registry 一多出 adapter 而沒掛合約測試，這裡就會紅。
import { Platform, Surface } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { fakeAdapter } from "../fake";
import { allAdapters } from "../index";
import { adapterContract } from "./contract";

// 已掛合約測試的平台（新增 adapter 時：先在下方呼叫 adapterContract，再把平台加進來）
const PLATFORMS_UNDER_CONTRACT: Platform[] = [Platform.FAKE];

// ── 1. FAKE（架構驗證）──
adapterContract(fakeAdapter, {
  validPayload: () => ({
    surface: Surface.FEED,
    body: "合約測試貼文",
    assets: [],
  }),
  failingPayload: () => ({
    surface: Surface.FEED,
    body: "這篇會失敗",
    assets: [],
    platformOpts: { simulate: "TOKEN_EXPIRED" },
  }),
  fakeAccount: () => ({
    id: "contract-test-account",
    platform: Platform.FAKE,
    platformAccountId: "fake-user",
    displayName: "合約測試假帳號",
    accessToken: "secret-token-must-not-leak",
    refreshToken: "refresh-secret-must-not-leak",
    meta: null,
  }),
});

// ── 之後依序在這裡掛上：THREADS → FB → IG → X → MEDIUM → LINE_OA ──

describe("adapter registry 守門", () => {
  it(`registry 內每個 adapter 都掛了合約測試（目前：${PLATFORMS_UNDER_CONTRACT.join("、")}）`, () => {
    const registered = allAdapters()
      .map((a) => a.capabilities.platform)
      .sort();
    expect(registered).toEqual([...PLATFORMS_UNDER_CONTRACT].sort());
  });
});
