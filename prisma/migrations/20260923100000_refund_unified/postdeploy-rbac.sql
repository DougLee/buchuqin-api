-- IKHZKA 退款功能 v1 部署配套（幂等；在 API 启动同步之后执行）
-- 1) 售后退款菜单 perms 补新列表端点（存量菜单行 sync 不 update）
UPDATE "AdminMenu" SET perms = 'GET /admin/after-sales,GET /admin/refunds'
WHERE code = 'after-sales' AND perms = 'GET /admin/after-sales';

-- 2) 存量校区运营角色补授退款审核（新角色由模板首灌自动含）
INSERT INTO "AdminRoleMenu" ("id", "roleId", "menuId", "createdAt")
SELECT 'rm_refund_' || r.id, r.id, m.id, now()
FROM "AdminRole" r
JOIN "AdminMenu" m ON m.code = 'after-sales.audit'
WHERE r.code = 'campus-operations'
ON CONFLICT ("roleId", "menuId") DO NOTHING;
