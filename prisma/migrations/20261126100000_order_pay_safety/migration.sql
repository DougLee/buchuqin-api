-- IKY6QE（道哥 2026-11-26）：下单锁定库存 + 支付落账不可失败
-- 幂等：可重复执行——生产可先手工应用，容器启动时 migrate deploy 再跑一次不报错。
-- wxTransactionId：微信支付交易单号（落账/晚到支付均记录）
-- stockLocked：下单时是否已持有库存锁（区分功能上线前的存量待支付单）
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "wxTransactionId" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "stockLocked" BOOLEAN NOT NULL DEFAULT false;
