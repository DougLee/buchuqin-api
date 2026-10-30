-- IKRQR7 转单留痕：骑手转单记录（转单即释放回池的唯一痕迹）
CREATE TABLE "TransferLog" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "fromStatus" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransferLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TransferLog_orderId_idx" ON "TransferLog"("orderId");
CREATE INDEX "TransferLog_staffId_createdAt_idx" ON "TransferLog"("staffId", "createdAt");

ALTER TABLE "TransferLog" ADD CONSTRAINT "TransferLog_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TransferLog" ADD CONSTRAINT "TransferLog_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
