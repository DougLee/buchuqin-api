-- AlterTable
ALTER TABLE "NightInventoryReport" ADD COLUMN     "compensationAmount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "depositTxnId" TEXT,
ADD COLUMN     "responsibility" TEXT;

-- CreateTable
CREATE TABLE "NightOpeningRequest" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "managerStaffId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "reviewReason" TEXT NOT NULL DEFAULT '',
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NightOpeningRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NightOpeningRequest_storeId_status_startAt_endAt_idx" ON "NightOpeningRequest"("storeId", "status", "startAt", "endAt");

-- CreateIndex
CREATE UNIQUE INDEX "NightOpeningRequest_storeId_requestId_key" ON "NightOpeningRequest"("storeId", "requestId");

-- CreateIndex
CREATE UNIQUE INDEX "NightInventoryReport_depositTxnId_key" ON "NightInventoryReport"("depositTxnId");

-- AddForeignKey
ALTER TABLE "NightOpeningRequest" ADD CONSTRAINT "NightOpeningRequest_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "NightStore"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- A store has one current request awaiting the campus decision.
CREATE UNIQUE INDEX "NightOpeningRequest_one_pending" ON "NightOpeningRequest"("storeId") WHERE "status" = 'pending';
ALTER TABLE "NightInventoryReport" ADD CONSTRAINT "NightInventoryReport_compensation_nonnegative" CHECK ("compensationAmount" >= 0);
