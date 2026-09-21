/** Non-delegable boundaries, independent of editable menu permissions. */
export function isSuperOnlyOperation(method: string, path: string): boolean {
  if (/^\/admin\/rbac\/(menus|roles|permissions|catalog)(\/|$)/.test(path)) return true;
  return method !== 'GET' && /^\/admin\/accounts(\/|$)/.test(path);
}

/** Platform operations cannot be granted through a campus-scoped role. */
export const PLATFORM_PATTERNS = [
  'GET /admin/accounts', 'GET /admin/rbac/accounts/:id/preview',
  'GET /admin/rbac/audit', 'GET /admin/reports/hq-daily',
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
