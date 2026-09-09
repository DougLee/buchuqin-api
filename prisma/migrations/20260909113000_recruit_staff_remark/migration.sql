-- IKEAGE：运营备注独立字段（admin 补录，与候选人 note 相互独立）
ALTER TABLE "RecruitingApplication" ADD COLUMN "staffRemark" TEXT NOT NULL DEFAULT '';
