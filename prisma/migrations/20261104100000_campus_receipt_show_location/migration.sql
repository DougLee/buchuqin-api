-- IKRSJ2（道哥 2026-11-04 定版）：小票库位打印开关——关=小票全联不打库位行
-- 存量校区默认 true，行为不变；printer.service 宽位断言消费，落地即生效
ALTER TABLE "Campus" ADD COLUMN "receiptShowLocation" BOOLEAN NOT NULL DEFAULT true;
