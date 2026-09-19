import { PrismaService } from '../database/prisma.service';
import { RbacService, matchUrl } from './rbac/rbac.service';
import { legacyRbacCtx } from './rbac/spec-fixtures';
import { ADMIN_URL_WHITELIST } from './rbac/registry';
import {
  concreteRoute,
  listAdminRoutes,
  uncoveredRoutes,
} from './rbac/route-inventory';

/**
 * RBAC 蛋词体系（2026-09-19 拍板 B）单元测试：
 * - matchUrl 模式匹配内核（:seg 通配/方法区分/多模式/尾斜杠）；
 * - 旧五角色（LEGACY_ROLE_MAP→ROLE_TEMPLATES 推导上下文）的关键 URL 模式
 *   allow/deny 对账（冻结旧 ADMIN_MATRIX 的代表性端点，写语义无缩水）；
 * - 有意行为变化逐条钉死（URL 通配固有语义 + V1 遗留收权）；
 * - 模式覆盖自检：AdminController 每条路由必须被 ≥1 个 registry 模式覆盖
 *   或在守卫白名单内（漏配即红——本任务的自检闭环）。
 */

describe('matchUrl（蛋词模式匹配内核）', () => {
  it(':seg 通配单段；段数不同不匹配', () => {
    expect(matchUrl(['GET /admin/orders/:id'], 'GET', '/admin/orders/abc123')).toBe(true);
    expect(matchUrl(['GET /admin/orders/:id'], 'GET', '/admin/orders')).toBe(false);
    expect(matchUrl(['GET /admin/orders/:id'], 'GET', '/admin/orders/a/b')).toBe(false);
  });
  it('方法严格区分（同路径不同 method 拒）', () => {
    expect(matchUrl(['PATCH /admin/products/:id'], 'PATCH', '/admin/products/x')).toBe(true);
    expect(matchUrl(['PATCH /admin/products/:id'], 'POST', '/admin/products/x')).toBe(false);
    expect(matchUrl(['PATCH /admin/products/:id'], 'GET', '/admin/products/x')).toBe(false);
  });
  it('多模式并集：命中任一即放行', () => {
    const pats = ['GET /admin/orders', 'GET /admin/orders/status-counts'];
    expect(matchUrl(pats, 'GET', '/admin/orders')).toBe(true);
    expect(matchUrl(pats, 'GET', '/admin/orders/status-counts')).toBe(true);
    expect(matchUrl(pats, 'GET', '/admin/orders/other')).toBe(false);
  });
  it('字面段优先于通配心智：:id 也能匹配字面段（status-counts 被 :id 覆盖是固有语义）', () => {
    expect(matchUrl(['GET /admin/orders/:id'], 'GET', '/admin/orders/status-counts')).toBe(true);
  });
  it('尾部斜杠归一（/admin/x/ 与 /admin/x 同权）', () => {
    expect(matchUrl(['GET /admin/orders'], 'GET', '/admin/orders/')).toBe(true);
  });
  it('价格拆分端点与普通编辑端点模式互不误伤', () => {
    expect(matchUrl(['PATCH /admin/products/:id/price'], 'PATCH', '/admin/products/x/price')).toBe(true);
    expect(matchUrl(['PATCH /admin/products/:id/price'], 'PATCH', '/admin/products/x')).toBe(false);
    expect(matchUrl(['PATCH /admin/products/:id'], 'PATCH', '/admin/products/x/price')).toBe(false);
  });
  it('无方法前缀的脏模式被忽略（不炸不误放）', () => {
    expect(matchUrl(['/admin/orders'], 'GET', '/admin/orders')).toBe(false);
  });
});

