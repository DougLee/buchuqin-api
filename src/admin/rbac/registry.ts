/**
 * RBAC 登记表（对齐蛋词体系版，2026-09-19 道哥拍板 B）：
 * 菜单+按钮权限合一棵树（AdminMenu：type 0 目录 / 1 菜单 / 2 按钮），
 * 判权=按钮/菜单行的 perms（「METHOD 路径模式」逗号串，:seg 通配）与
 * 请求 method+path 匹配——与 dancikeji（cool-admin）同构，适配 RESTful。
 *
 * - 菜单行 perms = 查看（GET）类模式：勾菜单=能进页面拉数据；
 * - 按钮行 perms = 操作类模式：勾按钮=能做对应操作；
 * - code 唯一，为代码登记锚点：启动按 code 幂等 upsert（新增节点随发版出现，
 *   已有节点不覆盖后台修改——菜单可在后台改名/排序/显隐）。
 * 保留 buchuqin 内核：super-admin 角色通配、会话版本踢线、审计、校区 scope。
 */

export type MenuType = 0 | 1 | 2; // 0 目录 1 菜单 2 按钮

export interface MenuNodeDef {
  code: string;
  name: string;
  type: MenuType;
  /** 父节点 code（根目录无） */
  parent?: string;
  /** 菜单：前端路由 path */
  path?: string;
  /** perms：URL 模式（'METHOD /admin/...'，逗号并集；:seg 通配） */
  perms?: string[];
  icon?: string;
  order: number;
  remark?: string;
}

/* ==================== 菜单树（目录 7 + 菜单 35 + 按钮 60） ==================== */

