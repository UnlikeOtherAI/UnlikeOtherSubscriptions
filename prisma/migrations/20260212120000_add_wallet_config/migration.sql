-- CreateTable
CREATE TABLE "WalletConfig" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "autoTopUpEnabled" BOOLEAN NOT NULL DEFAULT false,
    "thresholdMinor" INTEGER NOT NULL DEFAULT 0,
    "topUpAmountMinor" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'usd',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WalletConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WalletConfig_teamId_appId_key" ON "WalletConfig"("teamId", "appId");

-- AddForeignKey
ALTER TABLE "WalletConfig" ADD CONSTRAINT "WalletConfig_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
