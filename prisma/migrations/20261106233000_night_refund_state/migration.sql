-- Preserve order/stock/coupon history; do not infer old gateway success from order status.
CREATE TABLE "NightRefund" (
  "id" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "storeId" TEXT NOT NULL,
  "outRefundNo" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'requested',
  "originalStatus" TEXT NOT NULL,
  "originalAfterSaleStatus" TEXT,
  "productAmount" INTEGER NOT NULL,
  "deliveryFeeAmount" INTEGER NOT NULL,
  "totalAmount" INTEGER NOT NULL,
  "restock" BOOLEAN NOT NULL DEFAULT true,
  "fullProductRefund" BOOLEAN NOT NULL DEFAULT false,
  "heldValue" INTEGER NOT NULL DEFAULT 0,
  "reason" TEXT NOT NULL,
  "operatorId" TEXT NOT NULL,
  "gatewayRefundId" TEXT,
  "errorMessage" TEXT NOT NULL DEFAULT '',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "leaseUntil" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NightRefund_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NightRefund_amounts_check" CHECK ("productAmount" >= 0 AND "deliveryFeeAmount" >= 0 AND "totalAmount" >= 0 AND "totalAmount" = "productAmount" + "deliveryFeeAmount" AND "heldValue" >= 0)
);
CREATE UNIQUE INDEX "NightRefund_orderId_key" ON "NightRefund"("orderId");
CREATE UNIQUE INDEX "NightRefund_outRefundNo_key" ON "NightRefund"("outRefundNo");
CREATE INDEX "NightRefund_status_leaseUntil_idx" ON "NightRefund"("status", "leaseUntil");
CREATE INDEX "NightRefund_storeId_createdAt_idx" ON "NightRefund"("storeId", "createdAt");
ALTER TABLE "NightRefund" ADD CONSTRAINT "NightRefund_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "NightOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NightRefund" ADD CONSTRAINT "NightRefund_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "NightStore"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
