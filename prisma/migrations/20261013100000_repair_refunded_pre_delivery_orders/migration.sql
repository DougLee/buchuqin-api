-- Issue IKL9D3：未发货整单退款的 RefundItem 为空，旧审核逻辑曾将退款金额
-- 覆盖为 0，并把已退款订单错误恢复为 paid。以下修复幂等地补齐历史终态、
-- 退款金额、库存/销量、优惠券状态；已标记 stockRestored 的订单不会重复回补。

BEGIN;

WITH broken_orders AS MATERIALIZED (
  SELECT
    o.id,
    o.items,
    o."stockRestored"
  FROM "Order" o
  WHERE EXISTS (
    SELECT 1
    FROM "Refund" r
    WHERE r."orderId" = o.id
      AND r.source = 'pre-delivery'
      AND r.status = 'refunded'
  )
    AND o.status NOT IN ('refunded', 'cancelled')
), restore_quantities AS (
  SELECT
    p.id AS product_id,
    SUM((line.value ->> 'quantity')::integer)::integer AS quantity
  FROM broken_orders broken
  CROSS JOIN LATERAL jsonb_array_elements(broken.items) AS line(value)
  JOIN "Product" p ON p.id = line.value #>> '{product,id}'
  WHERE NOT broken."stockRestored"
    AND (
      line.value #>> '{product,costSource}' IS NULL
      OR line.value #>> '{product,costSource}' = 'LEGACY'
      OR line.value #>> '{product,costSource}' = p."procurementMode"
    )
  GROUP BY p.id
)
UPDATE "Product" p
SET
  stock = p.stock + restore.quantity,
  sales = GREATEST(0, p.sales - restore.quantity)
FROM restore_quantities restore
WHERE p.id = restore.product_id;

UPDATE "Refund" r
SET amount = GREATEST(0, o."payableAmount" - o."deliveryFee")
FROM "Order" o
WHERE r."orderId" = o.id
  AND r.source = 'pre-delivery'
  AND r.status = 'refunded'
  AND o.status NOT IN ('refunded', 'cancelled');

UPDATE "UserCoupon" coupon
SET status = 'released'
FROM "Order" o
WHERE coupon.id = o."couponId"
  AND coupon.status IN ('locked', 'used')
  AND EXISTS (
    SELECT 1
    FROM "Refund" r
    WHERE r."orderId" = o.id
      AND r.source = 'pre-delivery'
      AND r.status = 'refunded'
  )
  AND o.status NOT IN ('refunded', 'cancelled');

UPDATE "Order" o
SET
  status = 'refunded',
  "statusText" = '已退款',
  "stockRestored" = true
WHERE EXISTS (
  SELECT 1
  FROM "Refund" r
  WHERE r."orderId" = o.id
    AND r.source = 'pre-delivery'
    AND r.status = 'refunded'
)
  AND o.status NOT IN ('refunded', 'cancelled');

COMMIT;
