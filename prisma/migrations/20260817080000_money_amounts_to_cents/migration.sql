-- IK8W5K 金额元转分：全部金额字段 Decimal(10,2) → integer（单位:分，字段名不变）。
-- 顺序：先全表 UPDATE ×100（Decimal 数值乘法精确，2 位小数 ×100 后必为整数），
-- 再 ALTER COLUMN TYPE integer（::integer 对已是整数的数值无精度损失）。
-- 空表/新环境同样安全（UPDATE 0 行）。重量（weight/weightFrom/weightTo）与
-- 百分比（onTimeRate/proofRate）非金额维度，保持 Decimal 不动。

-- 商品价格
UPDATE "Product" SET "price" = "price" * 100, "originalPrice" = "originalPrice" * 100;
ALTER TABLE "Product" ALTER COLUMN "price" TYPE integer USING ("price")::integer,
  ALTER COLUMN "originalPrice" TYPE integer USING ("originalPrice")::integer;

-- 优惠券面额/门槛
UPDATE "Coupon" SET "amount" = "amount" * 100, "threshold" = "threshold" * 100;
ALTER TABLE "Coupon" ALTER COLUMN "amount" TYPE integer USING ("amount")::integer,
  ALTER COLUMN "threshold" TYPE integer USING ("threshold")::integer;

-- 订单金额五件套
UPDATE "Order" SET "productAmount" = "productAmount" * 100,
  "deliveryThreshold" = "deliveryThreshold" * 100,
  "deliveryFee" = "deliveryFee" * 100,
  "discount" = "discount" * 100,
  "payableAmount" = "payableAmount" * 100;
ALTER TABLE "Order" ALTER COLUMN "productAmount" TYPE integer USING ("productAmount")::integer,
  ALTER COLUMN "deliveryThreshold" TYPE integer USING ("deliveryThreshold")::integer,
  ALTER COLUMN "deliveryFee" TYPE integer USING ("deliveryFee")::integer,
  ALTER COLUMN "discount" TYPE integer USING ("discount")::integer,
  ALTER COLUMN "payableAmount" TYPE integer USING ("payableAmount")::integer;

-- 退款金额
UPDATE "Refund" SET "amount" = "amount" * 100;
ALTER TABLE "Refund" ALTER COLUMN "amount" TYPE integer USING ("amount")::integer;

-- 员工累计收入
UPDATE "Staff" SET "income" = "income" * 100;
ALTER TABLE "Staff" ALTER COLUMN "income" TYPE integer USING ("income")::integer;

-- 调配奖励
UPDATE "DispatchInvitation" SET "reward" = "reward" * 100;
ALTER TABLE "DispatchInvitation" ALTER COLUMN "reward" TYPE integer USING ("reward")::integer;

-- 提成规则单价
UPDATE "CommissionRule" SET "price" = "price" * 100;
ALTER TABLE "CommissionRule" ALTER COLUMN "price" TYPE integer USING ("price")::integer;

-- 提成记录金额（可为负，跨期调整）
UPDATE "Commission" SET "amount" = "amount" * 100;
ALTER TABLE "Commission" ALTER COLUMN "amount" TYPE integer USING ("amount")::integer;

-- 月度账单四件套
UPDATE "BmBill" SET "baseSalary" = "baseSalary" * 100,
  "commissionTotal" = "commissionTotal" * 100,
  "adjustment" = "adjustment" * 100,
  "payable" = "payable" * 100;
ALTER TABLE "BmBill" ALTER COLUMN "baseSalary" TYPE integer USING ("baseSalary")::integer,
  ALTER COLUMN "commissionTotal" TYPE integer USING ("commissionTotal")::integer,
  ALTER COLUMN "adjustment" TYPE integer USING ("adjustment")::integer,
  ALTER COLUMN "payable" TYPE integer USING ("payable")::integer;
