-- IKHL6Y 秒杀双渠道：购物车行身份（秒杀行/原价行），存量行默认原价
ALTER TABLE "CartItem" ADD COLUMN "asSeckill" BOOLEAN NOT NULL DEFAULT false;
