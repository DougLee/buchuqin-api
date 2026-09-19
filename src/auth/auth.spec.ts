import { UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { hash } from 'bcryptjs';
import { PrismaService } from '../database/prisma.service';
import { BusinessService } from '../business/business.service';
import { RbacService } from '../admin/rbac/rbac.service';
import { ADMIN_CAMPUS_ID } from '../common/campus';
import { AuthController } from './auth.controller';
import type { AuthUser } from './jwt-auth.guard';

/** admin-login 账号密码认证（IK9JHP）：bcrypt 校验 + 统一 401 防枚举。 */
describe('auth admin-login (IK9JHP)', () => {
  const db = new PrismaService();
  const jwt = new JwtService({
    secret: process.env.JWT_SECRET ?? 'test-secret',
    signOptions: { expiresIn: '7d' },
  });
  const controller = new AuthController(jwt, db, new BusinessService(db), new RbacService(db));
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