export const MENU_NODES: MenuNodeDef[] = [
  /* ---------- 目录：运营中心 ---------- */
  { code: 'g.ops', name: '运营中心', type: 0, order: 1 },
  { code: 'dashboard', name: '经营总览', type: 1, parent: 'g.ops', path: '/', icon: 'dashboard', order: 1, perms: ['GET /admin/dashboard'] },
  { code: 'orders', name: '订单配送', type: 1, parent: 'g.ops', path: '/orders', icon: 'orders', order: 2, perms: ['GET /admin/orders', 'GET /admin/orders/status-counts', 'GET /admin/orders/new-order-watch', 'GET /admin/orders/:id'] },
  { code: 'orders.write', name: '订单操作', type: 2, parent: 'orders', order: 1, perms: ['POST /admin/orders/:id/actions/:action', 'POST /admin/orders/:id/status', 'POST /admin/orders/:id/print-receipt'], remark: '改状态/出库/补打小票' },
  { code: 'inventory.outbound', name: '订单出库', type: 2, parent: 'orders', order: 2, perms: ['POST /admin/orders/:id/actions/outbound'], remark: '拣货出库（仓储角色对订单只读但可出库）' },
  { code: 'after-sales', name: '售后退款', type: 1, parent: 'g.ops', path: '/after-sales', icon: 'after', order: 3, perms: ['GET /admin/after-sales'] },
  { code: 'battle-map', name: '营销作战地图', type: 1, parent: 'g.ops', path: '/battle-map', icon: 'buildings', order: 4, perms: ['GET /admin/marketing/map', 'GET /admin/battle-map/buildings/:buildingId', 'GET /admin/battle-map/rooms/:roomId'] },
  { code: 'campus-report', name: '校区日报', type: 1, parent: 'g.ops', path: '/campus-report', icon: 'campus-report', order: 5, perms: ['GET /admin/reports/campus-daily', 'GET /admin/reports/hq-daily'] },

  /* ---------- 目录：仓储中心 ---------- */
  { code: 'g.wh', name: '仓储中心', type: 0, order: 2 },
  { code: 'official-products', name: '官方商品库', type: 1, parent: 'g.wh', path: '/official-products', icon: 'official-products', order: 1, perms: ['GET /admin/products', 'GET /admin/products/status-counts', 'GET /admin/products/official-library'] },
  { code: 'products.official.write', name: '官方库维护', type: 2, parent: 'official-products', order: 1, perms: ['POST /admin/products', 'PATCH /admin/products/:id', 'POST /admin/products/batch-status', 'POST /admin/products/:id/pull-upstream'], remark: '官方库建档/编辑/放行回收/推校区' },
  { code: 'products', name: '商品管理', type: 1, parent: 'g.wh', path: '/products', icon: 'products', order: 2, perms: ['GET /admin/products', 'GET /admin/products/status-counts', 'POST /admin/products/barcode/lookup'] },
  { code: 'products.write', name: '商品编辑', type: 2, parent: 'products', order: 1, perms: ['POST /admin/products', 'PATCH /admin/products/:id', 'POST /admin/products/import'], remark: '新建/普通编辑/官方库导入（不含改价与上下架）' },
  { code: 'products.price', name: '商品改价', type: 2, parent: 'products', order: 2, perms: ['PATCH /admin/products/:id/price'], remark: '价格字段修改（独立端点，字段级分权保留）' },
  { code: 'products.status', name: '商品上下架', type: 2, parent: 'products', order: 3, perms: ['POST /admin/products/batch-status'] },
  { code: 'categories', name: '商品类别', type: 1, parent: 'g.wh', path: '/categories', icon: 'categories', order: 3, perms: ['GET /admin/categories'] },
  { code: 'categories.write', name: '类别维护', type: 2, parent: 'categories', order: 1, perms: ['POST /admin/categories', 'PATCH /admin/categories/:id', 'DELETE /admin/categories/:id'] },
  { code: 'inventory', name: '库存总览', type: 1, parent: 'g.wh', path: '/inventory', icon: 'inventory', order: 4, perms: ['GET /admin/inventory'] },
  { code: 'inventory.inbound', name: '库存入库', type: 2, parent: 'inventory', order: 1, perms: ['POST /admin/inventory/stock-in'], remark: '直接入库（平台/总部仓口径）' },
  { code: 'inventory.adjust', name: '库存调整/盘点', type: 2, parent: 'inventory', order: 2, perms: ['POST /admin/inventory/stocktake', 'POST /admin/inventory/adjust'] },
  { code: 'warehouse-orders', name: '拣货任务', type: 1, parent: 'g.wh', path: '/warehouse-orders', icon: 'warehouse-orders', order: 5, perms: ['GET /admin/orders', 'GET /admin/orders/status-counts'] },
  { code: 'inventory-txns', name: '出入库流水', type: 1, parent: 'g.wh', path: '/inventory-txns', icon: 'inventory-txns', order: 6, perms: ['GET /admin/inventory/txns'] },
  { code: 'locations', name: '库位管理', type: 1, parent: 'g.wh', path: '/locations', icon: 'locations', order: 7, perms: ['GET /admin/locations'] },
  { code: 'locations.write', name: '库位维护', type: 2, parent: 'locations', order: 1, perms: ['POST /admin/locations', 'PATCH /admin/locations/:id', 'DELETE /admin/locations/:id'] },

  /* ---------- 目录：订货与采购 ---------- */
  { code: 'g.supply', name: '订货与采购', type: 0, order: 3 },
  { code: 'restock', name: '订货管理', type: 1, parent: 'g.supply', path: '/restock', icon: 'restock', order: 1, perms: ['GET /admin/restock/batches', 'GET /admin/restock/batches/:id', 'GET /admin/restock/orders', 'GET /admin/restock/orders/:id', 'GET /admin/restock/orders/:id/shipment'] },
  { code: 'restock.order', name: '校区订货', type: 2, parent: 'restock', order: 1, perms: ['PUT /admin/restock/batches/:batchId/order', 'POST /admin/restock/batches/:batchId/order/submit', 'POST /admin/restock/batches/:batchId/order/withdraw', 'POST /admin/restock/orders/:id/receipt'], remark: '订货单编辑/提交/撤回/收货确认' },
  { code: 'restock.manage', name: '批次管理', type: 2, parent: 'restock', order: 2, perms: ['POST /admin/restock/batches', 'PATCH /admin/restock/batches/:id', 'POST /admin/restock/batches/:id/close', 'POST /admin/restock/orders/:id/audit', 'POST /admin/restock/orders/:id/ship'], remark: '建批/改批/关批/审单/发货（平台）' },
  { code: 'purchase', name: '采购管理', type: 1, parent: 'g.supply', path: '/purchase', icon: 'purchase', order: 2, perms: ['GET /admin/purchase/orders', 'GET /admin/purchase/orders/:id', 'GET /admin/reports/hq-daily'] },
  { code: 'purchase.write', name: '采购管理操作', type: 2, parent: 'purchase', order: 1, perms: ['POST /admin/restock/batches/:batchId/purchase-order', 'POST /admin/purchase/orders/:id/receive', 'POST /admin/purchase/orders/:id/close', 'POST /admin/purchase/orders/:id/reopen'] },

  /* ---------- 目录：营销活动 ---------- */
  { code: 'g.mkt', name: '营销活动', type: 0, order: 4 },
  { code: 'banners', name: 'Banner 配置', type: 1, parent: 'g.mkt', path: '/banners', icon: 'marketing', order: 1, perms: ['GET /admin/banners'] },
  { code: 'banners.write', name: 'Banner 管理', type: 2, parent: 'banners', order: 1, perms: ['POST /admin/banners', 'PATCH /admin/banners/:id', 'DELETE /admin/banners/:id'] },
  { code: 'pay-ads', name: '支付广告位', type: 1, parent: 'g.mkt', path: '/pay-ads', icon: 'marketing', order: 2, perms: ['GET /admin/banners'] },
  { code: 'coupons', name: '优惠券配置', type: 1, parent: 'g.mkt', path: '/coupons', icon: 'marketing', order: 3, perms: ['GET /admin/coupons'] },
  { code: 'marketing.write', name: '营销操作', type: 2, parent: 'coupons', order: 1, perms: ['POST /admin/coupons', 'PATCH /admin/coupons/:id', 'DELETE /admin/coupons/:id', 'POST /admin/coupons/:id/issue'], remark: '优惠券增改删发（促销/推荐位/转盘共用营销码）' },
  { code: 'promotions', name: '限时秒杀', type: 1, parent: 'g.mkt', path: '/promotions', icon: 'marketing', order: 4, perms: ['GET /admin/promotions'] },
  { code: 'promotions.write', name: '促销活动操作', type: 2, parent: 'promotions', order: 1, perms: ['POST /admin/promotions', 'PATCH /admin/promotions/:id'] },
  { code: 'featured', name: '推荐位管理', type: 1, parent: 'g.mkt', path: '/featured', icon: 'marketing', order: 5, perms: ['GET /admin/featured'] },
  { code: 'featured.write', name: '推荐位保存', type: 2, parent: 'featured', order: 1, perms: ['PUT /admin/featured'] },
  { code: 'wheel', name: '抽奖转盘', type: 1, parent: 'g.mkt', path: '/wheel', icon: 'marketing', order: 6, perms: ['GET /admin/wheel'] },
  { code: 'wheel.write', name: '转盘配置', type: 2, parent: 'wheel', order: 1, perms: ['PUT /admin/wheel'] },
  { code: 'wechat-groups', name: '微信群码', type: 1, parent: 'g.mkt', path: '/wechat-groups', icon: 'campus', order: 7, perms: ['GET /admin/wechat-groups'] },
  { code: 'wechat-groups.write', name: '群码维护', type: 2, parent: 'wechat-groups', order: 1, perms: ['POST /admin/wechat-groups', 'DELETE /admin/wechat-groups/:id'] },

  /* ---------- 目录：组织管理 ---------- */
  { code: 'g.org', name: '组织管理', type: 0, order: 5 },
  { code: 'staff', name: '履约人员', type: 1, parent: 'g.org', path: '/staff', icon: 'staff', order: 1, perms: ['GET /admin/staff', 'GET /admin/leave-requests', 'GET /admin/dispatch-invitations'] },
  { code: 'staff.write', name: '员工管理', type: 2, parent: 'staff', order: 1, perms: ['POST /admin/staff', 'PATCH /admin/staff/:id', 'DELETE /admin/staff/:id', 'POST /admin/dispatch-invitations', 'POST /admin/dispatch-invitations/:id/cancel'] },
  { code: 'recruit', name: '楼长招募', type: 1, parent: 'g.org', path: '/recruit', icon: 'recruit', order: 2, perms: ['GET /admin/recruit-applications', 'GET /admin/recruit-applications/status-counts'] },
  { code: 'recruit.note', name: '招募备注', type: 2, parent: 'recruit', order: 1, perms: ['PATCH /admin/recruit-applications/:id'] },
  { code: 'recruit.interview', name: '面试安排', type: 2, parent: 'recruit', order: 2, perms: ['POST /admin/recruit-applications/:id/transition'] },
  { code: 'recruit.approve', name: '审批通过', type: 2, parent: 'recruit', order: 3, perms: ['POST /admin/recruit-applications/:id/approve'] },
  { code: 'recruit.reject', name: '审批拒绝', type: 2, parent: 'recruit', order: 4, perms: ['POST /admin/recruit-applications/:id/reject'] },
  { code: 'recruit.idcard.read', name: '身份证查看', type: 2, parent: 'recruit', order: 5, perms: ['GET /admin/recruit-applications/:id/idcard'] },
  { code: 'recruit.idcard.write', name: '身份证补录', type: 2, parent: 'recruit', order: 6, perms: ['POST /admin/recruit-applications/:id/idcard'] },
  { code: 'buildings', name: '楼栋管理', type: 1, parent: 'g.org', path: '/buildings', icon: 'buildings', order: 3, perms: ['GET /admin/buildings', 'GET /admin/buildings/:id/rooms'] },
  { code: 'buildings.write', name: '楼栋维护', type: 2, parent: 'buildings', order: 1, perms: ['POST /admin/buildings', 'PATCH /admin/buildings/:id', 'DELETE /admin/buildings/:id', 'POST /admin/buildings/:id/rooms', 'DELETE /admin/buildings/:id/rooms/:roomId', 'GET /admin/buildings/:id/rooms/template', 'POST /admin/buildings/:id/rooms/import'] },
  { code: 'campuses', name: '校区管理', type: 1, parent: 'g.org', path: '/campuses', icon: 'campus', order: 4, perms: ['GET /admin/campuses', 'GET /admin/delivery-config'] },
  { code: 'campus-config', name: '校区配置', type: 1, parent: 'g.org', path: '/campus-config', icon: 'campus', order: 5, perms: ['GET /admin/campus-config'] },
  { code: 'campus-config.slots', name: '送达时段维护', type: 2, parent: 'campus-config', order: 1, perms: ['POST /admin/delivery-slots', 'PATCH /admin/delivery-slots/:id', 'DELETE /admin/delivery-slots/:id'] },
  { code: 'campus-config.notices', name: '公告维护', type: 2, parent: 'campus-config', order: 2, perms: ['POST /admin/notices', 'PATCH /admin/notices/:id', 'DELETE /admin/notices/:id'] },
  { code: 'campuses.config.write', name: '校区配置', type: 2, parent: 'campuses', order: 1, perms: ['PATCH /admin/delivery-config'], remark: '本校区配送费/门槛/闭店窗' },
  { code: 'campuses.manage', name: '校区本体管理', type: 2, parent: 'campuses', order: 2, perms: ['POST /admin/campuses', 'PATCH /admin/campuses/:id'], remark: '新建校区/本体增改（平台）' },
  { code: 'users', name: 'C端用户', type: 1, parent: 'g.org', path: '/users', icon: 'staff', order: 5, perms: ['GET /admin/users', 'GET /admin/users/stats', 'GET /admin/users/:id/orders'] },
  { code: 'users.phone.reveal', name: '手机号明文', type: 2, parent: 'users', order: 1, perms: ['GET /admin/users/:id/phone'] },
  { code: 'dispatch', name: '调配与请假', type: 1, parent: 'g.org', path: '/dispatch', icon: 'staff', order: 6, perms: ['GET /admin/leave-requests', 'GET /admin/dispatch-invitations'] },
  { code: 'dispatch.write', name: '调配操作', type: 2, parent: 'dispatch', order: 1, perms: ['POST /admin/dispatch-invitations', 'POST /admin/dispatch-invitations/:id/cancel'] },

  /* ---------- 目录：财务系统 ---------- */
  { code: 'g.fin', name: '财务系统', type: 0, order: 6 },
  { code: 'finance', name: '结算中心', type: 1, parent: 'g.fin', path: '/finance', icon: 'finance', order: 1, perms: ['GET /admin/settlements'] },
  { code: 'finance.confirm', name: '账单确认', type: 2, parent: 'finance', order: 1, perms: ['POST /admin/settlements/:id/confirm'] },
  { code: 'finance.pay', name: '标记支付', type: 2, parent: 'finance', order: 2, perms: ['POST /admin/settlements/:id/pay'] },
  { code: 'rules', name: '提成规则', type: 1, parent: 'g.fin', path: '/rules', icon: 'finance', order: 2, perms: ['GET /admin/commission-rules'] },
  { code: 'finance.rules.write', name: '提成规则维护', type: 2, parent: 'rules', order: 1, perms: ['POST /admin/commission-rules', 'PATCH /admin/commission-rules/:id'] },
  { code: 'audit', name: '审计日志', type: 1, parent: 'g.fin', path: '/audit', icon: 'audit', order: 3, perms: ['GET /admin/audit-logs'] },

  /* ---------- 目录：系统 ---------- */
  { code: 'g.sys', name: '系统', type: 0, order: 7 },
  { code: 'accounts', name: '账号管理', type: 1, parent: 'g.sys', path: '/accounts', icon: 'accounts', order: 1, perms: ['GET /admin/accounts', 'GET /admin/rbac/accounts/:id/preview'] },
  { code: 'rbac.accounts.write', name: '账号管理操作', type: 2, parent: 'accounts', order: 1, perms: ['POST /admin/accounts', 'PATCH /admin/accounts/:id', 'DELETE /admin/accounts/:id'] },
  { code: 'rbac-roles', name: '角色管理', type: 1, parent: 'g.sys', path: '/rbac-roles', icon: 'accounts', order: 2, perms: ['GET /admin/rbac/roles', 'GET /admin/rbac/menus', 'GET /admin/rbac/permissions', 'GET /admin/rbac/catalog'] },
  { code: 'rbac.roles.write', name: '角色管理操作', type: 2, parent: 'rbac-roles', order: 1, perms: ['POST /admin/rbac/roles', 'PATCH /admin/rbac/roles/:id', 'DELETE /admin/rbac/roles/:id'] },
  { code: 'rbac-menus', name: '菜单管理', type: 1, parent: 'g.sys', path: '/rbac-menus', icon: 'accounts', order: 3, perms: ['GET /admin/rbac/menus', 'GET /admin/rbac/catalog'] },
  { code: 'rbac.menus.write', name: '菜单管理', type: 2, parent: 'rbac-roles', order: 2, perms: ['POST /admin/rbac/menus', 'PATCH /admin/rbac/menus/:id', 'DELETE /admin/rbac/menus/:id'] },
  { code: 'rbac-permissions', name: '权限目录', type: 1, parent: 'g.sys', path: '/rbac-permissions', icon: 'accounts', order: 3, perms: ['GET /admin/rbac/permissions'] },
  { code: 'rbac-audit', name: '权限审计', type: 1, parent: 'g.sys', path: '/rbac-audit', icon: 'audit', order: 4, perms: ['GET /admin/rbac/audit'] },
  { code: 'printers', name: '打印机', type: 1, parent: 'g.sys', path: '/printers', icon: 'printers', order: 5, perms: ['GET /admin/printers'] },
  { code: 'printers.write', name: '打印机管理', type: 2, parent: 'printers', order: 1, perms: ['POST /admin/printers', 'DELETE /admin/printers/:id', 'POST /admin/printers/:id/test-print'] },
  /* 帮助中心/更新日志（道哥 2026-09-22）：纯前端只读页，不挂 API perms——
     登录即可见（router 对这两个 path 白名单放行，菜单节点仅作展示） */
  { code: 'help', name: '帮助中心', type: 1, parent: 'g.sys', path: '/help', icon: 'help', order: 6 },
  { code: 'changelog', name: '更新日志', type: 1, parent: 'g.sys', path: '/changelog', icon: 'help', order: 7 },
];

