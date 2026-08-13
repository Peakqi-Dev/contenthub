import { Platform } from "@prisma/client";
import { fakeAdapter } from "./fake";
import type { PlatformAdapter, PlatformCapabilities } from "./types";

// Registry：platform → adapter（規格 §1 決策三）
// 新平台上線 = 實作 PlatformAdapter + 通過 __tests__/contract.ts + 在這裡登記一行。
//
// 實作順序（規格 v1.1，2026-08-14 二次修訂；一次只做一個，其他檔案不動）：
//   1. FAKE（架構驗證：job 狀態機、重試、冪等性）✅
//   2. THREADS
//   3. meta/shared.ts + FACEBOOK_PAGE
//   4. INSTAGRAM（FEED / STORY / REEL）
//   5. X
//   6. MEDIUM（ASSISTED）
//   7. LINE_OA
const registry: Partial<Record<Platform, PlatformAdapter>> = {
  [Platform.FAKE]: fakeAdapter,
};

export function getAdapter(platform: Platform): PlatformAdapter {
  const adapter = registry[platform];
  if (!adapter) {
    throw new Error(`平台 ${platform} 的 adapter 尚未實作（實作順序見 lib/adapters/index.ts）`);
  }
  return adapter;
}

export function isAdapterRegistered(platform: Platform): boolean {
  return platform in registry;
}

/** 已有 adapter 的平台清單（發布入口用它挑可用帳號） */
export function registeredPlatforms(): Platform[] {
  return Object.keys(registry) as Platform[];
}

/** 所有已註冊的 adapter（contract 測試逐一驗證用） */
export function allAdapters(): PlatformAdapter[] {
  return Object.values(registry);
}

/** 給前端快取用的完整 capability matrix（GET /api/capabilities） */
export function getCapabilityMatrix(): PlatformCapabilities[] {
  return allAdapters().map((a) => a.capabilities);
}

export type { PlatformAdapter, PlatformCapabilities } from "./types";
