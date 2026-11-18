-- 楼栋夜宵店（IKSW1F 道哥 2026-11-04 定稿）：7 张新表 + 现有表加列
-- 业务基线：押金=进货额度（库存×售价≤押金）；与白天业务完全隔离

-- ===== 现有表加列 =====
ALTER TABLE "Campus" ADD COLUMN "nightEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Campus" ADD COLUMN "nightStartAt" TEXT;
ALTER TABLE "Campus" ADD COLUMN "nightEndAt" TEXT;
ALTER TABLE "Campus" ADD COLUMN "nightPayTimeout" INTEGER;
ALTER TABLE "Campus" ADD COLUMN "nightAcceptTimeout" INTEGER;
ALTER TABLE "Coupon" ADD COLUMN "businessType" TEXT NOT NULL DEFAULT 'day';

-- ===== 1. NightStore 夜宵店 =====
CREATE TABLE "NightStore" (
    "id" TEXT NOT NULL,
    "campusId" TEXT NOT NULL,
    "buildingId" TEXT NOT NULL,
    "managerStaffId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'closed',
    "deposit" INTEGER NOT NULL DEFAULT 0,
    "commissionRate" INTEGER NOT NULL DEFAULT 0,
    "openedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "NightStore_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "NightStore_buildingId_key" ON "NightStore"("buildingId");
CREATE INDEX "NightStore_campusId_idx" ON "NightStore"("campusId");
ALTER TABLE "NightStore" ADD CONSTRAINT "NightStore_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NightStore" ADD CONSTRAINT "NightStore_buildingId_fkey" FOREIGN KEY ("buildingId") REFERENCES "Building"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NightStore" ADD CONSTRAINT "NightStore_managerStaffId_fkey" FOREIGN KEY ("managerStaffId") REFERENCES "Staff"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ===== 2. NightProduct 夜宵商品楼栋行 =====
CREATE TABLE "NightProduct" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "catalogProductId" TEXT NOT NULL,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "onShelf" BOOLEAN NOT NULL DEFAULT true,
    "saleAllowed" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "NightProduct_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "NightProduct_storeId_catalogProductId_key" ON "NightProduct"("storeId", "catalogProductId");
CREATE INDEX "NightProduct_storeId_idx" ON "NightProduct"("storeId");
ALTER TABLE "NightProduct" ADD CONSTRAINT "NightProduct_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "NightStore"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NightProduct" ADD CONSTRAINT "NightProduct_catalogProductId_fkey" FOREIGN KEY ("catalogProductId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== 3. NightDepositTxn 押金流水 =====
CREATE TABLE "NightDepositTxn" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "payOrderNo" TEXT,
    "operatorId" TEXT,
    "remark" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NightDepositTxn_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "NightDepositTxn_storeId_createdAt_idx" ON "NightDepositTxn"("storeId", "createdAt");
ALTER TABLE "NightDepositTxn" ADD CONSTRAINT "NightDepositTxn_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "NightStore"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== 4. NightOrder 夜宵订单 =====
CREATE TABLE "NightOrder" (
    "id" TEXT NOT NULL,
    "orderNo" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "managerStaffId" TEXT,
    "userId" TEXT NOT NULL,
    "businessDate" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "statusText" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "productAmount" INTEGER NOT NULL,
    "couponDiscount" INTEGER NOT NULL DEFAULT 0,
    "deliveryFee" INTEGER NOT NULL DEFAULT 0,
    "payableAmount" INTEGER NOT NULL,
    "couponId" TEXT,
    "couponSnapshot" JSONB,
    "commissionRate" INTEGER NOT NULL,
    "address" JSONB NOT NULL,
    "remark" TEXT NOT NULL DEFAULT '',
    "timeline" JSONB NOT NULL,
    "timeoutAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "NightOrder_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "NightOrder_orderNo_key" ON "NightOrder"("orderNo");
CREATE INDEX "NightOrder_storeId_status_idx" ON "NightOrder"("storeId", "status");
CREATE INDEX "NightOrder_managerStaffId_status_idx" ON "NightOrder"("managerStaffId", "status");
CREATE INDEX "NightOrder_businessDate_idx" ON "NightOrder"("businessDate");
CREATE INDEX "NightOrder_userId_status_idx" ON "NightOrder"("userId", "status");
ALTER TABLE "NightOrder" ADD CONSTRAINT "NightOrder_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "NightStore"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NightOrder" ADD CONSTRAINT "NightOrder_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== 5. NightCommissionTxn 佣金流水 =====
CREATE TABLE "NightCommissionTxn" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "managerStaffId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "base" INTEGER,
    "rate" INTEGER,
    "amount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'estimated',
    "settleBatch" TEXT,
    "remark" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NightCommissionTxn_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "NightCommissionTxn_managerStaffId_status_idx" ON "NightCommissionTxn"("managerStaffId", "status");
CREATE INDEX "NightCommissionTxn_storeId_status_idx" ON "NightCommissionTxn"("storeId", "status");
CREATE INDEX "NightCommissionTxn_settleBatch_idx" ON "NightCommissionTxn"("settleBatch");
ALTER TABLE "NightCommissionTxn" ADD CONSTRAINT "NightCommissionTxn_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "NightOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NightCommissionTxn" ADD CONSTRAINT "NightCommissionTxn_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "NightStore"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== 6. NightStockOrder 备货订单 =====
CREATE TABLE "NightStockOrder" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "managerStaffId" TEXT NOT NULL,
    "items" JSONB NOT NULL,
    "totalValue" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NightStockOrder_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "NightStockOrder_storeId_createdAt_idx" ON "NightStockOrder"("storeId", "createdAt");
ALTER TABLE "NightStockOrder" ADD CONSTRAINT "NightStockOrder_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "NightStore"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ===== 7. NightStockTxn 库存流水 =====
CREATE TABLE "NightStockTxn" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "nightProductId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "delta" INTEGER NOT NULL,
    "afterStock" INTEGER NOT NULL,
    "refType" TEXT,
    "refId" TEXT,
    "operatorId" TEXT,
    "remark" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NightStockTxn_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "NightStockTxn_nightProductId_createdAt_idx" ON "NightStockTxn"("nightProductId", "createdAt");
CREATE INDEX "NightStockTxn_storeId_createdAt_idx" ON "NightStockTxn"("storeId", "createdAt");
ALTER TABLE "NightStockTxn" ADD CONSTRAINT "NightStockTxn_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "NightStore"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "NightStockTxn" ADD CONSTRAINT "NightStockTxn_nightProductId_fkey" FOREIGN KEY ("nightProductId") REFERENCES "NightProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
