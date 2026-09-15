-- IKFOPY：总部仓=特殊校区。type=hq 的校区承载「供应商→总部仓→分拨各校区」
-- 中转职能：不对外售卖（用户端全入口按 type=campus 过滤），复用仓储全套能力。
ALTER TABLE "Campus" ADD COLUMN IF NOT EXISTS "type" TEXT NOT NULL DEFAULT 'campus';

-- 预置总部仓记录（固定 id，后台不可删/不可停用/不可改 type）。
-- status=active：hq/admin 视角经库存 campusScope 可聚焦使用仓储页。
INSERT INTO "Campus" ("id", "type", "name", "shortName", "warehouseName", "status")
VALUES ('campus-hq', 'hq', '总部仓', '总部', '总部仓', 'active')
ON CONFLICT ("id") DO NOTHING;
