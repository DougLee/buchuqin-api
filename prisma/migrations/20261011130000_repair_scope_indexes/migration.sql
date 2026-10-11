-- Repair indexes that may be absent when older baseline columns were created manually
-- before their original migrations ran. Both statements are safe to deploy repeatedly.
CREATE INDEX IF NOT EXISTS "AdminAccount_organizationId_idx"
ON "AdminAccount"("organizationId");

CREATE INDEX IF NOT EXISTS "Category_campusId_idx"
ON "Category"("campusId");
