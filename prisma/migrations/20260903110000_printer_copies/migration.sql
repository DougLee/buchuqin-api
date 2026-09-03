-- IKCZOX：小票多联打印——Printer.copies（1=单联无联名；2=商家+骑手；3=再加用户联）
-- 存量默认 1，行为与此前完全一致。
ALTER TABLE "Printer" ADD COLUMN "copies" INTEGER NOT NULL DEFAULT 1;
