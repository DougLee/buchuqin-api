ALTER TABLE "Refund" ADD COLUMN "refundedAt" TIMESTAMP(3);

UPDATE "Refund"
SET "refundedAt" = "updatedAt"
WHERE "status" = 'refunded' AND "refundedAt" IS NULL;

CREATE INDEX "Refund_status_refundedAt_idx" ON "Refund"("status", "refundedAt");
