import type { AuthUser } from '../auth/jwt-auth.guard';

export type AdminRole = 'admin' | 'operations' | 'warehouse' | 'finance';
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
  | 'audit'
  | 'accounts';
export type AdminAccess = 'read' | 'write';

const ALL: AdminRole[] = ['admin', 'operations', 'warehouse', 'finance'];
const OPS: AdminRole[] = ['admin', 'operations'];

/**
 * 后台权限矩阵（ADR-0004 / IK9JHR，2026-08-18 道哥签字版）：
 *
 * | 板块            | admin | 运营       | 仓储 | 财务       |
 * |-----------------|-------|-----------|------|-----------|
 * | dashboard 工作台 | 读    | 读        | 读   | 读        |
 * | orders 订单      | 读写  | 读写      | 读   | 读        |
 * | products 商品    | 读写  | 读写      | 读写 | —         |
 * | categories 类别  | 读写  | 读写      | 读写 | —         |
 * | inventory 库存   | 读写  | 读写      | 读写 | —         |
 * | staff 员工/请假  | 读写  | 读写      | —    | —         |
 * | campuses 楼栋    | 读写  | 读写      | —    | —         |
 * | after-sales 售后 | 读    | 读        | 读   | 读（只读留档）|
 * | finance 结算/规则| 读写  | 读        | —    | 读写      |
 * | marketing 券/用户| 读写  | 读写      | —    | —         |
 * | audit 审计日志   | 读    | 读        | —    | 读        |
 *
 * 调度（dispatch-invitations）并入 staff 板块（员工/楼栋/调度同属运营域）。
 * 修改口径：先改这张表，不要散到各端点里加 if。
 */
export const ADMIN_MATRIX: Record<
  AdminSection,
  { read: AdminRole[]; write: AdminRole[] }
> = {
  dashboard: { read: ALL, write: [] },
  orders: { read: ALL, write: OPS },
  products: { read: [...OPS, 'warehouse'], write: [...OPS, 'warehouse'] },
  // 类别字典（2026-08-19 独立菜单）：人群与商品板块一致。
  categories: { read: [...OPS, 'warehouse'], write: [...OPS, 'warehouse'] },
  inventory: { read: [...OPS, 'warehouse'], write: [...OPS, 'warehouse'] },
  staff: { read: OPS, write: OPS },
  campuses: { read: OPS, write: OPS },
  'after-sales': { read: ALL, write: [] },
  finance: { read: [...OPS, 'finance'], write: ['admin', 'finance'] },
  marketing: { read: OPS, write: OPS },
  audit: { read: [...OPS, 'finance'], write: [] },
  // 账号管理（IK9KWO）：仅超管，防越权提权。
  accounts: { read: ['admin'], write: ['admin'] },
};

/** 判断后台角色对板块的读/写权限。非后台角色一律 false。 */
export function canAdmin(
  role: AuthUser['role'],
  section: AdminSection,
  access: AdminAccess,
): boolean {
  return (ADMIN_MATRIX[section][access] as string[]).includes(role);
}
