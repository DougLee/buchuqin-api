-- IKDCVO：优惠券体系扩展（异业券 + 新人注册券 + 长期有效期）
-- kind 券品种 / trigger 发放方式 / remark 优惠说明；expiresAt 可空 = 长期有效
ALTER TABLE "Coupon" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'platform';
ALTER TABLE "Coupon" ADD COLUMN "trigger" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "Coupon" ADD COLUMN "remark" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Coupon" ALTER COLUMN "expiresAt" DROP NOT NULL;
