// 租戶隔離測試（規格追加 §5）：user A 的身分絕對取不到 user B 的資料。
// 需要 DATABASE_URL（本地 `npx prisma dev` 即可），由 vitest.config.mts 載入 .env。
import { randomUUID } from "node:crypto";
import { JobStatus, Platform, PublishTier, Surface } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../index";
import { getScopedDb, type ScopedDb } from "../scoped";

const run = randomUUID().slice(0, 8); // 每次執行用獨立資料，避免互相污染

let userAId: string;
let userBId: string;
let dbA: ScopedDb;
let accountAId: string;
let accountBId: string;
let pieceBId: string;
let variantBId: string;
let jobBId: string;
const jobBKey = `isolation-test-${run}`;

beforeAll(async () => {
  const [userA, userB] = await Promise.all([
    prisma.user.create({ data: { email: `iso-a-${run}@test.local`, name: "User A" } }),
    prisma.user.create({ data: { email: `iso-b-${run}@test.local`, name: "User B" } }),
  ]);
  userAId = userA.id;
  userBId = userB.id;
  dbA = getScopedDb(userAId);

  // A 與 B 各有一個 SocialAccount；B 另有完整的 content → variant → job 鏈
  const accountA = await prisma.socialAccount.create({
    data: {
      userId: userAId,
      platform: Platform.FAKE,
      publishTier: PublishTier.AUTO_API,
      displayName: `A 的帳號 ${run}`,
      platformAccountId: `iso-${run}-a`,
      accessToken: "enc-a",
      scopes: [],
    },
  });
  const accountB = await prisma.socialAccount.create({
    data: {
      userId: userBId,
      platform: Platform.FAKE,
      publishTier: PublishTier.AUTO_API,
      displayName: `B 的帳號 ${run}`,
      platformAccountId: `iso-${run}-b`,
      accessToken: "enc-b",
      scopes: [],
    },
  });
  accountAId = accountA.id;
  accountBId = accountB.id;

  const pieceB = await prisma.contentPiece.create({
    data: { userId: userBId, title: `B 的內容 ${run}`, sourceText: "secret of B" },
  });
  pieceBId = pieceB.id;
  const variantB = await prisma.variant.create({
    data: {
      contentPieceId: pieceBId,
      accountId: accountBId,
      surface: Surface.FEED,
      body: "B 的變體",
    },
  });
  variantBId = variantB.id;
  const jobB = await prisma.publishJob.create({
    data: {
      variantId: variantBId,
      scheduledAt: new Date(),
      status: JobStatus.PUBLISHED,
      idempotencyKey: jobBKey,
      externalPostId: "fake:b-post",
    },
  });
  jobBId = jobB.id;
});

afterAll(async () => {
  // FK 順序：content（cascade variant/job）→ account → user
  await prisma.contentPiece.deleteMany({ where: { userId: { in: [userAId, userBId] } } });
  await prisma.socialAccount.deleteMany({ where: { userId: { in: [userAId, userBId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [userAId, userBId] } } });
  await prisma.$disconnect();
});

describe("租戶隔離：以 A 的身分絕對取不到 B 的資料", () => {
  it("socialAccount.findMany 只回 A 自己的帳號", async () => {
    const accounts = await dbA.socialAccount.findMany();
    expect(accounts.map((a) => a.id)).toContain(accountAId);
    expect(accounts.map((a) => a.id)).not.toContain(accountBId);
  });

  it("socialAccount.findById(B 的 id) → null", async () => {
    expect(await dbA.socialAccount.findById(accountBId)).toBeNull();
  });

  it("socialAccount.update / delete B 的帳號 → 影響 0 筆", async () => {
    expect(await dbA.socialAccount.update(accountBId, { displayName: "hacked" })).toBe(0);
    expect(await dbA.socialAccount.delete(accountBId)).toBe(0);
    const untouched = await prisma.socialAccount.findUnique({ where: { id: accountBId } });
    expect(untouched?.displayName).toBe(`B 的帳號 ${run}`);
  });

  it("contentPiece：findMany 不含 B 的、findById(B) → null、delete(B) → 0", async () => {
    const pieces = await dbA.contentPiece.findMany();
    expect(pieces.map((p) => p.id)).not.toContain(pieceBId);
    expect(await dbA.contentPiece.findById(pieceBId)).toBeNull();
    expect(await dbA.contentPiece.delete(pieceBId)).toBe(0);
  });

  it("variant（經 parent 繼承歸屬）：findById(B 的 variant) → null", async () => {
    expect(await dbA.variant.findById(variantBId)).toBeNull();
  });

  it("publishJob（經 parent 繼承歸屬）：findMany / findById / findByIdempotencyKey 都看不到 B 的 job", async () => {
    const jobs = await dbA.publishJob.findMany();
    expect(jobs.map((j) => j.id)).not.toContain(jobBId);
    expect(await dbA.publishJob.findById(jobBId)).toBeNull();
    expect(await dbA.publishJob.findByIdempotencyKey(jobBKey)).toBeNull();
    // B 自己看得到（對照組）
    const dbB = getScopedDb(userBId);
    expect((await dbB.publishJob.findById(jobBId))?.id).toBe(jobBId);
  });

  it("同一個平台帳號可被不同 user 各自連結（複合唯一鍵含 userId）", async () => {
    const shared = `iso-${run}-shared`;
    const a = await dbA.socialAccount.create({
      platform: Platform.FAKE,
      publishTier: PublishTier.AUTO_API,
      displayName: "共享粉專（A 連結）",
      platformAccountId: shared,
      accessToken: "enc",
      scopes: [],
    });
    const dbB = getScopedDb(userBId);
    const b = await dbB.socialAccount.create({
      platform: Platform.FAKE,
      publishTier: PublishTier.AUTO_API,
      displayName: "共享粉專（B 連結）",
      platformAccountId: shared,
      accessToken: "enc",
      scopes: [],
    });
    expect(a.id).not.toBe(b.id);
    // 各自只看得到自己的那筆
    expect(await dbA.socialAccount.findById(b.id)).toBeNull();
    expect(await dbB.socialAccount.findById(a.id)).toBeNull();
  });
});
