-- CreateEnum
CREATE TYPE "StripeProductMapKind" AS ENUM ('BASE', 'SEAT', 'ADDON', 'OVERAGE', 'TOPUP');

-- CreateEnum
CREATE TYPE "TeamSubscriptionStatus" AS ENUM ('ACTIVE', 'PAST_DUE', 'CANCELED', 'INCOMPLETE', 'TRIALING', 'UNPAID');

-- CreateEnum
CREATE TYPE "LedgerAccountType" AS ENUM ('WALLET', 'ACCOUNTS_RECEIVABLE', 'REVENUE', 'COGS', 'TAX');

-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('TOPUP', 'SUBSCRIPTION_CHARGE', 'USAGE_CHARGE', 'REFUND', 'ADJUSTMENT', 'INVOICE_PAYMENT', 'COGS_ACCRUAL');

-- CreateEnum
CREATE TYPE "LedgerReferenceType" AS ENUM ('STRIPE_INVOICE', 'STRIPE_PAYMENT_INTENT', 'USAGE_EVENT', 'MANUAL');

-- CreateTable
CREATE TABLE "JtiUsage" (
    "jti" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JtiUsage_pkey" PRIMARY KEY ("jti")
);

-- CreateTable
CREATE TABLE "Plan" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Addon" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Addon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StripeProductMap" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "planId" TEXT,
    "addonId" TEXT,
    "stripeProductId" TEXT NOT NULL,
    "stripePriceId" TEXT NOT NULL,
    "kind" "StripeProductMapKind" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StripeProductMap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamSubscription" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "stripeSubscriptionId" TEXT NOT NULL,
    "status" "TeamSubscriptionStatus" NOT NULL,
    "planId" TEXT NOT NULL,
    "currentPeriodStart" TIMESTAMP(3) NOT NULL,
    "currentPeriodEnd" TIMESTAMP(3) NOT NULL,
    "seatsQuantity" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamAddon" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "addonId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamAddon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerAccount" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "billToId" TEXT NOT NULL,
    "type" "LedgerAccountType" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "billToId" TEXT NOT NULL,
    "ledgerAccountId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" "LedgerEntryType" NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "referenceType" "LedgerReferenceType" NOT NULL,
    "referenceId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JtiUsage_expiresAt_idx" ON "JtiUsage"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Plan_appId_code_key" ON "Plan"("appId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Addon_appId_code_key" ON "Addon"("appId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "StripeProductMap_appId_stripePriceId_key" ON "StripeProductMap"("appId", "stripePriceId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamSubscription_stripeSubscriptionId_key" ON "TeamSubscription"("stripeSubscriptionId");

-- CreateIndex
CREATE INDEX "TeamSubscription_teamId_idx" ON "TeamSubscription"("teamId");

-- CreateIndex
CREATE INDEX "TeamAddon_teamId_idx" ON "TeamAddon"("teamId");

-- CreateIndex
CREATE INDEX "TeamAddon_addonId_idx" ON "TeamAddon"("addonId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerAccount_appId_billToId_type_key" ON "LedgerAccount"("appId", "billToId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerEntry_idempotencyKey_key" ON "LedgerEntry"("idempotencyKey");

-- CreateIndex
CREATE INDEX "LedgerEntry_billToId_timestamp_idx" ON "LedgerEntry"("billToId", "timestamp");

-- CreateIndex
CREATE INDEX "LedgerEntry_ledgerAccountId_timestamp_idx" ON "LedgerEntry"("ledgerAccountId", "timestamp");

-- AddForeignKey
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Addon" ADD CONSTRAINT "Addon_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StripeProductMap" ADD CONSTRAINT "StripeProductMap_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StripeProductMap" ADD CONSTRAINT "StripeProductMap_addonId_fkey" FOREIGN KEY ("addonId") REFERENCES "Addon"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamSubscription" ADD CONSTRAINT "TeamSubscription_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamSubscription" ADD CONSTRAINT "TeamSubscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamAddon" ADD CONSTRAINT "TeamAddon_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamAddon" ADD CONSTRAINT "TeamAddon_addonId_fkey" FOREIGN KEY ("addonId") REFERENCES "Addon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerAccount" ADD CONSTRAINT "LedgerAccount_billToId_fkey" FOREIGN KEY ("billToId") REFERENCES "BillingEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_billToId_fkey" FOREIGN KEY ("billToId") REFERENCES "BillingEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_ledgerAccountId_fkey" FOREIGN KEY ("ledgerAccountId") REFERENCES "LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
