-- AlterTable
ALTER TABLE "RepoSettings" ADD COLUMN     "autoMerge" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mergeMethod" TEXT NOT NULL DEFAULT 'squash';

-- AlterTable
ALTER TABLE "Thread" ADD COLUMN     "autoMerge" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mergeStatus" TEXT,
ADD COLUMN     "mergedAt" TIMESTAMP(3),
ADD COLUMN     "scheduleId" TEXT;

-- CreateTable
CREATE TABLE "Schedule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "baseBranch" TEXT NOT NULL,
    "harness" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'turn',
    "frequency" TEXT NOT NULL,
    "minuteOfDay" INTEGER NOT NULL,
    "weekday" INTEGER,
    "timeZone" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'new',
    "threadId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "lastNote" TEXT,
    "lastThreadId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Schedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Schedule_enabled_nextRunAt_idx" ON "Schedule"("enabled", "nextRunAt");

-- CreateIndex
CREATE INDEX "Schedule_userId_idx" ON "Schedule"("userId");

-- AddForeignKey
ALTER TABLE "Schedule" ADD CONSTRAINT "Schedule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

