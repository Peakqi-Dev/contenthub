import { NextRequest, NextResponse } from "next/server";
import { Platform, PublishTier } from "@prisma/client";
import { encryptSecret } from "@/lib/crypto";
import { getScopedDb } from "@/lib/db/scoped";
import { OAUTH_NONCE_COOKIE, verifyOAuthState } from "@/lib/oauth/state";
import { exchangeThreadsCode, fetchThreadsProfile } from "@/lib/oauth/threads";

// GET /api/accounts/callback/:platform — OAuth 回呼（規格 §8）。
// 此路由在 middleware 豁免清單內：瀏覽器從平台導回時不依賴 session。
// 帳號歸屬由 state 內簽章的 userId 決定（規格追加 §4），但簽章只保證「沒被竄改」，
// 不保證「是同一個瀏覽器發起的」——故額外用 nonce cookie double-submit 綁定瀏覽器，
// 否則攻擊者可用自己的 state 誘騙受害者完成授權、把受害者帳號掛進攻擊者租戶。

function backToApp(req: NextRequest, params: Record<string, string>) {
  const url = new URL("/", req.nextUrl.origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = NextResponse.redirect(url);
  res.cookies.delete(OAUTH_NONCE_COOKIE); // 流程結束（成功或失敗）都清掉一次性 nonce
  return res;
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ platform: string }> }
) {
  const { platform } = await params;
  if (platform !== "threads") {
    return NextResponse.json({ error: `未知的 callback 平台：${platform}` }, { status: 404 });
  }

  const sp = req.nextUrl.searchParams;

  // 使用者在平台端拒絕授權
  if (sp.get("error")) {
    return backToApp(req, {
      connect_error: `授權被拒絕（${sp.get("error_description") ?? sp.get("error") ?? ""}）`,
    });
  }

  const code = sp.get("code");
  const state = sp.get("state");
  if (!code || !state) {
    return backToApp(req, { connect_error: "缺少 code 或 state 參數" });
  }

  // 驗簽 state → 取回發起授權的 userId（不信任 session）
  let userId: string;
  try {
    const payload = verifyOAuthState(state);
    if (payload.platform !== "THREADS") throw new Error("state 平台不符");
    // double-submit：state 的 nonce 必須與 connect 時下發的 cookie 一致，
    // 證明完成 callback 的瀏覽器就是發起授權的那一個
    const cookieNonce = req.cookies.get(OAUTH_NONCE_COOKIE)?.value;
    if (!cookieNonce || cookieNonce !== payload.nonce) {
      throw new Error("OAuth 流程與瀏覽器不符，請重新從本站發起連結");
    }
    userId = payload.userId;
  } catch (err) {
    return backToApp(req, {
      connect_error: err instanceof Error ? err.message : "state 驗證失敗",
    });
  }

  try {
    const redirectUri =
      process.env.THREADS_REDIRECT_URI ??
      `${req.nextUrl.origin}/api/accounts/callback/threads`;

    const { accessToken, expiresAt, threadsUserId } = await exchangeThreadsCode(
      code,
      redirectUri
    );
    const profile = await fetchThreadsProfile(accessToken).catch(() => null);
    const displayName =
      profile?.name || (profile?.username ? `@${profile.username}` : `Threads ${threadsUserId}`);

    const db = getScopedDb(userId);
    const account = await db.socialAccount.upsertByPlatformAccount({
      platform: Platform.THREADS,
      platformAccountId: profile?.id ?? threadsUserId,
      create: {
        publishTier: PublishTier.AUTO_API,
        displayName,
        accessToken: encryptSecret(accessToken),
        tokenExpiresAt: expiresAt,
        scopes: ["threads_basic", "threads_content_publish"],
        meta: profile?.username ? { username: profile.username } : undefined,
        healthStatus: "OK",
        lastHealthCheckAt: new Date(),
      },
      update: {
        displayName,
        accessToken: encryptSecret(accessToken),
        tokenExpiresAt: expiresAt,
        scopes: ["threads_basic", "threads_content_publish"],
        meta: profile?.username ? { username: profile.username } : undefined,
        isActive: true,
        healthStatus: "OK",
        lastHealthCheckAt: new Date(),
      },
    });

    return backToApp(req, { connected: "threads", account: account.displayName });
  } catch (err) {
    console.error("[oauth] Threads callback 失敗", err);
    return backToApp(req, {
      connect_error: err instanceof Error ? err.message.slice(0, 120) : "連結失敗",
    });
  }
}
