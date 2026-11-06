ALTER TABLE "NightStockOrder" ADD COLUMN "requestId" TEXT;
CREATE UNIQUE INDEX "NightStockOrder_storeId_requestId_key" ON "NightStockOrder"("storeId", "requestId");
