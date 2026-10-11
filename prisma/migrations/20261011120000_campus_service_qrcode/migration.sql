-- IKKTWM 校区客服微信二维码：默认空串=未配置（回落拨号）
ALTER TABLE "Campus" ADD COLUMN IF NOT EXISTS "serviceQrcode" TEXT NOT NULL DEFAULT '';
