-- IK8W5L 财务结算建模：提成规则 / 提成记录 / 月度账单
CREATE TABLE "CommissionRule" (
    "id" TEXT NOT NULL,
    "campusId" TEXT NOT NULL,
    "buildingId" TEXT,
    "floor" INTEGER,
    "weightFrom" DECIMAL(10,3),
    "weightTo" DECIMAL(10,3),
    "mode" TEXT,
    "price" DECIMAL(10,2) NOT NULL,
    "version" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "effectiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommissionRule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Commission" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "campusId" TEXT NOT NULL,
    "ruleId" TEXT,
    "ruleVersion" INTEGER,
    "amount" DECIMAL(10,2) NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'commission',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "fallback" BOOLEAN NOT NULL DEFAULT false,
    "period" TEXT NOT NULL,
    "remark" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Commission_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "BmBill" (
    "id" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "campusId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "baseSalary" DECIMAL(10,2) NOT NULL,
    "commissionTotal" DECIMAL(10,2) NOT NULL,
    "adjustment" DECIMAL(10,2) NOT NULL,
    "payable" DECIMAL(10,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending-review',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "BmBill_pkey" PRIMARY KEY ("id")
);

-- 一单一人一类唯一：delivered 钩子幂等（重复送达/重试不重复生成），
-- 退款负向调整（kind=adjustment）独立成行，与原始提成并存。
CREATE UNIQUE INDEX "Commission_orderId_staffId_kind_key" ON "Commission"("orderId", "staffId", "kind");
-- 一人一月一张账单：settlements 物化 upsert 依赖
CREATE UNIQUE INDEX "BmBill_staffId_period_key" ON "BmBill"("staffId", "period");

ALTER TABLE "Commission" ADD CONSTRAINT "Commission_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Commission" ADD CONSTRAINT "Commission_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Commission" ADD CONSTRAINT "Commission_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "CommissionRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BmBill" ADD CONSTRAINT "BmBill_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
