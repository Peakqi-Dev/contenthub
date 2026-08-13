import { NextRequest, NextResponse } from "next/server";
import { JobStatus, Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { getScopedDb } from "@/lib/db/scoped";

// GET /api/jobs?status=&from=&to= — 本租戶的發布任務清單（規格 §8）
export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "未登入" }, { status: 401 });
  }
  const db = getScopedDb(session.user.id);

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

  // 變體與帳號摘要由 scoped 層固定附帶
  const jobs = await db.publishJob.findMany({ where, take: 50 });

  return NextResponse.json({ jobs });
}
