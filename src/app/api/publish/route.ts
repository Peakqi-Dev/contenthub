import { NextRequest, NextResponse } from "next/server";
import { JobStatus, Prisma, Surface } from "@prisma/client";
import { isAdapterRegistered, registeredPlatforms } from "@/lib/adapters";
import { prisma } from "@/lib/db";
import { publishText } from "@/lib/publish";

// POST /api/publish — 立即發布通道：
// 建立 ContentPiece + Variant + PublishJob，同步執行發布（純文字走 route handler，規格 §7），
// 回傳完整 job 紀錄。排程通道（POST /api/schedule + cron dispatcher）屬後續 Sprint。
//
// body: {
//   text: string          必填，貼文內容
//   title?: string        ContentPiece 標題，預設取內文前 50 字
//   accountId?: string    指定帳號；不填則取第一個「已有 adapter 的平台」的啟用帳號
//   surface?: string      預設 FEED
//   platformOpts?: object 平台專屬選項（原樣存入 Variant.platformOpts）
//   idempotencyKey?: string  防重複；同 key 重打會回傳既有 job，不會重發
// }

// 無認證入口的基本防線：擋掉異常大的輸入（規格第一階段為單人自用）
const MAX_TEXT_CHARS = 10_000;
const MAX_TITLE_CHARS = 200;
const MAX_PLATFORM_OPTS_BYTES = 4_096;
const MAX_IDEMPOTENCY_KEY_CHARS = 200;

interface PublishRequestBody {
  text?: unknown;
  title?: unknown;
  accountId?: unknown;
  surface?: unknown;
  platformOpts?: unknown;
  idempotencyKey?: unknown;
}

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function POST(req: NextRequest) {
  let body: PublishRequestBody;
  try {
    body = await req.json();
  } catch {
    return badRequest("request body 必須是 JSON");
  }

  const text = typeof body.text === "string" ? body.text : "";
  if (!text.trim()) return badRequest("text 為必填欄位");
  if (text.length > MAX_TEXT_CHARS) {
    return badRequest(`text 過長（上限 ${MAX_TEXT_CHARS} 字元；各平台實際上限另由預檢把關）`);
  }
  if (body.title !== undefined && typeof body.title !== "string") {
    return badRequest("title 需為字串");
  }
  if (typeof body.title === "string" && body.title.length > MAX_TITLE_CHARS) {
    return badRequest(`title 過長（上限 ${MAX_TITLE_CHARS} 字元）`);
  }

  let surface: Surface = Surface.FEED;
  if (body.surface !== undefined) {
    if (
      typeof body.surface !== "string" ||
      !Object.prototype.hasOwnProperty.call(Surface, body.surface)
    ) {
      return badRequest(`surface 必須是 ${Object.keys(Surface).join(" / ")}`);
    }
    surface = body.surface as Surface;
  }

  let platformOpts: Prisma.InputJsonValue | undefined;
  if (body.platformOpts !== undefined) {
    if (
      typeof body.platformOpts !== "object" ||
      body.platformOpts === null ||
      Array.isArray(body.platformOpts)
    ) {
      return badRequest("platformOpts 需為物件");
    }
    const serialized = JSON.stringify(body.platformOpts);
    if (new TextEncoder().encode(serialized).length > MAX_PLATFORM_OPTS_BYTES) {
      return badRequest(`platformOpts 過大（上限 ${MAX_PLATFORM_OPTS_BYTES} bytes）`);
    }
    platformOpts = body.platformOpts as Prisma.InputJsonValue;
  }

  const idempotencyKey =
    typeof body.idempotencyKey === "string" && body.idempotencyKey
      ? body.idempotencyKey
      : undefined;
  if (idempotencyKey && idempotencyKey.length > MAX_IDEMPOTENCY_KEY_CHARS) {
    return badRequest(`idempotencyKey 過長（上限 ${MAX_IDEMPOTENCY_KEY_CHARS} 字元）`);
  }

  // 找帳號：指定 accountId，或取第一個「已有 adapter 的平台」的啟用帳號
  const available = registeredPlatforms();
  const account =
    typeof body.accountId === "string" && body.accountId
      ? await prisma.socialAccount.findUnique({ where: { id: body.accountId } })
      : available.length > 0
        ? await prisma.socialAccount.findFirst({
            where: { platform: { in: available }, isActive: true },
          })
        : null;

  if (!account) {
    return NextResponse.json(
      {
        error:
          available.length === 0
            ? "目前沒有任何已實作的平台 adapter（實作順序見 lib/adapters/index.ts）"
            : "找不到可用的帳號，請先連結帳號",
      },
      { status: 404 }
    );
  }
  if (!account.isActive) {
    return NextResponse.json({ error: `帳號 ${account.displayName} 已停用` }, { status: 409 });
  }
  // 指定 accountId 的路徑也要擋未實作的平台，否則 job 會在 getAdapter 拋錯時卡死
  if (!isAdapterRegistered(account.platform)) {
    return NextResponse.json(
      { error: `平台 ${account.platform} 的 adapter 尚未實作，無法發布` },
      { status: 409 }
    );
  }

  const outcome = await publishText(account, {
    text,
    title: typeof body.title === "string" ? body.title : undefined,
    surface,
    platformOpts,
    idempotencyKey,
  });

  if (outcome.deduplicated) {
    return NextResponse.json({ deduplicated: true, job: outcome.job }, { status: 200 });
  }

  const response = {
    contentPieceId: outcome.contentPieceId,
    variantId: outcome.variantId,
    job: outcome.job,
    validation: outcome.validation,
  };

  if (outcome.job.status === JobStatus.PUBLISHED) {
    return NextResponse.json(response, { status: 201 });
  }
  const status = outcome.job.errorCode === "VALIDATION_FAILED" ? 422 : 502;
  return NextResponse.json(response, { status });
}
