-- AlterTable
ALTER TABLE "UsageEvent" ADD COLUMN     "nextRetryAt" TIMESTAMP(3),
ADD COLUMN     "retryCount" INTEGER NOT NULL DEFAULT 0;
