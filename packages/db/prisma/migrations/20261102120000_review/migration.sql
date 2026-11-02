-- AlterTable
ALTER TABLE "RepoSettings" ADD COLUMN     "reviewPostToGitHub" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "reviewRounds" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "reviewer" TEXT;

-- AlterTable
ALTER TABLE "Thread" ADD COLUMN     "diff" TEXT,
ADD COLUMN     "diffBase" TEXT;

-- CreateTable
CREATE TABLE "ReviewFinding" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "file" TEXT,
    "line" INTEGER,
    "severity" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewFinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReviewFinding_threadId_createdAt_idx" ON "ReviewFinding"("threadId", "createdAt");

-- CreateIndex
CREATE INDEX "ReviewFinding_runId_idx" ON "ReviewFinding"("runId");

-- AddForeignKey
ALTER TABLE "ReviewFinding" ADD CONSTRAINT "ReviewFinding_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewFinding" ADD CONSTRAINT "ReviewFinding_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

