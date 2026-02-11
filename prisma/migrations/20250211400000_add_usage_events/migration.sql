-- CreateTable
CREATE TABLE "UsageEvent" (
    "id" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "billToId" TEXT NOT NULL,
    "userId" TEXT,
    "eventType" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UsageEvent_appId_idempotencyKey_key" ON "UsageEvent"("appId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "UsageEvent_appId_teamId_timestamp_idx" ON "UsageEvent"("appId", "teamId", "timestamp");

-- CreateIndex
CREATE INDEX "UsageEvent_billToId_timestamp_idx" ON "UsageEvent"("billToId", "timestamp");

-- AddForeignKey
ALTER TABLE "UsageEvent" ADD CONSTRAINT "UsageEvent_billToId_fkey" FOREIGN KEY ("billToId") REFERENCES "BillingEntity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
