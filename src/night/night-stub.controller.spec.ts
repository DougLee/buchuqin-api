import 'reflect-metadata';
import { NightStubController } from './night-stub.controller';
import { USER_ROLES_KEY, UserRoleGuard } from '../auth/user-role.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthRequest } from '../auth/jwt-auth.guard';

/**
 * 夜宵入口桩（IKW3E7）：按 NightEntry 完整契约恒返「夜宵关闭」全关态。
 * 新版本小程序首页链路据此渲染纯白天模式；守卫链与真实实现对齐
 * （JwtAuthGuard + UserRoleGuard，仅 role=user 放行）。
 */
describe('night entry stub (IKW3E7)', () => {
  const controller = new NightStubController({
    campus: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === 'campus-a' ? { id: 'campus-a', name: '测试校区' } : null,
    },
  } as never);

  const req = (campusId = 'campus-a') =>
    ({ user: { id: 'u1', campusId } }) as unknown as AuthRequest;

  it('返回全关态：nightEnabled/inWindow/inNightSession/dayClosed 均 false', async () => {
    const res = (await controller.entry(req())) as {
      code: number;
      data: Record<string, unknown>;
    };
    expect(res.code).toBe(0);
    expect(res.data.nightEnabled).toBe(false);
    expect(res.data.inWindow).toBe(false);
    expect(res.data.inNightSession).toBe(false);
    expect(res.data.dayClosed).toBe(false);
  });

  it('契约形状完整：校区信息/窗口 null/配送费 0/nowMinutes 合法', async () => {
    const res = (await controller.entry(req())) as {
      data: {
        campusId: string;
        campusName: string;
        nightStartAt: string | null;
        nightEndAt: string | null;
        nightDeliveryFee: number;
        nowMinutes: number;
      };
    };
    expect(res.data.campusId).toBe('campus-a');
    expect(res.data.campusName).toBe('测试校区');
    expect(res.data.nightStartAt).toBeNull();
    expect(res.data.nightEndAt).toBeNull();
    expect(res.data.nightDeliveryFee).toBe(0);
    expect(res.data.nowMinutes).toBeGreaterThanOrEqual(0);
    expect(res.data.nowMinutes).toBeLessThan(1440);
  });

  it('校区查不到时 campusName 空串兜底，不抛错', async () => {
    const res = (await controller.entry(req('campus-missing'))) as {
      data: { campusId: string; campusName: string; inNightSession: boolean };
    };
    expect(res.data.campusId).toBe('campus-missing');
    expect(res.data.campusName).toBe('');
    expect(res.data.inNightSession).toBe(false);
  });

  it('守卫链与真实实现对齐：JwtAuthGuard + UserRoleGuard 仅放 role=user', () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      NightStubController,
    ) as unknown[];
    expect(guards).toContain(JwtAuthGuard);
    expect(guards).toContain(UserRoleGuard);
    expect(Reflect.getMetadata(USER_ROLES_KEY, NightStubController)).toEqual([
      'user',
    ]);
  });
});