describe('admin RBAC 蛋词体系（角色×URL 模式对账）', () => {
  const rbac = new RbacService(new PrismaService());
  const allow = (role: string, method: string, path: string) =>
    rbac.allow(legacyRbacCtx(role), method, path);

  /* ---------- admin：超管通配 ---------- */
  it('admin（超管）任意 method+path 放行', () => {
    for (const [m, p] of [
      ['GET', '/admin/anything'],
      ['POST', '/admin/rbac/roles'],
      ['DELETE', '/admin/rbac/menus/x'],
      ['PATCH', '/admin/products/x/price'],
    ] as const)
      expect(allow('admin', m, p)).toBe(true);
  });

  /* ---------- operations（campus-operations）：运营全权、平台动作拒绝 ---------- */
  it('operations：读面板/订单读写/商品/订货/招募/营销全通', () => {
    expect(allow('operations', 'GET', '/admin/dashboard')).toBe(true);
    expect(allow('operations', 'GET', '/admin/orders')).toBe(true);
    expect(allow('operations', 'GET', '/admin/orders/status-counts')).toBe(true);
    expect(allow('operations', 'POST', '/admin/orders/o1/actions/ship')).toBe(true);
    expect(allow('operations', 'POST', '/admin/orders/o1/status')).toBe(true);
    expect(allow('operations', 'PATCH', '/admin/products/p1')).toBe(true);
    expect(allow('operations', 'PATCH', '/admin/products/p1/price')).toBe(true);
    expect(allow('operations', 'POST', '/admin/products/batch-status')).toBe(true);
    expect(allow('operations', 'POST', '/admin/inventory/stocktake')).toBe(true);
    expect(allow('operations', 'PUT', '/admin/restock/batches/b1/order')).toBe(true);
    expect(allow('operations', 'POST', '/admin/staff')).toBe(true);
    expect(allow('operations', 'POST', '/admin/recruit-applications/a1/idcard')).toBe(true);
    expect(allow('operations', 'POST', '/admin/recruit-applications/a1/approve')).toBe(true);
    expect(allow('operations', 'GET', '/admin/users/u1/phone')).toBe(true);
    expect(allow('operations', 'GET', '/admin/marketing/map')).toBe(true);
    expect(allow('operations', 'GET', '/admin/battle-map/rooms/r1')).toBe(true);
    expect(allow('operations', 'POST', '/admin/coupons')).toBe(true);
    expect(allow('operations', 'PUT', '/admin/wheel')).toBe(true);
  });
  it('operations：平台动作与超管域拒绝', () => {
    expect(allow('operations', 'POST', '/admin/settlements/s1/confirm')).toBe(false); // 旧矩阵 finance.write 本就只 admin/finance
    expect(allow('operations', 'POST', '/admin/inventory/stock-in')).toBe(false);
    expect(allow('operations', 'GET', '/admin/purchase/orders')).toBe(false);
    expect(allow('operations', 'POST', '/admin/campuses')).toBe(false); // 有意变化①（对齐 IKBWRT 真实门禁）
    expect(allow('operations', 'POST', '/admin/rbac/roles')).toBe(false);
    expect(allow('operations', 'POST', '/admin/rbac/menus')).toBe(false);
    expect(allow('operations', 'GET', '/admin/accounts')).toBe(false);
    // Banner：校区自管仅 admin（IKBW0A）；operations 读写皆拒（pay-ads 同源同拒）
    expect(allow('operations', 'GET', '/admin/banners')).toBe(false);
    expect(allow('operations', 'POST', '/admin/banners')).toBe(false);
  });

  /* ---------- warehouse（campus-warehouse）：订单只读+可出库 ---------- */
  it('warehouse：商品/库存/订货可写；订单只读但可出库', () => {
    expect(allow('warehouse', 'GET', '/admin/orders')).toBe(true);
    expect(allow('warehouse', 'POST', '/admin/orders/o1/actions/outbound')).toBe(true);
    expect(allow('warehouse', 'POST', '/admin/orders/o1/actions/cancel')).toBe(false);
    expect(allow('warehouse', 'PATCH', '/admin/products/p1')).toBe(true);
    expect(allow('warehouse', 'PATCH', '/admin/products/p1/price')).toBe(true);
    expect(allow('warehouse', 'POST', '/admin/inventory/stocktake')).toBe(true);
    expect(allow('warehouse', 'PUT', '/admin/restock/batches/b1/order')).toBe(true);
    expect(allow('warehouse', 'POST', '/admin/restock/orders/r1/receipt')).toBe(true);
  });
  it('warehouse：直入/批次管理/财务/招募/员工全拒', () => {
    expect(allow('warehouse', 'POST', '/admin/inventory/stock-in')).toBe(false);
    expect(allow('warehouse', 'POST', '/admin/restock/batches')).toBe(false);
    expect(allow('warehouse', 'POST', '/admin/restock/orders/r1/audit')).toBe(false);
    expect(allow('warehouse', 'GET', '/admin/settlements')).toBe(false);
    expect(allow('warehouse', 'GET', '/admin/staff')).toBe(false);
    expect(allow('warehouse', 'GET', '/admin/recruit-applications')).toBe(false);
    expect(allow('warehouse', 'GET', '/admin/users/u1/phone')).toBe(false);
  });

  /* ---------- finance（campus-finance）：结算/规则/日报 ---------- */
  it('finance：结算确认/支付、提成规则、审计可写；不碰商品库存', () => {
    expect(allow('finance', 'GET', '/admin/settlements')).toBe(true);
    expect(allow('finance', 'POST', '/admin/settlements/s1/confirm')).toBe(true);
    expect(allow('finance', 'POST', '/admin/settlements/s1/pay')).toBe(true);
    expect(allow('finance', 'POST', '/admin/commission-rules')).toBe(true);
    expect(allow('finance', 'PATCH', '/admin/commission-rules/c1')).toBe(true);
    expect(allow('finance', 'GET', '/admin/audit-logs')).toBe(true);
    expect(allow('finance', 'GET', '/admin/reports/campus-daily')).toBe(true);
    expect(allow('finance', 'GET', '/admin/after-sales')).toBe(true);
  });
  it('finance：商品/库存/员工/招募拒绝（旧矩阵同口径）', () => {
    expect(allow('finance', 'PATCH', '/admin/products/p1')).toBe(false);
    expect(allow('finance', 'POST', '/admin/inventory/stocktake')).toBe(false);
    expect(allow('finance', 'GET', '/admin/staff')).toBe(false);
    expect(allow('finance', 'GET', '/admin/recruit-applications')).toBe(false);
    expect(allow('finance', 'POST', '/admin/inventory/stock-in')).toBe(false);
  });

  /* ---------- hq（hq-director）：官方库/库存/订货批次/采购/校区本体 ---------- */
  it('hq：官方库维护/直入/批次管理/采购/校区本体/账号只读', () => {
    expect(allow('hq', 'GET', '/admin/products')).toBe(true);
    expect(allow('hq', 'POST', '/admin/products')).toBe(true);
    expect(allow('hq', 'PATCH', '/admin/products/p1')).toBe(true);
    expect(allow('hq', 'POST', '/admin/products/batch-status')).toBe(true);
    // official.write 模式含拉上游；端点内对「平台且无校区上下文」另有业务 403（官方库即源头）
    expect(allow('hq', 'POST', '/admin/products/p1/pull-upstream')).toBe(true);
    expect(allow('hq', 'GET', '/admin/inventory')).toBe(true);
    expect(allow('hq', 'POST', '/admin/inventory/stock-in')).toBe(true);
    expect(allow('hq', 'POST', '/admin/restock/batches')).toBe(true);
    expect(allow('hq', 'POST', '/admin/restock/orders/r1/ship')).toBe(true);
    expect(allow('hq', 'GET', '/admin/purchase/orders')).toBe(true);
    expect(allow('hq', 'POST', '/admin/purchase/orders/p1/receive')).toBe(true);
    expect(allow('hq', 'GET', '/admin/reports/hq-daily')).toBe(true);
    expect(allow('hq', 'POST', '/admin/campuses')).toBe(true);
    expect(allow('hq', 'PATCH', '/admin/campuses/c1')).toBe(true);
    expect(allow('hq', 'GET', '/admin/accounts')).toBe(true); // 只读保留（旧矩阵 accounts.read）
  });
  it('hq：校区动作与超管域拒绝', () => {
    expect(allow('hq', 'POST', '/admin/accounts')).toBe(false); // 有意变化②：账号管理收归超管
    expect(allow('hq', 'PUT', '/admin/restock/batches/b1/order')).toBe(false); // 拆码：校区订货动作
    expect(allow('hq', 'GET', '/admin/after-sales')).toBe(false); // 旧矩阵 hq 无售后
    expect(allow('hq', 'POST', '/admin/rbac/roles')).toBe(false);
    expect(allow('hq', 'POST', '/admin/rbac/menus')).toBe(false);
    expect(allow('hq', 'GET', '/admin/settlements')).toBe(false);
    expect(allow('hq', 'GET', '/admin/banners')).toBe(false);
  });

  /* ---------- 模板无缩水抽查：旧矩阵 write=true 的端点全部可达 ---------- */
  it('旧矩阵 write 语义无缩水（各角色写端点都在模板 patterns 内）', () => {
    // orders.write: admin/operations
    expect(allow('operations', 'POST', '/admin/orders/o1/status')).toBe(true);
    // products/categories/inventory/restock write: admin/operations/warehouse/hq（hq=官方库+批次管理拆码）
    expect(allow('warehouse', 'PATCH', '/admin/categories/c1')).toBe(true);
    expect(allow('hq', 'PATCH', '/admin/categories/c1')).toBe(true);
    expect(allow('warehouse', 'DELETE', '/admin/locations/l1')).toBe(true);
    expect(allow('hq', 'DELETE', '/admin/locations/l1')).toBe(true);
    expect(allow('hq', 'POST', '/admin/restock/orders/r1/audit')).toBe(true);
    // purchase write: hq/admin
    expect(allow('hq', 'POST', '/admin/restock/batches/b1/purchase-order')).toBe(true);
    expect(allow('operations', 'POST', '/admin/restock/batches/b1/purchase-order')).toBe(false);
    // staff/buildings/recruit/marketing/wechat-groups write: admin/operations
    expect(allow('operations', 'PATCH', '/admin/staff/s1')).toBe(true);
    expect(allow('operations', 'POST', '/admin/buildings')).toBe(true);
    expect(allow('operations', 'POST', '/admin/buildings/b1/rooms')).toBe(true);
    expect(allow('operations', 'POST', '/admin/buildings/b1/rooms/import')).toBe(true);
    expect(allow('operations', 'PATCH', '/admin/recruit-applications/a1')).toBe(true);
    expect(allow('operations', 'POST', '/admin/coupons/c1/issue')).toBe(true);
    expect(allow('operations', 'DELETE', '/admin/wechat-groups/w1')).toBe(true);
    // finance write: admin/finance
    expect(allow('finance', 'POST', '/admin/settlements/s1/pay')).toBe(true);
    expect(allow('operations', 'POST', '/admin/settlements/s1/pay')).toBe(false);
    // campuses write: admin/hq（operations 有意拒绝，见上）
    expect(allow('hq', 'POST', '/admin/campuses')).toBe(true);
  });
  it('admin 独占写（banners/printers/rbac）模板角色全拒', () => {
    for (const role of ['hq', 'operations', 'warehouse', 'finance']) {
      expect(allow(role, 'POST', '/admin/banners')).toBe(false);
      expect(allow(role, 'POST', '/admin/printers')).toBe(false);
      expect(allow(role, 'DELETE', '/admin/printers/p1')).toBe(false);
      expect(allow(role, 'GET', '/admin/rbac/permissions')).toBe(false);
      expect(allow(role, 'GET', '/admin/rbac/audit')).toBe(false);
    }
  });

  /* ---------- 有意行为变化（URL 模式固有语义，逐条钉死） ---------- */
  it('有意变化③：orders.write 通配动作段——operations 现在可出库（旧码分 outbound 单列）', () => {
    // 旧 V1：outbound 单列 inventory.outbound，operations 无该码被拒；
    // 蛋词 URL 模式 POST /admin/orders/:id/actions/:action 天然覆盖 outbound 段
    expect(allow('operations', 'POST', '/admin/orders/o1/actions/outbound')).toBe(true);
  });
  it('有意变化④：纯备注角色（recruit.note）不再能经 GET :id/idcard 读备注', () => {
    // recruit.note 节点 perms 仅 PATCH /admin/recruit-applications/:id；
    // 备注回显保留在 PATCH 响应（controller allowUrl 复检）
    const patterns = legacyRbacCtx('operations').patterns;
    expect(matchUrl(patterns, 'PATCH', '/admin/recruit-applications/a1')).toBe(true);
    // 构造仅勾 recruit+recruit.note 的角色视角：菜单 perms 并集不含 GET idcard 模式
    const noteOnlyPats = ['GET /admin/recruit-applications', 'PATCH /admin/recruit-applications/:id'];
    expect(matchUrl(noteOnlyPats, 'GET', '/admin/recruit-applications/a1/idcard')).toBe(false);
  });

  it('非后台角色（user/楼长/骑手）无法构造后台上下文', () => {
    for (const role of ['user', 'building-manager', 'fulltime-rider'])
      expect(() => legacyRbacCtx(role)).toThrow('非后台角色');
  });

  it('超管上下文 menuCodes=全部目录/菜单行；校区角色不含未勾菜单', () => {
    const adminCtx = legacyRbacCtx('admin');
    expect(adminCtx.menuCodes.has('g.ops')).toBe(true);
    expect(adminCtx.menuCodes.has('orders')).toBe(true);
    expect(adminCtx.menuCodes.size).toBeGreaterThanOrEqual(42);
    const finCtx = legacyRbacCtx('finance');
    expect(finCtx.menuCodes.has('finance')).toBe(true);
    expect(finCtx.menuCodes.has('orders')).toBe(true);
    expect(finCtx.menuCodes.has('products')).toBe(false);
    expect(finCtx.patterns.has('GET /admin/settlements')).toBe(true);
  });
});

describe('守卫白名单与模式覆盖自检（漏配即红）', () => {
  it('白名单恰为三个登录可读端点', () => {
    expect([...ADMIN_URL_WHITELIST].sort()).toEqual([
      'GET /admin/rbac/me',
      'GET /admin/rbac/menus',
      'GET /admin/rbac/permmenu',
    ]);
  });
  it('白名单端点在控制器路由中真实存在（GET）', () => {
    const routes = listAdminRoutes().map((r) => `${r.method} ${r.path}`);
    for (const w of ADMIN_URL_WHITELIST) expect(routes).toContain(w);
  });
  it('AdminController 全部路由被 registry 模式覆盖（或白名单）——漏配清单为空', () => {
    expect(uncoveredRoutes()).toEqual([]);
  });
  it('concreteRoute 参数段替换后仍与模式匹配（矩阵扫描前提）', () => {
    const routes = listAdminRoutes();
    expect(routes.length).toBeGreaterThan(120);
    const sample = concreteRoute({ method: 'GET', path: '/admin/products/:id/price' });
    expect(sample.path).toBe('/admin/products/spec-p1/price');
  });
});
