-- AlterTable
ALTER TABLE "RepoSettings" ADD COLUMN     "autoLessons" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Lesson" (
    "id" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "rule" TEXT NOT NULL,
    "why" TEXT NOT NULL DEFAULT '',
    "evidence" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'proposed',
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Lesson_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Lesson_repo_status_idx" ON "Lesson"("repo", "status");

