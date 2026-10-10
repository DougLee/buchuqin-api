/** Non-delegable boundaries, independent of editable menu permissions. */
export function isSuperOnlyOperation(method: string, path: string): boolean {
  if (/^\/admin\/rbac\/(menus|roles|permissions|catalog)(\/|$)/.test(path)) return true;
  return method !== 'GET' && /^\/admin\/accounts(\/|$)/.test(path);
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
