import type { NextAuthConfig } from "next-auth";

// Edge-safe 的共用設定：middleware 用它驗 JWT，不含 adapter / provider
// （完整設定在 src/auth.ts）。Session 一律帶 userId（規格追加 §3）。
export const authConfig = {
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  callbacks: {
    jwt({ token, user }) {
      if (user?.id) token.userId = user.id;
      return token;
    },
    session({ session, token }) {
      if (typeof token.userId === "string") session.user.id = token.userId;
      return session;
    },
  },
  providers: [],
} satisfies NextAuthConfig;
