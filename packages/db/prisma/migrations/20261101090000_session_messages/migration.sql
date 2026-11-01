-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "fromRunId" TEXT,
ADD COLUMN     "fromThreadId" TEXT,
ADD COLUMN     "hops" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "replyToThreadId" TEXT;

-- AlterTable
ALTER TABLE "Thread" ADD COLUMN     "peers" TEXT NOT NULL DEFAULT 'repo';

-- CreateIndex
CREATE UNIQUE INDEX "Run_fromRunId_threadId_key" ON "Run"("fromRunId", "threadId");

