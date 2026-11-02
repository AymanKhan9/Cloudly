-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "checkCommand" TEXT,
ADD COLUMN     "checkMs" INTEGER,
ADD COLUMN     "checkOutput" TEXT,
ADD COLUMN     "checkStatus" TEXT,
ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'turn';

-- CreateTable
CREATE TABLE "RepoSettings" (
    "repo" TEXT NOT NULL,
    "checks" TEXT NOT NULL DEFAULT 'auto',
    "checkCommand" TEXT,
    "fixAttempts" INTEGER NOT NULL DEFAULT 2,
    "checkTimeoutSec" INTEGER NOT NULL DEFAULT 600,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RepoSettings_pkey" PRIMARY KEY ("repo")
);

