/** Non-delegable boundaries, independent of editable menu permissions. */
export function isSuperOnlyOperation(method: string, path: string): boolean {
  if (/^\/admin\/rbac\/(menus|roles|permissions|catalog)(\/|$)/.test(path)) return true;
  if (method !== 'GET' && /^\/admin\/accounts(\/|$)/.test(path)) return true;
  // IKKRMS：组织维护与开通=平台超管动作（建组/微信配置/启停/开通组织 B）；
  // registry organizations.write 按钮节点仅供目录展示与角色编辑，判权不消费
  //（同账号管理先例）。读端点仍走菜单 perms（平台级能力）。
  return method !== 'GET' && /^\/admin\/organizations(\/|$)/.test(path);
}

/** Platform operations cannot be granted through a campus-scoped role. */
export const PLATFORM_PATTERNS = [
  'GET /admin/accounts', 'GET /admin/rbac/accounts/:id/preview',
  'GET /admin/rbac/audit', 'GET /admin/reports/hq-daily',
  // IKKRMM：多租户组织读端点为平台层能力（跨组织视角），校区级角色不可授予
  'GET /admin/organizations', 'GET /admin/organizations/:id',
  // IKKRMW（ADR-0001 决策 3）：平台商品目录归平台层，校区级角色不可授予
  // （组织从目录导入走 IKKRMX 的组织级端点）
  'GET /admin/platform-products', 'POST /admin/platform-products',
  'PATCH /admin/platform-products/:id',
  // IKKRMX（ADR-0001 决策 4）：组织商品目录归平台/组织层——校区级角色不可
  // 授予；组织级账号持平台级授权（org-admin 预设口径）可入。数据边界由控制
  // 器 orgTarget 按 ctx.orgLevel/organizationId 收口：平台账号 ?organizationId
  // 必填，组织级账号恒本组织（显式传参越组织 403）。
  'GET /admin/org-products', 'POST /admin/org-products',
  'PATCH /admin/org-products/:id', 'POST /admin/org-products/:id/import',
  'POST /admin/campuses', 'PATCH /admin/campuses/:id',
  'POST /admin/inventory/stock-in',
  'POST /admin/restock/batches', 'PATCH /admin/restock/batches/:id',
  'POST /admin/restock/batches/:id/close',
  'POST /admin/restock/orders/:id/audit', 'POST /admin/restock/orders/:id/ship',
  'POST /admin/restock/batches/:batchId/purchase-order',
  'GET /admin/purchase/orders', 'GET /admin/purchase/orders/:id',
  'POST /admin/purchase/orders/:id/receive',
  'POST /admin/purchase/orders/:id/close', 'POST /admin/purchase/orders/:id/reopen',
];
