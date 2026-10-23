-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "councilId" TEXT,
ADD COLUMN     "councilRole" TEXT,
ADD COLUMN     "councilRound" INTEGER,
ADD COLUMN     "output" TEXT;

-- CreateTable
CREATE TABLE "Council" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "repo" TEXT,
    "baseBranch" TEXT,
    "members" TEXT[],
    "chair" TEXT NOT NULL,
    "rounds" INTEGER NOT NULL DEFAULT 3,
    "round" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'running',
    "budgetUsd" DECIMAL(65,30),
    "guidance" JSONB NOT NULL DEFAULT '[]',
    "report" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Council_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Council_userId_createdAt_idx" ON "Council"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Run_councilId_councilRound_councilRole_harness_key" ON "Run"("councilId", "councilRound", "councilRole", "harness");

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_councilId_fkey" FOREIGN KEY ("councilId") REFERENCES "Council"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Council" ADD CONSTRAINT "Council_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

