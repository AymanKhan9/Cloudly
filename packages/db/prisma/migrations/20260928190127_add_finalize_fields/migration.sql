-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "baseSha" TEXT,
ADD COLUMN     "commitSha" TEXT,
ADD COLUMN     "leaseGen" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "patchHash" TEXT;
