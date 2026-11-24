-- IKXLV5（道哥 2026-11-24）：服务号绑定支持一人多组织
-- 1) 新表 StaffGzhBinding：「员工 × 来源服务号」维度
-- 2) Staff.unionId / Staff.gzhOpenid 放开唯一约束（同微信多组织 unionid 相同是常态）

CREATE TABLE "StaffGzhBinding" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "gzhAppId" TEXT NOT NULL,
    "gzhOpenid" TEXT NOT NULL,
    "unionId" TEXT NOT NULL,
    "boundAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffGzhBinding_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StaffGzhBinding_staffId_gzhAppId_key" ON "StaffGzhBinding"("staffId", "gzhAppId");
CREATE UNIQUE INDEX "StaffGzhBinding_gzhAppId_gzhOpenid_key" ON "StaffGzhBinding"("gzhAppId", "gzhOpenid");
CREATE INDEX "StaffGzhBinding_unionId_gzhAppId_idx" ON "StaffGzhBinding"("unionId", "gzhAppId");

ALTER TABLE "StaffGzhBinding" ADD CONSTRAINT "StaffGzhBinding_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 放开唯一约束：一人多组织时同一 unionid/gzhOpenid 可出现在多个组织员工行
-- 注意：Prisma 的 @unique 在 PostgreSQL 建的是独立唯一**索引**（不是表约束），
-- 必须用 DROP INDEX——首个版本误用 DROP CONSTRAINT + IF EXISTS 静默空转，
-- 导致生产 unionid 写入仍撞唯一冲突被吞（2026-11-24 实测已修正）
DROP INDEX IF EXISTS "Staff_unionId_key";
DROP INDEX IF EXISTS "Staff_gzhOpenid_key";
