-- AlterTable
ALTER TABLE "BillableLineItem" ADD COLUMN     "walletDebitedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "BillableLineItem_teamId_walletDebitedAt_idx" ON "BillableLineItem"("teamId", "walletDebitedAt");
