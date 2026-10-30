-- IKRSIX #112：楼长提成模式（per-order|rate）+ 万分比比例；IKRSIX #97：手动采购记录台账
-- （只含本 issue 变更；工作区其他未提交字段的 DDL 归各自迁移，勿并入）
ALTER TABLE "Campus" ADD COLUMN     "managerCommissionMode" TEXT NOT NULL DEFAULT 'per-order',
ADD COLUMN     "managerCommissionRate" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "PurchaseRecord" (
    "id" TEXT NOT NULL,
    "campusId" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "price" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "purchasedAt" TIMESTAMP(3) NOT NULL,
    "remark" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PurchaseRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PurchaseRecord_campusId_purchasedAt_idx" ON "PurchaseRecord"("campusId", "purchasedAt");

-- AddForeignKey
ALTER TABLE "PurchaseRecord" ADD CONSTRAINT "PurchaseRecord_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
