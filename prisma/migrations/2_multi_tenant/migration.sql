-- 多租戶資料隔離（規格追加）：User + VerificationToken + 四模型 userId FK
-- 既有資料（遷移前的單人時期）歸屬到 bootstrap user 'local'。

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "image" TEXT,
    "emailVerified" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VerificationToken_pkey" PRIMARY KEY ("identifier","token")
);

-- Bootstrap user：承接遷移前的既有資料（本地開發資料；雲端全新 DB 則是空殼帳號，無害）
INSERT INTO "User" ("id", "email", "name", "createdAt", "updatedAt")
VALUES ('local', 'local@bootstrap.invalid', 'Local（遷移前資料）', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- SocialAccount：userId 已存在（舊 default 'local'），改為 FK、換唯一鍵
ALTER TABLE "SocialAccount" ALTER COLUMN "userId" DROP DEFAULT;
ALTER TABLE "SocialAccount" ADD CONSTRAINT "SocialAccount_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
DROP INDEX "SocialAccount_platform_platformAccountId_key";
CREATE UNIQUE INDEX "SocialAccount_userId_platform_platformAccountId_key"
    ON "SocialAccount"("userId", "platform", "platformAccountId");
CREATE INDEX "SocialAccount_userId_idx" ON "SocialAccount"("userId");

-- ContentPiece
ALTER TABLE "ContentPiece" ADD COLUMN "userId" TEXT NOT NULL DEFAULT 'local';
ALTER TABLE "ContentPiece" ALTER COLUMN "userId" DROP DEFAULT;
ALTER TABLE "ContentPiece" ADD CONSTRAINT "ContentPiece_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "ContentPiece_userId_idx" ON "ContentPiece"("userId");

-- MediaAsset
ALTER TABLE "MediaAsset" ADD COLUMN "userId" TEXT NOT NULL DEFAULT 'local';
ALTER TABLE "MediaAsset" ALTER COLUMN "userId" DROP DEFAULT;
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "MediaAsset_userId_idx" ON "MediaAsset"("userId");

-- GenerationRun
ALTER TABLE "GenerationRun" ADD COLUMN "userId" TEXT NOT NULL DEFAULT 'local';
ALTER TABLE "GenerationRun" ALTER COLUMN "userId" DROP DEFAULT;
ALTER TABLE "GenerationRun" ADD CONSTRAINT "GenerationRun_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "GenerationRun_userId_idx" ON "GenerationRun"("userId");
