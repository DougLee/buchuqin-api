-- IKB3KG 方案A：后台账号可运营校区授权表。
-- AdminAccount.campusId=当前登录校区，本表=可切换校区全集（hq campusId='' 无行）。
CREATE TABLE "AdminCampusAccess" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "campusId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminCampusAccess_pkey" PRIMARY KEY ("id")
);

-- 存量校区账号按当前所属校区补授权（幂等：唯一索引冲突即跳过整批插入前先去重）
INSERT INTO "AdminCampusAccess" ("id", "accountId", "campusId")
SELECT DISTINCT md5(random()::text || clock_timestamp()::text || a."id"), a."id", a."campusId"
FROM "AdminAccount" a
WHERE a."campusId" <> ''
  AND NOT EXISTS (
    SELECT 1 FROM "AdminCampusAccess" x WHERE x."accountId" = a."id" AND x."campusId" = a."campusId"
  );

-- CreateIndex
CREATE UNIQUE INDEX "AdminCampusAccess_accountId_campusId_key" ON "AdminCampusAccess"("accountId", "campusId");

-- CreateIndex
CREATE INDEX "AdminCampusAccess_accountId_idx" ON "AdminCampusAccess"("accountId");

-- AddForeignKey
ALTER TABLE "AdminCampusAccess" ADD CONSTRAINT "AdminCampusAccess_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "AdminAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
