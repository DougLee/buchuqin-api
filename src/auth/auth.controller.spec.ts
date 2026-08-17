import { HttpException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../database/prisma.service';
import { AuthController } from './auth.controller';
import type { AuthRequest } from './jwt-auth.guard';

/** 微信登录 env 门控（IK8W5H）：未配置 WX_APPID/WX_SECRET 返回 501，不回退 test-login。 */
describe('auth wechat-login env gate (IK8W5H)', () => {
  const db = new PrismaService();
  const controller = new AuthController(
    new JwtService({ secret: 'test-secret' }),
    db,
  );
  const hadAppid = process.env.WX_APPID;
  const hadSecret = process.env.WX_SECRET;
  let userId = '';

  beforeAll(() => {
    delete process.env.WX_APPID;
    delete process.env.WX_SECRET;
  });
  afterAll(async () => {
    if (hadAppid) process.env.WX_APPID = hadAppid;
    if (hadSecret) process.env.WX_SECRET = hadSecret;
    if (userId) await db.user.delete({ where: { id: userId } }).catch(() => {});
    await db.$disconnect();
  });

  it('returns 501 微信登录未配置 when WX env missing', async () => {
    await expect(
      controller.wechatLogin({ code: 'wx-code' } as never),
    ).rejects.toMatchObject({
      status: 501,
      message: '微信登录未配置',
    });
    // 显式断言异常类型，避免 MatchObject 掩盖非 HttpException 错误
    try {
      await controller.wechatLogin({ code: 'wx-code' } as never);
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(501);
    }
  });

  it('binds phone for a logged-in user (simplified channel)', async () => {
    const user = await db.user.create({
      data: {
        campusId: 'campus-hbut',
        nickname: '微信绑定测试',
        phone: '',
        role: 'user',
      },
    });
    userId = user.id;
    const request = { user: { id: user.id, campusId: 'campus-hbut', role: 'user' } } as unknown as AuthRequest;
    const result = await controller.bindPhone(request, { phone: '13800001234' });
    expect(result.data.phone).toBe('13800001234');
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: user.id } })).phone,
    ).toBe('13800001234');
  });

  it('rejects malformed phone numbers before touching the database', async () => {
    const request = { user: { id: 'user-001', campusId: 'campus-hbut', role: 'user' } } as unknown as AuthRequest;
    // service 层防御性复核：绕过管道的非法号直接拒绝，不落库
    await expect(
      controller.bindPhone(request, { phone: 'abc' } as never),
    ).rejects.toThrow('手机号格式不正确');
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: 'user-001' } })).phone,
    ).not.toBe('abc');
  });
});
