CREATE TABLE "NightDepositRefund" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "storeId" TEXT NOT NULL REFERENCES "NightStore"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "requestId" VARCHAR(80) NOT NULL,
  "payOrderNo" TEXT NOT NULL,
  "outRefundNo" TEXT NOT NULL UNIQUE,
  "originalAmount" INTEGER NOT NULL,
  "amount" INTEGER NOT NULL,
  "payMerchantId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'requested',
  "operatorId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "errorMessage" TEXT NOT NULL DEFAULT '',
  "gatewayRefundId" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "leaseUntil" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NightDepositRefund_amount_check" CHECK ("amount" > 0 AND "amount" <= "originalAmount")
);
CREATE UNIQUE INDEX "NightDepositRefund_storeId_requestId_payOrderNo_key" ON "NightDepositRefund"("storeId", "requestId", "payOrderNo");
CREATE INDEX "NightDepositRefund_storeId_createdAt_idx" ON "NightDepositRefund"("storeId", "createdAt");
CREATE INDEX "NightDepositRefund_status_leaseUntil_idx" ON "NightDepositRefund"("status", "leaseUntil");
UPDATE "AdminMenu" SET "perms" = 'POST /admin/night/stores/:id/deposit/deduct,POST /admin/night/stores/:id/deposit/refund,GET /admin/night/stores/:id/deposit-refunds,POST /admin/night/stores/:id/deposit/refunds/:requestId/sync', "updatedAt" = CURRENT_TIMESTAMP WHERE "code" = 'night-deposit';
UPDATE "RbacState" SET version = version + 1 WHERE id = 'global';
UPDATE "AdminMenu" SET perms = concat_ws(',', perms, 'GET /admin/night/stores/:id/deposit-txns'), "updatedAt" = CURRENT_TIMESTAMP WHERE code = 'night-stores' AND position('GET /admin/night/stores/:id/deposit-txns' in perms) = 0;
