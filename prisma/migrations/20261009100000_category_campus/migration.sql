-- IKKA1S 商品类别按校区隔离（模板初始化制）
-- ⓪ 加列（nullable，迁移末尾收紧 NOT NULL）
ALTER TABLE "Category" ADD COLUMN IF NOT EXISTS "campusId" TEXT;

-- ① 官方商品所挂类别 → campus-official 模板集
UPDATE "Category" SET "campusId" = 'campus-official'
WHERE "id" IN (
  SELECT DISTINCT "categoryId" FROM "Product" WHERE "campusId" = 'campus-official'
);

-- ② 各校区（含总部仓）副本：id 用 migcat+md5 防碰撞；仅复制本校区商品实际挂载的类别
INSERT INTO "Category" ("id", "name", "sort", "image", "hidden", "campusId")
SELECT
  'migcat-' || substr(md5(p."campusId" || '|' || cat."id"), 1, 20),
  cat."name", cat."sort", cat."image", cat."hidden", p."campusId"
FROM "Category" cat
JOIN (SELECT DISTINCT "campusId", "categoryId" FROM "Product") p
  ON p."categoryId" = cat."id"
WHERE p."campusId" <> 'campus-official'
ON CONFLICT ("id") DO NOTHING;

-- ③ 商品重映射到本校区副本
UPDATE "Product" pr
SET "categoryId" = 'migcat-' || substr(md5(pr."campusId" || '|' || pr."categoryId"), 1, 20)
WHERE pr."campusId" <> 'campus-official';

-- ④ 孤儿全局类别删除（无商品挂载=无引用）
DELETE FROM "Category" WHERE "campusId" IS NULL;

-- ⑤ NOT NULL + 校区内唯一 + 查询索引
ALTER TABLE "Category" ALTER COLUMN "campusId" SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "Category_campusId_name_key" ON "Category"("campusId", "name");
CREATE INDEX IF NOT EXISTS "Category_campusId_idx" ON "Category"("campusId");
