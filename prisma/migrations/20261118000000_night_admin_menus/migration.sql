-- IKW9WP：夜宵经营菜单族（g.night 八节点）落库。
-- syncRegistry 只在"从未初始化"时首灌全量节点；既有库（menusSeeded=true）
-- 新增节点必须走显式迁移——本迁移即该显式落库，字段与 registry.ts 逐字对齐。
-- 幂等：按 code 存在性跳过；父目录被人为删除则整族跳过（数据库为唯一
-- 真源，不复活已删菜单）；有插入时 bump RbacState.version 刷新前端缓存。
DO $$
DECLARE
  g_night_id TEXT;
  parent_id  TEXT;
  inserted   INTEGER := 0;
BEGIN
  -- 目录：g.night 夜宵经营（type 0）
  IF NOT EXISTS (SELECT 1 FROM "AdminMenu" WHERE "code" = 'g.night') THEN
    INSERT INTO "AdminMenu" ("id", "code", "name", "type", "perms", "path", "viewPath", "icon", "orderNum", "isShow", "status", "updatedAt")
    VALUES ('g-night-20261118', 'g.night', '夜宵经营', 0, '', '', '', '', 7, true, 'active', CURRENT_TIMESTAMP);
    inserted := inserted + 1;
  END IF;

  SELECT "id" INTO g_night_id FROM "AdminMenu" WHERE "code" = 'g.night';
  -- 父目录不存在（被人为删除且无行）→ 整族跳过，不复活已删菜单
  IF g_night_id IS NULL THEN RETURN; END IF;

  -- 页面：night-stores 夜宵店铺（type 1）
  IF NOT EXISTS (SELECT 1 FROM "AdminMenu" WHERE "code" = 'night-stores') THEN
    INSERT INTO "AdminMenu" ("id", "code", "parentId", "name", "type", "perms", "path", "viewPath", "icon", "orderNum", "isShow", "status", "updatedAt")
    VALUES ('night-stores-20261118', 'night-stores', g_night_id, '夜宵店铺', 1,
      'GET /admin/night/stores,GET /admin/night/stores/:id,GET /admin/night/stores/:id/stock-txns,GET /admin/night/stores/:id/deposit-txns,GET /admin/night/stores/:id/liquidation,GET /admin/night/catalog,GET /admin/night/store-products,GET /admin/night/catalog/candidates,GET /admin/night/stock-orders,GET /admin/night/inventory-reports,GET /admin/night/config,GET /admin/night/opening-requests,GET /admin/night/coupons',
      '/night-stores', 'night-stores', 'campus', 1, true, 'active', CURRENT_TIMESTAMP);
    inserted := inserted + 1;
  END IF;

  SELECT "id" INTO parent_id FROM "AdminMenu" WHERE "code" = 'night-stores';

  -- 按钮：night-stores.write 夜宵店铺管理（type 2）
  IF parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "AdminMenu" WHERE "code" = 'night-stores.write') THEN
    INSERT INTO "AdminMenu" ("id", "code", "parentId", "name", "type", "perms", "path", "viewPath", "icon", "orderNum", "isShow", "status", "updatedAt")
    VALUES ('night-stores-write-20261118', 'night-stores.write', parent_id, '夜宵店铺管理', 2,
      'POST /admin/night/stores,PATCH /admin/night/stores/:id,POST /admin/night/catalog,POST /admin/night/catalog/import,PATCH /admin/night/catalog/:id,POST /admin/night/stock-orders/:id/review,POST /admin/night/stock-orders/:id/ship,POST /admin/night/stock-orders/:id/cancel,POST /admin/night/inventory-reports/:id/review,POST /admin/night/stores/:id/products,PATCH /admin/night/stores/:id/products/:productId,POST /admin/night/stores/:id/products/:productId/stock,PUT /admin/night/config,POST /admin/night/opening-requests/:id/review',
      '', '', '', 1, true, 'active', CURRENT_TIMESTAMP);
    inserted := inserted + 1;
  END IF;

  -- 按钮：night-deposit 押金账务（type 2）
  IF parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "AdminMenu" WHERE "code" = 'night-deposit') THEN
    INSERT INTO "AdminMenu" ("id", "code", "parentId", "name", "type", "perms", "path", "viewPath", "icon", "orderNum", "isShow", "status", "updatedAt")
    VALUES ('night-deposit-20261118', 'night-deposit', parent_id, '押金账务', 2,
      'POST /admin/night/stores/:id/deposit/deduct,POST /admin/night/stores/:id/deposit/refund,GET /admin/night/stores/:id/deposit-refunds,POST /admin/night/stores/:id/deposit/refunds/:requestId/sync',
      '', '', '', 2, true, 'active', CURRENT_TIMESTAMP);
    inserted := inserted + 1;
  END IF;

  -- 页面：night-orders 夜宵订单（type 1）
  IF NOT EXISTS (SELECT 1 FROM "AdminMenu" WHERE "code" = 'night-orders') THEN
    INSERT INTO "AdminMenu" ("id", "code", "parentId", "name", "type", "perms", "path", "viewPath", "icon", "orderNum", "isShow", "status", "updatedAt")
    VALUES ('night-orders-20261118', 'night-orders', g_night_id, '夜宵订单', 1,
      'GET /admin/night/orders,GET /admin/night/orders/:id',
      '/night-orders', 'night-orders', 'orders', 2, true, 'active', CURRENT_TIMESTAMP);
    inserted := inserted + 1;
  END IF;

  SELECT "id" INTO parent_id FROM "AdminMenu" WHERE "code" = 'night-orders';

  -- 按钮：night-orders.refund 夜宵退款（type 2）
  IF parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "AdminMenu" WHERE "code" = 'night-orders.refund') THEN
    INSERT INTO "AdminMenu" ("id", "code", "parentId", "name", "type", "perms", "path", "viewPath", "icon", "orderNum", "isShow", "status", "updatedAt")
    VALUES ('night-orders-refund-20261118', 'night-orders.refund', parent_id, '夜宵退款', 2,
      'POST /admin/night/orders/:id/refund,POST /admin/night/orders/:id/refund/sync,POST /admin/night/orders/:id/after-sale/reject',
      '', '', '', 1, true, 'active', CURRENT_TIMESTAMP);
    inserted := inserted + 1;
  END IF;

  -- 页面：night-settlements 夜宵结算（type 1）
  IF NOT EXISTS (SELECT 1 FROM "AdminMenu" WHERE "code" = 'night-settlements') THEN
    INSERT INTO "AdminMenu" ("id", "code", "parentId", "name", "type", "perms", "path", "viewPath", "icon", "orderNum", "isShow", "status", "updatedAt")
    VALUES ('night-settlements-20261118', 'night-settlements', g_night_id, '夜宵结算', 1,
      'GET /admin/night/settlements',
      '/night-settlements', 'night-settlements', 'finance', 3, true, 'active', CURRENT_TIMESTAMP);
    inserted := inserted + 1;
  END IF;

  SELECT "id" INTO parent_id FROM "AdminMenu" WHERE "code" = 'night-settlements';

  -- 按钮：night-settlements.write 夜宵结算操作（type 2）
  IF parent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "AdminMenu" WHERE "code" = 'night-settlements.write') THEN
    INSERT INTO "AdminMenu" ("id", "code", "parentId", "name", "type", "perms", "path", "viewPath", "icon", "orderNum", "isShow", "status", "updatedAt")
    VALUES ('night-settlements-write-20261118', 'night-settlements.write', parent_id, '夜宵结算操作', 2,
      'POST /admin/night/settlements/settle,POST /admin/night/settlements/:batch/pay',
      '', '', '', 1, true, 'active', CURRENT_TIMESTAMP);
    inserted := inserted + 1;
  END IF;

  -- 有插入才 bump 版本（刷新前端 permmenu 缓存）
  IF inserted > 0 THEN
    UPDATE "RbacState"
    SET "version" = "version" + 1, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = 'global';
  END IF;
END $$;
