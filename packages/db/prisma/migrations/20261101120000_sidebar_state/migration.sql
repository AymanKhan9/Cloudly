-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "Thread" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "needsInput" TEXT,
ADD COLUMN     "pinnedAt" TIMESTAMP(3),
ADD COLUMN     "seenAt" TIMESTAMP(3),
ADD COLUMN     "settledAt" TIMESTAMP(3),
ADD COLUMN     "snoozedUntil" TIMESTAMP(3);


-- Sessions that existed before count as seen, so an upgrade marks nothing unread.
UPDATE "Thread" SET "seenAt" = CURRENT_TIMESTAMP;
