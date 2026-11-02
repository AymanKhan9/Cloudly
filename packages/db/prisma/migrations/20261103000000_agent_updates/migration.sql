-- AlterTable
ALTER TABLE "Provider" ADD COLUMN     "autoUpdate" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "availableLaunch" JSONB,
ADD COLUMN     "availableVersion" TEXT,
ADD COLUMN     "checkedAt" TIMESTAMP(3),
ADD COLUMN     "previousLaunch" JSONB,
ADD COLUMN     "previousVersion" TEXT,
ADD COLUMN     "skipVersion" TEXT,
ADD COLUMN     "updateNote" TEXT,
ADD COLUMN     "updateState" TEXT,
ADD COLUMN     "updatedVersionAt" TIMESTAMP(3);

