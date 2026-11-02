-- AlterTable
ALTER TABLE "RepoSettings" ADD COLUMN     "ciFixAttempts" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "fixCi" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "issueLabel" TEXT NOT NULL DEFAULT 'cloudly',
ADD COLUMN     "onIssueLabel" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "onMention" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "onPrReview" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "triggerHarness" TEXT;

-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "trigger" JSONB,
ADD COLUMN     "triggerKey" TEXT;

-- AlterTable
ALTER TABLE "Thread" ADD COLUMN     "issueNumber" INTEGER;

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "action" TEXT,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_receivedAt_idx" ON "WebhookDelivery"("status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Run_triggerKey_key" ON "Run"("triggerKey");

-- CreateIndex
CREATE INDEX "Thread_repo_issueNumber_idx" ON "Thread"("repo", "issueNumber");

-- CreateIndex
CREATE INDEX "Thread_repo_branch_idx" ON "Thread"("repo", "branch");

