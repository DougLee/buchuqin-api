ALTER TABLE "AdminAccount" ADD COLUMN "rbacMigrated" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AdminRole" ADD COLUMN "menusMigrated" BOOLEAN NOT NULL DEFAULT false;

-- Existing grants and explicit authorization edits are already authoritative.
-- In particular an audited empty grant must never be reconstructed from legacy role.
UPDATE "AdminAccount" a SET "rbacMigrated" = true
WHERE a."role" = 'rbac'
   OR EXISTS (SELECT 1 FROM "AdminAccountRole" g WHERE g."accountId" = a.id)
   OR EXISTS (SELECT 1 FROM "AuditLog" l WHERE l."entityId" = a.id
              AND l."action" = 'rbac.grant.set');
UPDATE "AdminRole" r SET "menusMigrated" = true
WHERE EXISTS (SELECT 1 FROM "AdminRoleMenu" m WHERE m."roleId" = r.id)
   OR EXISTS (SELECT 1 FROM "AuditLog" l WHERE l."entityId" = r.id
              AND l."action" IN ('rbac.role.create', 'rbac.role.update'));
