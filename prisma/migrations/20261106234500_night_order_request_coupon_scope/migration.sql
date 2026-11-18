ALTER TABLE "NightOrder" ADD COLUMN "requestId" VARCHAR(80), ADD COLUMN "requestHash" TEXT;
CREATE UNIQUE INDEX "NightOrder_userId_requestId_key" ON "NightOrder"("userId", "requestId");
ALTER TABLE "Coupon" ADD COLUMN "nightProductIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "NightOrder" ADD COLUMN "payMerchantId" TEXT, ADD COLUMN "payAppId" TEXT, ADD COLUMN "wxTransactionId" TEXT;
ALTER TABLE "NightDepositOrder" ADD COLUMN "payMerchantId" TEXT, ADD COLUMN "payAppId" TEXT, ADD COLUMN "wxTransactionId" TEXT;

-- Existing night-refund operators gain reconciliation/review within the same capability.
WITH changed AS (
  UPDATE "AdminMenu" SET perms = concat_ws(',', perms,
    CASE WHEN position('POST /admin/night/orders/:id/refund/sync' in perms) = 0 THEN 'POST /admin/night/orders/:id/refund/sync' END,
    CASE WHEN position('POST /admin/night/orders/:id/after-sale/reject' in perms) = 0 THEN 'POST /admin/night/orders/:id/after-sale/reject' END), "updatedAt" = CURRENT_TIMESTAMP
  WHERE code = 'night-orders.refund' AND (position('POST /admin/night/orders/:id/refund/sync' in perms) = 0 OR position('POST /admin/night/orders/:id/after-sale/reject' in perms) = 0)
  RETURNING id
)
UPDATE "RbacState" SET version = version + 1 WHERE id = 'global' AND EXISTS (SELECT 1 FROM changed);
