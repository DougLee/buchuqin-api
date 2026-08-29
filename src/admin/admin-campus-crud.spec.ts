import { ForbiddenException } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import type { AuthRequest, AuthUser } from '../auth/jwt-auth.guard';

/**
 * 校区本体增改的角色门禁（IKBWRT，2026-08-29 道哥定版）：
 * admin 平台超管与 hq 同权新建/编辑校区（对齐 IKBFJ4 账号同权口径）；
 * operations 等职能角色仍限楼栋域。守卫在 controller，服务层用桩避免动库。
 */
describe('campus CRUD role gate (IKBWRT)', () => {
  const calls: string[] = [];
  const controller = new AdminController({
    createCampus: async () => {
      calls.push('create');
      return { id: 'campus-x' };
    },
    updateCampus: async () => {
      calls.push('update');
      return { id: 'campus-x' };
    },
  } as unknown as AdminService);
  const req = (role: AuthUser['role']) =>
    ({
      user: { id: 'spec-op', campusId: 'campus-hbut', role },
    }) as unknown as AuthRequest;
  const body = { name: '测试校区', shortName: '测', warehouseName: '测试仓' };

  it('admin 可新建校区', async () => {
    await expect(
      controller.createCampus(req('admin'), body),
    ).resolves.toBeDefined();
    expect(calls).toContain('create');
  });

  it('admin 可修改校区', async () => {
    await expect(
      controller.updateCampus(req('admin'), 'campus-hbut', { name: '改名' }),
    ).resolves.toBeDefined();
    expect(calls).toContain('update');
  });

  it('operations 仍不可新建/修改校区', async () => {
    await expect(controller.createCampus(req('operations'), body)).rejects.toThrow(
      ForbiddenException,
    );
    await expect(
      controller.updateCampus(req('operations'), 'campus-hbut', { name: '改名' }),
    ).rejects.toThrow(ForbiddenException);
    expect(calls).toEqual(['create', 'update']);
  });
});
