-- IKA0VG 库位管理：库位字典表 + 商品库位编号（location=区域下拉，locationCode=编号手填）

-- CreateTable
CREATE TABLE "StorageLocation" (
    "id" TEXT NOT NULL,
    "campusId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "sort" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StorageLocation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StorageLocation_campusId_sort_idx" ON "StorageLocation"("campusId", "sort");

-- AddForeignKey
ALTER TABLE "StorageLocation" ADD CONSTRAINT "StorageLocation_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable：商品加库位编号
ALTER TABLE "Product" ADD COLUMN "locationCode" TEXT NOT NULL DEFAULT '';
