-- CreateTable
CREATE TABLE "SandboxImage" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "scriptHash" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'ready',
    "log" TEXT NOT NULL DEFAULT '',
    "image" TEXT NOT NULL DEFAULT 'cloud-agents-base',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SandboxImage_pkey" PRIMARY KEY ("id")
);
