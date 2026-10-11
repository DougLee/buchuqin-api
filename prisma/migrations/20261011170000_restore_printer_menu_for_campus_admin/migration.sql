-- 当前库未保留打印机菜单节点；显式补建，避免依赖启动时注册表同步。
INSERT INTO "AdminMenu" (
  "id", "code", "parentId", "name", "type", "perms", "path", "viewPath",
  "keepAlive", "icon", "orderNum", "isShow", "status", "createdAt", "updatedAt"
)
SELECT
  'menu_printers', 'printers', parent."id", '打印机', 1,
  'GET /admin/printers', '/printers', 'printers', false, 'printers', 5,
  true, 'active', now(), now()
FROM "AdminMenu" parent
WHERE parent."code" = 'g.sys'
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "AdminMenu" (
  "id", "code", "parentId", "name", "type", "perms", "path", "viewPath",
  "keepAlive", "icon", "orderNum", "isShow", "status", "createdAt", "updatedAt"
)
SELECT
  'menu_printers_write', 'printers.write', parent."id", '打印机管理', 2,
  'POST /admin/printers,DELETE /admin/printers/:id,POST /admin/printers/:id/test-print',
  '', '', false, '', 1, true, 'active', now(), now()
FROM "AdminMenu" parent
WHERE parent."code" = 'printers'
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "AdminRoleMenu" ("id", "roleId", "menuId", "createdAt")
SELECT
  'rm_campus_printer_' || role."id" || '_' || menu."id",
  role."id",
  menu."id",
  now()
FROM "AdminRole" role
JOIN "AdminMenu" menu ON menu."code" IN ('g.sys', 'printers', 'printers.write')
WHERE role."code" = 'campus-admin'
ON CONFLICT ("roleId", "menuId") DO NOTHING;

UPDATE "RbacState" SET "version" = "version" + 1 WHERE "id" = 'global';
