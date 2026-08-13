// Threads OAuth（官方文件查證日 2026-08-14）：
//   authorize：https://threads.net/oauth/authorize（client_id 是 Threads App ID，不是 Facebook 那組）
//   短效 token：POST graph.threads.net/oauth/access_token（1 小時）
//   換長效：GET graph.threads.net/access_token?grant_type=th_exchange_token（60 天）

const AUTHORIZE_URL = "https://threads.net/oauth/authorize";
const TOKEN_URL = "https://graph.threads.net/oauth/access_token";
const EXCHANGE_URL = "https://graph.threads.net/access_token";
const GRAPH_BASE = "https://graph.threads.net/v1.0";
const SCOPES = "threads_basic,threads_content_publish";
const FETCH_TIMEOUT_MS = 15_000;

function env(name: "THREADS_APP_ID" | "THREADS_APP_SECRET"): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} 未設定（Meta App Dashboard → Threads use case 取得）`);
  return v;
}

export function buildThreadsAuthUrl(state: string, redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: env("THREADS_APP_ID"),
    redirect_uri: redirectUri,
    scope: SCOPES,
    response_type: "code",
    state,
  });
  return `${AUTHORIZE_URL}?${params}`;
}

async function fetchJson<T>(url: string, init: RequestInit, context: string): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const body = (await res.json().catch(() => ({}))) as T & {
    error?: { message?: string } | string;
    error_message?: string;
  };
  if (!res.ok) {
    const msg =
      (typeof body.error === "object" ? body.error?.message : body.error) ??
      body.error_message ??
      `HTTP ${res.status}`;
    throw new Error(`${context}失敗：${msg}`);
  }
  return body;
}

/** code → 短效 token → 長效 token（60 天）。回傳長效 token 與到期時間。 */
export async function exchangeThreadsCode(
  code: string,
  redirectUri: string
): Promise<{ accessToken: string; expiresAt: Date; threadsUserId: string }> {
  const short = await fetchJson<{ access_token: string; user_id: number | string }>(
    TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env("THREADS_APP_ID"),
        client_secret: env("THREADS_APP_SECRET"),
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri, // 必須與授權時完全一致
      }).toString(),
    },
    "短效 token 交換"
  );

  const long = await fetchJson<{ access_token: string; expires_in?: number }>(
    `${EXCHANGE_URL}?${new URLSearchParams({
      grant_type: "th_exchange_token",
      client_secret: env("THREADS_APP_SECRET"),
      access_token: short.access_token,
    })}`,
    { method: "GET" },
    "長效 token 交換"
  );

  const expiresInSec = long.expires_in ?? 60 * 24 * 60 * 60;
  return {
    accessToken: long.access_token,
    expiresAt: new Date(Date.now() + expiresInSec * 1000),
    threadsUserId: String(short.user_id),
  };
}

export async function fetchThreadsProfile(
  accessToken: string
): Promise<{ id: string; username?: string; name?: string }> {
  const me = await fetchJson<{ id: string; username?: string; name?: string }>(
    `${GRAPH_BASE}/me?${new URLSearchParams({
      fields: "id,username,name",
      access_token: accessToken,
    })}`,
    { method: "GET" },
    "取得 Threads 個人資料"
  );
  return me;
}
