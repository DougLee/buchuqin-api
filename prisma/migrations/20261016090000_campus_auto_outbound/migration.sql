-- 订单自动出库（IKM55A）：校区级开关+延迟秒数
ALTER TABLE "Campus" ADD COLUMN     "autoOutboundDelaySeconds" INTEGER NOT NULL DEFAULT 60,
ADD COLUMN     "autoOutboundEnabled" BOOLEAN NOT NULL DEFAULT false;
