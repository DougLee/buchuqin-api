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
  // IKKRMR：订单动作拆钮——POST /admin/orders/:id/actions/:action 通配之外的
  // 独立授权锚点（每个 action 值一个按钮，capability 判权同源）。orders.write
  // 通配仍覆盖全部已登记 action（渐进兼容，存量角色零变化）；未登记 capability
  // 的新增 action 在端点处默认 403（admin.controller 门禁），outbound 复用
  // inventory.outbound 不重复登记。
  { code: 'orders.cancel', name: '订单取消', type: 2, parent: 'orders', order: 3, perms: ['POST /admin/orders/:id/actions/cancel'], remark: '取消订单（capability order.cancel）' },
  { code: 'orders.advance', name: '订单推进', type: 2, parent: 'orders', order: 4, perms: ['POST /admin/orders/:id/actions/advance'], remark: '推进订单（capability order.advance）' },
  { code: 'orders.exception', name: '订单标记异常', type: 2, parent: 'orders', order: 5, perms: ['POST /admin/orders/:id/actions/mark-exception'], remark: '标记订单异常（capability order.exception）' },
  // IKKRMV 组织 B 后台员工配送拆钮（staff_delivery 组织校区专用动作，
  // capability 同源；orders.write 通配仍覆盖——渐进兼容，存量角色零变化）
  { code: 'orders.staff-deliver', name: '员工配送出发', type: 2, parent: 'orders', order: 6, perms: ['POST /admin/orders/:id/actions/staff-deliver'], remark: '员工取货出发（capability order.staff-deliver，IKKRMV）' },
  { code: 'orders.staff-complete', name: '员工配送送达', type: 2, parent: 'orders', order: 7, perms: ['POST /admin/orders/:id/actions/staff-complete'], remark: '员工送达寝室（capability order.staff-complete，IKKRMV）' },
  { code: 'after-sales', name: '售后退款', type: 1, parent: 'g.ops', path: '/after-sales', icon: 'after', order: 3, perms: ['GET /admin/after-sales', 'GET /admin/refunds'] },
  // IKHZKA 退款审核（动钱）：默认只授校区运营模板；仓储/财务/总部只读
  { code: 'after-sales.audit', name: '退款审核', type: 2, parent: 'after-sales', order: 1, perms: ['POST /admin/refunds/:id/audit', 'POST /admin/refunds/:id/sync', 'POST /admin/orders/:id/refunds'], remark: '批准=微信原路退回；拒绝=回滚订单；同步=查询退款终态；按商品退款' },
  { code: 'battle-map', name: '营销作战地图', type: 1, parent: 'g.ops', path: '/battle-map', icon: 'buildings', order: 4, perms: ['GET /admin/marketing/map', 'GET /admin/battle-map/buildings/:buildingId', 'GET /admin/battle-map/rooms/:roomId'] },
  { code: 'campus-report', name: '校区日报', type: 1, parent: 'g.ops', path: '/campus-report', icon: 'campus-report', order: 5, perms: ['GET /admin/reports/campus-daily', 'GET /admin/reports/hq-daily'] },

  /* ---------- 目录：仓储中心 ---------- */
  { code: 'g.wh', name: '仓储中心', type: 0, order: 2 },
  { code: 'official-products', name: '官方商品库', type: 1, parent: 'g.wh', path: '/official-products', icon: 'official-products', order: 1, perms: ['GET /admin/products', 'GET /admin/products/status-counts', 'GET /admin/products/official-library'] },
  { code: 'products.official.write', name: '官方库维护', type: 2, parent: 'official-products', order: 1, perms: ['POST /admin/products', 'PATCH /admin/products/:id', 'POST /admin/products/batch-status', 'POST /admin/products/:id/pull-upstream'], remark: '官方库建档/编辑/放行回收/推校区' },
  // IKKRMW（ADR-0001 决策 3）：平台商品目录=原官方库的逻辑层正名——数据源
  // catalogScope='platform' 行（campus-official 伪校区解绑过渡标记）。平台级
  // 能力（PLATFORM_PATTERNS 拦校区级授予）；前端页面与组织导入 UI 属 IKKRMX，
  // 落地前该菜单对超管显示「页面尚未配置」占位（同 organizations 先例）。
  { code: 'platform-products', name: '平台商品目录', type: 1, parent: 'g.wh', path: '/platform-products', icon: 'official-products', order: 8, perms: ['GET /admin/platform-products'] },
  { code: 'platform-products.write', name: '平台目录维护', type: 2, parent: 'platform-products', order: 1, perms: ['POST /admin/platform-products', 'PATCH /admin/platform-products/:id'], remark: '平台目录建档/编辑（IKKRMW 语义别名，复用官方库 service）' },
  // IKKRMX（ADR-0001 决策 4）：组织商品目录——组织层的商品建档/组织供货价/
  // 采购来源管理面。数据源=organizationId 非空且 catalogScope='org' 行（复用
  // 校区模型不建新表）。平台级能力（PLATFORM_PATTERNS 拦校区级授予，组织级
  // 账号持平台级授权可入）；数据边界由控制器按 ctx.orgLevel/organizationId
  // 收口（平台 ?organizationId 必填 / 组织级恒本组织）。前端页面未落地前同
  // organizations 先例对超管显示占位。
  { code: 'org-products', name: '组织商品', type: 1, parent: 'g.wh', path: '/org-products', icon: 'official-products', order: 9, perms: ['GET /admin/org-products'] },
  { code: 'org-products.write', name: '组织商品维护', type: 2, parent: 'org-products', order: 1, perms: ['POST /admin/org-products', 'PATCH /admin/org-products/:id', 'POST /admin/org-products/:id/import'], remark: '组织目录建档/编辑/导入组织内校区（IKKRMX）' },
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
  { code: 'restock', name: '订货单', type: 1, parent: 'g.supply', path: '/restock', icon: 'restock', order: 1, perms: ['GET /admin/restock/batches', 'GET /admin/restock/batches/:id', 'GET /admin/restock/orders', 'GET /admin/restock/orders/:id', 'GET /admin/restock/orders/:id/shipment'] },
  { code: 'restock.order', name: '校区订货', type: 2, parent: 'restock', order: 1, perms: ['PUT /admin/restock/batches/:batchId/order', 'DELETE /admin/restock/orders/:id', 'POST /admin/restock/orders/:id/receipt'], remark: '提交订货单/删除待审核单/收货确认（IKJCJF 多单制）' },
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
  // IKKRMM（ADR-0001）：多租户组织只读端点——平台权限（PLATFORM_PATTERNS 拦
  // 校区级授予），页面组件属 IKKRMS（组织 B 开通一条龙），落地前该菜单对
  // 超管显示「页面尚未配置」占位。
  { code: 'organizations', name: '组织管理', type: 1, parent: 'g.sys', path: '/organizations', icon: 'campus', order: 2, perms: ['GET /admin/organizations', 'GET /admin/organizations/:id'], remark: '多租户组织列表/详情（IKKRMM 基线）' },
  // IKKRMS：组织维护/开通按钮节点——判权恒走超管（isSuperOnlyOperation，
  // 同 rbac.accounts.write 先例），本节点供权限目录展示与角色编辑勾选留痕
  { code: 'organizations.write', name: '组织管理操作', type: 2, parent: 'organizations', order: 1, perms: ['POST /admin/organizations', 'PATCH /admin/organizations/:id', 'POST /admin/organizations/:id/status', 'POST /admin/organizations/:id/bootstrap'], remark: '组织 CRUD/启停/开通组织 B（IKKRMS，超管专属）' },
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
 * IKKRMR：rbac/capabilities 同口径——capability 字典+本人持有情况（前端按钮
 * 判权数据源，只暴露账号自身权限，与 permmenu 同信任级）。
 */
