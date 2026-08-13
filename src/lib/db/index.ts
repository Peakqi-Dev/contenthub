import { PrismaClient } from "@prisma/client";

// Next.js dev 模式會熱重載，模組層快取避免連線數暴增
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
