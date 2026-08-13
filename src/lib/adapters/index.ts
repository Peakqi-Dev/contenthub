import { Platform } from "@prisma/client";
import { blueskyAdapter } from "./bluesky";
import type { PlatformAdapter, PlatformCapabilities } from "./types";

// Registry：platform → adapter（規格 §1 決策三）
// 新平台上線 = 實作 PlatformAdapter + 在這裡登記一行，其他程式碼不用動。
const registry: Partial<Record<Platform, PlatformAdapter>> = {
  [Platform.BLUESKY]: blueskyAdapter,
};

export function getAdapter(platform: Platform): PlatformAdapter {
  const adapter = registry[platform];
  if (!adapter) {
    throw new Error(
      `平台 ${platform} 的 adapter 尚未實作（Sprint 0 只支援 BLUESKY）`
    );
  }
  return adapter;
}

export function isAdapterRegistered(platform: Platform): boolean {
  return platform in registry;
}

/** 給前端快取用的完整 capability matrix（GET /api/capabilities） */
export function getCapabilityMatrix(): PlatformCapabilities[] {
  return Object.values(registry).map((a) => a.capabilities);
}

export type { PlatformAdapter, PlatformCapabilities } from "./types";
