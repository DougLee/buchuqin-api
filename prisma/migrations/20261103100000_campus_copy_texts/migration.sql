-- IKSN20（道哥 2026-11-03）：结算页预约达营销文案 + 商品详情页「配送到寝」
-- 说明三段，校区级可配；空=回落前端默认文案
ALTER TABLE "Campus" ADD COLUMN "scheduledGiftText" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Campus" ADD COLUMN "deliveryStoryTitle" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Campus" ADD COLUMN "deliveryStoryMain" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Campus" ADD COLUMN "deliveryStoryDesc" TEXT NOT NULL DEFAULT '';
