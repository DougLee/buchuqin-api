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
  | 'buildings'
  | 'after-sales'
  | 'finance'
  | 'marketing'
  | 'banners'
  | 'printers'
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
 * | campuses 校区管理| 读写(全部校区)| 读写(本校区+本体，IKBWRT) | 只读(菜单隐藏) | —   | —      |
 * | buildings 楼栋管理| —       | 读写(本校区，IKCRS8) | 读写(本校区) | —    | —      |
 * | after-sales 售后 | —       | 读    | 读        | 读   | 读（只读留档）|
 * | finance 结算/规则| —       | 读写  | 读        | —    | 读写      |
 * | marketing 促销/券| —       | 读写  | 读写      | —    | —         |
 * | banners Banner   | —       | 读写(本校区)| —    | —    | —         |
 * | printers 打印机  | —       | 读写(本校区)| —    | —    | —         |
 * | audit 审计日志   | 读(全校区)| 读   | 读        | —    | 读        |
 * | accounts 账号    | 读写(全部)| 读写(全部，IKBFJ4) | —   | —    | —        |
 * | users C端用户    | 读(全校区) | 读  | 读        | —    | —         |
 * | wechat-groups 群码| —      | 读写  | 读写      | —    | —         |
 *
 * Banner 校区自管（IKBW0A 2026-08-29：投放范围概念废止，校区各自管理各自的
 * Banner/广告位，hq 移出；原「归总部投放」IKAJSL 决策作废），从校区 marketing
 * 拆出独立板块；促销/优惠券/群码仍归校区（marketing/wechat-groups 不含 hq）。
 * 校区本体增改（POST/PATCH /campuses）在 controller 里限定 hq + admin（IKBWRT
 * 2026-08-29：admin 平台超管全菜单操作权限；operations 仍限楼栋域）。
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
  // 楼栋/寝室管理（IKCRS8 2026-09-02：从 campuses 拆独立键）——挂本校区
  // （顶栏切换运营校区定上下文）；hq 无楼栋入口；warehouse/finance 收口移除
  //（修漂移：此前 warehouse 前端菜单显示但 campuses 矩阵无权 403）。
  buildings: { read: OPS, write: OPS },
  'after-sales': { read: ALL, write: [] },
  finance: { read: [...OPS, 'finance'], write: ['admin', 'finance'] },
  marketing: { read: OPS, write: OPS },
  // Banner 校区自管（IKBW0A 2026-08-29）：各校区管理员管本校区 Banner/广告位，
  // hq 不再做投放（原 IKAJSL「总部投放」及 2026-08-26 admin 跨校区开放作废）。
  banners: { read: ['admin'], write: ['admin'] },
  // 校区打印机绑定（IKBW0Q 2026-08-29）：校区自主绑定/管理小票机，与 banners 同口径。
  printers: { read: ['admin'], write: ['admin'] },
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

/**
 * 平台视角角色（IKCHEW 2026-09-01 道哥定版）：hq 总部长 + admin 平台超管，
 * 数据范围同跨校区口径（dashboard/orders/users/audit 全校区、官方库建档）。
 * 只用于「数据范围」判定；板块读写仍以 ADMIN_MATRIX 为准。
 * admin 仍保留 campusId 校区归属：校区域写（履约/库存/Banner/打印机）
 * 与商品「本校区视角」以本校区为上下文（campusScope/productCampus 见 controller）。
 */
export function isHqScope(role: AuthUser['role']): boolean {
  return role === 'hq' || role === 'admin';
}
