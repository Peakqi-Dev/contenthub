import type { MediaKind, Platform, PublishTier, Surface } from "@prisma/client";

// ============ Capability（平台差異用資料描述，不用 if-else，規格 §1 決策三）============

// 各平台字數演算法不同（規格 v1.1 修訂 3）：
//   CHARS       以 Unicode grapheme cluster 計（Threads 等「算字元」的平台）
//   UTF8_BYTES  以 UTF-8 bytes 計
//   UTF16       以 UTF-16 code units 計（IG 等）
//   X_WEIGHTED  X 的加權計算（URL 固定 23、CJK 權重 2）
export type TextCountingMode = "CHARS" | "UTF8_BYTES" | "UTF16" | "X_WEIGHTED";

export interface TextCapability {
  /** 同一平台可同時有多種上限（例如 grapheme 與 byte 雙上限），有定義的都會被檢查 */
  limits: {
    chars?: number;
    utf8Bytes?: number;
    utf16Units?: number;
    weighted?: number;
  };
  /** 主要計數模式：UI 字數顯示、validate() 主訊息以此為準 */
  countingMode: TextCountingMode;
  supportsMarkdown: boolean;
  supportsHashtags: boolean;
  urlCountsAsChars: boolean;
}

export interface PlatformCapabilities {
  platform: Platform;
  publishTier: PublishTier;
  surfaces: Surface[];

  text: TextCapability;

  media: {
    requiresPublicUrl: boolean; // Meta 家族全為 true
    supportsDirectUpload: boolean;
    image: {
      maxCount: number;
      formats: string[];
      maxBytes: number;
      aspectRatios: string[]; // 空陣列 = 不限比例
    } | null;
    video: {
      maxDurationSec: number;
      formats: string[];
      maxBytes: number;
      aspectRatios: string[];
    } | null;
  };

  limits: {
    postsPer24h: number | null;
    requestsPerMinute: number | null;
    notes: string;
  };

  requiresAppReview: boolean;
  costPerPost?: { currency: string; base: number; withUrl?: number };
}

// ============ 發布資料 ============

export interface PublishPayload {
  surface: Surface;
  body: string;
  assets: {
    url: string;
    kind: MediaKind;
    width?: number;
    height?: number;
    durationSec?: number;
  }[];
  linkInComment?: boolean;
  platformOpts?: Record<string, unknown>;
}

export interface ValidationIssue {
  level: "ERROR" | "WARNING";
  field: string;
  message: string; // 給人看的中文訊息
  autoFixable: boolean;
}

export interface PublishResult {
  externalPostId: string;
  externalUrl?: string;
  /** 容器模式平台（Meta 系）回傳中繼 ID，供 pollStatus 用 */
  containerId?: string;
  raw: unknown;
}

/** SocialAccount 解密後的執行期形態；accessToken / refreshToken 為明文，僅存在於記憶體 */
export interface DecryptedAccount {
  id: string;
  platform: Platform;
  platformAccountId: string;
  displayName: string;
  accessToken: string;
  refreshToken?: string;
  meta: Record<string, unknown> | null;
}

// ============ Adapter 介面（系統核心，規格 §4）============

export interface PlatformAdapter {
  readonly capabilities: PlatformCapabilities;

  /** 純函式，不打網路，前端可即時呼叫 */
  validate(payload: PublishPayload): ValidationIssue[];

  /** 可選：自動修正（截斷、裁切、搬移連結） */
  autoFix?(payload: PublishPayload): PublishPayload;

  /** 實際發布 */
  publish(payload: PublishPayload, account: DecryptedAccount): Promise<PublishResult>;

  /** 容器模式平台用（Meta 系）：輪詢處理狀態 */
  pollStatus?(
    containerId: string,
    account: DecryptedAccount
  ): Promise<"PROCESSING" | "FINISHED" | "ERROR">;

  /** Token 更新 */
  refreshCredentials?(account: DecryptedAccount): Promise<Partial<DecryptedAccount>>;

  /** ASSISTED 專用：產生給人操作的內容 */
  buildAssistPackage?(payload: PublishPayload): {
    clipboardText: string;
    deeplink?: string;
    qrPayload?: string;
    instructions: string[];
  };
}
