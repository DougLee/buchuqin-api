-- CreateTable
CREATE TABLE "LotteryWheel" (
    "id" TEXT NOT NULL,
    "campusId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "prizes" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LotteryWheel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LotteryDraw" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "wheelId" TEXT NOT NULL,
    "drawDate" TEXT NOT NULL,
    "prizeIndex" INTEGER NOT NULL,
    "prizeType" TEXT NOT NULL,
    "userCouponId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LotteryDraw_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LotteryWheel_campusId_key" ON "LotteryWheel"("campusId");

-- CreateIndex
CREATE UNIQUE INDEX "LotteryDraw_userId_drawDate_key" ON "LotteryDraw"("userId", "drawDate");

-- CreateIndex
CREATE INDEX "LotteryDraw_userId_createdAt_idx" ON "LotteryDraw"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "LotteryWheel" ADD CONSTRAINT "LotteryWheel_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LotteryDraw" ADD CONSTRAINT "LotteryDraw_wheelId_fkey" FOREIGN KEY ("wheelId") REFERENCES "LotteryWheel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
