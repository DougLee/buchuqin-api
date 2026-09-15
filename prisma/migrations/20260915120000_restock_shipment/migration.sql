-- IKFOQ2 分拨发货：发货单一对一面挂订货单，行快照供毛利②
-- CreateEnum 不涉及（status 均为 String）

CREATE TABLE "RestockShipment" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "campusId" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "shippedBy" TEXT NOT NULL,
    "shippedByName" TEXT NOT NULL DEFAULT '',
    "shippedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedBy" TEXT,
    "receivedByName" TEXT NOT NULL DEFAULT '',
    "receivedAt" TIMESTAMP(3),

    CONSTRAINT "RestockShipment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RestockShipmentItem" (
    "id" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "cases" INTEGER NOT NULL,
    "unitsPerCase" INTEGER NOT NULL,
    "costPerCase" INTEGER NOT NULL,
    "wholesalePerCase" INTEGER NOT NULL,

    CONSTRAINT "RestockShipmentItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RestockShipment_orderId_key" ON "RestockShipment"("orderId");
CREATE INDEX "RestockShipment_batchId_idx" ON "RestockShipment"("batchId");
CREATE INDEX "RestockShipment_campusId_idx" ON "RestockShipment"("campusId");

CREATE UNIQUE INDEX "RestockShipmentItem_shipmentId_productId_key" ON "RestockShipmentItem"("shipmentId", "productId");
CREATE INDEX "RestockShipmentItem_productId_idx" ON "RestockShipmentItem"("productId");

ALTER TABLE "RestockShipment" ADD CONSTRAINT "RestockShipment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "RestockOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RestockShipment" ADD CONSTRAINT "RestockShipment_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "RestockBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RestockShipmentItem" ADD CONSTRAINT "RestockShipmentItem_shipmentId_fkey" FOREIGN KEY ("shipmentId") REFERENCES "RestockShipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RestockShipmentItem" ADD CONSTRAINT "RestockShipmentItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
