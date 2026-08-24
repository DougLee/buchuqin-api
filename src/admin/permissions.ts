import type { AuthUser } from '../auth/jwt-auth.guard';

export type AdminRole =
  | 'hq'
  | 'admin'
  | 'operations'
  | 'warehouse'
  | 'finance';
export type AdminSection =
  | 'dashboard'
  | 'orders'
  | 'products'
  | 'categories'
  | 'inventory'
  | 'staff'
  | 'campuses'
  | 'after-sales'
  | 'finance'
  | 'marketing'
  | 'banners'
  | 'audit'
  | 'accounts'
  | 'users'
  | 'wechat-groups';
export type AdminAccess = 'read' | 'write';

const ALL: AdminRole[] = ['admin', 'operations', 'warehouse', 'finance'];
const OPS: AdminRole[] = ['admin', 'operations'];

/**
 * 后台权限矩阵（ADR-0004 / IK9JHR，2026-08-18 道哥签字版；
 * IKAJSL 2026-08-24 增总部层：hq=总部长，campusId 空=跨校区视角）：
 *
 * | 板块            | hq 总部长 | admin | 运营       | 仓储 | 财务       |
 * |-----------------|----------|-------|-----------|------|-----------|
 * | dashboard 工作台 | 读(跨校区汇总)| 读 | 读        | 读   | 读        |
 * | orders 订单      | 读(全校区) | 读写 | 读写      | 读   | 读        |
 * | products 商品    | 读写(官方库)| 读写 | 读写      | 读写 | —        |
 * | categories 类别  | 读写    | 读写  | 读写      | 读写 | —         |
 * | inventory 库存   | —       | 读写  | 读写      | 读写 | —         |
 * | staff 员工/请假  | —       | 读写  | 读写      | —    | —         |
 * | campuses 校区/楼栋| 读写(全部校区)| 读写(本校区) | 读写 | —   | —      |
 * | after-sales 售后 | —       | 读    | 读        | 读   | 读（只读留档）|
 * | finance 结算/规则| —       | 读写  | 读        | —    | 读写      |
 * | marketing 促销/券| —       | 读写  | 读写      | —    | —         |
 * | banners Banner   | 读写(投放)| —   | —         | —    | —         |
 * | audit 审计日志   | 读(全校区)| 读   | 读        | —    | 读        |
 * | accounts 账号    | 读写(全部)| 读写(本校区) | —   | —    | —        |
 * | users C端用户    | 读(全校区) | 读  | 读        | —    | —         |
 * | wechat-groups 群码| —      | 读写  | 读写      | —    | —         |
 *
 * Banner 归总部投放（IKAJSL 决策），从校区 marketing 拆出独立板块；
 * 促销/优惠券/群码仍归校区（marketing/wechat-groups 不含 hq）。
 * 校区本体增改（POST/PATCH /campuses）在 controller 里限定 hq。
 * 调度（dispatch-invitations）并入 staff 板块（员工/楼栋/调度同属运营域）。
 * 修改口径：先改这张表，不要散到各端点里加 if。
 */
export const ADMIN_MATRIX: Record<
  AdminSection,
  { read: AdminRole[]; write: AdminRole[] }
> = {
  // hq 无 campusId → dashboard 走跨校区汇总分支
  dashboard: { read: [...ALL, 'hq'], write: [] },
  // hq 只读全校区（履约操作是校区侧职责）
  orders: { read: [...ALL, 'hq'], write: OPS },
  // hq 的商品板块 = 官方商品库（IKAJSM，落特殊官方库校区）
  products: { read: [...OPS, 'warehouse', 'hq'], write: [...OPS, 'warehouse', 'hq'] },
  // 类别字典（2026-08-19 独立菜单）：全局字典，总部统一维护。
  categories: { read: [...OPS, 'warehouse', 'hq'], write: [...OPS, 'warehouse', 'hq'] },
  inventory: { read: [...OPS, 'warehouse'], write: [...OPS, 'warehouse'] },
  staff: { read: OPS, write: OPS },
  campuses: { read: [...OPS, 'hq'], write: [...OPS, 'hq'] },
  'after-sales': { read: ALL, write: [] },
  finance: { read: [...OPS, 'finance'], write: ['admin', 'finance'] },
  marketing: { read: OPS, write: OPS },
  // Banner 总部投放（IKAJSL）：校区侧不再可见（原属 marketing）。
  banners: { read: ['hq'], write: ['hq'] },
  audit: { read: [...OPS, 'finance', 'hq'], write: [] },
  // 账号管理（IK9KWO）：hq 管全部账号（含建 hq），admin 管本校区职能账号。
  accounts: { read: ['hq', 'admin'], write: ['hq', 'admin'] },
  // C 端用户管理（IKAJSW）：运营域只读；hq 跨校区只读。
  users: { read: [...OPS, 'hq'], write: [] },
  // 微信群二维码（IKAJSY）：组织营销域（校区自主）。
  'wechat-groups': { read: OPS, write: OPS },
};

/** 判断后台角色对板块的读/写权限。非后台角色一律 false。 */
export function canAdmin(
  role: AuthUser['role'],
  section: AdminSection,
  access: AdminAccess,
): boolean {
  return (ADMIN_MATRIX[section][access] as string[]).includes(role);
}
