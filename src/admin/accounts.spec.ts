import {
  BadRequestException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../database/prisma.service';
import { BusinessService } from '../business/business.service';
import { AdminService } from './admin.service';
import { AuthController } from '../auth/auth.controller';
import { ADMIN_CAMPUS_ID } from '../common/campus';

/**
 * 后台账号管理（IK9KWO）：CRUD + 保护规则 + 自助改密。
 * 真实 DB 集成测试，spec 账号用完即清。
 */
describe('admin account management (IK9KWO)', () => {
  const db = new PrismaService();
  const service = new AdminService(db, new BusinessService(db));
  const auth = new AuthController(
    new JwtService({ secret: 'spec-secret' }),
    db,
  );
  const CAMPUS = ADMIN_CAMPUS_ID;
  const tag = `spec-${Date.now()}`;
  const ids: string[] = [];
  let superAdminId = '';

  beforeAll(async () => {
    const superAdmin = await service.createAccount(
      {
        username: `${tag}-root`,
        password: 'root-pass-123',
        role: 'admin',
        nickname: '规格超管',
      },
      'spec-bootstrap',
      CAMPUS,
      'admin',
    );
    superAdminId = superAdmin.id;
    ids.push(superAdminId);
  });

  afterAll(async () => {
    await db.auditLog.deleteMany({
      where: { entityId: { in: ids }, entityType: 'admin-account' },
    });
    await db.adminAccount.deleteMany({ where: { id: { in: ids } } });
    await db.$disconnect();
  });

  it('创建运营账号并可登录，角色入 token', async () => {
    const account = await service.createAccount(
      {
        username: `${tag}-ops`,
        password: 'ops-pass-123',
        role: 'operations',
        nickname: '规格运营',
      },
      superAdminId,
      CAMPUS,
      'admin',
    );
    ids.push(account.id);
    const result = (await auth.adminLogin({
      username: `${tag}-ops`,
      password: 'ops-pass-123',
    })) as { data: { user: { role: string; nickname: string } } };
    expect(result.data.user.role).toBe('operations');
    expect(result.data.user.nickname).toBe('规格运营');
  });

  it('重复用户名被拒绝', async () => {
    await expect(
      service.createAccount(
        { username: `${tag}-ops`, password: 'whatever-123', role: 'finance' },
        superAdminId,
        CAMPUS,
        'admin',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('不能删除当前登录账号', async () => {
    await expect(
      service.deleteAccount(superAdminId, superAdminId, CAMPUS, 'admin'),
    ).rejects.toThrow('不能删除当前登录账号');
  });

  it('最后一个 admin 不可降级也不可删除', async () => {
    // 共享开发库可能已存在其他 admin（如本地 seed 的超管），
    // 临时把它们降级，构造"root 是最后一个 admin"的确定场景，finally 恢复。
    const others = await db.adminAccount.findMany({
      where: { role: 'admin', id: { not: superAdminId } },
      select: { id: true },
    });
    await db.adminAccount.updateMany({
      where: { id: { in: others.map((x) => x.id) } },
      data: { role: 'operations' },
    });
    try {
      await expect(
        service.updateAccount(
          superAdminId,
          { role: 'finance' },
          superAdminId,
          CAMPUS,
          'admin',
        ),
      ).rejects.toThrow('至少需要保留一个超管账号');
      await expect(
        // 用另一个操作者身份绕过"不能删自己"，验证最后 admin 保护独立生效
        service.deleteAccount(superAdminId, 'someone-else', CAMPUS, 'admin'),
      ).rejects.toThrow('至少需要保留一个超管账号');
    } finally {
      await db.adminAccount.updateMany({
        where: { id: { in: others.map((x) => x.id) } },
        data: { role: 'admin' },
      });
    }
  });

  it('自助改密：旧密码失效、新密码可登录、错旧密码 401', async () => {
    const account = await service.createAccount(
      { username: `${tag}-fin`, password: 'fin-old-123', role: 'finance' },
      superAdminId,
      CAMPUS,
      'admin',
    );
    ids.push(account.id);
    const req = {
      user: { id: account.id, campusId: CAMPUS, role: 'finance' as const },
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
