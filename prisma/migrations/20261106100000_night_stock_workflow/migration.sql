-- Approved stock workflow: additive migration; legacy completed stock orders stay completed.
ALTER TABLE "Product" ADD COLUMN "nightBarcode" TEXT,
  ADD COLUMN "nightReservedStock" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "warehouseProductId" TEXT;
ALTER TABLE "Product" ADD CONSTRAINT "Product_warehouseProductId_fkey"
  FOREIGN KEY ("warehouseProductId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "NightProduct" ADD COLUMN "frozenStock" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "inventoryValue" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "inventoryVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "NightOrder" ADD COLUMN "inventoryRestocked" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "quotaHeld" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "NightStockOrder" ADD COLUMN "heldValue" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "reason" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "receivedAt" TIMESTAMP(3), ADD COLUMN "reviewedAt" TIMESTAMP(3),
  ADD COLUMN "reviewedBy" TEXT, ADD COLUMN "shippedAt" TIMESTAMP(3), ADD COLUMN "shippedBy" TEXT,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "NightStockOrder" ALTER COLUMN "status" SET DEFAULT 'requested';
CREATE TABLE "NightInventoryReport" (
  "id" TEXT NOT NULL PRIMARY KEY, "storeId" TEXT NOT NULL, "managerStaffId" TEXT NOT NULL,
  "kind" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'pending', "requestId" TEXT NOT NULL,
  "stockOrderId" TEXT, "items" JSONB NOT NULL, "reason" TEXT NOT NULL, "photos" JSONB,
  "heldValue" INTEGER NOT NULL DEFAULT 0, "reviewReason" TEXT NOT NULL DEFAULT '',
  "reviewedBy" TEXT, "reviewedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "NightInventoryReport_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "NightStore"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "NightInventoryReport_stockOrderId_fkey" FOREIGN KEY ("stockOrderId") REFERENCES "NightStockOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "NightInventoryReport_storeId_requestId_key" ON "NightInventoryReport"("storeId", "requestId");
CREATE INDEX "NightInventoryReport_storeId_status_idx" ON "NightInventoryReport"("storeId", "status");
CREATE INDEX "NightInventoryReport_stockOrderId_idx" ON "NightInventoryReport"("stockOrderId");

-- Preserve historical valuation before any later sale-price changes.
UPDATE "NightProduct" n SET "inventoryValue" = n.stock * p.price FROM "Product" p WHERE p.id = n."catalogProductId";
UPDATE "NightOrder" o SET "quotaHeld" = COALESCE((SELECT SUM((x->>'quantity')::int * (x->>'price')::int)
  FROM jsonb_array_elements(o.items) x), 0)
  WHERE o.status IN ('pending-payment', 'pending-accept', 'delivering');
-- Legacy cancellations/refunds may already have returned goods before this flag existed.
UPDATE "NightOrder" o SET "inventoryRestocked" = true WHERE o.status = 'cancelled'
  OR EXISTS (SELECT 1 FROM "NightStockTxn" t WHERE t."refType" = 'night-order' AND t."refId" = o.id AND t.type = 'refundBack');

-- One physical campus SKU owns the barcode. Channel copies keep an independent display snapshot.
UPDATE "Product" SET "nightBarcode" = barcode, barcode = NULL WHERE "nightCatalog" = true;
UPDATE "Product" n SET "warehouseProductId" = (
  SELECT w.id FROM "Product" w WHERE w."campusId" = n."campusId" AND w."nightCatalog" = false
  AND ((n."sourceProductId" IS NOT NULL AND w."sourceProductId" = n."sourceProductId")
    OR (n."nightBarcode" IS NOT NULL AND w.barcode = n."nightBarcode")) ORDER BY w.id LIMIT 1
) WHERE n."nightCatalog" = true;
-- Existing building stock is already outside the warehouse; creating a SKU never invents stock.
INSERT INTO "Product" (id, "campusId", "categoryId", name, subtitle, price, "originalPrice", stock,
  tag, image, weight, status, barcode, "sourceProductId", "retailUnit", "wholesaleUnit", "unitsPerCase")
SELECT 'nw_' || md5(n.id), n."campusId", n."categoryId", n.name, n.subtitle, n.price, n."originalPrice", 0,
  n.tag, n.image, n.weight, 'off-sale', n."nightBarcode", n."sourceProductId", n."retailUnit", n."wholesaleUnit", n."unitsPerCase"
FROM "Product" n WHERE n."nightCatalog" = true AND n."warehouseProductId" IS NULL;
UPDATE "Product" SET "warehouseProductId" = 'nw_' || md5(id)
  WHERE "nightCatalog" = true AND "warehouseProductId" IS NULL;

ALTER TABLE "Product" ADD CONSTRAINT "night_reserved_nonnegative" CHECK ("nightReservedStock" >= 0);
ALTER TABLE "NightProduct" ADD CONSTRAINT "night_inventory_nonnegative" CHECK ("inventoryValue" >= 0 AND "frozenStock" >= 0);
ALTER TABLE "NightStockOrder" ADD CONSTRAINT "night_stock_hold_nonnegative" CHECK ("heldValue" >= 0);
ALTER TABLE "NightInventoryReport" ADD CONSTRAINT "night_report_hold_nonnegative" CHECK ("heldValue" >= 0);
-- Extend existing night menu grants; no new roles or cross-campus authorization.
UPDATE "AdminMenu" m SET perms = (
  SELECT string_agg(DISTINCT p, ',') FROM unnest(string_to_array(m.perms, ',') || ARRAY[
    'GET /admin/night/catalog/candidates', 'GET /admin/night/stock-orders', 'GET /admin/night/inventory-reports'
  ]) AS p WHERE p <> ''
) WHERE m.code = 'night-stores';
UPDATE "AdminMenu" m SET perms = (
  SELECT string_agg(DISTINCT p, ',') FROM unnest(string_to_array(m.perms, ',') || ARRAY[
    'POST /admin/night/catalog/import', 'POST /admin/night/stock-orders/:id/review',
    'POST /admin/night/stock-orders/:id/ship', 'POST /admin/night/stock-orders/:id/cancel',
    'POST /admin/night/inventory-reports/:id/review'
  ]) AS p WHERE p <> ''
) WHERE m.code = 'night-stores.write';
UPDATE "RbacState" SET version = version + 1, "updatedAt" = CURRENT_TIMESTAMP WHERE id = 'global';
