-- IKKRMM 多租户组织基线（ADR-0001 2026-10-10 定稿）：平台—组织—校区三层。
-- 口径：先扩展、回填校验、再收紧——本迁移只做前两步（建表+组织 A 基线+
-- Campus.organizationId 扩展回填），NOT NULL 收紧留待账号层级固定（IKKRMP）。
-- 全程幂等（IF NOT EXISTS / ON CONFLICT），组织 A 现有行为零变化。

-- 1) Organization 表：微信配置为预留字段（ADR-0001 决策 2：存 DB 后台维护，
--    组织 B 开通用；组织 A env 兜底），本阶段可空、无读取链路
CREATE TABLE IF NOT EXISTS "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shortName" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'active',
    "wxAppId" TEXT,
    "wxSecret" TEXT,
    "mchId" TEXT,
    "mchApiV3Key" TEXT,
    "serialNo" TEXT,
    "privateKey" TEXT,
    "notifyDomain" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- 2) 组织 A 基线：不出寝食社——存量数据的默认归属（org-a 固定 id，
--    后续 issue 以此为锚点，勿改）
INSERT INTO "Organization" ("id", "name", "shortName", "status")
VALUES ('org-a', '不出寝食社', '', 'active')
ON CONFLICT ("id") DO NOTHING;

-- 3) Campus 扩展列（可空：campus-official 平台伪校区永属平台层留空，
--    伪校区解绑属 IKKRMW；新建校区默认未分配，分配入口属 IKKRMS）
ALTER TABLE "Campus" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;

-- 4) 回填：campus-hq（总部仓）与全部真实校区归组织 A；
--    campus-official 留空 = 平台层（NOT IN 写法与该语义等价，取 <> 显式）
UPDATE "Campus"
SET "organizationId" = 'org-a'
WHERE "id" <> 'campus-official'
  AND ("organizationId" IS NULL OR "organizationId" <> 'org-a');

-- 5) 归属查询索引（不加 FK：参照 AdminAccount.campusId 先例——纯字符串，
--    校区与组织生命周期独立，删除保护由服务层负责）
CREATE INDEX IF NOT EXISTS "Campus_organizationId_idx" ON "Campus"("organizationId");
