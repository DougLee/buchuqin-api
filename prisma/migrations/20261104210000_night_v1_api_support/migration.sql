-- 楼栋夜宵店 API 支撑补列（IKSW1F）：夜主档标识 / 夜间配送费 / 订单售后状态 / 押金支付单
-- 四项均为纯增量：存量数据默认值语义与迁移前完全一致，白天业务零变化

-- 夜主档标识（白天读路径一律 nightCatalog=false 过滤；存量行默认 false 不受影响）
ALTER TABLE "Product" ADD COLUMN "nightCatalog" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "Product_nightCatalog_idx" ON "Product"("campusId", "nightCatalog");

-- 夜间配送费（null=未配置回落 deliveryFeeInstant；0=显式免费）
ALTER TABLE "Campus" ADD COLUMN "nightDeliveryFee" INTEGER;

-- 夜宵订单售后状态（null=无售后；requested 期间佣金不得转 pending）
ALTER TABLE "NightOrder" ADD COLUMN "afterSaleStatus" TEXT;

-- 押金支付单（楼长缴押微信支付意图单；回调/查单幂等键）
CREATE TABLE "NightDepositOrder" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "outTradeNo" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "targetTier" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NightDepositOrder_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "NightDepositOrder_outTradeNo_key" ON "NightDepositOrder"("outTradeNo");
CREATE INDEX "NightDepositOrder_storeId_status_idx" ON "NightDepositOrder"("storeId", "status");
ALTER TABLE "NightDepositOrder" ADD CONSTRAINT "NightDepositOrder_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "NightStore"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
