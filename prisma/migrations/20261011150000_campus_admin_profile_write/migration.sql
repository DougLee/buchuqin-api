-- 校区管理员可维护本人所属校区的基础档案；不授予校区运营。
INSERT INTO "AdminMenu" (
  "id", "code", "parentId", "name", "type", "perms", "path", "viewPath",
  "keepAlive", "icon", "orderNum", "isShow", "status", "createdAt", "updatedAt"
)
SELECT
  'menu_campus_config_profile',
  'campus-config.profile',
  parent."id",
  '基础档案维护',
  2,
  'PATCH /admin/campuses/:id',
  '', '', false, '', 3, true, 'active', now(), now()
FROM "AdminMenu" parent
WHERE parent."code" = 'campus-config'
ON CONFLICT ("code") DO UPDATE SET
  "parentId" = EXCLUDED."parentId",
  "name" = EXCLUDED."name",
  "type" = EXCLUDED."type",
  "perms" = EXCLUDED."perms",
  "orderNum" = EXCLUDED."orderNum",
  "status" = EXCLUDED."status",
  "updatedAt" = now();

INSERT INTO "AdminRoleMenu" ("id", "roleId", "menuId", "createdAt")
SELECT 'rm_campus_profile_' || role."id", role."id", menu."id", now()
FROM "AdminRole" role
JOIN "AdminMenu" menu ON menu."code" = 'campus-config.profile'
WHERE role."code" = 'campus-admin'
ON CONFLICT ("roleId", "menuId") DO NOTHING;

UPDATE "RbacState" SET "version" = "version" + 1 WHERE "id" = 'global';
