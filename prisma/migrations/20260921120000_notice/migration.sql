-- IKHM1P 小程序公告：校区多条+生效窗+启停
CREATE TABLE "Notice" (
    "id" TEXT NOT NULL,
    "campusId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Notice_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Notice_campusId_status_idx" ON "Notice"("campusId", "status");
ALTER TABLE "Notice" ADD CONSTRAINT "Notice_campusId_fkey" FOREIGN KEY ("campusId") REFERENCES "Campus"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
