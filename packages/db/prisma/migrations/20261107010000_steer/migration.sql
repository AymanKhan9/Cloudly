-- CreateTable
CREATE TABLE "RunSteer" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunSteer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RunSteer_runId_status_idx" ON "RunSteer"("runId", "status");

-- AddForeignKey
ALTER TABLE "RunSteer" ADD CONSTRAINT "RunSteer_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

