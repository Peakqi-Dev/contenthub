// 連結 Bluesky 帳號：驗證 app password 後把帳號（token 加密）寫入 SocialAccount。
// 用法：在 .env 填好 BLUESKY_IDENTIFIER / BLUESKY_APP_PASSWORD 後執行
//   npm run connect:bluesky
// Bluesky 免 app review，OAuth 連結流程（/api/accounts/connect/:platform）屬 Sprint 1。

import { AtpAgent } from "@atproto/api";
import { Platform, PrismaClient, PublishTier } from "@prisma/client";
import { encryptSecret } from "../src/lib/crypto";

const prisma = new PrismaClient();

async function main() {
  const identifier = process.env.BLUESKY_IDENTIFIER;
  const password = process.env.BLUESKY_APP_PASSWORD;
  const service = process.env.BLUESKY_SERVICE || "https://bsky.social";

  if (!identifier || !password) {
    console.error(
      "請在 .env 設定 BLUESKY_IDENTIFIER（handle，如 you.bsky.social）與 BLUESKY_APP_PASSWORD。\n" +
        "App password 到 Bluesky 設定 → Privacy and Security → App Passwords 產生，不要用主密碼。"
    );
    process.exit(1);
  }

  console.log(`正在登入 ${service}（${identifier}）...`);
  const agent = new AtpAgent({ service });
  await agent.login({ identifier, password });

  const session = agent.session;
  if (!session) throw new Error("登入成功但拿不到 session，異常");

  let displayName = session.handle;
  try {
    const profile = await agent.getProfile({ actor: session.did });
    if (profile.data.displayName) displayName = profile.data.displayName;
  } catch {
    // 拿不到 profile 就用 handle 當顯示名稱
  }

  const account = await prisma.socialAccount.upsert({
    where: {
      platform_platformAccountId: {
        platform: Platform.BLUESKY,
        platformAccountId: session.did,
      },
    },
    create: {
      platform: Platform.BLUESKY,
      publishTier: PublishTier.AUTO_API,
      displayName,
      platformAccountId: session.did, // DID 最穩定，不受改 handle 影響
      accessToken: encryptSecret(password),
      scopes: [],
      meta: { identifier, handle: session.handle, service },
      isActive: true,
      healthStatus: "OK",
      lastHealthCheckAt: new Date(),
    },
    update: {
      displayName,
      accessToken: encryptSecret(password),
      meta: { identifier, handle: session.handle, service },
      isActive: true,
      healthStatus: "OK",
      lastHealthCheckAt: new Date(),
    },
  });

  console.log("✅ Bluesky 帳號已連結：");
  console.log(`   accountId : ${account.id}`);
  console.log(`   handle    : ${session.handle}`);
  console.log(`   did       : ${session.did}`);
  console.log(`   顯示名稱  : ${displayName}`);
  console.log("\n測試發文：");
  console.log(
    `   curl -X POST http://localhost:3000/api/publish -H "Content-Type: application/json" -d "{\\"text\\": \\"hello from content-hub\\"}"`
  );
}

main()
  .catch((err) => {
    console.error("❌ 連結失敗：", err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
