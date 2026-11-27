-- IKY6QE 追加（道哥 2026-11-26）：押金补录权限——night-deposit 菜单 perms
-- 追加 POST /admin/night/stores/:id/deposit/add（幂等：已含则不动）
UPDATE "AdminMenu"
SET "perms" = "perms" || ',POST /admin/night/stores/:id/deposit/add',
    "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" = 'night-deposit'
  AND "perms" IS NOT NULL
  AND "perms" NOT LIKE '%deposit/add%';
