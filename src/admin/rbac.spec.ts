import { ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { BusinessService } from '../business/business.service';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { RbacService } from './rbac/rbac.service';
import { legacyRbacCtx, specReq } from './rbac/spec-fixtures';
import {
  ROLE_TEMPLATES,
  SECTION_ACCESS_CODE,
} from './rbac/registry';

/**
 * RBAC V1 迁移等价性（IK9JHR → 2026-09-19 重构）：
 * 旧静态矩阵（git main:src/admin/permissions.ts ADMIN_MATRIX，ADR-0004 签字版）
 * 在此冻结为基线——新体系（LEGACY_ROLE_MAP→ROLE_TEMPLATES 模板权限 + specReq
 * 上下文 + SECTION_ACCESS_CODE 端点映射）不得比旧矩阵缩水（有意变化除外，逐条注明）。
 */

/* ---------- 冻结基线：旧 ADMIN_MATRIX 快照（勿改——迁移对账凭据） ---------- */
type LegacyRole = 'admin' | 'hq' | 'operations' | 'warehouse' | 'finance';
const LEGACY_ROLES: LegacyRole[] = [
  'admin',
  'hq',
  'operations',
  'warehouse',
  'finance',
];
const LEGACY_MATRIX: Record<string, { read: LegacyRole[]; write: LegacyRole[] }> = {
  dashboard: { read: [...LEGACY_ROLES], write: [] },
  orders: {
    read: [...LEGACY_ROLES],
    write: ['admin', 'operations'],
  },
  products: {
    read: ['admin', 'operations', 'warehouse', 'hq'],
    write: ['admin', 'operations', 'warehouse', 'hq'],
  },
  categories: {
    read: ['admin', 'operations', 'warehouse', 'hq'],
    write: ['admin', 'operations', 'warehouse', 'hq'],
  },
  inventory: {
    read: ['admin', 'operations', 'warehouse', 'hq'],
    write: ['admin', 'operations', 'warehouse', 'hq'],
  },
  restock: {
    read: ['admin', 'operations', 'warehouse', 'hq'],
    write: ['admin', 'operations', 'warehouse', 'hq'],
  },
  purchase: { read: ['hq', 'admin'], write: ['hq', 'admin'] },
  'campus-report': {
    read: ['hq', 'admin', 'operations', 'finance'],
    write: [],
  },
  staff: { read: ['admin', 'operations'], write: ['admin', 'operations'] },
  campuses: {
    read: ['admin', 'operations', 'hq'],
    write: ['admin', 'operations', 'hq'],
  },
  buildings: { read: ['admin', 'operations'], write: ['admin', 'operations'] },
  'after-sales': {
    read: ['admin', 'operations', 'warehouse', 'finance'],
    write: [],
  },
  finance: {
    read: ['admin', 'operations', 'finance'],
    write: ['admin', 'finance'],
  },
  marketing: { read: ['admin', 'operations'], write: ['admin', 'operations'] },
  // IKBW0A：Banner 校区自管归 admin（hq 投放废止）
  banners: { read: ['admin'], write: ['admin'] },
  // IKBW0Q：打印机绑定与 banners 同口径
  printers: { read: ['admin'], write: ['admin'] },
  audit: {
    read: ['admin', 'operations', 'finance', 'hq'],
    write: [],
  },
  accounts: { read: ['hq', 'admin'], write: ['hq', 'admin'] },
  users: { read: ['admin', 'operations', 'hq'], write: [] },
  'wechat-groups': {
    read: ['admin', 'operations'],
    write: ['admin', 'operations'],
  },
  recruit: { read: ['admin', 'operations'], write: ['admin', 'operations'] },
};

/* ---------- 等价改写：旧板块×角色 → 新端点权限码 ---------- */
/**
 * 拆码改写（旧一格读写 → 新更细粒度；语义等价但码不同）：
 * - hq×products：旧「hq 商品板块=官方商品库」（IKAJSM）拆为 products.official.*；
 * - hq×restock(write)：旧「批次管理+审单」拆为平台码 restock.manage。
 * 其余板块×角色按 SECTION_ACCESS_CODE 直译。
 */
const CODE_OVERRIDE: Record<
  string,
  { read?: string; write?: string }
> = {
  'hq|products': { read: 'products.official.read', write: 'products.official.write' },
  'hq|restock': { write: 'restock.manage' },
};
const endpointCode = (role: string, section: string, access: 'read' | 'write') =>
  CODE_OVERRIDE[`${role}|${section}`]?.[access] ??
  SECTION_ACCESS_CODE[section][access];

/**
 * 有意变化（V1 收权/对齐，非缩水事故；单独用例逐一断言）：
 * - operations|campuses|write：旧矩阵写列含 operations，但 IKBWRT controller
 *   门禁实际只放 hq/admin（矩阵与门禁漂移）；V1 权限码与真实门禁对齐 → 拒。
 * - hq|accounts|write：旧 hq 可管账号；V1 收归超管（goal：仅超管管理账号授权）。
 */
const INTENTIONAL_DENY = ['operations|campuses|write', 'hq|accounts|write'];

describe('admin RBAC migration (IK9JHR → V1)', () => {
  const db = new PrismaService();
  const rbac = new RbacService(db);
  const admin = new AdminController(
    new AdminService(db, new BusinessService(db)),
    rbac,
  );
  const has = (role: string, code: string) =>
    rbac.has(legacyRbacCtx(role), code);
  /** 经控制器 authorize 兼容层（SECTION_ACCESS_CODE 映射 + requirePerm 链路） */
  const authorize = (
    role: string,
    section: string,
    access: 'read' | 'write' = 'read',
  ) =>
    (
      admin as unknown as {
        authorize: (r: unknown, s: unknown, a: unknown) => void;
      }
    ).authorize(specReq(role), section, access);

  afterAll(() => db.$disconnect());

  it('冻结基线自检：旧矩阵 write ⊆ read，read 非空', () => {
    for (const rule of Object.values(LEGACY_MATRIX)) {
      for (const role of rule.write) expect(rule.read).toContain(role);
      expect(rule.read.length).toBeGreaterThan(0);
    }
  });

  it('迁移无缩水：旧矩阵 read/write=true → 新体系等价放行对应端点码；=false → 拒绝', () => {
    const mismatches: string[] = [];
    for (const [section, rule] of Object.entries(LEGACY_MATRIX)) {
      for (const access of ['read', 'write'] as const) {
        // 旧 write=[] 的板块无写端点（新映射 write 码=读码同值），不做写断言
        if (access === 'write' && rule.write.length === 0) continue;
        for (const role of LEGACY_ROLES) {
          if (INTENTIONAL_DENY.includes(`${role}|${section}|${access}`)) continue;
          const legacyAllowed = rule[access].includes(role);
          const nowAllowed = has(role, endpointCode(role, section, access));
          if (legacyAllowed !== nowAllowed)
            mismatches.push(
              `${role} ${section}.${access}(${endpointCode(role, section, access)}): 旧=${legacyAllowed} 新=${nowAllowed}`,
            );
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('admin（超管通配）全板块读写放行', () => {
    for (const [section, codes] of Object.entries(SECTION_ACCESS_CODE)) {
      void section;
      expect(has('admin', codes.read)).toBe(true);
      expect(has('admin', codes.write)).toBe(true);
    }
  });

  it('代表性拒绝：warehouse 结算/营销/员工只字不提；finance 不碰商品库存', () => {
    expect(has('warehouse', 'finance.read')).toBe(false);
    expect(has('warehouse', 'marketing.read')).toBe(false);
    expect(has('warehouse', 'staff.read')).toBe(false);
    expect(has('warehouse', 'orders.write')).toBe(false);
    expect(has('finance', 'products.read')).toBe(false);
    expect(has('finance', 'inventory.adjust')).toBe(false);
    expect(has('operations', 'purchase.read')).toBe(false);
    expect(has('operations', 'banners.read')).toBe(false);
  });

  it('拆码等价：hq 商品=官方库（products.official.*）；hq 订货写=批次管理（restock.manage）', () => {
    for (const code of [
      'products.official.read',
      'products.official.write',
      'restock.manage',
    ])
      expect(has('hq', code)).toBe(true);
    // 校区商品/校区订货提交不在 hq 权限面（拆码后职责边界）
    expect(has('hq', 'products.read')).toBe(false);
    expect(has('hq', 'restock.order')).toBe(false);
  });

  it('有意变化①：operations 建校区被拒（V1 对齐 IKBWRT 真实门禁，修旧矩阵漂移）', () => {
    expect(has('operations', 'campuses.manage')).toBe(false);
    expect(has('warehouse', 'campuses.manage')).toBe(false);
    expect(has('finance', 'campuses.manage')).toBe(false);
    // hq/admin 仍放行（与旧行为一致）
    expect(has('hq', 'campuses.manage')).toBe(true);
    expect(has('admin', 'campuses.manage')).toBe(true);
  });

  it('有意变化②：hq 账号管理收归超管（V1 goal：仅超管管理账号授权）', () => {
    expect(has('hq', 'rbac.accounts.write')).toBe(false);
    // 只读保留（旧矩阵 hq accounts.read=true）
    expect(has('hq', 'rbac.accounts.read')).toBe(true);
  });

  it('非后台角色（user/楼长/骑手）无法构造后台上下文', () => {
    for (const role of ['user', 'building-manager', 'fulltime-rider'])
      expect(() => legacyRbacCtx(role)).toThrow('非后台角色');
  });

  it('SECTION_ACCESS_CODE 每个 write 码在对应模板或超管可达', () => {
    const templateCodes = new Set(
      ROLE_TEMPLATES.flatMap((t) => [
        ...t.platformPermissions,
        ...t.campusPermissions,
      ]),
    );
    const superCtx = legacyRbacCtx('admin');
    const onlySuper: string[] = [];
    for (const { write } of Object.values(SECTION_ACCESS_CODE)) {
      expect(rbac.has(superCtx, write)).toBe(true); // 超管通配全量可达
      if (!templateCodes.has(write)) onlySuper.push(write);
    }
    // 模板不可达、仅超管持有的写码，恰为旧矩阵「admin 独占写」板块
    // （banners/printers）+ V1 有意收权的账号管理：
    expect(onlySuper.sort()).toEqual([
      'banners.write',
      'printers.write',
      'rbac.accounts.write',
    ]);
  });

  it('控制器 authorize 兼容层按映射判权（等价矩阵的代表通路）', () => {
    expect(() => authorize('warehouse', 'inventory', 'write')).not.toThrow();
    expect(() => authorize('warehouse', 'products', 'write')).not.toThrow();
    expect(() => authorize('finance', 'finance', 'write')).not.toThrow();
    expect(() => authorize('operations', 'orders', 'write')).not.toThrow();
    expect(() => authorize('operations', 'after-sales', 'read')).not.toThrow();
    expect(() => authorize('warehouse', 'orders', 'write')).toThrow(
      ForbiddenException,
    );
    expect(() => authorize('finance', 'marketing', 'read')).toThrow(
      ForbiddenException,
    );
    expect(() => authorize('operations', 'banners', 'read')).toThrow(
      ForbiddenException,
    );
    // 校区角色 hq 专属平台动作不可达（purchase 仅 hq/admin）
    expect(() => authorize('operations', 'purchase', 'read')).toThrow(
      ForbiddenException,
    );
    expect(() => authorize('hq', 'purchase', 'read')).not.toThrow();
  });
});
