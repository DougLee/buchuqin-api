import 'reflect-metadata';
import {
  BusinessContextStubController,
  inCloseWindow,
} from './business-context-stub.controller';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import type { AuthRequest } from '../auth/jwt-auth.guard';

/**
 * 工作台上下文桩（IKW3H9）：契约逐字段对齐真实 businessContext，夜宵侧
 * 恒关；mode 忠实复刻白天闭店判定（manualClosed + 打烊窗，跨零点合法）。
 */
describe('business-context stub (IKW3H9)', () => {
  const CAMPUS = {
    name: '测试校区',
    manualClosed: false,
    closeStart: '00:00',
    closeEnd: '00:00',
  };
  const controller = new BusinessContextStubController({
    staff: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === 'staff-1'
          ? { id: 'staff-1', role: 'fulltime-rider', campus: CAMPUS }
          : null,
    },
  } as never);

  const req = (overrides: Record<string, unknown> = {}): AuthRequest =>
    ({
      user: { id: 'staff-1', role: 'fulltime-rider', ...overrides },
    }) as unknown as AuthRequest;

  it('白天态：夜宵侧全关 + mode=day + reason 空串', async () => {
    const res = (await controller.businessContext(req())) as {
      code: number;
      data: Record<string, unknown>;
    };
    expect(res.code).toBe(0);
    expect(res.data.staffId).toBe('staff-1');
    expect(res.data.staffRole).toBe('fulltime-rider');
    expect(res.data.campusName).toBe('测试校区');
    expect(res.data.canSwitchWorkspace).toBe(false);
    expect(res.data.nightEnabled).toBe(false);
    expect(res.data.hasNightHistory).toBe(false);
    expect(res.data.hasNightStore).toBe(false);
    expect(res.data.mode).toBe('day');
    expect(res.data.reason).toBe('');
    expect(res.data.nightStartAt).toBeNull();
    expect(res.data.nightEndAt).toBeNull();
  });

  it('手动闭店 → mode=rest + reason 当前已休息', async () => {
    const c = {
      staff: {
        findUnique: async () => ({
          id: 'staff-1',
          role: 'building-manager',
          campus: { ...CAMPUS, manualClosed: true },
        }),
      },
    } as never;
    const res = (await new BusinessContextStubController(c).businessContext(
      req({ role: 'building-manager' }),
    )) as { data: { mode: string; reason: string } };
    expect(res.data.mode).toBe('rest');
    expect(res.data.reason).toBe('当前已休息');
  });

  it('打烊窗内（跨零点 22:30~06:00，北京 23:00）→ rest', () => {
    // 2026-11-17T15:00:00Z = 北京 23:00，在 22:30~06:00 跨零点窗内
    expect(
      inCloseWindow('22:30', '06:00', new Date('2026-11-17T15:00:00Z')),
    ).toBe(true);
    // 北京 12:00（04:00Z）不在窗内
    expect(
      inCloseWindow('22:30', '06:00', new Date('2026-11-17T04:00:00Z')),
    ).toBe(false);
    // 相等 = 不打烊
    expect(inCloseWindow('09:00', '09:00')).toBe(false);
    // 非法/空 = 不打烊
    expect(inCloseWindow('', '06:00')).toBe(false);
    expect(inCloseWindow('abc', '06:00')).toBe(false);
  });

  it('非履约角色 403；员工不存在 404', async () => {
    await expect(
      controller.businessContext(req({ role: 'user' })),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      controller.businessContext(req({ id: 'staff-missing' })),
    ).rejects.toThrow(NotFoundException);
  });

  it('守卫与 main 履约端对齐：JwtAuthGuard', () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      BusinessContextStubController,
    ) as unknown[];
    expect(guards).toContain(JwtAuthGuard);
  });
});
