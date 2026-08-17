-- IK8W5H 微信登录：User.openid 唯一可选（test-login 演示通道保持不动）
ALTER TABLE "User" ADD COLUMN "openid" TEXT;
CREATE UNIQUE INDEX "User_openid_key" ON "User"("openid");
