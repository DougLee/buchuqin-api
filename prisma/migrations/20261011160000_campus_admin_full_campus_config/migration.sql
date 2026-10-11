-- 校区管理员拥有“校区配置”内全部内容模块；仅授予本角色，不授予校区运营。
INSERT INTO "AdminRoleMenu" ("id", "roleId", "menuId", "createdAt")
SELECT
  'rm_campus_config_all_' || role."id" || '_' || menu."id",
  role."id",
  menu."id",
  now()
FROM "AdminRole" role
JOIN "AdminMenu" menu ON menu."code" IN (
  'banners',
  'banners.write',
  'pay-ads',
  'printers',
  'printers.write'
)
WHERE role."code" = 'campus-admin'
ON CONFLICT ("roleId", "menuId") DO NOTHING;

UPDATE "RbacState" SET "version" = "version" + 1 WHERE "id" = 'global';
