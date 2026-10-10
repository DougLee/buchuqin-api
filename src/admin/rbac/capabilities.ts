/**
 * IKKRMR：业务 capability 登记表（渐进映射方案，2026-10-10）。
 *
 * 现状判权=菜单 perms 的 URL 模式匹配（宽泛通配，如
 * POST /admin/orders/:id/actions/:action 覆盖一切 action 值），存在两类风险：
 * 1) 动态 URL 碰撞——新增 action 自动落进既有通配，无需任何授权动作；
 * 2) 语义宽泛——「订单操作」一码全开，无法只授取消不授推进。
 *
 * capability 层不推翻 URL 判权（渐进）：登记「稳定业务能力标识 → URL 模式集」，
 * 高风险域（issue 点名：订单动作 / 成本读写）逐个 action 拆开——
 * - 判权：RbacService.allowCapability(ctx, cap) 按 cap 的模式集走既有 allow
 *   语义（超管通配 / 平台窄化 / 菜单 perms 匹配），持任一模式即视为持有；
 * - 门禁：AdminController 的 orders actions 端点对 action 值做 capability
 *   复检——**未登记的 action 一律 403「未登记的操作能力」**（默认拒绝新增
 *   action，消除「新增 action 自动获权」）；已登记 action 仍可经 orders.write
 *   通配或单 action 按钮（orders.cancel/advance/exception、inventory.outbound）
 *   授予，存量角色行为零变化；
 * - 前端同源：GET /admin/rbac/capabilities（登录可读白名单）下发字典+当前
 *   账号持有情况（前端按钮改造属 IKKRMY，本端点只供数据）。
 *
 * 冲突自检：assertNoCapabilityOverlap——同一 URL 模式被两个 capability 声明
 * 即 throw（启动时由 syncRegistry 调用，拒启）；capability 引用未登记的
 * 菜单 perms 模式同样拒启（字典与菜单树不允许漂移）。
 */

export interface CapabilityDef {
  /** 稳定业务能力标识（域.动作；跨端契约锚点，改名=破坏性变更） */
  code: string;
  /** 中文说明（前端按钮/授权提示数据源） */
  name: string;
  /** 授权锚点：URL 模式集（'METHOD /admin/…'，:seg 通配）。
   *  必须全部登记于 registry.ALL_PERM_PATTERNS（syncRegistry 校验）；
   *  持任一模式即视为拥有该 capability（allowCapability）。 */
  patterns: string[];
  /** 口径/边界备注 */
  remark?: string;
}

/** 首批高风险域（issue IKKRMR 点名）：订单动作逐个拆 + 成本读写 */
export const CAPABILITIES: readonly CapabilityDef[] = [
  {
    code: 'order.cancel',
    name: '取消订单',
    patterns: ['POST /admin/orders/:id/actions/cancel'],
    remark: '取消订单（触发微信原路退款流程）',
  },
  {
    code: 'order.advance',
    name: '推进订单',
    patterns: ['POST /admin/orders/:id/actions/advance'],
    remark: '沿 12 态状态机单步推进履约',
  },
  {
    code: 'order.outbound',
    name: '订单出库',
    patterns: ['POST /admin/orders/:id/actions/outbound'],
    remark: '拣货出库（IKA0UQ：仓储角色对订单只读但可出库，锚点=inventory.outbound）',
  },
  {
    code: 'order.exception',
    name: '标记订单异常',
    patterns: ['POST /admin/orders/:id/actions/mark-exception'],
    remark: '运营手动把订单置为异常态',
  },
  {
    code: 'cost.read',
    name: '成本/毛利读取',
    patterns: [
      'GET /admin/dashboard',
      'GET /admin/reports/campus-daily',
      'GET /admin/reports/hq-daily',
    ],
    remark: '订单毛利/成本口径端点（经营总览校区概览毛利、校区/总部日报）；持任一端点即视为可读成本数据',
  },
  {
    code: 'cost.write',
    name: '商品改价',
    patterns: ['PATCH /admin/products/:id/price'],
    remark: '价格字段修改（售价/原价/成本价/批发价/本地采购价，分）',
  },
];

export const CAPABILITY_BY_CODE: ReadonlyMap<string, CapabilityDef> = new Map(
  CAPABILITIES.map((c) => [c.code, c]),
);

export const CAPABILITY_CODES: ReadonlySet<string> = new Set(
  CAPABILITIES.map((c) => c.code),
);

/**
 * orders actions 端点（POST /admin/orders/:id/actions/:action）的 action 值 →
 * capability 登记表。**新增 action 必须在此登记**，否则端点默认 403
 * （未登记的操作能力）——这是「默认拒绝新增 action」的唯一闸门。
 */
export const ORDER_ACTION_CAPABILITIES: Readonly<Record<string, string>> = {
  cancel: 'order.cancel',
  advance: 'order.advance',
  outbound: 'order.outbound',
  'mark-exception': 'order.exception',
};

/**
 * 冲突自检（纯函数，spec 钉死）：
 * - 同一 URL 模式被两个 capability 声明 → throw（歧义重叠：判权语义不清）；
 * - capability 未登记任何模式 / code 重复 → throw。
 * 启动时 syncRegistry 调用（拒启），spec 可传自定义字典验证 throw 路径。
 */
export function assertNoCapabilityOverlap(
  caps: readonly CapabilityDef[] = CAPABILITIES,
): void {
  const owner = new Map<string, string>();
  const seenCode = new Set<string>();
  for (const c of caps) {
    if (seenCode.has(c.code))
      throw new Error(`capability 编码重复登记: ${c.code}`);
    seenCode.add(c.code);
    if (!c.patterns.length)
      throw new Error(`capability ${c.code} 未登记任何 URL 模式`);
    for (const p of c.patterns) {
      const prev = owner.get(p);
      if (prev !== undefined && prev !== c.code)
        throw new Error(
          `capability URL 冲突: ${p} 同时属于 ${prev} 与 ${c.code}（同一端点只允许一个 capability 声明）`,
        );
      owner.set(p, c.code);
    }
  }
}
