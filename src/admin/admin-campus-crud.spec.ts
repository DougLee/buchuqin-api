import { ForbiddenException } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { PrismaService } from '../database/prisma.service';
import { RbacService } from './rbac/rbac.service';
import { specReq } from './rbac/spec-fixtures';

/**
 * 校区本体增改的权限门禁（IKBWRT → RBAC V1 2026-09-19）：
 * campuses.manage 平台码——admin（超管通配）与 hq（总部长模板平台权限）放行，
 * operations 等校区模板无该平台码 → 拒。守卫在 controller，服务层用桩避免动库。
 */
describe('campus CRUD role gate (IKBWRT)', () => {
  const calls: string[] = [];
  const controller = new AdminController(
    {
      createCampus: async () => {
        calls.push('create');
        return { id: 'campus-x' };
      },
      updateCampus: async () => {
        calls.push('update');
        return { id: 'campus-x' };
      },
    } as unknown as AdminService,
    // has() 纯内存判定（超管通配/权限集合），不需要真实授权数据
    new RbacService(new PrismaService()),
  );
  const body = { name: '测试校区', shortName: '测', warehouseName: '测试仓' };

  it('admin（超管通配）可新建校区', async () => {
    await expect(
      controller.createCampus(specReq('admin'), body),
    ).resolves.toBeDefined();
    expect(calls).toContain('create');
  });

  it('admin 可修改校区', async () => {
    await expect(
      controller.updateCampus(specReq('admin'), 'campus-hbut', { name: '改名' }),
    ).resolves.toBeDefined();
    expect(calls).toContain('update');
  });

  it('hq（总部长模板平台权限 campuses.manage）同权新建/修改', async () => {
    // 与旧行为一致（IKBWRT：admin 与 hq 同权）；模板 platformPermissions 含 campuses.manage
    await expect(
      controller.createCampus(specReq('hq'), body),
    ).resolves.toBeDefined();
    await expect(
      controller.updateCampus(specReq('hq'), 'campus-hbut', { name: '改名' }),
    ).resolves.toBeDefined();
  });

  it('operations（校区模板无平台码）仍不可新建/修改校区', async () => {
    await expect(
      controller.createCampus(specReq('operations'), body),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      controller.updateCampus(specReq('operations'), 'campus-hbut', {
        name: '改名',
      }),
    ).rejects.toThrow(ForbiddenException);
  });
});
