import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getScopedDb } from "@/lib/db/scoped";

// GET /api/accounts — 本租戶已連結帳號 + 健康狀態（規格 §8）。永不回傳 token 欄位。
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "未登入" }, { status: 401 });
  }
  const db = getScopedDb(session.user.id);

  const accounts = (await db.socialAccount.findMany()).map((a) => ({
    id: a.id,
    platform: a.platform,
    publishTier: a.publishTier,
    displayName: a.displayName,
    platformAccountId: a.platformAccountId,
    scopes: a.scopes,
    meta: a.meta,
    isActive: a.isActive,
    healthStatus: a.healthStatus,
    lastHealthCheckAt: a.lastHealthCheckAt,
    tokenExpiresAt: a.tokenExpiresAt,
    createdAt: a.createdAt,
  }));

  return NextResponse.json({ accounts });
}
