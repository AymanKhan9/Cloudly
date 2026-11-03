-- AlterTable
ALTER TABLE "RepoSettings" ADD COLUMN     "screenshotCommand" TEXT,
ADD COLUMN     "screenshotPaths" TEXT[] DEFAULT ARRAY['/']::TEXT[],
ADD COLUMN     "screenshotPort" INTEGER NOT NULL DEFAULT 3000,
ADD COLUMN     "screenshots" BOOLEAN NOT NULL DEFAULT false;

