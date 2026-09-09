-- IKEAGE：楼长招募报名表（C 端报名 → 后台面试审批 → 实习楼长）
CREATE TABLE "RecruitingApplication" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "campusId" TEXT NOT NULL,
    "buildingId" TEXT NOT NULL,
    "buildingName" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "rejectReason" TEXT NOT NULL DEFAULT '',
    "idCardNo" TEXT NOT NULL DEFAULT '',
    "idCardImages" JSONB,
    "staffId" TEXT,
    "auditBy" TEXT NOT NULL DEFAULT '',
    "auditByName" TEXT NOT NULL DEFAULT '',
    "auditedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecruitingApplication_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "RecruitingApplication" ADD CONSTRAINT "RecruitingApplication_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RecruitingApplication" ADD CONSTRAINT "RecruitingApplication_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "RecruitingApplication_campusId_status_idx" ON "RecruitingApplication"("campusId", "status");
CREATE INDEX "RecruitingApplication_userId_status_idx" ON "RecruitingApplication"("userId", "status");
