-- IKI3ZP 服务号派单推送：Staff 加 unionId（小程序登录侧写）与 gzhOpenid（服务号关注）
ALTER TABLE "Staff" ADD COLUMN IF NOT EXISTS "unionId" TEXT;
ALTER TABLE "Staff" ADD COLUMN IF NOT EXISTS "gzhOpenid" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "Staff_unionId_key" ON "Staff"("unionId");
CREATE UNIQUE INDEX IF NOT EXISTS "Staff_gzhOpenid_key" ON "Staff"("gzhOpenid");
