-- AlterTable
ALTER TABLE "Thread" ADD COLUMN     "discordChannelId" TEXT,
ADD COLUMN     "discordThreadId" TEXT,
ADD COLUMN     "discordToken" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "discordUserId" TEXT;

-- CreateTable
CREATE TABLE "DiscordLinkCode" (
    "code" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscordLinkCode_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "DiscordChannel" (
    "channelId" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "baseBranch" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscordChannel_pkey" PRIMARY KEY ("channelId")
);

-- CreateTable
CREATE TABLE "NotifySettings" (
    "userId" TEXT NOT NULL,
    "discordDm" BOOLEAN NOT NULL DEFAULT true,
    "discordWebhookUrl" TEXT,
    "slackWebhookUrl" TEXT,
    "onNeedsYou" BOOLEAN NOT NULL DEFAULT true,
    "onDone" BOOLEAN NOT NULL DEFAULT true,
    "onFailed" BOOLEAN NOT NULL DEFAULT true,
    "onMerged" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "NotifySettings_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "threadId" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "url" TEXT,
    "key" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Notification_key_key" ON "Notification"("key");

-- CreateIndex
CREATE INDEX "Notification_sentAt_createdAt_idx" ON "Notification"("sentAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_discordUserId_key" ON "User"("discordUserId");

-- AddForeignKey
ALTER TABLE "NotifySettings" ADD CONSTRAINT "NotifySettings_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "sentTo" TEXT[] DEFAULT ARRAY[]::TEXT[];
