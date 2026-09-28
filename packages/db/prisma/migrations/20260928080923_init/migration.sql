-- CreateEnum
CREATE TYPE "RunStatusEnum" AS ENUM ('queued', 'running', 'finalizing', 'succeeded', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "RunEventEnum" AS ENUM ('status', 'text', 'tool_call', 'tool_result', 'raw', 'error', 'done');

-- CreateTable
CREATE TABLE "Run" (
    "id" TEXT NOT NULL,
    "status" "RunStatusEnum" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMP(3),
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "costUsd" DECIMAL(65,30) DEFAULT 0,
    "repo" TEXT NOT NULL,
    "baseBranch" TEXT NOT NULL,
    "branch" TEXT,
    "prompt" TEXT NOT NULL,
    "harness" TEXT NOT NULL,
    "workerId" TEXT,
    "sessionId" TEXT,
    "prUrl" TEXT,
    "error" TEXT,

    CONSTRAINT "Run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunEvent" (
    "runId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" "RunEventEnum" NOT NULL,
    "data" JSONB,

    CONSTRAINT "RunEvent_pkey" PRIMARY KEY ("runId","seq")
);

-- CreateIndex
CREATE INDEX "Run_status_createdAt_idx" ON "Run"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "RunEvent" ADD CONSTRAINT "RunEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;
