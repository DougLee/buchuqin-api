import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { PrismaService } from '../database/prisma.service';
import { RbacService } from './rbac/rbac.service';
import { legacyRbacCtx, specReq } from './rbac/spec-fixtures';

/**
 * 校区本体增改的门禁（IKBWRT → 蛋词体系 2026-09-19）：
 * campuses.manage 平台动作——URL 模式 POST/PATCH /admin/campuses[:id] 仅
 * hq（总部长模板）与超管角色集持有；operations 等校区模板无该模式 → guard 拒。
 * 判权已上移 AdminAuthGuard（URL 模式），本单测断言模式层放行/拒绝 +
 * controller happy-path（服务层用桩避免动库）。
 */
describe('campus CRUD role gate (IKBWRT → 蛋词模式)', () => {
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
    // allow() 纯内存判定（超管通配/模式集合），不需要真实授权数据
    new RbacService(new PrismaService()),
  );
  const rbac = new RbacService(new PrismaService());
  const allow = (role: string, method: string, path: string) =>
    rbac.allow(legacyRbacCtx(role), method, path);
  const body = { name: '测试校区', shortName: '测', warehouseName: '测试仓' };

  it('admin（超管通配）可新建/修改校区', async () => {
    expect(allow('admin', 'POST', '/admin/campuses')).toBe(true);
    expect(allow('admin', 'PATCH', '/admin/campuses/c1')).toBe(true);
    await expect(
      controller.createCampus(specReq('admin'), body),
    ).resolves.toBeDefined();
    expect(calls).toContain('create');
    await expect(
      controller.updateCampus(specReq('admin'), 'campus-hbut', { name: '改名' }),
    ).resolves.toBeDefined();
    expect(calls).toContain('update');
  });

  it('hq（总部长模板 campuses.manage 模式）同权新建/修改', async () => {
    // 与旧行为一致（IKBWRT：admin 与 hq 同权）；模板 menuCodes 含 campuses.manage
    expect(allow('hq', 'POST', '/admin/campuses')).toBe(true);
    expect(allow('hq', 'PATCH', '/admin/campuses/c1')).toBe(true);
    await expect(
      controller.createCampus(specReq('hq'), body),
    ).resolves.toBeDefined();
    await expect(
      controller.updateCampus(specReq('hq'), 'campus-hbut', { name: '改名' }),
    ).resolves.toBeDefined();
  });

  it('operations（校区模板无平台模式）仍不可新建/修改校区', () => {
    // 判权在 guard（URL 模式），controller 不再拦——用模式断言等价钉死
    expect(allow('operations', 'POST', '/admin/campuses')).toBe(false);
    expect(allow('operations', 'PATCH', '/admin/campuses/c1')).toBe(false);
    expect(allow('warehouse', 'POST', '/admin/campuses')).toBe(false);
    expect(allow('finance', 'POST', '/admin/campuses')).toBe(false);
  });
});
