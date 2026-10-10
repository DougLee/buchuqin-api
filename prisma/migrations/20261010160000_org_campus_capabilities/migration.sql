-- IKKRMU 组织授权与校区功能开关（营销切片，ADR-0001 多租户）：
-- - Organization.capabilities：null=全开（组织 A 现状，行为零变化）；JSON 数组
--   =已开通能力白名单（如 ["marketing"]；空数组=全关）
-- - Campus.features：null=继承组织；JSON 数组=校区级白名单（只能再收窄：
--   组织关→校区必关，组织开→校区可显式关）
-- 全程幂等（IF NOT EXISTS），不回填、不收紧——存量行保持 null=全开。
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "capabilities" JSONB;
ALTER TABLE "Campus" ADD COLUMN IF NOT EXISTS "features" JSONB;
