import { AdminController } from './admin.controller';
import { PrismaService } from '../database/prisma.service';
import { RbacService, type RbacContext } from './rbac/rbac.service';
import { legacyRbacCtx, specReq } from './rbac/spec-fixtures';
import { ADMIN_URL_WHITELIST, ALL_PERM_PATTERNS, MENU_NODES } from './rbac/registry';
import { listAdminRoutes } from './rbac/route-inventory';
import {
  CAPABILITIES,
  CAPABILITY_BY_CODE,
  ORDER_ACTION_CAPABILITIES,
  assertNoCapabilityOverlap,
  type CapabilityDef,
} from './rbac/capabilities';

/**
 * IKKRMR 单元测试：业务 capability 渐进映射（不推翻 URL 判权）。
 * - 字典登记：首批清单钉死、中文说明、URL 模式全部锚定在菜单 perms；
 * - allowCapability 判权：超管通配 / 旧角色兼容（orders.write 通配覆盖）/
 *   单 action 独立授权 / 平台端点窄化 / 未登记 capability fail closed；
 * - orders actions 端点门禁：未登记 action 一律 403「未登记的操作能力」
 *   （超管也不豁免——消除「新增 action 自动获权」）；
 * - 重叠检测：同 URL 两个 capability 声明 → throw（启动拒启）；
 * - 前端同源：GET /admin/rbac/capabilities 白名单+字典下发+本人持有情况。
 */

const rbac = new RbacService(new PrismaService());

/** 最小上下文夹具：只持给定 URL 模式（校区级、无平台授权） */
function ctxWith(patterns: string[], campusId = 'campus-hbut'): RbacContext {
  return {
    accountId: 'spec-capability',
    username: 'capability',
    nickname: 'capability',
    campusId,
    platform: false,
    super: false,
    campuses: [campusId],
    patterns: new Set(patterns),
    platformPatterns: new Set<string>(),
    menuCodes: new Set<string>(),
  };
}

