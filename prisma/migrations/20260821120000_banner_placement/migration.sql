-- IKA57F：Banner 增加展示位置（home 首页轮播 / pay-success 支付成功页广告位）
ALTER TABLE "Banner" ADD COLUMN "placement" TEXT NOT NULL DEFAULT 'home';
