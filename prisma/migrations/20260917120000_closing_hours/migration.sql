-- IKG1C 打烊停单：Campus 每日打烊窗（HH:mm，closeStart > closeEnd = 跨零点窗，
-- 相等 = 不打烊）+ 手动闭店开关（与时间窗叠加判定，任一命中即拦）。
-- 存量默认：22:00–次日 08:00 打烊、不手动闭店，行为与功能上线前一致（不拦）。
-- 注：本仓迁移历史含迁移外建表（RestockOrder 等），prisma migrate dev 的
-- shadow 重放会炸（P3006），故沿用 db execute + resolve 落地。

-- AlterTable
ALTER TABLE "Campus" ADD COLUMN     "closeEnd" TEXT NOT NULL DEFAULT '08:00',
ADD COLUMN     "closeStart" TEXT NOT NULL DEFAULT '22:00',
ADD COLUMN     "manualClosed" BOOLEAN NOT NULL DEFAULT false;