describe('IKKRMR：capability 字典登记', () => {
  it('首批高风险域清单钉死（订单动作拆开 + 员工配送拆开 + 成本读写）', () => {
    expect(CAPABILITIES.map((c) => c.code)).toEqual([
      'order.cancel',
      'order.advance',
      'order.outbound',
      'order.exception',
      'order.staff-deliver',
      'order.staff-complete',
      'cost.read',
      'cost.write',
    ]);
  });
  it('每个 capability 附中文说明且 URL 模式非空', () => {
    for (const c of CAPABILITIES) {
      expect(c.name.trim().length).toBeGreaterThan(0);
      expect(/[一-鿿]/.test(c.name)).toBe(true);
      expect(c.patterns.length).toBeGreaterThan(0);
      for (const p of c.patterns)
        expect(p).toMatch(/^(GET|POST|PATCH|PUT|DELETE) \/admin\//);
    }
  });
  it('capability 的 URL 模式全部登记在菜单 perms 内（syncRegistry 校验前提，漂移即红）', () => {
    for (const c of CAPABILITIES)
      for (const p of c.patterns) expect(ALL_PERM_PATTERNS).toContain(p);
  });
  it('订单动作拆钮有独立授权锚点（orders.cancel/advance/exception/staff-* + inventory.outbound）', () => {
    const node = (code: string) => MENU_NODES.find((n) => n.code === code);
    expect(node('orders.cancel')?.perms).toEqual([
      'POST /admin/orders/:id/actions/cancel',
    ]);
    expect(node('orders.advance')?.perms).toEqual([
      'POST /admin/orders/:id/actions/advance',
    ]);
    expect(node('orders.exception')?.perms).toEqual([
      'POST /admin/orders/:id/actions/mark-exception',
    ]);
    // IKKRMV 组织 B 后台员工配送拆钮（staff_delivery 组织校区专用）
    expect(node('orders.staff-deliver')?.perms).toEqual([
      'POST /admin/orders/:id/actions/staff-deliver',
    ]);
    expect(node('orders.staff-complete')?.perms).toEqual([
      'POST /admin/orders/:id/actions/staff-complete',
    ]);
    expect(node('inventory.outbound')?.perms).toEqual([
      'POST /admin/orders/:id/actions/outbound',
    ]);
  });
});

describe('IKKRMR：orders actions 登记=service 支持的 action 全集', () => {
  it('ORDER_ACTION_CAPABILITIES 恰好覆盖 service.orderAction 的六个分支', () => {
    // admin.service.orderAction 支持：cancel / advance / outbound /
    // mark-exception / staff-deliver / staff-complete（IKKRMV）
    // （不支持的 action 本就 400「不支持的订单操作」；登记表漏一个=该动作被
    // 门禁 403 挡死，多一个=死映射）——此处钉死两者一致。
    expect(Object.keys(ORDER_ACTION_CAPABILITIES).sort()).toEqual([
      'advance',
      'cancel',
      'mark-exception',
      'outbound',
      'staff-complete',
      'staff-deliver',
    ]);
  });
  it('登记表值全部指向已登记 capability', () => {
    for (const cap of Object.values(ORDER_ACTION_CAPABILITIES))
      expect(CAPABILITY_BY_CODE.has(cap)).toBe(true);
  });
});

describe('IKKRMR：allowCapability 判权', () => {
  const capOf = (role: string, cap: string) =>
    rbac.allowCapability(legacyRbacCtx(role), cap);

  it('超管：全部 capability 放行', () => {
    for (const c of CAPABILITIES) expect(capOf('admin', c.code)).toBe(true);
  });
  it('operations（orders.write 通配）：四个订单动作全通（渐进兼容，存量角色零变化）', () => {
    for (const cap of ['order.cancel', 'order.advance', 'order.outbound', 'order.exception'])
      expect(capOf('operations', cap)).toBe(true);
    expect(capOf('operations', 'cost.read')).toBe(true); // dashboard 毛利
    expect(capOf('operations', 'cost.write')).toBe(true); // products.price
  });
  it('warehouse：订单只读但可出库；取消/推进/异常不可', () => {
    expect(capOf('warehouse', 'order.outbound')).toBe(true);
    expect(capOf('warehouse', 'order.cancel')).toBe(false);
    expect(capOf('warehouse', 'order.advance')).toBe(false);
    expect(capOf('warehouse', 'order.exception')).toBe(false);
  });
  it('finance：订单动作全拒；成本可读（campus-daily）、改价不可', () => {
    for (const cap of ['order.cancel', 'order.advance', 'order.outbound', 'order.exception'])
      expect(capOf('finance', cap)).toBe(false);
    expect(capOf('finance', 'cost.read')).toBe(true);
    expect(capOf('finance', 'cost.write')).toBe(false);
  });

  /* ---------- 独立授权（AC：订单动作可独立授权） ---------- */
  it('order.cancel 独立授权：只持取消按钮模式 → 仅 order.cancel 放行', () => {
    const ctx = ctxWith(['POST /admin/orders/:id/actions/cancel']);
    expect(rbac.allowCapability(ctx, 'order.cancel')).toBe(true);
    expect(rbac.allowCapability(ctx, 'order.advance')).toBe(false);
    expect(rbac.allowCapability(ctx, 'order.outbound')).toBe(false);
    expect(rbac.allowCapability(ctx, 'order.exception')).toBe(false);
  });
  it('order.advance / order.exception 同样可独立授权（互不放大）', () => {
    const advance = ctxWith(['POST /admin/orders/:id/actions/advance']);
    expect(rbac.allowCapability(advance, 'order.advance')).toBe(true);
    expect(rbac.allowCapability(advance, 'order.cancel')).toBe(false);
    const exception = ctxWith(['POST /admin/orders/:id/actions/mark-exception']);
    expect(rbac.allowCapability(exception, 'order.exception')).toBe(true);
    expect(rbac.allowCapability(exception, 'order.outbound')).toBe(false);
  });
  it('cost.read：持任一毛利/成本端点即视为可读（ANY-of 语义）', () => {
    expect(
      rbac.allowCapability(ctxWith(['GET /admin/reports/campus-daily']), 'cost.read'),
    ).toBe(true);
    expect(
      rbac.allowCapability(ctxWith(['GET /admin/reports/hq-daily']), 'cost.read'),
    ).toBe(false); // 平台端点，校区级授权不放大（allow 平台窄化复用）
    expect(rbac.allowCapability(ctxWith(['GET /admin/reports/hq-daily']), 'cost.write')).toBe(false);
    expect(
      rbac.allowCapability(
        legacyRbacCtx('hq'),
        'cost.read',
      ),
    ).toBe(true); // hq 平台级授权可读 hq-daily
  });
  it('cost.write：仅改价端点授权（商品读/改不含改价）', () => {
    expect(
      rbac.allowCapability(ctxWith(['PATCH /admin/products/:id/price']), 'cost.write'),
    ).toBe(true);
    expect(
      rbac.allowCapability(
        ctxWith(['GET /admin/products', 'GET /admin/products/status-counts']),
        'cost.write',
      ),
    ).toBe(false);
    expect(
      rbac.allowCapability(
        ctxWith(['GET /admin/products', 'GET /admin/products/status-counts']),
        'cost.read',
      ),
    ).toBe(false);
  });
  it('未登记 capability 恒拒绝（fail closed）', () => {
    expect(rbac.allowCapability(legacyRbacCtx('admin'), 'order.delete')).toBe(false);
    expect(rbac.allowCapability(legacyRbacCtx('operations'), '')).toBe(false);
  });
});

describe('IKKRMR：orders actions 端点门禁（默认拒绝新增 action）', () => {
  const orderActionStub = jest.fn().mockResolvedValue({ done: true });
  const controller = new AdminController(
    { orderAction: orderActionStub } as never,
    rbac,
  );

  beforeEach(() => orderActionStub.mockClear());

  it('未登记 action 一律 403「未登记的操作能力」——超管也不豁免', async () => {
    for (const action of ['ship', 'teardown', 'export']) {
      await expect(
        controller.orderAction(specReq('admin'), 'o1', action),
      ).rejects.toThrow('未登记的操作能力');
      await expect(
        controller.orderAction(specReq('operations'), 'o1', action),
      ).rejects.toThrow('未登记的操作能力');
    }
    expect(orderActionStub).not.toHaveBeenCalled(); // 拒绝发生在业务调用前
  });
  it('已登记 action 无权限 → 403（finance 无订单动作）', async () => {
    await expect(
      controller.orderAction(specReq('finance'), 'o1', 'cancel'),
    ).rejects.toThrow('所在用户组暂无该订单操作权限');
    expect(orderActionStub).not.toHaveBeenCalled();
  });
  it('已登记 action 有权限 → 放行进业务（operations 通配；仓储仅出库）', async () => {
    await expect(
      controller.orderAction(specReq('operations'), 'o1', 'cancel'),
    ).resolves.toBeTruthy();
    expect(orderActionStub).toHaveBeenCalledWith(
      'o1',
      'cancel',
      'spec-operations',
      'campus-hbut',
    );
    await expect(
      controller.orderAction(specReq('warehouse'), 'o2', 'outbound'),
    ).resolves.toBeTruthy();
    expect(orderActionStub).toHaveBeenLastCalledWith(
      'o2',
      'outbound',
      'spec-warehouse',
      'campus-hbut',
    );
  });
});

describe('IKKRMR：重叠检测（启动拒启）', () => {
  it('真实字典无冲突（不 throw）', () => {
    expect(() => assertNoCapabilityOverlap()).not.toThrow();
  });
  it('同一 URL 被两个 capability 声明 → throw 并点名双方', () => {
    const clash: CapabilityDef[] = [
      { code: 'order.cancel', name: '取消', patterns: ['POST /admin/orders/:id/actions/cancel'] },
      { code: 'order.cancel.v2', name: '取消2', patterns: ['POST /admin/orders/:id/actions/cancel'] },
    ];
    expect(() => assertNoCapabilityOverlap(clash)).toThrow(
      /order\.cancel.*order\.cancel\.v2|order\.cancel\.v2.*order\.cancel/,
    );
  });
  it('空模式与重复编码同样拒绝', () => {
    expect(() =>
      assertNoCapabilityOverlap([{ code: 'x.read', name: '读', patterns: [] }]),
    ).toThrow('未登记任何 URL 模式');
    expect(() =>
      assertNoCapabilityOverlap([
        { code: 'x.read', name: '读', patterns: ['GET /admin/x'] },
        { code: 'x.read', name: '读2', patterns: ['GET /admin/y'] },
      ]),
    ).toThrow('编码重复登记');
  });
});

describe('IKKRMR：rbac/capabilities 前端同源数据', () => {
  const controller = new AdminController({} as never, rbac);

  it('守卫白名单登记 + 控制器路由真实存在', () => {
    expect(ADMIN_URL_WHITELIST.has('GET /admin/rbac/capabilities')).toBe(true);
    expect(
      listAdminRoutes().map((r) => `${r.method} ${r.path}`),
    ).toContain('GET /admin/rbac/capabilities');
  });
  it('下发字典+当前账号持有情况（finance 视角）', async () => {
    const res = await controller.rbacCapabilities(specReq('finance'));
    const rows = res.data as ReturnType<typeof rbac.listCapabilities>;
    expect(rows.map((r) => r.code)).toEqual(CAPABILITIES.map((c) => c.code));
    const granted = new Map(rows.map((r) => [r.code, r.granted]));
    expect(granted.get('order.cancel')).toBe(false);
    expect(granted.get('order.advance')).toBe(false);
    expect(granted.get('order.outbound')).toBe(false);
    expect(granted.get('order.exception')).toBe(false);
    expect(granted.get('cost.read')).toBe(true);
    expect(granted.get('cost.write')).toBe(false);
    for (const r of rows) expect(r.patterns.length).toBeGreaterThan(0);
  });
  it('超管视角全部 granted', async () => {
    const rows = (await controller.rbacCapabilities(specReq('admin')))
      .data as ReturnType<typeof rbac.listCapabilities>;
    for (const r of rows) expect(r.granted).toBe(true);
  });
  it('未装载 RBAC 上下文的请求拒绝（守卫未注入即无数据可发）', async () => {
    await expect(
      controller.rbacCapabilities({ user: { id: 'x' } } as never),
    ).rejects.toThrow('未授权的访问');
  });
});
