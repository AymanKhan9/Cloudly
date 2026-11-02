-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "planId" TEXT;

-- AlterTable
ALTER TABLE "Thread" ADD COLUMN     "planId" TEXT;

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "baseBranch" TEXT NOT NULL,
    "goal" TEXT NOT NULL,
    "planner" TEXT NOT NULL,
    "harness" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planning',
    "maxParallel" INTEGER NOT NULL DEFAULT 3,
    "autoMerge" BOOLEAN NOT NULL DEFAULT true,
    "summary" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanTask" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "dependsOn" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "position" INTEGER NOT NULL,
    "threadId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "note" TEXT,

    CONSTRAINT "PlanTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Plan_status_idx" ON "Plan"("status");

-- CreateIndex
CREATE INDEX "Plan_userId_createdAt_idx" ON "Plan"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PlanTask_threadId_key" ON "PlanTask"("threadId");

-- CreateIndex
CREATE UNIQUE INDEX "PlanTask_planId_key_key" ON "PlanTask"("planId", "key");

-- AddForeignKey
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanTask" ADD CONSTRAINT "PlanTask_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

