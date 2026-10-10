ALTER TABLE "Product"
ADD COLUMN "procurementMode" TEXT,
ADD COLUMN "localPurchasePrice" INTEGER;

ALTER TABLE "Product"
ADD CONSTRAINT "Product_procurementMode_check"
CHECK ("procurementMode" IS NULL OR "procurementMode" IN ('HQ', 'LOCAL'));

ALTER TABLE "Product"
ADD CONSTRAINT "Product_localPurchasePrice_check"
CHECK ("localPurchasePrice" IS NULL OR "localPurchasePrice" >= 0);
