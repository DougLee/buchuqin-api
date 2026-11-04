-- 道哥 2026-11-04：小票二维码打印开关——关=不打票尾二维码及文案行
-- 存量校区默认 true 行为不变
ALTER TABLE "Campus" ADD COLUMN "receiptShowQrcode" BOOLEAN NOT NULL DEFAULT true;
