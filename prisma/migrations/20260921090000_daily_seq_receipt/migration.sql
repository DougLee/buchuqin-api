-- IKHFDZ 商家联当日分拣序号：Order.dailySeq + 校区日计数表（原子发号）
ALTER TABLE "Order" ADD COLUMN "dailySeq" INTEGER;

CREATE TABLE "CampusDailySeq" (
    "id" TEXT NOT NULL,
    "campusId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CampusDailySeq_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CampusDailySeq_campusId_date_key" ON "CampusDailySeq"("campusId", "date");