export const MENU_NODE_CODES = new Set(MENU_NODES.map((n) => n.code));
export const ALL_PERM_PATTERNS: string[] = [
  ...new Set(MENU_NODES.flatMap((n) => n.perms ?? [])),
];

/** 校验 perms 模式格式（METHOD /path） */
export function assertPatternShape(): void {
  for (const p of ALL_PERM_PATTERNS)
    if (!/^(GET|POST|PATCH|PUT|DELETE) \/admin\//.test(p))
      throw new Error(`perms 模式非法: ${p}`);
}
assertPatternShape();

/* ---------- 内置超管（通配；不可删改） ---------- */
export const SUPER_ROLE_CODE = 'super-admin';

/**
 * 守卫白名单（登录即可读，不判 perms）：当前账号权限读取入口与菜单目录。
 * 匹配语义：method + path 精确比对（path 剥全局前缀与尾部斜杠后）。
 */
export const ADMIN_URL_WHITELIST: ReadonlySet<string> = new Set([
  'GET /admin/rbac/me',
  'GET /admin/rbac/permmenu',
]);

/* ---------- 迁移模板（role_menu 节点 code 集；含目录） ---------- */

function withDirs(codes: string[]): string[] {
  const byCode = new Map(MENU_NODES.map((n) => [n.code, n]));
  const out = new Set<string>(codes);
  for (const c of codes) {
    let cur = byCode.get(c)?.parent;
    while (cur) {
      out.add(cur);
      cur = byCode.get(cur)?.parent;
    }
  }
  return [...out];
}

/**
 * 旧五角色迁移模板（对齐 RBAC V1 首版权限集，无缩水）：
 * menuCodes = 原 permissions ∪ menus（目录自动补齐父链）。
 */
export const ROLE_TEMPLATES: { code: string; name: string; remark: string; menuCodes: string[] }[] = [
  {
    code: 'hq-director',
    name: '总部长（迁移）',
    remark: '旧 hq 角色迁移模板：平台级跨校区视角',
    menuCodes: withDirs([
      'dashboard', 'orders', 'campus-report', 'official-products', 'categories', 'categories.write',
      'products.official.write', 'inventory', 'inventory.inbound', 'inventory.adjust',
      'locations', 'locations.write', 'restock', 'restock.manage', 'purchase', 'purchase.write',
      'campuses', 'campuses.config.write', 'campuses.manage',
      'accounts', 'users', 'audit',
    ]),
  },
  {
    code: 'campus-operations',
    name: '校区运营（迁移）',
    remark: '旧 operations 角色迁移模板：按校区授予',
    menuCodes: withDirs([
      'dashboard', 'orders', 'orders.write', 'after-sales', 'battle-map', 'campus-report',
      'products', 'products.write', 'products.price', 'products.status',
      'categories', 'categories.write', 'inventory', 'inventory.adjust', 'inventory.outbound',
      'warehouse-orders', 'inventory-txns',
      'locations', 'locations.write', 'restock', 'restock.order',
      'coupons', 'marketing.write', 'promotions', 'promotions.write',
      'featured', 'featured.write', 'wheel', 'wheel.write',
      'wechat-groups', 'wechat-groups.write',
      'staff', 'staff.write', 'recruit', 'recruit.note', 'recruit.interview',
      'recruit.approve', 'recruit.reject', 'recruit.idcard.read', 'recruit.idcard.write',
      'buildings', 'buildings.write', 'campuses', 'campuses.config.write',
      'users', 'users.phone.reveal', 'dispatch', 'dispatch.write',
      'finance', 'rules', 'audit',
    ]),
  },
  {
    code: 'campus-warehouse',
    name: '校区仓储（迁移）',
    remark: '旧 warehouse 角色迁移模板：按校区授予',
    menuCodes: withDirs([
      'dashboard', 'orders', 'after-sales',
      'products', 'products.write', 'products.price', 'products.status',
      'categories', 'categories.write', 'inventory', 'inventory.adjust', 'inventory.outbound',
      'warehouse-orders', 'inventory-txns',
      'locations', 'locations.write', 'restock', 'restock.order',
    ]),
  },
  {
    code: 'campus-finance',
    name: '校区财务（迁移）',
    remark: '旧 finance 角色迁移模板：按校区授予',
    menuCodes: withDirs([
      'dashboard', 'orders', 'after-sales', 'campus-report',
      'finance', 'finance.confirm', 'finance.pay', 'rules', 'finance.rules.write', 'audit',
    ]),
  },
];

/** 旧静态角色串 → 迁移落点 */
export const LEGACY_ROLE_MAP: Record<string, { template: string; scope: 'platform' | 'campus' }> = {
  admin: { template: SUPER_ROLE_CODE, scope: 'platform' },
  hq: { template: 'hq-director', scope: 'platform' },
  operations: { template: 'campus-operations', scope: 'campus' },
  warehouse: { template: 'campus-warehouse', scope: 'campus' },
  finance: { template: 'campus-finance', scope: 'campus' },
};

// 启动即校验：模板引用的节点 code 必须登记
for (const t of ROLE_TEMPLATES)
  for (const c of t.menuCodes)
    if (!MENU_NODE_CODES.has(c)) throw new Error(`模板 ${t.code} 引用未登记菜单节点: ${c}`);
