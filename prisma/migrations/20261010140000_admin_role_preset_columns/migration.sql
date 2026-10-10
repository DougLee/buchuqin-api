-- IKKRMQ 统一角色管理：AdminRole 分配边界两列。
-- 口径：仅加列、不回填——assignableBy 默认 'platform'（仅超管可分配）与
-- 现状等价（账号写端点本就超管独占），存量角色零变化；applicableLevel
-- NULL=不限层级（现状语义）。预设角色（org-admin/campus-admin/
-- campus-operator）的边界值由启动同步在首次登记时写入，不动存量行。
-- 全程幂等（IF NOT EXISTS / IF NULL）。

ALTER TABLE "AdminRole" ADD COLUMN IF NOT EXISTS "assignableBy" TEXT NOT NULL DEFAULT 'platform';
ALTER TABLE "AdminRole" ADD COLUMN IF NOT EXISTS "applicableLevel" TEXT;
