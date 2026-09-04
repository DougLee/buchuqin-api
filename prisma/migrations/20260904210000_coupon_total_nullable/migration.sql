-- IKDEN2：发放总量可空 = 不限量（与 expiresAt 可空=长期有效同模式）
ALTER TABLE "Coupon" ALTER COLUMN "total" DROP NOT NULL;
ALTER TABLE "Coupon" ALTER COLUMN "total" DROP DEFAULT;
