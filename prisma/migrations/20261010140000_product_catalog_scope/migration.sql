-- IKKRMW 平台商品目录逻辑层（ADR-0001 决策 3）：
-- Product.catalogScope 标记行归属——'platform'=平台目录行（原官方库）、
-- 'campus'=组织校区行（组织 B 接入前的现状口径）。仅加列+打标记，不迁移行：
-- campus-official 伪校区保留，全部现有查询按 campusId 维度工作、语义零改动；
-- 伪校区的物理迁移（campusId 改指向/去外键）留 IKKRMX。
-- 全程幂等（IF NOT EXISTS / 条件 UPDATE）。

ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "catalogScope" TEXT NOT NULL DEFAULT 'campus';

-- 存量官方库行（campus-official 伪校区）打平台标记；
-- 条件 UPDATE 保证已标记/重放不重写行（updatedAt 不被无谓前移）
UPDATE "Product"
SET "catalogScope" = 'platform'
WHERE "campusId" = 'campus-official'
  AND "catalogScope" <> 'platform';
