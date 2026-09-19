/**
 * RBAC V1 权限点登记表（2026-09-19 道哥 goal）：
 * 权限点由开发在此登记，RbacService 启动时同步入库（AdminPermission 表），
 * 后台只配置已实现的权限，不提供任意权限编码编辑器。
 *
 * scope 语义：
 * - platform：平台功能——数据跨校区（或平台级资源），仅「平台级」授权可用；
 * - campus：校区业务——数据按校区隔离，「平台级」或对应「校区级」授权皆可。
 *
 * 旧静态矩阵（permissions.ts 已退役，快照冻结于 rbac.spec.ts LEGACY_MATRIX，
 * 5 角色 × 24 板块读写）为迁移基线：
 * 旧 write 持有者在新粒度下拿齐拆分码（不缩水）；拆分只为未来可细配。
 * 修改口径：先改这张表 + 同步各端点 authorize，不散落 if。
 */

export type PermScope = 'platform' | 'campus';

export interface PermissionDef {
  code: string;
  name: string;
  group: string;
  scope: PermScope;
  remark?: string;
}

/** 业务分组（权限目录/角色矩阵展示排序） */
export const PERMISSION_GROUPS = [
  { key: 'rbac', name: '权限与账号' },
  { key: 'workspace', name: '工作台与订单' },
  { key: 'product', name: '商品与库存' },
  { key: 'supply', name: '订货与采购' },
  { key: 'org', name: '组织与招募' },
  { key: 'finance', name: '财务结算' },
  { key: 'marketing', name: '营销' },
  { key: 'report', name: '报表与审计' },
  { key: 'user', name: 'C 端用户' },
] as const;

