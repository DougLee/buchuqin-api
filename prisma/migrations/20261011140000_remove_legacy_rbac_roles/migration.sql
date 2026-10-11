-- 旧角色迁移模板已经退役。先清理引用，再删除角色本体。
DELETE FROM "AdminAccountRole"
WHERE "roleId" IN (
  SELECT "id" FROM "AdminRole"
  WHERE "code" IN ('hq-director', 'campus-operations', 'campus-warehouse', 'campus-finance')
);

DELETE FROM "AdminRoleMenu"
WHERE "roleId" IN (
  SELECT "id" FROM "AdminRole"
  WHERE "code" IN ('hq-director', 'campus-operations', 'campus-warehouse', 'campus-finance')
);

DELETE FROM "AdminRolePermission"
WHERE "roleId" IN (
  SELECT "id" FROM "AdminRole"
  WHERE "code" IN ('hq-director', 'campus-operations', 'campus-warehouse', 'campus-finance')
);

DELETE FROM "AdminRole"
WHERE "code" IN ('hq-director', 'campus-operations', 'campus-warehouse', 'campus-finance');
