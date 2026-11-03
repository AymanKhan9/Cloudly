-- CreateTable
CREATE TABLE "SessionHandoff" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "harness" TEXT NOT NULL,
    "sessionId" TEXT,
    "fileName" TEXT,
    "file" TEXT,
    "transcript" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SessionHandoff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SessionHandoff_status_createdAt_idx" ON "SessionHandoff"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "SessionHandoff" ADD CONSTRAINT "SessionHandoff_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

