import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { OAUTH_NONCE_COOKIE, signOAuthState } from "@/lib/oauth/state";
import { buildThreadsAuthUrl } from "@/lib/oauth/threads";

// GET /api/accounts/connect/:platform — OAuth 起點（規格 §8）。
// state 攜帶簽章過的 userId（規格追加 §4），callback 以它決定帳號歸屬。
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ platform: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "未登入" }, { status: 401 });
  }

  const { platform } = await params;
  if (platform !== "threads") {
    return NextResponse.json(
      { error: `平台 ${platform} 的 OAuth 連結尚未實作（目前支援：threads）` },
      { status: 404 }
    );
  }

  const redirectUri =
    process.env.THREADS_REDIRECT_URI ??
    `${req.nextUrl.origin}/api/accounts/callback/threads`;

  try {
    // nonce 同時進 state 與 HttpOnly cookie，callback 比對兩者（double-submit），
    // 把流程綁定到這個瀏覽器，擋跨租戶帳號劫持
    const nonce = randomBytes(16).toString("base64url");
    const state = signOAuthState({ userId: session.user.id, platform: "THREADS", nonce });
    const res = NextResponse.redirect(buildThreadsAuthUrl(state, redirectUri));
    res.cookies.set(OAUTH_NONCE_COOKIE, nonce, {
      httpOnly: true,
      sameSite: "lax", // 從 threads.net 302 回來是 top-level GET，Lax 仍會帶上
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 600, // 對齊 state 的 TTL
    });
    return res;
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "OAuth 起點初始化失敗" },
      { status: 500 }
    );
  }
}
