-- 每个组织可配置独立的履约端小程序。用户端/履约端 AppID 通过同一
-- Organization 行配对；订单与骑手仍经 Campus.organizationId 收口。
ALTER TABLE "Organization"
ADD COLUMN IF NOT EXISTS "deliveryWxAppId" TEXT,
ADD COLUMN IF NOT EXISTS "deliveryWxSecret" TEXT,
ADD COLUMN IF NOT EXISTS "deliveryNotifyTemplateId" TEXT;

-- NULL 可重复；已登记的履约 AppID 必须全平台唯一，避免 AppID→组织解析歧义。
CREATE UNIQUE INDEX IF NOT EXISTS "Organization_deliveryWxAppId_key"
ON "Organization"("deliveryWxAppId");
