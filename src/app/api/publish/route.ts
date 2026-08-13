import { NextRequest, NextResponse } from "next/server";
import { ContentStatus, JobStatus, Platform, Surface } from "@prisma/client";
import { prisma } from "@/lib/db";
import { executePublishJob } from "@/lib/publish";

// POST /api/publish — Sprint 0 的立即發布通道：
// 建立 ContentPiece + Variant + PublishJob，同步執行發布（純文字走 route handler，規格 §7），
// 回傳完整 job 紀錄。排程通道（POST /api/schedule + cron dispatcher）屬 Sprint 3。
//
// body: {
//   text: string          必填，貼文內容
//   title?: string        ContentPiece 標題，預設取內文前 50 字
//   accountId?: string    指定帳號；不填則取唯一啟用中的 Bluesky 帳號
//   langs?: string[]      語言代碼，最多 3 個，如 ["zh-TW"]
//   idempotencyKey?: string  防重複；同 key 重打會回傳既有 job，不會重發
// }

interface PublishRequestBody {
  text?: unknown;
  title?: unknown;
  accountId?: unknown;
  langs?: unknown;
  idempotencyKey?: unknown;
}

export async function POST(req: NextRequest) {
  let body: PublishRequestBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "request body 必須是 JSON" }, { status: 400 });
  }

  const text = typeof body.text === "string" ? body.text : "";
  if (!text.trim()) {
    return NextResponse.json({ error: "text 為必填欄位" }, { status: 400 });
  }
  if (body.langs !== undefined && !Array.isArray(body.langs)) {
    return NextResponse.json({ error: "langs 需為字串陣列" }, { status: 400 });
  }
  const clientKey =
    typeof body.idempotencyKey === "string" && body.idempotencyKey ? body.idempotencyKey : null;

  // 冪等：同 key 的 job 已存在就直接回傳，不重發
  if (clientKey) {
    const existing = await prisma.publishJob.findUnique({
      where: { idempotencyKey: clientKey },
    });
    if (existing) {
      return NextResponse.json(
        { deduplicated: true, job: existing },
        { status: 200 }
      );
    }
  }

  // 找帳號
  const account =
    typeof body.accountId === "string" && body.accountId
      ? await prisma.socialAccount.findUnique({ where: { id: body.accountId } })
      : await prisma.socialAccount.findFirst({
          where: { platform: Platform.BLUESKY, isActive: true },
        });

  if (!account) {
    return NextResponse.json(
      { error: "找不到可用的帳號。請先執行 `npm run connect:bluesky` 連結 Bluesky 帳號。" },
      { status: 404 }
    );
  }
  if (!account.isActive) {
    return NextResponse.json({ error: `帳號 ${account.displayName} 已停用` }, { status: 409 });
  }

  // 建立 ContentPiece → Variant → PublishJob（同一交易）
  const scheduledAt = new Date();
  const { job, variant } = await prisma.$transaction(async (tx) => {
    const contentPiece = await tx.contentPiece.create({
      data: {
        title:
          typeof body.title === "string" && body.title.trim()
            ? body.title.trim()
            : text.slice(0, 50),
        sourceText: text,
        status: ContentStatus.READY,
      },
    });
    const variant = await tx.variant.create({
      data: {
        contentPieceId: contentPiece.id,
        accountId: account.id,
        surface: Surface.FEED,
        body: text,
        platformOpts: body.langs ? { langs: body.langs } : undefined,
      },
    });
    const job = await tx.publishJob.create({
      data: {
        variantId: variant.id,
        scheduledAt,
        // 規格 §7：idempotencyKey 必填，預設 `${variantId}:${scheduledAt ISO}`
        idempotencyKey: clientKey ?? `${variant.id}:${scheduledAt.toISOString()}`,
      },
    });
    return { job, variant };
  });

  // 同步執行（Bluesky 純文字，幾秒內完成）
  const finished = await executePublishJob(job.id);

  const refreshedVariant = await prisma.variant.findUnique({
    where: { id: variant.id },
    select: { id: true, contentPieceId: true, validationState: true },
  });

  const response = {
    contentPieceId: refreshedVariant?.contentPieceId ?? variant.contentPieceId,
    variantId: variant.id,
    job: finished,
    validation: refreshedVariant?.validationState ?? null,
  };

  if (finished.status === JobStatus.PUBLISHED) {
    return NextResponse.json(response, { status: 201 });
  }
  const status = finished.errorCode === "VALIDATION_FAILED" ? 422 : 502;
  return NextResponse.json(response, { status });
}
