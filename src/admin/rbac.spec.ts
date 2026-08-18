import { ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { BusinessService } from '../business/business.service';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { ADMIN_CAMPUS_ID } from '../common/campus';
import { ADMIN_MATRIX, canAdmin } from './permissions';
import type { AuthUser } from '../auth/jwt-auth.guard';

/**
 * RBAC 权限矩阵（IK9JHR / ADR-0004 签字版）：
 * 四角色各覆盖代表性允许+拒绝；矩阵表本身做全量一致性体检。
 */
describe('admin RBAC matrix (IK9JHR)', () => {
  const db = new PrismaService();
  const admin = new AdminController(
    new AdminService(db, new BusinessService(db)),
  );
  const authorize = (
    role: AuthUser['role'],
    section: Parameters<typeof canAdmin>[1],
    access: Parameters<typeof canAdmin>[2] = 'read',
  ) =>
    (
      admin as unknown as {
        authorize: (r: unknown, s: unknown, a: unknown) => void;
      }
    ).authorize(
      { user: { id: 'spec', campusId: ADMIN_CAMPUS_ID, role } },
      section,
      access,
    );

  afterAll(() => db.$disconnect());

  it('admin 全板块读写放行', () => {
    for (const section of Object.keys(
      ADMIN_MATRIX,
    ) as (keyof typeof ADMIN_MATRIX)[]) {
      expect(() => authorize('admin', section, 'read')).not.toThrow();
      if (ADMIN_MATRIX[section].write.length)
        expect(() => authorize('admin', section, 'write')).not.toThrow();
    }
  });

  it('warehouse 仓储：出入库放行，结算/营销/员工拒绝', () => {
    expect(() => authorize('warehouse', 'inventory', 'write')).not.toThrow();
    expect(() => authorize('warehouse', 'products', 'write')).not.toThrow();
    expect(() => authorize('warehouse', 'orders', 'read')).not.toThrow();
    expect(() => authorize('warehouse', 'orders', 'write')).toThrow(
      ForbiddenException,
    );
    expect(() => authorize('warehouse', 'finance', 'read')).toThrow(
      ForbiddenException,
    );
    expect(() => authorize('warehouse', 'marketing', 'read')).toThrow(
      ForbiddenException,
    );
    expect(() => authorize('warehouse', 'staff', 'read')).toThrow(
      ForbiddenException,
    );
  });

  it('finance 财务：结算读写放行，商品/库存/营销拒绝', () => {
    expect(() => authorize('finance', 'finance', 'write')).not.toThrow();
    expect(() => authorize('finance', 'orders', 'read')).not.toThrow();
    expect(() => authorize('finance', 'audit', 'read')).not.toThrow();
    expect(() => authorize('finance', 'products', 'read')).toThrow(
      ForbiddenException,
    );
    expect(() => authorize('finance', 'inventory', 'write')).toThrow(
      ForbiddenException,
    );
    expect(() => authorize('finance', 'marketing', 'read')).toThrow(
      ForbiddenException,
    );
  });

  it('operations 运营：商品/订单/调度放行，结算只读（写拒绝）', () => {
    expect(() => authorize('operations', 'products', 'write')).not.toThrow();
    expect(() => authorize('operations', 'orders', 'write')).not.toThrow();
    expect(() => authorize('operations', 'staff', 'write')).not.toThrow();
    expect(() => authorize('operations', 'finance', 'read')).not.toThrow();
    expect(() => authorize('operations', 'finance', 'write')).toThrow(
      ForbiddenException,
    );
  });

  it('售后板块任何角色只读留档（IK9JHQ：写入口不存在）', () => {
    for (const role of [
      'admin',
      'operations',
      'warehouse',
      'finance',
    ] as const) {
      expect(() => authorize(role, 'after-sales', 'read')).not.toThrow();
      expect(() => authorize(role, 'after-sales', 'write')).toThrow(
        ForbiddenException,
      );
    }
  });

  it('非后台角色（user/楼长/骑手）一律拒绝', () => {
    for (const role of ['user', 'building-manager', 'fulltime-rider'] as const)
      expect(() => authorize(role, 'dashboard', 'read')).toThrow(
        ForbiddenException,
      );
  });

  it('矩阵一致性：write 集合必须是 read 集合的子集', () => {
    for (const rule of Object.values(ADMIN_MATRIX)) {
      for (const role of rule.write) expect(rule.read).toContain(role);
      expect(rule.read.length).toBeGreaterThan(0);
    }
  });
});
