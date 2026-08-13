import type {
  ContentPiece,
  GenerationRun,
  MediaAsset,
  PublishJob,
  SocialAccount,
  Variant,
} from "@prisma/client";
import { Prisma } from "@prisma/client";
import { prisma } from "./index";

// 租戶隔離的資料存取層（規格追加 §2）。
//
// 這是 route handler / 頁面存取租戶資料的唯一入口：所有查詢自動注入 userId，
// 不存 userId 的 Variant / PublishJob 則經 parent 關聯（contentPiece.userId）過濾。
// route 層直接 import prisma 會被 ESLint 擋下（見 eslint.config.mjs 的
// no-restricted-imports 規則）；lib 內部引擎（publish.ts 等）仍可用 raw prisma，
// 但其輸入必須來自這一層查出的資料。

/** PublishJob 的租戶過濾條件（經 variant → contentPiece 繼承歸屬） */
function jobTenantWhere(userId: string): Prisma.PublishJobWhereInput {
  return { variant: { contentPiece: { userId } } };
}

export type ScopedDb = ReturnType<typeof getScopedDb>;

export function getScopedDb(userId: string) {
  if (!userId) throw new Error("getScopedDb 需要 userId");

  return {
    userId,

    socialAccount: {
      findMany(where?: Prisma.SocialAccountWhereInput): Promise<SocialAccount[]> {
        return prisma.socialAccount.findMany({
          where: { AND: [{ userId }, where ?? {}] },
          orderBy: { createdAt: "asc" },
        });
      },
      findFirst(where?: Prisma.SocialAccountWhereInput): Promise<SocialAccount | null> {
        return prisma.socialAccount.findFirst({ where: { AND: [{ userId }, where ?? {}] } });
      },
      findById(id: string): Promise<SocialAccount | null> {
        return prisma.socialAccount.findFirst({ where: { id, userId } });
      },
      create(
        data: Omit<Prisma.SocialAccountUncheckedCreateInput, "userId">
      ): Promise<SocialAccount> {
        return prisma.socialAccount.create({ data: { ...data, userId } });
      },
      /** 以本租戶的 (platform, platformAccountId) upsert（複合唯一鍵含 userId） */
      upsertByPlatformAccount(args: {
        platform: SocialAccount["platform"];
        platformAccountId: string;
        create: Omit<
          Prisma.SocialAccountUncheckedCreateInput,
          "userId" | "platform" | "platformAccountId"
        >;
        update: Omit<Prisma.SocialAccountUncheckedUpdateInput, "userId">;
      }): Promise<SocialAccount> {
        const { platform, platformAccountId } = args;
        return prisma.socialAccount.upsert({
          where: {
            userId_platform_platformAccountId: { userId, platform, platformAccountId },
          },
          create: { ...args.create, userId, platform, platformAccountId },
          update: args.update,
        });
      },
      /** 回傳更新筆數（0 = 不存在或不屬於本租戶）；data 型別排除 userId，防轉移歸屬 */
      async update(
        id: string,
        data: Omit<Prisma.SocialAccountUncheckedUpdateInput, "userId">
      ): Promise<number> {
        const r = await prisma.socialAccount.updateMany({ where: { id, userId }, data });
        return r.count;
      },
      async delete(id: string): Promise<number> {
        const r = await prisma.socialAccount.deleteMany({ where: { id, userId } });
        return r.count;
      },
      count(where?: Prisma.SocialAccountWhereInput): Promise<number> {
        return prisma.socialAccount.count({ where: { AND: [{ userId }, where ?? {}] } });
      },
    },

    contentPiece: {
      findMany(where?: Prisma.ContentPieceWhereInput): Promise<ContentPiece[]> {
        return prisma.contentPiece.findMany({
          where: { AND: [{ userId }, where ?? {}] },
          orderBy: { createdAt: "desc" },
        });
      },
      findById(id: string): Promise<ContentPiece | null> {
        return prisma.contentPiece.findFirst({ where: { id, userId } });
      },
      create(data: Omit<Prisma.ContentPieceUncheckedCreateInput, "userId">): Promise<ContentPiece> {
        return prisma.contentPiece.create({ data: { ...data, userId } });
      },
      async update(
        id: string,
        data: Omit<Prisma.ContentPieceUncheckedUpdateInput, "userId">
      ): Promise<number> {
        const r = await prisma.contentPiece.updateMany({ where: { id, userId }, data });
        return r.count;
      },
      async delete(id: string): Promise<number> {
        const r = await prisma.contentPiece.deleteMany({ where: { id, userId } });
        return r.count;
      },
      count(where?: Prisma.ContentPieceWhereInput): Promise<number> {
        return prisma.contentPiece.count({ where: { AND: [{ userId }, where ?? {}] } });
      },
    },

    mediaAsset: {
      findMany(where?: Prisma.MediaAssetWhereInput): Promise<MediaAsset[]> {
        return prisma.mediaAsset.findMany({
          where: { AND: [{ userId }, where ?? {}] },
          orderBy: { createdAt: "desc" },
        });
      },
      findById(id: string): Promise<MediaAsset | null> {
        return prisma.mediaAsset.findFirst({ where: { id, userId } });
      },
      create(data: Omit<Prisma.MediaAssetUncheckedCreateInput, "userId">): Promise<MediaAsset> {
        return prisma.mediaAsset.create({ data: { ...data, userId } });
      },
      async delete(id: string): Promise<number> {
        const r = await prisma.mediaAsset.deleteMany({ where: { id, userId } });
        return r.count;
      },
    },

    generationRun: {
      findMany(where?: Prisma.GenerationRunWhereInput): Promise<GenerationRun[]> {
        return prisma.generationRun.findMany({
          where: { AND: [{ userId }, where ?? {}] },
          orderBy: { createdAt: "desc" },
        });
      },
      create(
        data: Omit<Prisma.GenerationRunUncheckedCreateInput, "userId">
      ): Promise<GenerationRun> {
        return prisma.generationRun.create({ data: { ...data, userId } });
      },
    },

    // Variant / PublishJob 不存 userId，經 parent 關聯過濾（規格追加 §1）

    variant: {
      findById(id: string): Promise<Variant | null> {
        return prisma.variant.findFirst({ where: { id, contentPiece: { userId } } });
      },
      findMany(where?: Prisma.VariantWhereInput): Promise<Variant[]> {
        return prisma.variant.findMany({
          where: { AND: [{ contentPiece: { userId } }, where ?? {}] },
          orderBy: { createdAt: "desc" },
        });
      },
    },

    publishJob: {
      findById(id: string): Promise<PublishJob | null> {
        return prisma.publishJob.findFirst({ where: { AND: [{ id }, jobTenantWhere(userId)] } });
      },
      findByIdempotencyKey(idempotencyKey: string): Promise<PublishJob | null> {
        return prisma.publishJob.findFirst({
          where: { AND: [{ idempotencyKey }, jobTenantWhere(userId)] },
        });
      },
      /** 列表一律附帶變體與帳號摘要（jobs API 與首頁共用同一形狀） */
      findMany(args?: {
        where?: Prisma.PublishJobWhereInput;
        take?: number;
      }): Promise<ScopedPublishJob[]> {
        return prisma.publishJob.findMany({
          where: { AND: [jobTenantWhere(userId), args?.where ?? {}] },
          orderBy: { createdAt: "desc" },
          take: args?.take ?? 50,
          include: jobInclude,
        });
      },
      count(where?: Prisma.PublishJobWhereInput): Promise<number> {
        return prisma.publishJob.count({ where: { AND: [jobTenantWhere(userId), where ?? {}] } });
      },
    },
  };
}

const jobInclude = {
  variant: {
    select: {
      id: true,
      surface: true,
      body: true,
      contentPieceId: true,
      account: { select: { id: true, platform: true, displayName: true } },
    },
  },
} satisfies Prisma.PublishJobInclude;

export type ScopedPublishJob = Prisma.PublishJobGetPayload<{ include: typeof jobInclude }>;
