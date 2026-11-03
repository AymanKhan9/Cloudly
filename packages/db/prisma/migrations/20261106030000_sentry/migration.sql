-- CreateTable
CREATE TABLE "SentryProject" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "harness" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "perDay" INTEGER NOT NULL DEFAULT 5,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SentryProject_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SentryProject_slug_key" ON "SentryProject"("slug");

-- AddForeignKey
ALTER TABLE "SentryProject" ADD CONSTRAINT "SentryProject_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

