-- IKH0EK 首页推荐位：Product 加推荐位字段 + sales 历史回填
ALTER TABLE "Product" ADD COLUMN "featured" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Product" ADD COLUMN "featuredSort" INTEGER NOT NULL DEFAULT 0;

-- sales 历史回填：已支付订单的 JSON 订单行聚合（Prisma Json 列 = PG jsonb）。
-- 只回填 sales=0 的行（防御性；当前全量为 0）。行结构 {product:{id}, quantity}
-- 与 pay() 落库写入一致。退款单不扣回（销量口径含历史成交）。
UPDATE "Product" p SET sales = COALESCE(agg.qty, 0)
FROM (
  SELECT (line->'product'->>'id') AS pid, SUM((line->>'quantity')::int) AS qty
  FROM "Order" o
  CROSS JOIN LATERAL jsonb_array_elements(o."items") AS line
  WHERE o."paidAt" IS NOT NULL
  GROUP BY 1
) agg
WHERE p.id = agg.pid AND p.sales = 0;