export const PERMISSIONS: PermissionDef[] = [
  /* ---------- 权限与账号（platform；V1 仅超级管理员可持有） ---------- */
  { code: 'rbac.accounts.read', name: '账号查看', group: 'rbac', scope: 'platform', remark: '后台账号列表与角色绑定查看' },
  { code: 'rbac.accounts.write', name: '账号管理', group: 'rbac', scope: 'platform', remark: '创建/编辑/停用账号、重置密码、按校区授予/撤销角色' },
  { code: 'rbac.roles.read', name: '角色查看', group: 'rbac', scope: 'platform', remark: '角色列表、权限矩阵、关联账号' },
  { code: 'rbac.roles.write', name: '角色管理', group: 'rbac', scope: 'platform', remark: '新建/复制/编辑/启停角色并配置权限（内置超管除外）' },
  { code: 'rbac.permissions.read', name: '权限目录', group: 'rbac', scope: 'platform', remark: '已登记权限点/分组/含义只读展示' },
  { code: 'rbac.audit.read', name: '权限审计', group: 'rbac', scope: 'platform', remark: '授权/撤权/角色变更/敏感访问审计记录' },

  /* ---------- 工作台与订单（campus） ---------- */
  { code: 'dashboard.read', name: '工作台', group: 'workspace', scope: 'campus' },
  { code: 'orders.read', name: '订单查看', group: 'workspace', scope: 'campus' },
  { code: 'orders.write', name: '订单操作', group: 'workspace', scope: 'campus', remark: '改状态/补打小票等履约操作' },

  /* ---------- 商品与库存（campus；官方库为 platform） ---------- */
  { code: 'products.read', name: '商品查看', group: 'product', scope: 'campus' },
  { code: 'products.write', name: '商品编辑', group: 'product', scope: 'campus', remark: '新建/普通编辑（不含改价与上下架）' },
  { code: 'products.price', name: '商品改价', group: 'product', scope: 'campus', remark: '售价/原价等价格字段修改' },
  { code: 'products.status', name: '商品上下架', group: 'product', scope: 'campus', remark: '单商品与批量上下架' },
  { code: 'products.official.read', name: '官方商品库查看', group: 'product', scope: 'platform' },
  { code: 'products.official.write', name: '官方商品库维护', group: 'product', scope: 'platform', remark: '官方库建档/编辑/推校区' },
  { code: 'categories.read', name: '类别查看', group: 'product', scope: 'campus' },
  { code: 'categories.write', name: '类别维护', group: 'product', scope: 'campus', remark: '全局类别字典增删改' },
  { code: 'inventory.read', name: '库存查看', group: 'product', scope: 'campus' },
  { code: 'inventory.inbound', name: '库存入库', group: 'product', scope: 'campus', remark: '直接入库（总部仓/平台口径）；校区侧入库走订货收货' },
  { code: 'inventory.adjust', name: '库存调整/盘点', group: 'product', scope: 'campus' },
  { code: 'inventory.outbound', name: '订单出库', group: 'product', scope: 'campus', remark: '拣货出库（orders/:id/actions/outbound）' },
  { code: 'locations.read', name: '库位查看', group: 'product', scope: 'campus' },
  { code: 'locations.write', name: '库位维护', group: 'product', scope: 'campus' },

  /* ---------- 订货与采购 ---------- */
  { code: 'restock.read', name: '订货查看', group: 'supply', scope: 'campus', remark: '批次/订货单/发货单查看' },
  { code: 'restock.order', name: '校区订货', group: 'supply', scope: 'campus', remark: '订货单编辑/提交/撤回' },
  { code: 'restock.manage', name: '批次管理', group: 'supply', scope: 'platform', remark: '建批/改批/关批/审单/发货/收货确认' },
  { code: 'purchase.read', name: '采购查看', group: 'supply', scope: 'platform' },
  { code: 'purchase.write', name: '采购管理', group: 'supply', scope: 'platform', remark: '生成/验收/关闭/重开采购单' },

  /* ---------- 组织与招募（campus） ---------- */
  { code: 'staff.read', name: '员工查看', group: 'org', scope: 'campus', remark: '履约人员/请假/调配查看' },
  { code: 'staff.write', name: '员工管理', group: 'org', scope: 'campus', remark: '员工/楼栋绑定/调配邀请维护' },
  { code: 'recruit.read', name: '招募查看', group: 'org', scope: 'campus', remark: '报名列表/进度（不含身份证）' },
  { code: 'recruit.note', name: '招募备注', group: 'org', scope: 'campus', remark: '运营备注编辑' },
  { code: 'recruit.interview', name: '面试安排', group: 'org', scope: 'campus', remark: '转面试中' },
  { code: 'recruit.approve', name: '审批通过', group: 'org', scope: 'campus' },
  { code: 'recruit.reject', name: '审批拒绝', group: 'org', scope: 'campus' },
  { code: 'recruit.idcard.read', name: '身份证查看', group: 'org', scope: 'campus', remark: '身份证号与照片读取' },
  { code: 'recruit.idcard.write', name: '身份证补录', group: 'org', scope: 'campus' },
  { code: 'campuses.read', name: '校区查看', group: 'org', scope: 'campus', remark: '校区列表/详情/配置查看' },
  { code: 'campuses.config.write', name: '校区配置', group: 'org', scope: 'campus', remark: '本校区配送费/门槛/闭店窗配置' },
  { code: 'campuses.manage', name: '校区管理', group: 'org', scope: 'platform', remark: '校区本体增改/新建校区（平台级）' },
  { code: 'buildings.read', name: '楼栋查看', group: 'org', scope: 'campus', remark: '楼栋/寝室查看（含作战地图）' },
  { code: 'buildings.write', name: '楼栋管理', group: 'org', scope: 'campus', remark: '楼栋/寝室增删改/批量导入' },

  /* ---------- 财务结算（campus） ---------- */
  { code: 'finance.read', name: '结算查看', group: 'finance', scope: 'campus', remark: '账单/提成/规则查看' },
  { code: 'finance.confirm', name: '账单确认', group: 'finance', scope: 'campus' },
  { code: 'finance.pay', name: '标记支付', group: 'finance', scope: 'campus' },
  { code: 'finance.rules.write', name: '提成规则维护', group: 'finance', scope: 'campus' },

  /* ---------- 营销（campus） ---------- */
  { code: 'marketing.read', name: '营销查看', group: 'marketing', scope: 'campus', remark: '促销/优惠券/推荐位/抽奖查看' },
  { code: 'marketing.write', name: '营销管理', group: 'marketing', scope: 'campus', remark: '促销/优惠券/推荐位/抽奖维护' },
  { code: 'banners.read', name: 'Banner查看', group: 'marketing', scope: 'campus' },
  { code: 'banners.write', name: 'Banner管理', group: 'marketing', scope: 'campus' },
  { code: 'wechat-groups.read', name: '群码查看', group: 'marketing', scope: 'campus' },
  { code: 'wechat-groups.write', name: '群码维护', group: 'marketing', scope: 'campus' },
  { code: 'printers.read', name: '打印机查看', group: 'marketing', scope: 'campus' },
  { code: 'printers.write', name: '打印机管理', group: 'marketing', scope: 'campus', remark: '绑定/解绑/测试打印' },

  /* ---------- 报表与审计（campus；平台级授权=跨校区口径） ---------- */
  { code: 'campus-report.read', name: '经营日报', group: 'report', scope: 'campus' },
  { code: 'audit.read', name: '业务审计', group: 'report', scope: 'campus', remark: '业务操作审计日志查看' },

  /* ---------- C 端用户（campus） ---------- */
  { code: 'users.read', name: '用户查看', group: 'user', scope: 'campus', remark: 'C 端用户列表/订单（脱敏）' },
  { code: 'users.phone.reveal', name: '手机号明文', group: 'user', scope: 'campus', remark: '揭开用户手机号脱敏' },

  /* ---------- 售后（campus，只读留档） ---------- */
  { code: 'after-sales.read', name: '售后查看', group: 'workspace', scope: 'campus' },
];

