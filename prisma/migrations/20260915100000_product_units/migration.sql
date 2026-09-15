-- IKFOPU：商品单位属性（零售单位/批发单位/每件含量）
-- 存量默认：零售单位空串（展示处不显示单位文字，行为不变）、批发单位「件」、含量 1
ALTER TABLE "Product" ADD COLUMN "retailUnit" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Product" ADD COLUMN "wholesaleUnit" TEXT NOT NULL DEFAULT '件';
ALTER TABLE "Product" ADD COLUMN "unitsPerCase" INTEGER NOT NULL DEFAULT 1;
