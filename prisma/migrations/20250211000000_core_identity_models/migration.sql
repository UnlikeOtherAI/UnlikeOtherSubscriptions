-- CreateEnum
CREATE TYPE "TeamKind" AS ENUM ('PERSONAL', 'STANDARD', 'ENTERPRISE');

-- CreateEnum
CREATE TYPE "BillingMode" AS ENUM ('SUBSCRIPTION', 'WALLET', 'HYBRID', 'ENTERPRISE_CONTRACT');

-- CreateEnum
CREATE TYPE "TeamMemberRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "TeamMemberStatus" AS ENUM ('ACTIVE', 'REMOVED');

-- CreateEnum
CREATE TYPE "BillingEntityType" AS ENUM ('TEAM', 'ORG');

-- CreateEnum
CREATE TYPE "AppSecretStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateTable
CREATE TABLE "App" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "App_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "TeamKind" NOT NULL,
    "ownerUserId" TEXT,
    "defaultCurrency" TEXT NOT NULL DEFAULT 'USD',
    "stripeCustomerId" TEXT,
    "billingMode" "BillingMode" NOT NULL DEFAULT 'SUBSCRIPTION',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "externalRef" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamMember" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "TeamMemberRole" NOT NULL DEFAULT 'MEMBER',
    "status" "TeamMemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "TeamMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingEntity" (
    "id" TEXT NOT NULL,
    "type" "BillingEntityType" NOT NULL DEFAULT 'TEAM',
    "teamId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingEntity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalTeamRef" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "externalTeamId" TEXT NOT NULL,
    "billingTeamId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalTeamRef_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSecret" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "kid" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "status" "AppSecretStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "AppSecret_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Team_ownerUserId_idx" ON "Team"("ownerUserId");

-- CreateIndex: Unique partial index — one Personal Team per user
CREATE UNIQUE INDEX "Team_ownerUserId_personal_unique" ON "Team"("ownerUserId") WHERE "kind" = 'PERSONAL';

-- CreateIndex
CREATE UNIQUE INDEX "User_appId_externalRef_key" ON "User"("appId", "externalRef");

-- CreateIndex
CREATE INDEX "User_appId_email_idx" ON "User"("appId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "TeamMember_teamId_userId_key" ON "TeamMember"("teamId", "userId");

-- CreateIndex
CREATE INDEX "TeamMember_teamId_status_idx" ON "TeamMember"("teamId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BillingEntity_teamId_key" ON "BillingEntity"("teamId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalTeamRef_appId_externalTeamId_key" ON "ExternalTeamRef"("appId", "externalTeamId");

-- CreateIndex
CREATE INDEX "ExternalTeamRef_billingTeamId_idx" ON "ExternalTeamRef"("billingTeamId");

-- CreateIndex
CREATE UNIQUE INDEX "AppSecret_kid_key" ON "AppSecret"("kid");

-- CreateIndex
CREATE INDEX "AppSecret_appId_status_idx" ON "AppSecret"("appId", "status");

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingEntity" ADD CONSTRAINT "BillingEntity_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalTeamRef" ADD CONSTRAINT "ExternalTeamRef_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalTeamRef" ADD CONSTRAINT "ExternalTeamRef_billingTeamId_fkey" FOREIGN KEY ("billingTeamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppSecret" ADD CONSTRAINT "AppSecret_appId_fkey" FOREIGN KEY ("appId") REFERENCES "App"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
