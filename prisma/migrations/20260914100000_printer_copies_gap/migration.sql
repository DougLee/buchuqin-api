-- IKFFHO：多联小票联间发送间隔（0=现状单次 POST 拼联；1-5 逐联推送）
ALTER TABLE "Printer" ADD COLUMN "copiesGapSeconds" INTEGER NOT NULL DEFAULT 0;