export const PERMISSION_CODES = new Set(PERMISSIONS.map((p) => p.code));

/** 校验代码内引用的权限码已登记（防拼写漂移；启动时 assert） */
export function assertKnownCodes(codes: string[]): void {
  for (const c of codes) if (!PERMISSION_CODES.has(c))
    throw new Error(`未登记的权限码: ${c}（先在 rbac/registry.ts 登记）`);
}

/* ---------- 内置/模板角色 ---------- */

/** 受保护内置超管：权限恒为全量（通配，不落 AdminRolePermission，杜绝被改权/删权） */
export const SUPER_ROLE_CODE = 'super-admin';

export interface RoleTemplateDef {
  code: string;
  name: string;
  remark: string;
  /** 平台级授权（跨校区）持有这些权限 */
  platformPermissions: string[];
  /** 校区级授权持有这些权限（旧校区角色的迁移落点） */
  campusPermissions: string[];
}

/**
 * 旧五角色迁移模板（对照 ADMIN_MATRIX 逐格翻译，write 持有者拿齐拆分码）：
 * - super-admin 通配全量 ← 旧 admin（平台超管，全板块读写+跨校区+账号管理，原样保留）
 * - hq-director ← 旧 hq 总部长：跨校区只读 + 官方库/订货批次/采购/校区本体/账号查看。
 *   ⚠️ 变化点（待道哥确认）：旧 hq 的「账号管理」在 V1 收归超管（goal：仅超管管理账号授权）。
 * - campus-operations ← 旧 operations；campus-warehouse ← 旧 warehouse；campus-finance ← 旧 finance。
 */
