-- 菜单不再区分内置节点与自建节点，全部由后台统一维护。
ALTER TABLE "AdminMenu" DROP COLUMN "builtin";

