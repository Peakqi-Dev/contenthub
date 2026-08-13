// 每個已註冊的 adapter 都必須在這裡呼叫 adapterContract() 掛上合約測試。
// 下面的計數斷言是守門員：registry 一多出 adapter 而沒掛合約測試，這裡就會紅。
import { describe, expect, it } from "vitest";
import { allAdapters } from "../index";

// 目前已掛合約測試的 adapter 數（新增 adapter 時：先在下方呼叫 adapterContract，再 +1）
const ADAPTERS_UNDER_CONTRACT = 0;

// ── 之後依序在這裡掛上（規格 v1.1 修訂 5 的順序）──
// adapterContract(lineOaAdapter, { validPayload: ..., fakeAccount: ... });

describe("adapter registry 守門", () => {
  it(`registry 內每個 adapter 都掛了合約測試（目前 ${ADAPTERS_UNDER_CONTRACT} 個）`, () => {
    expect(allAdapters()).toHaveLength(ADAPTERS_UNDER_CONTRACT);
  });
});
