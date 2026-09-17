-- IKGNMV 补充（2026-09-17 道哥拍板）：新校区默认 24 小时营业（不打烊）
ALTER TABLE "Campus" ALTER COLUMN "closeStart" SET DEFAULT '00:00';
ALTER TABLE "Campus" ALTER COLUMN "closeEnd" SET DEFAULT '00:00';
