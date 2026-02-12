-- CreateEnum
CREATE TYPE "PriceBookKind" AS ENUM ('COGS', 'CUSTOMER');

-- CreateTable
CREATE TABLE "PriceBook" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "kind" "PriceBookKind" NOT NULL,
    "currency" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceBook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceRule" (
    "id" TEXT NOT NULL,
    "priceBookId" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "match" JSONB NOT NULL,
    "rule" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillableLineItem" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "billToId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT,
    "usageEventId" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "priceBookId" TEXT NOT NULL,
    "priceRuleId" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "inputsSnapshot" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillableLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PriceBook_appId_kind_idx" ON "PriceBook"("appId", "kind");

-- CreateIndex
CREATE INDEX "PriceBook_appId_effectiveFrom_idx" ON "PriceBook"("appId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "PriceRule_priceBookId_priority_idx" ON "PriceRule"("priceBookId", "priority");

-- CreateIndex
CREATE INDEX "BillableLineItem_appId_teamId_timestamp_idx" ON "BillableLineItem"("appId", "teamId", "timestamp");

-- CreateIndex
CREATE INDEX "BillableLineItem_billToId_timestamp_idx" ON "BillableLineItem"("billToId", "timestamp");

-- AddForeignKey
ALTER TABLE "PriceBook" ADD CONSTRAINT "PriceBook_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceRule" ADD CONSTRAINT "PriceRule_priceBookId_fkey" FOREIGN KEY ("priceBookId") REFERENCES "PriceBook"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillableLineItem" ADD CONSTRAINT "BillableLineItem_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillableLineItem" ADD CONSTRAINT "BillableLineItem_billToId_fkey" FOREIGN KEY ("billToId") REFERENCES "BillingEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillableLineItem" ADD CONSTRAINT "BillableLineItem_priceBookId_fkey" FOREIGN KEY ("priceBookId") REFERENCES "PriceBook"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillableLineItem" ADD CONSTRAINT "BillableLineItem_priceRuleId_fkey" FOREIGN KEY ("priceRuleId") REFERENCES "PriceRule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
