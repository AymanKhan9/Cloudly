-- CreateTable
CREATE TABLE "SessionImport" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sessionId" TEXT,
    "cwd" TEXT,
    "fileName" TEXT,
    "file" TEXT,
    "summary" TEXT,
    "startFrom" TEXT,
    "turns" INTEGER NOT NULL,
    "dropped" INTEGER NOT NULL DEFAULT 0,
    "resumed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SessionImport_threadId_key" ON "SessionImport"("threadId");

-- AddForeignKey
ALTER TABLE "SessionImport" ADD CONSTRAINT "SessionImport_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

