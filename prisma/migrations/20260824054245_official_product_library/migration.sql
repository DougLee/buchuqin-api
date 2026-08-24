/*
  Warnings:

  - A unique constraint covering the columns `[campusId,barcode]` on the table `Product` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "Product_barcode_key";

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "sourceProductId" TEXT,
ADD COLUMN     "sourceSyncedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "Product_campusId_barcode_key" ON "Product"("campusId", "barcode");

-- 官方商品库伪校区（IKAJSL/IKAJSM 道哥决策版）：status=official，
-- campuses() 列表与用户端选校区流程均排除；hq 商品板块读写都落这个"校区"。
INSERT INTO "Campus" ("id","name","shortName","warehouseName","address","status","deliveryFeeInstant","deliveryFeeScheduled","deliveryThreshold","createdAt")
VALUES ('campus-official', '官方商品库', '官方库', '总部官方库', '', 'official', 0, 0, 0, NOW())
ON CONFLICT (id) DO NOTHING;
