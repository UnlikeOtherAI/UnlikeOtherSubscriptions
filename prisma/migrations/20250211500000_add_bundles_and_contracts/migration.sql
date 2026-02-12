-- CreateEnum
CREATE TYPE "MeterLimitType" AS ENUM ('NONE', 'INCLUDED', 'UNLIMITED', 'HARD_CAP');

-- CreateEnum
CREATE TYPE "MeterEnforcement" AS ENUM ('NONE', 'SOFT', 'HARD');

-- CreateEnum
CREATE TYPE "OverageBilling" AS ENUM ('NONE', 'PER_UNIT', 'TIERED', 'CUSTOM');

-- CreateEnum
CREATE TYPE "ContractStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ENDED');

-- CreateEnum
CREATE TYPE "BillingPeriod" AS ENUM ('MONTHLY', 'QUARTERLY');

-- CreateEnum
CREATE TYPE "PricingMode" AS ENUM ('FIXED', 'FIXED_PLUS_TRUEUP', 'MIN_COMMIT_TRUEUP', 'CUSTOM_INVOICE_ONLY');

-- CreateEnum
CREATE TYPE "ContractRateCardKind" AS ENUM ('CUSTOMER', 'COGS');

-- CreateTable
CREATE TABLE "Bundle" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bundle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BundleApp" (
    "id" TEXT NOT NULL,
    "bundleId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "defaultFeatureFlags" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BundleApp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BundleMeterPolicy" (
    "id" TEXT NOT NULL,
    "bundleId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "meterKey" TEXT NOT NULL,
    "limitType" "MeterLimitType" NOT NULL,
    "includedAmount" INTEGER,
    "enforcement" "MeterEnforcement" NOT NULL DEFAULT 'NONE',
    "overageBilling" "OverageBilling" NOT NULL DEFAULT 'NONE',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BundleMeterPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contract" (
    "id" TEXT NOT NULL,
    "billToId" TEXT NOT NULL,
    "status" "ContractStatus" NOT NULL DEFAULT 'DRAFT',
    "bundleId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "billingPeriod" "BillingPeriod" NOT NULL,
    "termsDays" INTEGER NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "pricingMode" "PricingMode" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractOverride" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "meterKey" TEXT NOT NULL,
    "limitType" "MeterLimitType",
    "includedAmount" INTEGER,
    "overageBilling" "OverageBilling",
    "enforcement" "MeterEnforcement",
    "featureFlags" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContractOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractRateCard" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "kind" "ContractRateCardKind" NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContractRateCard_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Bundle_code_key" ON "Bundle"("code");

-- CreateIndex
CREATE UNIQUE INDEX "BundleApp_bundleId_appId_key" ON "BundleApp"("bundleId", "appId");

-- CreateIndex
CREATE UNIQUE INDEX "BundleMeterPolicy_bundleId_appId_meterKey_key" ON "BundleMeterPolicy"("bundleId", "appId", "meterKey");

-- CreateIndex
CREATE INDEX "Contract_billToId_idx" ON "Contract"("billToId");

-- CreateIndex
CREATE INDEX "Contract_bundleId_idx" ON "Contract"("bundleId");

-- CreateIndex: Unique partial index — at most one ACTIVE contract per billing entity
CREATE UNIQUE INDEX "Contract_billToId_active_unique" ON "Contract"("billToId") WHERE "status" = 'ACTIVE';

-- CreateIndex
CREATE UNIQUE INDEX "ContractOverride_contractId_appId_meterKey_key" ON "ContractOverride"("contractId", "appId", "meterKey");

-- CreateIndex
CREATE INDEX "ContractRateCard_contractId_idx" ON "ContractRateCard"("contractId");

-- AddForeignKey
ALTER TABLE "BundleApp" ADD CONSTRAINT "BundleApp_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "Bundle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BundleApp" ADD CONSTRAINT "BundleApp_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BundleMeterPolicy" ADD CONSTRAINT "BundleMeterPolicy_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "Bundle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BundleMeterPolicy" ADD CONSTRAINT "BundleMeterPolicy_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_billToId_fkey" FOREIGN KEY ("billToId") REFERENCES "BillingEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "Bundle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractOverride" ADD CONSTRAINT "ContractOverride_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractOverride" ADD CONSTRAINT "ContractOverride_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractRateCard" ADD CONSTRAINT "ContractRateCard_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
