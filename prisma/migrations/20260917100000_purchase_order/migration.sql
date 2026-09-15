-- IKFOQ1 采购汇总：供应商采购单 + 行（批次已确认订货单聚合，验收入总部仓）
CREATE TABLE "PurchaseOrder" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "supplierName" TEXT NOT NULL,
    "closedAt" TIMESTAMP(3),
    "closedNote" TEXT NOT NULL DEFAULT '',
    "closedBy" TEXT NOT NULL DEFAULT '',
    "closedByName" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT NOT NULL,
    "createdByName" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PurchaseOrder_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PurchaseOrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "requiredCases" INTEGER NOT NULL,
    "receivedCases" INTEGER NOT NULL DEFAULT 0,
    "badCases" INTEGER NOT NULL DEFAULT 0,
    "unitCost" INTEGER NOT NULL,
    "unitsPerCase" INTEGER NOT NULL,
    "lastNote" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "PurchaseOrderItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PurchaseOrder_batchId_idx" ON "PurchaseOrder"("batchId");

CREATE UNIQUE INDEX "PurchaseOrderItem_orderId_productId_key" ON "PurchaseOrderItem"("orderId", "productId");

ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "PurchaseOrder_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "RestockBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "PurchaseOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PurchaseOrderItem" ADD CONSTRAINT "PurchaseOrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