export const ADMIN_URL_WHITELIST: ReadonlySet<string> = new Set([
  'GET /admin/rbac/me',
  'GET /admin/rbac/permmenu',
  'GET /admin/rbac/capabilities',
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
      'dashboard', 'orders', 'orders.write', 'after-sales', 'after-sales.audit', 'battle-map', 'campus-report',
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

/* ==================== 预设角色（IKKRMQ，2026-10-10）：统一角色管理 ====================
 * 平台超管 / 组织管理员 / 校区管理员 / 校区运营四个官方预设，与旧五角色迁移
 * 模板（ROLE_TEMPLATES）并存且互不影响。启动同步按 code 幂等登记：首次落
 * 名称/说明/分配边界并首灌菜单（seeded 标记），之后实际权限勾选仍走角色管
 * 管理页（超管可自由增删菜单）。super-admin 为内置通配（无菜单行、不可编辑
 * 不可删），登记仅为说明与校验锚点——同步时跳过。
 *
 * 分配边界（授权侧校验，rbac.service.canAssignRole）：
 * - assignableBy：'platform' 仅超管可分配 | 'org' 组织管理员可分配 | 'campus' 校区管理员可分配；
 * - applicableLevel：null 不限 | 'org' 仅组织级账号 | 'campus' 仅校区级账号。
 */
export interface PresetRoleDef {
  code: string;
  name: string;
  remark: string;
  /** 分配权归属（值域同 AdminRole.assignableBy） */
  assignableBy: 'platform' | 'org' | 'campus';
  /** 适用目标账号层级（null=不限，值域同 AdminRole.applicableLevel） */
  applicableLevel: 'org' | 'campus' | null;
  /** 首灌菜单节点 code 集（目录自动补齐父链；super-admin 通配恒空） */
  menuCodes: string[];
}

/** campus-operator 与旧 campus-operations 迁移模板对齐（钉死不漂移的锚点） */
const CAMPUS_OPERATOR_BASE = ROLE_TEMPLATES.find(
  (t) => t.code === 'campus-operations',
)!.menuCodes;

/** campus-admin = campus-operator 全集 + 校区落位配置面（送达时段/公告） */
const CAMPUS_ADMIN_MENUS = withDirs([
  ...CAMPUS_OPERATOR_BASE,
  'campus-config',
  'campus-config.slots',
  'campus-config.notices',
]);

/**
 * org-admin = campus-admin 裁剪（IKKRMQ 拍板：组织域读 + 校区经营授权）：
 * 保留经营管理面（订单/售后/商品/库存读调/订货/营销/人事/楼栋/财务读），
 * 裁掉驻场执行与单校区落位配置（拣货出库/拣货任务/流水/库位/配送费与时段
 * 公告），另加组织域读（organizations）。scope 按 platform 授予——平台功能
 * 可携带，数据边界由账号 orgLevel='org' 收口（IKKRMP：层级优先于角色视角）。
 */
const ORG_ADMIN_MENUS = withDirs([
  'dashboard',
  'orders',
  'orders.write',
  'after-sales',
  'after-sales.audit',
  'battle-map',
  'campus-report',
  'products',
  'products.write',
  'products.price',
  'products.status',
  'categories',
  'categories.write',
  'inventory',
  'inventory.adjust',
  'restock',
  'restock.order',
  'coupons',
  'marketing.write',
  'promotions',
  'promotions.write',
  'featured',
  'featured.write',
  'wheel',
  'wheel.write',
  'wechat-groups',
  'wechat-groups.write',
  'staff',
  'staff.write',
  'recruit',
  'recruit.note',
  'recruit.interview',
  'recruit.approve',
  'recruit.reject',
  'recruit.idcard.read',
  'recruit.idcard.write',
  'buildings',
  'buildings.write',
  'campuses',
  'users',
  'users.phone.reveal',
  'dispatch',
  'dispatch.write',
  'finance',
  'rules',
  'audit',
  'organizations',
]);

export const PRESET_ROLES: PresetRoleDef[] = [
  {
    code: SUPER_ROLE_CODE,
    name: '超级管理员',
    remark: '内置：全部权限（通配），不可编辑/删除；仅系统主账号持有',
    assignableBy: 'platform',
    applicableLevel: null,
    menuCodes: [], // 通配不落 role_menu（buildMeResponse 超管分支取全树）
  },
  {
    code: 'org-admin',
    name: '组织管理员',
    remark:
      '组织域读+校区经营授权（IKKRMQ）；授权按平台级，数据边界由账号 orgLevel=org 收口',
    assignableBy: 'platform',
    applicableLevel: 'org',
    menuCodes: ORG_ADMIN_MENUS,
  },
  {
    code: 'campus-admin',
    name: '校区管理员',
    remark: '校区经营管理+落位配置（送达时段/公告）（IKKRMQ）',
    assignableBy: 'org',
    applicableLevel: 'campus',
    menuCodes: CAMPUS_ADMIN_MENUS,
  },
  {
    code: 'campus-operator',
    name: '校区运营',
    remark: '校区日常运营（对齐旧 campus-operations 迁移模板）（IKKRMQ）',
    assignableBy: 'campus',
    applicableLevel: 'campus',
    menuCodes: [...CAMPUS_OPERATOR_BASE],
  },
];

export const PRESET_ROLE_CODES = new Set(PRESET_ROLES.map((p) => p.code));

// 启动即校验：预设引用的节点 code 必须登记（super-admin 恒空跳过）
for (const p of PRESET_ROLES)
  for (const c of p.menuCodes)
    if (!MENU_NODE_CODES.has(c))
      throw new Error(`预设角色 ${p.code} 引用未登记菜单节点: ${c}`);
