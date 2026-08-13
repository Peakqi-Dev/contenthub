import { NextRequest, NextResponse } from "next/server";
import { JobStatus, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

// GET /api/jobs?status=&from=&to= — 發布任務清單（規格 §8）
export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const status = searchParams.get("status");
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  if (status && !(status in JobStatus)) {
    return NextResponse.json(
      { error: `status 必須是 ${Object.keys(JobStatus).join(" / ")}` },
      { status: 400 }
    );
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
