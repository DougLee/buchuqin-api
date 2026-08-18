import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { hash } from 'bcryptjs';
import { PrismaService } from '../database/prisma.service';
import { BusinessService } from '../business/business.service';
import { AdminController } from '../admin/admin.controller';
import { AdminService } from '../admin/admin.service';
import { ADMIN_CAMPUS_ID } from '../common/campus';
import { AuthController } from './auth.controller';
import type { AuthUser } from './jwt-auth.guard';

/** 后台角色别名 test-login（IK8W5W）：operations/warehouse/finance 各发对应 role 的 token。 */
describe('auth test-login admin role aliases (IK8W5W)', () => {
  const db = new PrismaService();
  const jwt = new JwtService({
    secret: process.env.JWT_SECRET ?? 'test-secret',
    signOptions: { expiresIn: '7d' },
  });
  const controller = new AuthController(jwt, db);
  const admin = new AdminController(new AdminService(db, new BusinessService(db)));

  afterAll(() => db.$disconnect());

  it.each(['operations', 'warehouse', 'finance'])(
    '%s logs in with its own role and passes admin.authorize',
    async (identity) => {
      const result = (await controller.login({ identity })) as {
        data: { token: string; user: AuthUser & { nickname: string } };
      };
      const claims = jwt.verify<AuthUser>(result.data.token);
      expect(claims.role).toBe(identity);
      expect(claims.id).toBe(`${identity}-001`);
      expect(claims.campusId).toBe(ADMIN_CAMPUS_ID);
      expect(result.data.user.nickname).toBeTruthy();
      // 后台守卫：别名 token 与 admin 同族放行。
      expect(() =>
        (admin as unknown as { authorize: (u: AuthUser) => void }).authorize({
          user: claims,
        }),
      ).not.toThrow();
    },
  );

  it('rejects non-admin roles in admin.authorize', () => {
    const authorize = (
      admin as unknown as { authorize: (u: AuthUser) => void }
    ).authorize;
    expect(() =>
      authorize({ user: { id: 'u', campusId: ADMIN_CAMPUS_ID, role: 'user' } }),
    ).toThrow(ForbiddenException);
    expect(() =>
      authorize({
        user: { id: 's', campusId: ADMIN_CAMPUS_ID, role: 'building-manager' },
      }),
    ).toThrow(ForbiddenException);
  });
});

/** admin-login 账号密码认证（IK9JHP）：bcrypt 校验 + 统一 401 防枚举。 */
describe('auth admin-login (IK9JHP)', () => {
  const db = new PrismaService();
  const jwt = new JwtService({
    secret: process.env.JWT_SECRET ?? 'test-secret',
    signOptions: { expiresIn: '7d' },
  });
  const controller = new AuthController(jwt, db);
  const username = `spec-admin-${Date.now()}`;
  const password = 'spec-password-123';

  beforeAll(async () => {
    await db.adminAccount.create({
      data: {
        username,
        passwordHash: await hash(password, 10),
        nickname: '规格超管',
        role: 'finance',
        campusId: ADMIN_CAMPUS_ID,
      },
    });
  });

  afterAll(async () => {
    await db.adminAccount.deleteMany({ where: { username } });
    await db.$disconnect();
  });

  it('正确账密登录成功，token 携带账号真实角色与校区', async () => {
    const result = (await controller.adminLogin({ username, password })) as {
      data: { token: string; user: AuthUser & { nickname: string } };
    };
    const claims = jwt.verify<AuthUser>(result.data.token);
    expect(claims.role).toBe('finance');
    expect(claims.campusId).toBe(ADMIN_CAMPUS_ID);
    expect(result.data.user.nickname).toBe('规格超管');
  });

  it('错误密码返回 401 且不泄露账号是否存在', async () => {
    await expect(
      controller.adminLogin({ username, password: 'wrong-password' }),
    ).rejects.toThrow(new UnauthorizedException('账号或密码不正确'));
  });

  it('不存在的账号返回同样的 401 文案', async () => {
    await expect(
      controller.adminLogin({ username: 'no-such-user', password }),
    ).rejects.toThrow(new UnauthorizedException('账号或密码不正确'));
  });
});
