-- AlterTable
-- IKP34J：服务号组织级路由——Organization 加服务号五字段（gzhAppId/gzhSecret/
-- gzhToken/gzhTemplateId 四项配齐才按组织路由，gzhQrcodeUrl 履约端引导下发）
ALTER TABLE "Organization" ADD COLUMN     "gzhAppId" TEXT,
ADD COLUMN     "gzhQrcodeUrl" TEXT,
ADD COLUMN     "gzhSecret" TEXT,
ADD COLUMN     "gzhTemplateId" TEXT,
ADD COLUMN     "gzhToken" TEXT;
