-- CreateTable
CREATE TABLE "Budget" (
    "userId" TEXT NOT NULL,
    "monthlyLimitUsd" DECIMAL(65,30) NOT NULL DEFAULT 10,
    "alertEmail" TEXT,
    "warnedMonth" TEXT,
    "stoppedMonth" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Budget_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "Budget" ADD CONSTRAINT "Budget_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
