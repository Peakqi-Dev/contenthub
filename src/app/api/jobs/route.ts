import { NextRequest, NextResponse } from "next/server";
import { JobStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

// GET /api/jobs?status=&from=&to= — 發布任務清單（規格 §8）
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const status = searchParams.get("status");
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  // hasOwnProperty：`status in JobStatus` 會被原型鏈繞過（?status=toString → 500）
  if (status && !Object.prototype.hasOwnProperty.call(JobStatus, status)) {
    return NextResponse.json(
      { error: `status 必須是 ${Object.keys(JobStatus).join(" / ")}` },
      { status: 400 }
    );
  }
  for (const [name, value] of [
    ["from", from],
    ["to", to],
  ] as const) {
    if (value && Number.isNaN(Date.parse(value))) {
      return NextResponse.json(
        { error: `${name} 不是有效的日期格式（請用 ISO 8601，如 2026-08-14T00:00:00Z）` },
        { status: 400 }
      );
    }
  }

  const where: Prisma.PublishJobWhereInput = {};
  if (status) where.status = status as JobStatus;
  if (from || to) {
    where.scheduledAt = {
      ...(from ? { gte: new Date(from) } : {}),
      ...(to ? { lte: new Date(to) } : {}),
    };
  }

  const jobs = await prisma.publishJob.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 50,
    include: {
      variant: {
        select: {
          id: true,
          surface: true,
          body: true,
          contentPieceId: true,
          account: {
            select: { id: true, platform: true, displayName: true },
          },
        },
      },
    },
  });

  return NextResponse.json({ jobs });
}
