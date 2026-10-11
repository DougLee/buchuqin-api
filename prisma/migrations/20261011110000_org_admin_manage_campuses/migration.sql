-- 组织管理员负责本组织校区生命周期管理：补授校区新建/编辑按钮节点。
-- 数据边界仍由 AdminAccount.orgLevel='org' + organizationId 强制收口，
-- 本授权只增加操作能力，不会扩大到其他组织。
INSERT INTO "AdminRoleMenu" ("id", "roleId", "menuId", "createdAt")
SELECT 'rm_org_campus_manage_' || r.id, r.id, m.id, now()
FROM "AdminRole" r
JOIN "AdminMenu" m ON m.code = 'campuses.manage'
WHERE r.code = 'org-admin'
ON CONFLICT ("roleId", "menuId") DO NOTHING;

-- 让在线会话下一次权限刷新立即感知角色菜单变化。
UPDATE "RbacState" SET "version" = "version" + 1 WHERE "id" = 'global';
