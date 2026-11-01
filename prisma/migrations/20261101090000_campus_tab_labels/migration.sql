-- IKS0W7：栏目标签文案校区级可配（分类页侧栏+首页栏目），空=前端回落默认
ALTER TABLE "Campus" ADD COLUMN "seckillLabel" TEXT;
ALTER TABLE "Campus" ADD COLUMN "featuredLabel" TEXT;
ALTER TABLE "Campus" ADD COLUMN "homeFeaturedLabel" TEXT;
ALTER TABLE "Campus" ADD COLUMN "clearanceLabel" TEXT;
