-- IKTU033 楼长推荐（楼栋行级）：楼长可设本店商品推荐与顺序，首页/货架排序自管
ALTER TABLE "NightProduct" ADD COLUMN "featured" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "NightProduct" ADD COLUMN "featuredSort" INTEGER NOT NULL DEFAULT 0;
