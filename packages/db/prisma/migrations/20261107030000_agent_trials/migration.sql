-- AlterTable
ALTER TABLE "Provider" ADD COLUMN     "testUpdates" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "AgentTrial" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "fromVersion" TEXT,
    "toVersion" TEXT NOT NULL,
    "launch" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "results" JSONB,
    "verdict" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentTrial_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentTrial_providerId_createdAt_idx" ON "AgentTrial"("providerId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentTrial_status_idx" ON "AgentTrial"("status");

