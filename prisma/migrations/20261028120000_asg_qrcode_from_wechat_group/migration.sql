-- IKQXSD 数据迁移（道哥 2026-10-28）：微信群码（校级大群）→ 售后福利群字段
-- 部署即有码零空窗：每校区取 buildingId 为空的校级群码，仅填空字段（幂等）。
-- 楼栋群不迁移（栋级群当全校区福利群语义不符）；工商闪电仓无校级群不迁。
UPDATE "Campus" c
SET "afterSalesGroupQrcode" = w.image
FROM "WechatGroup" w
WHERE w."campusId" = c.id
  AND w."buildingId" = ''
  AND c."afterSalesGroupQrcode" = '';
