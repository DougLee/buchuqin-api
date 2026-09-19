import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../database/prisma.service';
import { BusinessService } from '../business/business.service';
import { AdminService } from './admin.service';
import { AuthController } from '../auth/auth.controller';
import { RbacService } from './rbac/rbac.service';
import { ADMIN_CAMPUS_ID } from '../common/campus';

/**
 * 后台账号管理（IK9KWO → RBAC V1 2026-09-19）：建号/改号/删号 + 授权分离 +
 * 最后超管保护（AdminAccountRole 维度）+ 自助改密。真实 DB 集成测试，用完即清。
 */
describe('admin account management (IK9KWO)', () => {
  const db = new PrismaService();
  const business = new BusinessService(db);
  const service = new AdminService(db, business);
  const rbac = new RbacService(db);
  const auth = new AuthController(
    new JwtService({ secret: 'spec-secret' }),
    db,
    business,
    rbac,
  );
  const CAMPUS = ADMIN_CAMPUS_ID;
  const tag = `spec-${Date.now()}`;
  const ids: string[] = [];
  const actor = { id: 'spec-bootstrap', username: 'spec-bootstrap' };
  let superAdminId = '';

  beforeAll(async () => {
    // 角色/权限登记入库（生产为启动同步；spec 手动触发；并发 upsert 冲突重试一次）
    try {
      await rbac.syncRegistry();
    } catch {
      await rbac.syncRegistry();
    }
    const superAdmin = await service.createAccount(
      {
        username: `${tag}-root`,
        password: 'root-pass-123',
        nickname: '规格超管',
      },
      'spec-bootstrap',
    );
    superAdminId = superAdmin.id;
    ids.push(superAdminId);
    await rbac.setAccountRoles(actor, superAdminId, [
      { roleCode: 'super-admin', scope: 'platform' },
    ]);
  });

  afterAll(async () => {
    await db.auditLog.deleteMany({
      where: { entityId: { in: ids }, entityType: 'admin-account' },
    });
    await db.adminAccount.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  });

  it('建号+授权分离：账号落库、授权行走 RBAC、登录发 token（role 标记 rbac）', async () => {
    const account = await service.createAccount(
      {
        username: `${tag}-ops`,
        password: 'ops-pass-123',
        nickname: '规格运营',
        grants: [{ roleCode: 'campus-operations', scope: 'campus', campusId: CAMPUS }],
      },
      superAdminId,
    );
    ids.push(account.id);
    // 授权由 RbacService 落库（controller 编排同款调用面）
    await rbac.setAccountRoles(actor, account.id, [
      { roleCode: 'campus-operations', scope: 'campus', campusId: CAMPUS },
    ]);
    const grants = await db.adminAccountRole.findMany({
      where: { accountId: account.id },
      include: { role: { select: { code: true } } },
    });
    expect(grants).toHaveLength(1);
    expect(grants[0].role.code).toBe('campus-operations');
    expect(grants[0].scope).toBe('campus');
    expect(grants[0].campusId).toBe(CAMPUS);
    const result = (await auth.adminLogin({
      username: `${tag}-ops`,
      password: 'ops-pass-123',
    })) as { data: { user: { role: string; nickname: string } } };
    // V1：token role=账号标记 'rbac'，真实权限看 RBAC 上下文（Guard 装载）
    expect(result.data.user.role).toBe('rbac');
    expect(result.data.user.nickname).toBe('规格运营');
  });

  it('重复用户名被拒绝', async () => {
    await expect(
      service.createAccount(
        { username: `${tag}-ops`, password: 'whatever-123' },
        superAdminId,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('不能删除当前登录账号', async () => {
    await expect(service.deleteAccount(superAdminId, superAdminId)).rejects.toThrow(
      '不能删除当前登录账号',
    );
  });

  it('最后一个超管不可摘权也不可删除（AdminAccountRole 维度保护）', async () => {
    // V1 变化：旧「降级 role 字段」通道已拆——摘权=重设授权，保护下探到授权行
    await expect(
      rbac.setAccountRoles(actor, superAdminId, [
        { roleCode: 'campus-operations', scope: 'campus', campusId: CAMPUS },
      ]),
    ).rejects.toThrow('必须保留至少一个有效的超级管理员');
    // 用另一个操作者身份绕过"不能删自己"，验证最后超管保护独立生效
    await expect(
      service.deleteAccount(superAdminId, 'someone-else'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('自助改密：旧密码失效、新密码可登录、错旧密码 401', async () => {
    const account = await service.createAccount(
      { username: `${tag}-fin`, password: 'fin-old-123', nickname: '规格财务' },
      superAdminId,
    );
    ids.push(account.id);
    const req = {
      user: { id: account.id, campusId: CAMPUS, role: 'rbac' as const },
    };
    await expect(
      auth.changePassword(req as never, {
        oldPassword: 'wrong-old',
        newPassword: 'fin-new-123',
      }),
    ).rejects.toThrow(UnauthorizedException);
    await auth.changePassword(req as never, {
      oldPassword: 'fin-old-123',
      newPassword: 'fin-new-123',
    });
    await expect(
      auth.adminLogin({ username: `${tag}-fin`, password: 'fin-old-123' }),
    ).rejects.toThrow(UnauthorizedException);
    await expect(
      auth.adminLogin({ username: `${tag}-fin`, password: 'fin-new-123' }),
    ).resolves.toBeTruthy();
  });

  it('账号操作留审计', async () => {
    const logs = await db.auditLog.findMany({
      where: { entityType: 'admin-account', entityId: { in: ids } },
    });
    expect(logs.length).toBeGreaterThanOrEqual(3);
    expect(logs.map((x) => x.action)).toContain('account.create');
  });

  it('列表不泄露 passwordHash', async () => {
    const list = await service.accounts();
    for (const item of list) expect(item).not.toHaveProperty('passwordHash');
  });
});
