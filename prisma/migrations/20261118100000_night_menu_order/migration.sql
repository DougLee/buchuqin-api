-- IKW9WP 追问：夜宵经营菜单组挪位——组织管理(5)之下、财务系统(7)之上。
-- 生产库存在漂移：g.sys 实际 orderNum=7（registry 定义 8），g.night 也是 7
-- （并列导致排序不稳定，夜宵组掉到最底）。本迁移按 registry 新口径收敛：
--   g.ops=1 g.wh=2 g.supply=3 g.mkt=4 g.org=5 g.night=6 g.fin=7 g.sys=8
-- 幂等：重复执行写同值无副作用；bump RbacState.version 刷新前端菜单缓存。
UPDATE "AdminMenu" SET "orderNum" = 6, "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" = 'g.night' AND "orderNum" <> 6;
UPDATE "AdminMenu" SET "orderNum" = 7, "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" = 'g.fin' AND "orderNum" <> 7;
UPDATE "AdminMenu" SET "orderNum" = 8, "updatedAt" = CURRENT_TIMESTAMP
WHERE "code" = 'g.sys' AND "orderNum" <> 8;

UPDATE "RbacState" SET "version" = "version" + 1, "updatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'global';
