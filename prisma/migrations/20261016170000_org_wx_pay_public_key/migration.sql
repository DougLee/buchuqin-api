-- 微信支付公钥（2024+ 新商户回调验签，组织级路由）
ALTER TABLE "Organization" ADD COLUMN "wxPayPublicKey" TEXT;
