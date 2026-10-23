-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "additions" INTEGER,
ADD COLUMN     "deletions" INTEGER,
ADD COLUMN     "desktopPassword" TEXT,
ADD COLUMN     "filesChanged" INTEGER;

-- AlterTable
ALTER TABLE "Thread" ADD COLUMN     "arenaId" TEXT,
ADD COLUMN     "autoPr" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "desktop" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Arena" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "baseBranch" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "winnerThreadId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Arena_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpServer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "auth" TEXT NOT NULL DEFAULT 'oauth',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'needs_auth',
    "error" TEXT,
    "secret" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "McpServer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnvSecret" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "repo" TEXT NOT NULL DEFAULT '*',
    "value" TEXT NOT NULL,
    "hosts" TEXT NOT NULL DEFAULT '',
    "exposed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnvSecret_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepoFile" (
    "repo" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "content" BYTEA NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RepoFile_pkey" PRIMARY KEY ("repo","path")
);

-- CreateTable
CREATE TABLE "Preview" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'requested',
    "command" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "desktop" BOOLEAN NOT NULL DEFAULT false,
    "workerId" TEXT,
    "error" TEXT,
    "log" TEXT NOT NULL DEFAULT '',
    "vncPassword" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Preview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Arena_userId_createdAt_idx" ON "Arena"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "McpServer_name_key" ON "McpServer"("name");

-- CreateIndex
CREATE UNIQUE INDEX "EnvSecret_repo_name_key" ON "EnvSecret"("repo", "name");

-- CreateIndex
CREATE INDEX "Preview_status_createdAt_idx" ON "Preview"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Preview_threadId_createdAt_idx" ON "Preview"("threadId", "createdAt");

-- CreateIndex
CREATE INDEX "Thread_arenaId_idx" ON "Thread"("arenaId");

-- AddForeignKey
ALTER TABLE "Thread" ADD CONSTRAINT "Thread_arenaId_fkey" FOREIGN KEY ("arenaId") REFERENCES "Arena"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Arena" ADD CONSTRAINT "Arena_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Preview" ADD CONSTRAINT "Preview_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Preview" ADD CONSTRAINT "Preview_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
