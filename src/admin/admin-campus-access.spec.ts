import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../database/prisma.service';
import { BusinessService } from '../business/business.service';
import { AdminService } from './admin.service';
import { AuthController } from '../auth/auth.controller';
import { RbacService } from './rbac/rbac.service';
import { ADMIN_CAMPUS_ID } from '../common/campus';

/**
 * 后台账号多校区切换（IKB3KG → RBAC V1 2026-09-19）：
 * 多校区授权=AdminAccountRole 校区级授权集；顶栏切换=授权校验+换发 token。
 * 真实 DB 集成测试，spec 账号/校区用完即清。
 */
describe('admin campus access (IKB3KG)', () => {
  const db = new PrismaService();
  const business = new BusinessService(db);
  const service = new AdminService(db, business);
  const rbac = new RbacService(db);
  const auth = new AuthController(
    new JwtService({ secret: 'spec-secret' }),
    db,
    business,
    rbac,
  );
  const tag = `ca-${Date.now()}`;
  const campusBId = `${tag}-campus-b`;
  const accountIds: string[] = [];
  const actor = { id: 'spec-hq', username: 'spec-hq' };

  beforeAll(async () => {
    try {
      await rbac.syncRegistry();
    } catch {
      await rbac.syncRegistry();
    }
    await db.campus.create({
      data: {
        id: campusBId,
        name: `${tag}第二校园`,
        shortName: '规格B校',
        warehouseName: '规格B仓',
      },
    });
  });

  afterAll(async () => {
    await db.auditLog.deleteMany({
      where: { entityId: { in: [...accountIds, campusBId] } },
    });
    // 授权行随账号级联删；校区业务数据独立清理
    await db.adminAccount.deleteMany({ where: { id: { in: accountIds } } });
    await db.campus.delete({ where: { id: campusBId } });
    await db.$disconnect();
  });

  it('建号带多校区授权：授权行落库，列表回显 grants', async () => {
    const account = await service.createAccount(
      {
        username: `${tag}-ops`,
        password: 'ops-pass-123',
        nickname: '规格运营',
        grants: [
          { roleCode: 'campus-operations', scope: 'campus', campusId: ADMIN_CAMPUS_ID },
          { roleCode: 'campus-operations', scope: 'campus', campusId: campusBId },
        ],
      },
      'spec-hq',
    );
    accountIds.push(account.id);
    // 授权由 RbacService 落库（controller 编排同款调用面）
    await rbac.setAccountRoles(actor, account.id, [
      { roleCode: 'campus-operations', scope: 'campus', campusId: ADMIN_CAMPUS_ID },
      { roleCode: 'campus-operations', scope: 'campus', campusId: campusBId },
    ]);
    const rows = await db.adminAccountRole.findMany({
      where: { accountId: account.id },
    });
    expect(rows.map((r) => r.campusId).sort()).toEqual(
      [ADMIN_CAMPUS_ID, campusBId].sort(),
    );
    // 首个校区级授权落为初始上下文校区
    expect(account.campusId).toBe(ADMIN_CAMPUS_ID);
    const list = (await service.accounts()) as {
      id: string;
      grants: { scope: string; campusId: string | null }[];
    }[];
    const mine = list.find((x) => x.id === account.id);
    expect(
      mine?.grants
        .filter((g) => g.scope === 'campus')
        .map((g) => g.campusId)
        .sort(),
    ).toEqual([ADMIN_CAMPUS_ID, campusBId].sort());
  });

  it('重设授权：全量替换语义；上下文校区不自动挪动（V1 变化）', async () => {
    const account = await service.createAccount(
      {
        username: `${tag}-wh`,
        password: 'wh-pass-123',
        nickname: '规格仓储',
        grants: [{ roleCode: 'campus-warehouse', scope: 'campus', campusId: ADMIN_CAMPUS_ID }],
      },
      'spec-hq',
    );
    accountIds.push(account.id);
    await rbac.setAccountRoles(actor, account.id, [
      { roleCode: 'campus-warehouse', scope: 'campus', campusId: ADMIN_CAMPUS_ID },
    ]);
    // 重设=全量替换：只剩 B 校授权
    await rbac.setAccountRoles(actor, account.id, [
      { roleCode: 'campus-warehouse', scope: 'campus', campusId: campusBId },
    ]);
    const rows = await db.adminAccountRole.findMany({
      where: { accountId: account.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].campusId).toBe(campusBId);
    // V1 变化：旧 replaceCampusAccess「移出当前校区自动挪到首个」退役——
    // 上下文校区独立于授权，切换统一走 select（且受授权集约束）
    const after = await db.adminAccount.findUniqueOrThrow({
      where: { id: account.id },
    });
    expect(after.campusId).toBe(ADMIN_CAMPUS_ID);
  });

  it('非法授权被拒绝：校区级缺校区 / 校区不存在 / 角色不存在', async () => {
    const [, wh] = accountIds;
    await expect(
      rbac.setAccountRoles(actor, wh, [
        { roleCode: 'campus-warehouse', scope: 'campus' },
      ]),
    ).rejects.toThrow(BadRequestException);
    await expect(
      rbac.setAccountRoles(actor, wh, [
        { roleCode: 'campus-warehouse', scope: 'campus', campusId: 'campus-not-exist' },
      ]),
    ).rejects.toThrow(BadRequestException);
    await expect(
      rbac.setAccountRoles(actor, wh, [{ roleCode: 'no-such-role', scope: 'platform' }]),
    ).rejects.toThrow(BadRequestException);
  });

  it('顶栏切换：未授权校区被拒；授权校区换发 token 且落库', async () => {
    // 用第一个多校区账号登录（授权 A+B 两校）
    const login = (await auth.adminLogin({
      username: `${tag}-ops`,
      password: 'ops-pass-123',
    })) as unknown as {
      data: { token: string; user: { id: string; campusId: string; sv: number } };
    };
    const user = login.data.user;
    // 不存在的校区：存在性校验先拒
    await expect(
      auth.selectAdminCampus({ user } as never, { campusId: 'campus-not-exist' }),
    ).rejects.toThrow(BadRequestException);
    // 真实存在但不在授权集（campus-hq 总部仓）→ 授权拒绝
    await expect(
      auth.selectAdminCampus({ user } as never, { campusId: 'campus-hq' }),
    ).rejects.toThrow(ForbiddenException);
    // 授权校区切换成功：token 内 campusId 已换 + 账号表持久化
    const switched = (await auth.selectAdminCampus(
      { user } as never,
      { campusId: campusBId },
    )) as unknown as { data: { token: string; user: { campusId: string } } };
    expect(switched.data.user.campusId).toBe(campusBId);
    const payload = switched.data.token.split('.')[1];
    const claims = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as { campusId: string; role: string; sv: number };
    expect(claims.campusId).toBe(campusBId);
    // V1：role 为账号标记 'rbac'；sv 会话版本随 token 下发
    expect(claims.role).toBe('rbac');
    expect(claims.sv).toBe(user.sv);
    const account = await db.adminAccount.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(account.campusId).toBe(campusBId);
    // 可运营校区列表=校区级授权集：B 校为当前，A 校在列
    const campuses = (await auth.adminCampuses({
      user: { ...user, campusId: campusBId },
    } as never)) as unknown as {
      data: { id: string; current: boolean }[];
    };
    const ids = campuses.data.map((c) => c.id).sort();
    expect(ids).toEqual([ADMIN_CAMPUS_ID, campusBId].sort());
    expect(campuses.data.find((c) => c.current)?.id).toBe(campusBId);
    // 切回 A 校，不留脏状态
    await auth.selectAdminCampus(
      { user: { ...user, campusId: campusBId } } as never,
      { campusId: ADMIN_CAMPUS_ID },
    );
  });

  it('纯平台级授权（总部长）与用户端角色不可切换', async () => {
    // C 端用户 token：无 AdminAccount → 不支持切换
    await expect(
      auth.selectAdminCampus(
        { user: { id: 'x', campusId: '', role: 'user' } } as never,
        { campusId: campusBId },
      ),
    ).rejects.toThrow(ForbiddenException);
    // 纯平台级授权（总部长模板）：校区级授权集为空 → 跨校区视角不可切
    const hqAccount = await service.createAccount(
      { username: `${tag}-hq`, password: 'hq-pass-1234', nickname: '规格总部长' },
      'spec-hq',
    );
    accountIds.push(hqAccount.id);
    await rbac.setAccountRoles(actor, hqAccount.id, [
      { roleCode: 'hq-director', scope: 'platform' },
    ]);
    await expect(
      auth.selectAdminCampus(
        { user: { id: hqAccount.id, campusId: '', role: 'rbac' } } as never,
        { campusId: campusBId },
      ),
    ).rejects.toThrow(ForbiddenException);
    // 可切校区列表为空（纯平台级=跨校区视角）
    const campuses = (await auth.adminCampuses({
      user: { id: hqAccount.id, campusId: '', role: 'rbac' },
    } as never)) as unknown as { data: unknown[] };
    expect(campuses.data).toEqual([]);
  });
});
