import { PrismaAdapter } from "@auth/prisma-adapter";
import NextAuth from "next-auth";
import type { EmailConfig } from "next-auth/providers";
import { authConfig } from "./auth.config";
import { prisma } from "@/lib/db";

// Email magic link：dev 環境不接郵件服務，登入連結直接輸出在 server console
// （規格追加 §3）。之後接 Resend / SES 時只要換掉 sendVerificationRequest。
const devMagicLink: EmailConfig = {
  id: "email",
  type: "email",
  name: "Email（magic link）",
  from: "dev@contenthub.local",
  server: {},
  maxAge: 24 * 60 * 60,
  options: {},
  async sendVerificationRequest({ identifier, url }) {
    console.log(`\n🔗 [magic link] ${identifier} 的登入連結：\n${url}\n`);
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  // JWT session + email 流程只用到 user / verificationToken，
  // schema 刻意不建 Session / Account model（未來加 OAuth 登入時再補）。
  adapter: PrismaAdapter(prisma),
  providers: [devMagicLink],
});
