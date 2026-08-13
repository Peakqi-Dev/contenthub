import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// OAuth state 簽章工具（規格追加 §4）。
// 未來各平台的 OAuth 連結流程：起點以 signOAuthState({ userId, platform }) 產生
// state；callback 以 verifyOAuthState() 驗簽並取回 userId，決定 SocialAccount 歸屬。
// 絕不信任 callback 時的 session——state 內簽章的 userId 才是授權發起者。

export interface OAuthStatePayload {
  userId: string;
  platform?: string;
  redirectTo?: string;
  nonce: string;
  iat: number; // Unix 秒
  exp: number;
}

const DEFAULT_TTL_SECONDS = 600;

// connect 時把 state 的 nonce 寫進這個 HttpOnly cookie，callback 驗證
// state.nonce === cookie 才放行——把 OAuth 流程綁定到發起授權的同一個瀏覽器，
// 擋掉「攻擊者鑄造自己的 state 誘騙受害者完成授權」的跨租戶帳號劫持。
export const OAUTH_NONCE_COOKIE = "ch_oauth_nonce";

function getSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("AUTH_SECRET 未設定（OAuth state 簽章需要）");
  return secret;
}

function hmac(data: string): Buffer {
  return createHmac("sha256", getSecret()).update(data).digest();
}

export function signOAuthState(
  input: { userId: string; platform?: string; redirectTo?: string; nonce?: string },
  ttlSeconds: number = DEFAULT_TTL_SECONDS
): string {
  if (!input.userId) throw new Error("OAuth state 必須帶 userId");
  const now = Math.floor(Date.now() / 1000);
  const payload: OAuthStatePayload = {
    userId: input.userId,
    platform: input.platform,
    redirectTo: input.redirectTo,
    // caller 可傳入 nonce（同時寫進 cookie 做 double-submit）；不傳則自動產生
    nonce: input.nonce ?? randomBytes(16).toString("base64url"),
    iat: now,
    exp: now + ttlSeconds,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${hmac(body).toString("base64url")}`;
}

/** 驗證失敗（格式/簽章/過期/缺 userId）一律拋錯，呼叫端把它當 4xx 處理 */
export function verifyOAuthState(state: string): OAuthStatePayload {
  const parts = state.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("OAuth state 格式錯誤");

  const [body, signature] = parts;
  const expected = hmac(body);
  let given: Buffer;
  try {
    given = Buffer.from(signature, "base64url");
  } catch {
    throw new Error("OAuth state 格式錯誤");
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new Error("OAuth state 簽章驗證失敗");
  }

  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new Error("OAuth state 內容解析失敗");
  }
  if (!payload.userId || typeof payload.userId !== "string") {
    throw new Error("OAuth state 缺 userId");
  }
  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("OAuth state 已過期，請重新發起連結流程");
  }
  return payload;
}
