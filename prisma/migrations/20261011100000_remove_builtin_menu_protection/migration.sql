-- 菜单模板仅在首次初始化时灌入；之后菜单以数据库为唯一真源。
ALTER TABLE "RbacState"
ADD COLUMN "menusSeeded" BOOLEAN NOT NULL DEFAULT false;

-- 现有代码登记菜单转为普通菜单，允许统一编辑和删除。
UPDATE "AdminMenu" SET "builtin" = false WHERE "builtin" = true;

