-- IKWLHZ：楼长押金档位校区级可配置（默认 500 元 = 50000 分）
ALTER TABLE "Campus" ADD COLUMN "nightDeposit" INTEGER NOT NULL DEFAULT 50000;
