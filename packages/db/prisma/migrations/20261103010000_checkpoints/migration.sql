-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "rewoundAt" TIMESTAMP(3),
ADD COLUMN     "targetRunId" TEXT;

-- AlterTable
ALTER TABLE "Thread" ADD COLUMN     "forkAtRunId" TEXT,
ADD COLUMN     "forkOfThreadId" TEXT;

