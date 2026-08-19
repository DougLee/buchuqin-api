-- IK9SO6 配送费后台可配置 + IK9U40 商品库位 + IK9SNS 商品多图 + IK9SNN Banner 图文
ALTER TABLE "Campus" ADD COLUMN "deliveryFeeInstant" INTEGER NOT NULL DEFAULT 400;
ALTER TABLE "Campus" ADD COLUMN "deliveryFeeScheduled" INTEGER NOT NULL DEFAULT 200;
ALTER TABLE "Campus" ADD COLUMN "deliveryThreshold" INTEGER NOT NULL DEFAULT 1000;
ALTER TABLE "Product" ADD COLUMN "images" JSONB;
ALTER TABLE "Product" ADD COLUMN "location" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Banner" ADD COLUMN "content" TEXT;
-- IK9U4B 请假期间订单调配方式
ALTER TABLE "LeaveRequest" ADD COLUMN "dispatchMode" TEXT NOT NULL DEFAULT 'platform';
