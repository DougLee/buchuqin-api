-- RBAC V1（2026-09-19 道哥 goal）：账号 → 角色 → 权限，按校区生效。
-- 纯 DDL：权限点/内置超管/迁移模板角色与旧账号绑定由应用启动同步
--（RbacService.onModuleInit，幂等）——权限点由代码登记同步入库。

-- 1) 后台账号补状态与会话版本（停用/改密/撤权即时生效的依据）
ALTER TABLE "AdminAccount" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'active';
ALTER TABLE "AdminAccount" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;

-- 2) 角色（一个角色关联多个权限；builtin 内置超管受保护）
CREATE TABLE "AdminRole" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "remark" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'active',
    "builtin" BOOLEAN NOT NULL DEFAULT false,
    "seeded" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AdminRole_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AdminRole_code_key" ON "AdminRole"("code");

-- 3) 权限点（代码登记，后台只读配置）
CREATE TABLE "AdminPermission" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "group" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "remark" TEXT NOT NULL DEFAULT '',
    "builtin" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminPermission_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AdminPermission_code_key" ON "AdminPermission"("code");

-- 4) 角色-权限关联（全量重设式维护）
CREATE TABLE "AdminRolePermission" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminRolePermission_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AdminRolePermission_roleId_permissionId_key" ON "AdminRolePermission"("roleId", "permissionId");
ALTER TABLE "AdminRolePermission" ADD CONSTRAINT "AdminRolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "AdminRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdminRolePermission" ADD CONSTRAINT "AdminRolePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "AdminPermission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 5) 账号-角色绑定（含生效范围）：scope=platform 平台级 | campus 指定校区
CREATE TABLE "AdminAccountRole" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "campusId" TEXT,
    "grantedBy" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AdminAccountRole_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AdminAccountRole_accountId_scope_campusId_idx" ON "AdminAccountRole"("accountId", "scope", "campusId");
-- 范围硬约束：campus 级必须带校区；platform 级恒不带（不用空串/缺省冒充"全部校区"）
ALTER TABLE "AdminAccountRole" ADD CONSTRAINT "AdminAccountRole_scope_campus_check" CHECK ("scope" IN ('platform', 'campus') AND ("scope" = 'platform' OR "campusId" IS NOT NULL));
-- 同一账号同一角色：平台级至多一条；同一校区至多一条（服务层重设语义 + DB 兜底防并发重复）
CREATE UNIQUE INDEX "AdminAccountRole_account_role_platform_uniq" ON "AdminAccountRole"("accountId", "roleId") WHERE "scope" = 'platform';
CREATE UNIQUE INDEX "AdminAccountRole_account_role_campus_uniq" ON "AdminAccountRole"("accountId", "roleId", "campusId") WHERE "scope" = 'campus';
ALTER TABLE "AdminAccountRole" ADD CONSTRAINT "AdminAccountRole_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "AdminAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- 删角色仍有绑定时 DB 拒绝（service 前置校验给出人话报错）
ALTER TABLE "AdminAccountRole" ADD CONSTRAINT "AdminAccountRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "AdminRole"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 6) RBAC 全局版本号（有效权限缓存显式失效）
CREATE TABLE "RbacState" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RbacState_pkey" PRIMARY KEY ("id")
);

-- 7) 角色可见菜单（两层模型第一层，2026-09-19 道哥拍板 A）：key 清单，
--    模板角色菜单由启动同步灌注（menus IS NULL 时按模板补齐）
ALTER TABLE "AdminRole" ADD COLUMN "menus" JSONB;

-- 8) 蛋词体系对齐（2026-09-19 拍板 B）：菜单+按钮权限合一棵树（AdminMenu），
--    角色-菜单一体勾选（AdminRoleMenu）。权限真源从 AdminPermission 切到
--    AdminMenu.perms（URL 模式）；旧表保留数据退役，可回滚。
CREATE TABLE "AdminMenu" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "parentId" TEXT,
    "name" TEXT NOT NULL,
    "type" INTEGER NOT NULL DEFAULT 0,
    "perms" TEXT NOT NULL DEFAULT '',
    "path" TEXT NOT NULL DEFAULT '',
    "viewPath" TEXT NOT NULL DEFAULT '',
    "icon" TEXT NOT NULL DEFAULT '',
    "orderNum" INTEGER NOT NULL DEFAULT 0,
    "isShow" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'active',
    "builtin" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AdminMenu_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AdminMenu_code_key" ON "AdminMenu"("code");
CREATE INDEX "AdminMenu_parentId_orderNum_idx" ON "AdminMenu"("parentId", "orderNum");

CREATE TABLE "AdminRoleMenu" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "menuId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdminRoleMenu_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AdminRoleMenu_roleId_menuId_key" ON "AdminRoleMenu"("roleId", "menuId");
CREATE INDEX "AdminRoleMenu_menuId_idx" ON "AdminRoleMenu"("menuId");
ALTER TABLE "AdminRoleMenu" ADD CONSTRAINT "AdminRoleMenu_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "AdminRole"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AdminRoleMenu" ADD CONSTRAINT "AdminRoleMenu_menuId_fkey" FOREIGN KEY ("menuId") REFERENCES "AdminMenu"("id") ON DELETE CASCADE ON UPDATE CASCADE;
