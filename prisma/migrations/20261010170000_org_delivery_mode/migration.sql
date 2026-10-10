-- IKKRMV 组织配送履约模式（ADR-0001 多租户）：
-- 'rider_delivery'=骑手小程序履约（组织 A 现状）| 'staff_delivery'=后台员工
-- 履约（组织 B）。幂等仅加列，默认值=存量等价零变化（存量组织全部保持
-- 骑手模式，两种模式共用订单状态语义，仅履约入口不同）。
ALTER TABLE "Organization" ADD COLUMN IF NOT EXISTS "deliveryMode" TEXT NOT NULL DEFAULT 'rider_delivery';
