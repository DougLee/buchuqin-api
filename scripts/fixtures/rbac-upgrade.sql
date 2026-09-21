DO $$ BEGIN IF current_database() NOT LIKE 'buchuqin_rbac_upgrade_%' THEN RAISE EXCEPTION 'Only an isolated upgrade rehearsal database is allowed'; END IF; END $$;
-- Synthetic data ONLY, for an isolated pre-20260921 RBAC schema.
INSERT INTO "Campus" (id,name,"shortName","warehouseName") VALUES ('upgrade-a','迁移A','A','A仓'),('upgrade-b','迁移B','B','B仓');
INSERT INTO "AdminAccount" (id,username,"passwordHash",nickname,role,"campusId","updatedAt") VALUES
('upgrade-legacy','upgrade-legacy','not-a-login-hash','','operations','upgrade-a',NOW()),
('upgrade-revoked','upgrade-revoked','not-a-login-hash','','operations','upgrade-a',NOW()),
('upgrade-current','upgrade-current','not-a-login-hash','','rbac','upgrade-a',NOW()),
('upgrade-empty','upgrade-empty','not-a-login-hash','','rbac','upgrade-a',NOW()),
('upgrade-disabled','upgrade-disabled','not-a-login-hash','','operations','upgrade-a',NOW());
UPDATE "AdminAccount" SET status='disabled' WHERE id='upgrade-disabled';
INSERT INTO "AdminCampusAccess" (id,"accountId","campusId") VALUES ('upgrade-access','upgrade-legacy','upgrade-b');
INSERT INTO "AdminRole" (id,code,name,seeded,menus,"updatedAt") VALUES
('upgrade-existing-role','upgrade-existing-role','已配置角色',true,'["products"]',NOW()),
('upgrade-empty-role','campus-warehouse','明确清空的模板角色',false,'["products"]',NOW());
INSERT INTO "AdminMenu" (id,code,name,type,perms,path,"viewPath",builtin,"updatedAt") VALUES
('upgrade-menu','upgrade-menu','保留自定义入口',1,'GET /admin/products','/upgrade-products','products',false,NOW());
INSERT INTO "AdminRoleMenu" (id,"roleId","menuId") VALUES ('upgrade-role-menu','upgrade-existing-role','upgrade-menu');
INSERT INTO "AdminAccountRole" (id,"accountId","roleId",scope,"campusId","updatedAt") VALUES
('upgrade-grant','upgrade-current','upgrade-existing-role','campus','upgrade-a',NOW()),
('upgrade-empty-grant','upgrade-empty','upgrade-empty-role','campus','upgrade-a',NOW());
INSERT INTO "AuditLog" (id,"campusId",operator,action,"entityType","entityId","after") VALUES
('upgrade-revoke-audit','upgrade-a','fixture','rbac.grant.set','admin-account','upgrade-revoked','[]'),
('upgrade-empty-audit','upgrade-a','fixture','rbac.role.update','admin-role','upgrade-empty-role','{"menuCodes":[]}');
