-- IKRGLV 用户行为埋点 MVP：转化漏斗+商品热度
CREATE TABLE "UserEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "campusId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "targetId" TEXT NOT NULL DEFAULT '',
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "UserEvent_campusId_event_createdAt_idx" ON "UserEvent"("campusId", "event", "createdAt");
CREATE INDEX "UserEvent_userId_createdAt_idx" ON "UserEvent"("userId", "createdAt");
