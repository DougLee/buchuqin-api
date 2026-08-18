-- 员工微信登录绑定（IK8W5Q）：首次用工号+姓名换绑 openid，之后直登
ALTER TABLE "Staff" ADD COLUMN "openid" TEXT;
CREATE UNIQUE INDEX "Staff_openid_key" ON "Staff"("openid");
