-- IKRSIX #99/#184（券明细）/ #97（采购台账）/ #85（盘点统计）：新端点的菜单 perms
-- 经数据迁移登记（DB 是 menusSeeded 后唯一真源，先例 20261011170000 打印机菜单）。
-- registry 静态字典不改——rbac.spec 覆盖自检对这四条按迁移清单对账，漏迁移即红。
-- 注意：registry 已登记的 GET /admin/building-rank（IKRSJ0 #81b，building-rank
-- 菜单节点）不在此列；全新库首次启动首灌菜单时若 registry 尚无新节点，需按
-- 角色管理手动勾选（与 IKRQR7 转单管理同款口径，超管不受影响）。

-- 优惠券明细 → coupons 菜单（与 GET /admin/coupons 同页同权）
UPDATE "AdminMenu"
SET "perms" = "perms" || ',GET /admin/coupon-records',
    "updatedAt" = now()
WHERE "code" = 'coupons'
  AND strpos("perms", 'GET /admin/coupon-records') = 0;

-- 盘点统计 → inventory 菜单（库存总览页内操作）
UPDATE "AdminMenu"
SET "perms" = "perms" || ',GET /admin/inventory/stocktake-stats',
    "updatedAt" = now()
WHERE "code" = 'inventory'
  AND strpos("perms", 'GET /admin/inventory/stocktake-stats') = 0;

-- 采购台账读 → purchase 菜单；写 → purchase.write 按钮
UPDATE "AdminMenu"
SET "perms" = "perms" || ',GET /admin/purchases',
    "updatedAt" = now()
WHERE "code" = 'purchase'
  AND strpos("perms", 'GET /admin/purchases') = 0;

UPDATE "AdminMenu"
SET "perms" = "perms" || ',POST /admin/purchases',
    "updatedAt" = now()
WHERE "code" = 'purchase.write'
  AND strpos("perms", 'POST /admin/purchases') = 0;

-- 授权变更 bump 版本，15s 上下文缓存即刻失效
UPDATE "RbacState" SET "version" = "version" + 1 WHERE "id" = 'global';
