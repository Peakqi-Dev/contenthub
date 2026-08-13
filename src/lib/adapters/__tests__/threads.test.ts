import { Surface } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { threadsAdapter } from "../threads";
import type { PublishPayload } from "../types";

const base = (body: string): PublishPayload => ({ surface: Surface.FEED, body, assets: [] });

describe("Threads validate", () => {
  it("純文字 500 字內無 ERROR", () => {
    const issues = threadsAdapter.validate(base("你好，這是一則測試貼文"));
    expect(issues.filter((i) => i.level === "ERROR")).toEqual([]);
  });

  it("emoji 按 UTF-8 bytes 計：grapheme 未超標但位元組超標 → ERROR", () => {
    // 400 個 ASCII + 30 個 4-byte emoji：grapheme=430（<500）但加權=400+120=520
    const body = "a".repeat(400) + "🚀".repeat(30);
    const issues = threadsAdapter.validate(base(body));
    expect(issues.some((i) => i.level === "ERROR" && i.field === "body")).toBe(true);
  });

  it("連結超過 5 個 → ERROR", () => {
    const body = Array.from({ length: 6 }, (_, i) => `https://example.com/${i}`).join(" ");
    const issues = threadsAdapter.validate(base(body));
    expect(issues.some((i) => i.level === "ERROR" && i.field === "body")).toBe(true);
  });

  it("STORY surface → ERROR（Threads 無限動）", () => {
    const issues = threadsAdapter.validate({ ...base("x"), surface: Surface.STORY });
    expect(issues.some((i) => i.level === "ERROR" && i.field === "surface")).toBe(true);
  });
});