export const ROLE_TEMPLATES: RoleTemplateDef[] = [
  {
    code: 'hq-director',
    name: '总部长（迁移）',
    remark: '旧 hq 角色迁移模板：平台级跨校区视角',
    platformPermissions: [
      'dashboard.read', 'orders.read',
      'products.official.read', 'products.official.write',
      'categories.read', 'categories.write',
      'inventory.read', 'inventory.inbound', 'inventory.adjust', 'inventory.outbound',
      'locations.read', 'locations.write',
      'restock.read', 'restock.manage',
      'purchase.read', 'purchase.write',
      'campus-report.read',
      'campuses.read', 'campuses.config.write', 'campuses.manage',
      'rbac.accounts.read',
      'users.read', 'audit.read',
    ],
    campusPermissions: [],
  },
  {
    code: 'campus-operations',
    name: '校区运营（迁移）',
    remark: '旧 operations 角色迁移模板：按校区授予',
    platformPermissions: [],
    campusPermissions: [
      'dashboard.read',
      'orders.read', 'orders.write',
      'products.read', 'products.write', 'products.price', 'products.status',
      'categories.read', 'categories.write',
      'inventory.read', 'inventory.adjust', 'inventory.outbound',
      'locations.read', 'locations.write',
      'restock.read', 'restock.order',
      'campus-report.read',
      'staff.read', 'staff.write',
      'campuses.read', 'campuses.config.write',
      'buildings.read', 'buildings.write',
      'after-sales.read',
      'finance.read',
      'marketing.read', 'marketing.write',
      'wechat-groups.read', 'wechat-groups.write',
      'recruit.read', 'recruit.note', 'recruit.interview', 'recruit.approve',
      'recruit.reject', 'recruit.idcard.read', 'recruit.idcard.write',
      'audit.read',
      'users.read', 'users.phone.reveal',
    ],
  },
  {
    code: 'campus-warehouse',
    name: '校区仓储（迁移）',
    remark: '旧 warehouse 角色迁移模板：按校区授予',
    platformPermissions: [],
    campusPermissions: [
      'dashboard.read',
      'orders.read',
      'products.read', 'products.write', 'products.price', 'products.status',
      'categories.read', 'categories.write',
      'inventory.read', 'inventory.adjust', 'inventory.outbound',
      'locations.read', 'locations.write',
      'restock.read', 'restock.order',
      'after-sales.read',
    ],
  },
  {
    code: 'campus-finance',
    name: '校区财务（迁移）',
    remark: '旧 finance 角色迁移模板：按校区授予',
    platformPermissions: [],
    campusPermissions: [
      'dashboard.read',
      'orders.read',
      'after-sales.read',
      'finance.read', 'finance.confirm', 'finance.pay', 'finance.rules.write',
      'campus-report.read',
      'audit.read',
    ],
  },
];

/** 旧静态角色串 → 迁移落点（AdminAccount.role 留档值的语义） */
export const LEGACY_ROLE_MAP: Record<
  string,
  { template: string; scope: 'platform' | 'campus' }
> = {
  admin: { template: SUPER_ROLE_CODE, scope: 'platform' },
  hq: { template: 'hq-director', scope: 'platform' },
  operations: { template: 'campus-operations', scope: 'campus' },
  warehouse: { template: 'campus-warehouse', scope: 'campus' },
  finance: { template: 'campus-finance', scope: 'campus' },
};

/* ---------- 旧 authorize(section, access) 兼容映射 ----------
 * 121 个既有端点经 authorize(req, section, access) 判权；映射到新权限码，
 * 个别端点（改价/上下架/身份证/账单等）在 controller 改用细粒度码。
 */
export const SECTION_ACCESS_CODE: Record<
  string,
  { read: string; write: string }
> = {
  dashboard: { read: 'dashboard.read', write: 'dashboard.read' },
  orders: { read: 'orders.read', write: 'orders.write' },
  products: { read: 'products.read', write: 'products.write' },
  categories: { read: 'categories.read', write: 'categories.write' },
  inventory: { read: 'inventory.read', write: 'inventory.adjust' },
  restock: { read: 'restock.read', write: 'restock.order' },
  purchase: { read: 'purchase.read', write: 'purchase.write' },
  'campus-report': { read: 'campus-report.read', write: 'campus-report.read' },
  staff: { read: 'staff.read', write: 'staff.write' },
  campuses: { read: 'campuses.read', write: 'campuses.manage' },
  buildings: { read: 'buildings.read', write: 'buildings.write' },
  'after-sales': { read: 'after-sales.read', write: 'after-sales.read' },
  finance: { read: 'finance.read', write: 'finance.rules.write' },
  marketing: { read: 'marketing.read', write: 'marketing.write' },
  banners: { read: 'banners.read', write: 'banners.write' },
  printers: { read: 'printers.read', write: 'printers.write' },
  audit: { read: 'audit.read', write: 'audit.read' },
  accounts: { read: 'rbac.accounts.read', write: 'rbac.accounts.write' },
  users: { read: 'users.read', write: 'users.read' },
  'wechat-groups': { read: 'wechat-groups.read', write: 'wechat-groups.write' },
  recruit: { read: 'recruit.read', write: 'recruit.approve' },
};

// 启动即校验：模板/映射引用的权限码必须全部登记
for (const t of ROLE_TEMPLATES) assertKnownCodes([...t.platformPermissions, ...t.campusPermissions]);
for (const v of Object.values(SECTION_ACCESS_CODE)) assertKnownCodes([v.read, v.write]);
