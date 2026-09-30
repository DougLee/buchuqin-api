import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AdminController } from './admin.controller';
import type { AuthRequest } from '../auth/jwt-auth.guard';

/**
 * 校区上下文语义（IKJA7Y，2026-09-30 道哥定稿）：顶栏切换器移除后，
 * 校区上下文降级为请求级参数——
 * - campusScope：平台 ?campus= 可选聚焦（缺省空串=全量）；校区级授权集内可用、
 *   集外 403、缺省本校区
 * - scopedCampus：锁定类端点的单校区取值——参数优先，缺省落点/本校区（向后兼容）
 * - assertCampusAllowed / bannerScope / productCampus 同授权集语义
 * 纯 controller 逻辑，伪造 rbac ctx，不触库。
 */
describe('campus context (IKJA7Y)', () => {
  const KNOWN = new Set(['campus-a', 'campus-b', 'campus-c', 'campus-hq']);
  const controller = new AdminController(
    {} as never,
    { knownCampusIds: async () => KNOWN } as never,
  );

  /** 校区级账号：本校区 campus-a，授权集 a/b/c */
  const campusReq = (query: Record<string, string> = {}): AuthRequest =>
    ({
      rbac: {
        accountId: 'acc-1',
        username: 'chenhaibo',
        nickname: '校区管理员',
        campusId: 'campus-a',
        platform: false,
        super: false,
        campuses: ['campus-a', 'campus-b', 'campus-c'],
        patterns: new Set(),
        menuCodes: new Set(),
      },
      query,
      user: { id: 'u1', campusId: 'campus-a' },
    }) as unknown as AuthRequest;

  /** 平台账号：落点 campus-a（可为空串=官方仓视角） */
  const platformReq = (query: Record<string, string> = {}): AuthRequest =>
    ({
      rbac: {
        accountId: 'acc-0',
        username: 'admin',
        nickname: '平台管理员',
        campusId: 'campus-a',
        platform: true,
        super: true,
        campuses: [],
        patterns: new Set(),
        menuCodes: new Set(),
      },
      query,
      user: { id: 'u0', campusId: 'campus-a' },
    }) as unknown as AuthRequest;

  it('campusScope 校区级：授权集内可切、集外 403、缺省本校区', async () => {
    expect(await controller['campusScope'](campusReq({ campus: 'campus-b' }))).toBe(
      'campus-b',
    );
    await expect(
      controller['campusScope'](campusReq({ campus: 'campus-hq' })),
    ).rejects.toThrow(ForbiddenException);
    expect(await controller['campusScope'](campusReq())).toBe('campus-a');
  });

  it('campusScope 平台：存在即可聚焦、不存在 400、缺省空串=全量', async () => {
    expect(await controller['campusScope'](platformReq({ campus: 'campus-c' }))).toBe(
      'campus-c',
    );
    await expect(
      controller['campusScope'](platformReq({ campus: 'campus-x' })),
    ).rejects.toThrow(BadRequestException);
    expect(await controller['campusScope'](platformReq())).toBe('');
  });

  it('scopedCampus：参数优先、缺省落点、校区级集外 403', async () => {
    expect(await controller['scopedCampus'](campusReq({ campus: 'campus-c' }))).toBe(
      'campus-c',
    );
    expect(await controller['scopedCampus'](campusReq())).toBe('campus-a');
    await expect(
      controller['scopedCampus'](campusReq({ campus: 'campus-hq' })),
    ).rejects.toThrow(ForbiddenException);
    // 平台：缺省落点（与原 req.user.campusId 行为一致），参数需真实校区
    expect(await controller['scopedCampus'](platformReq())).toBe('campus-a');
    expect(
      await controller['scopedCampus'](platformReq({ campus: 'campus-b' })),
    ).toBe('campus-b');
    await expect(
      controller['scopedCampus'](platformReq({ campus: 'campus-x' })),
    ).rejects.toThrow(BadRequestException);
  });

  it('assertCampusAllowed 校区级：授权集内可写为目标', async () => {
    expect(
      await controller['assertCampusAllowed'](campusReq(), 'campus-b'),
    ).toBe('campus-b');
    await expect(
      controller['assertCampusAllowed'](campusReq(), 'campus-hq'),
    ).rejects.toThrow(ForbiddenException);
    // 缺省=本校区
    expect(await controller['assertCampusAllowed'](campusReq())).toBe('campus-a');
  });

  it('bannerScope/productCampus 校区级授权集内可切', () => {
    expect(controller['bannerScope'](campusReq({ campus: 'campus-b' }))).toBe(
      'campus-b',
    );
    expect(controller['bannerScope'](campusReq({ campus: 'campus-hq' }))).toBe(
      'campus-a',
    );
    expect(
      controller['productCampus'](campusReq({ campus: 'campus-b' }), 'campus'),
    ).toBe('campus-b');
    expect(controller['productCampus'](campusReq(), 'campus')).toBe('campus-a');
  });
});
