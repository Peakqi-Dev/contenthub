import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

// GET /api/accounts — 已連結帳號 + 健康狀態（規格 §8）。永不回傳 token 欄位。
export async function GET() {
  const accounts = await prisma.socialAccount.findMany({
    select: {
      id: true,
      platform: true,
      publishTier: true,
      displayName: true,
      platformAccountId: true,
      scopes: true,
      meta: true,
      isActive: true,
      healthStatus: true,
      lastHealthCheckAt: true,
      tokenExpiresAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({ accounts });
}
