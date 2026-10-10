-- IKKRMP 固定后台账号数据边界（ADR-0001）：平台 | 组织 | 校区三层。
-- 口径：仅加列、不回填——orgLevel NULL=历史账号按 campusId 推导（空串或
-- campus-hq 视作平台级，其余校区级），推导式与存量行为等价，组织 A 现有
-- 账号全部走推导=行为零变化；显式层级由超管在账号管理逐个固定。
-- organizationId 仅组织级账号使用（orgLevel='org' 必填，服务层校验），
-- 纯字符串不建外键（同 AdminAccount.campusId / Campus.organizationId 先例）。
-- 全程幂等（IF NOT EXISTS）。

ALTER TABLE "AdminAccount" ADD COLUMN IF NOT EXISTS "orgLevel" TEXT;
ALTER TABLE "AdminAccount" ADD COLUMN IF NOT EXISTS "organizationId" TEXT;

-- 组织维账号查询锚点（IKKRMS 组织开通流程按组织取账号清单用）
CREATE INDEX IF NOT EXISTS "AdminAccount_organizationId_idx" ON "AdminAccount"("organizationId");
