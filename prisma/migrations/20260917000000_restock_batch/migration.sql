-- IKFOQ0：订货批次（进销存③）
CREATE TABLE "RestockBatch" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "createdBy" TEXT NOT NULL,
    "createdByName" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RestockBatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RestockBatchItem" (
    "batchId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,

    CONSTRAINT "RestockBatchItem_pkey" PRIMARY KEY ("batchId","productId")
);

CREATE TABLE "RestockOrder" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "campusId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "submitBy" TEXT,
    "submitByName" TEXT NOT NULL DEFAULT '',
    "submittedAt" TIMESTAMP(3),
    "auditBy" TEXT,
    "auditByName" TEXT NOT NULL DEFAULT '',
    "auditNote" TEXT NOT NULL DEFAULT '',
    "auditAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RestockOrder_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RestockOrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "cases" INTEGER NOT NULL,
    "unitsPerCase" INTEGER NOT NULL,
    "remark" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "RestockOrderItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RestockOrder_campusId_status_idx" ON "RestockOrder"("campusId", "status");
CREATE UNIQUE INDEX "RestockOrder_batchId_campusId_key" ON "RestockOrder"("batchId", "campusId");
CREATE UNIQUE INDEX "RestockOrderItem_orderId_productId_key" ON "RestockOrderItem"("orderId", "productId");

ALTER TABLE "RestockBatchItem" ADD CONSTRAINT "RestockBatchItem_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "RestockBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RestockBatchItem" ADD CONSTRAINT "RestockBatchItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RestockOrder" ADD CONSTRAINT "RestockOrder_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "RestockBatch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RestockOrder" ADD CONSTRAINT "RestockOrder_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RestockOrderItem" ADD CONSTRAINT "RestockOrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "RestockOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RestockOrderItem" ADD CONSTRAINT "RestockOrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
