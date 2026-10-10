import { PrismaService } from '../database/prisma.service';

/**
 * IKKRMO（ADR-0001）：AppID → 组织身份解析工具。
 *
 * 多租户铁律——组织身份唯一可信来源是**服务端 code2session 实际使用的
 * AppID**（客户端 body.appid 只用于挑选 env 凭证，伪造它组织 AppID 拿不到
 * 对应 secret，code2session 必失败）。任何端点不接受客户端传
 * organizationId/组织参数，本模块是组织身份的唯一入口。
 */

/** 解析结果：仅携带鉴权所需字段，不含 wxSecret 等敏感凭据。 */
export interface ResolvedOrganization {
  id: string;
  name: string;
  status: string;
}

/**
 * 按小程序 AppID 解析组织：
 * - 命中 Organization.wxAppId → 返回该组织：登录/注册/切校区/校区列表全部
 *   限定在该组织校区集合内（跨组织一律 400/403 拒绝）。
 * - 未命中任何组织 → 返回 null：走 env 单组织兼容路径，现有行为零改动。
 *   组织 A 现状（wxAppId 未登记）即此路径——待 IKKRMS 组织 B 开通流程在
 *   「组织管理」页登记 wxAppId 后生效；组织 A 的 env WX_APPID_USER 继续
 *   兜底凭证，本任务不回填 org-a.wxAppId。
 *
 * 注：不过滤 status——若按 status=active 过滤，停用组织的 AppID 会掉进
 * null 兼容路径看到全部校区（权限扩大），比维持组织校区集合限定更危险；
 * 停用组织的登录处置属 IKKRMP。
 */
export async function resolveOrganizationByAppId(
  db: PrismaService,
  appId?: string | null,
): Promise<ResolvedOrganization | null> {
  const appid = appId?.trim();
  if (!appid) return null;
  const org = await db.organization.findFirst({
    where: { wxAppId: appid },
    select: { id: true, name: true, status: true },
  });
  return org ?? null;
}

/**
 * 校区 → 组织归属（Campus.organizationId；不存在/无归属返回 null）。
 * 用户与员工表均**不落**组织字段，组织身份一律从校区推导——这里是从
 * campusId 推导组织唯一入口（与登录侧 AppID 解析殊途同归，杜绝客户端直传）。
 */
export async function campusOrganizationId(
  db: PrismaService,
  campusId?: string | null,
): Promise<string | null> {
  if (!campusId) return null;
  const campus = await db.campus.findUnique({
    where: { id: campusId },
    select: { organizationId: true },
  });
  return campus?.organizationId ?? null;
}

/** IKKRMV：组织配送履约模式（Organization.deliveryMode 值域）。 */
export type DeliveryMode = 'rider_delivery' | 'staff_delivery';

/**
 * 校区是否按「后台员工配送」履约（IKKRMV）：校区→组织→deliveryMode
 * ='staff_delivery' 才为 true；无组织归属/组织行缺失/默认值一律 false
 * ——组织 A（org-a 存量默认值）与平台伪校区行为零变化。
 * 消费点：骑手任务池/派单通知跳过（不入池不通知）+ 后台 staff-deliver/
 * staff-complete 动作门禁（骑手模式校区不认员工配送动作）。
 */
export async function campusStaffDelivery(
  db: PrismaService,
  campusId?: string | null,
): Promise<boolean> {
  const organizationId = await campusOrganizationId(db, campusId);
  if (!organizationId) return false;
  const org = await db.organization.findUnique({
    where: { id: organizationId },
    select: { deliveryMode: true },
  });
  return org?.deliveryMode === 'staff_delivery';
}
