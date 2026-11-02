-- AlterTable
ALTER TABLE "DiscordLinkCode" ADD COLUMN     "provider" TEXT NOT NULL DEFAULT 'discord';

-- AlterTable
ALTER TABLE "NotifySettings" ADD COLUMN     "slackDm" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "Thread" ADD COLUMN     "slackChannelId" TEXT,
ADD COLUMN     "slackThreadTs" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "slackUserId" TEXT;

-- CreateTable
CREATE TABLE "SlackChannel" (
    "channelId" TEXT NOT NULL,
    "repo" TEXT NOT NULL,
    "baseBranch" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SlackChannel_pkey" PRIMARY KEY ("channelId")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_slackUserId_key" ON "User"("slackUserId");

