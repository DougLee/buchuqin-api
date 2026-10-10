-- IKKRMX 组织商品目录（ADR-0001 决策 4）：Product 仅加三列（幂等），不动存量。
-- - organizationId：组织目录行归属组织（行复用校区模型不建新表——物理上仍落
--   campus-official 伪校区，归属按 organizationId+catalogScope='org' 圈定；
--   平台/官方库视角查询一律 organizationId IS NULL 排除组织行）；
-- - orgCatalogId：组织校区副本指回组织目录行（三层来源链 platform←org←campus，
--   类似 sourceProductId 指回平台目录行）；
-- - supplyMode：组织采购来源（'platform'=平台供货 / 'local'=自主采购）。
-- 组织 A 的现有官方库导入链路照旧（组织目录行为全新数据面，无回填）。

ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "orgCatalogId" TEXT;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "supplyMode" TEXT;
