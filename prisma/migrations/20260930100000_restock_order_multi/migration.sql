-- IKJCJF 订货多单制：一批次一校区可多张（去草稿，每次提交成单）
-- 存量 draft 单为未完成草稿，随草稿机制一并移除（测试环境直删；生产执行前确认）
DELETE FROM "RestockOrder" WHERE "status" = 'draft';
DROP INDEX IF EXISTS "RestockOrder_batchId_campusId_key";
CREATE INDEX "RestockOrder_batchId_campusId_idx" ON "RestockOrder"("batchId", "campusId");
ALTER TABLE "RestockOrder" ALTER COLUMN "status" SET DEFAULT 'submitted';
