import { ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
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
