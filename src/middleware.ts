import NextAuth from "next-auth";
import { authConfig } from "./auth.config";

// middleware 只做 JWT 驗證（edge runtime，不碰 DB）
const { auth } = NextAuth(authConfig);

export default auth((req) => {
  if (req.auth?.user) return;

  const { nextUrl } = req;
  // API 回 401 JSON（curl / 前端 fetch 才不會拿到一頁 HTML）；頁面導向 /login
  if (nextUrl.pathname.startsWith("/api")) {
    return Response.json({ error: "未登入" }, { status: 401 });
  }
  const login = new URL("/login", nextUrl);
  login.searchParams.set("callbackUrl", nextUrl.pathname + nextUrl.search);
  return Response.redirect(login);
});

export const config = {
  // 保護所有頁面與 /api/*；放行 Auth.js 端點、登入頁與靜態資源（規格追加 §3）
  matcher: ["/((?!api/auth|login|_next/static|_next/image|favicon.ico).*)"],
};
