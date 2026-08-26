import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../database/prisma.service';
import { BusinessService } from '../business/business.service';
import { AdminService } from './admin.service';
import { AuthController } from '../auth/auth.controller';
import { ADMIN_CAMPUS_ID } from '../common/campus';

/**
 * 后台账号多校区切换（IKB3KG 方案A）：
 * 授权表维护（hq 建号/改号 campusIds）+ 顶栏切换（授权校验 + 换发 token）。
 * 真实 DB 集成测试，spec 账号/校区用完即清。
 */
describe('admin campus access (IKB3KG)', () => {
  const db = new PrismaService();
  const service = new AdminService(db, new BusinessService(db));
  const auth = new AuthController(new JwtService({ secret: 'spec-secret' }), db);
  const tag = `ca-${Date.now()}`;
  const campusBId = `${tag}-campus-b`;
  const accountIds: string[] = [];

  beforeAll(async () => {
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
    await db.adminCampusAccess.deleteMany({
      where: { accountId: { in: accountIds } },
    });
    await db.adminAccount.deleteMany({ where: { id: { in: accountIds } } });
    await db.campus.delete({ where: { id: campusBId } });
    await db.$disconnect();
  });

  it('hq 建号带多校区授权：授权行落库，列表回显 campusIds', async () => {
    const account = await service.createAccount(
      {
        username: `${tag}-ops`,
        password: 'ops-pass-123',
        role: 'operations',
        campusId: ADMIN_CAMPUS_ID,
        campusIds: [ADMIN_CAMPUS_ID, campusBId],
      },
      'spec-hq',
      '',
      'hq',
    );
    accountIds.push(account.id);
    const rows = await db.adminCampusAccess.findMany({
      where: { accountId: account.id },
    });
    expect(rows.map((r) => r.campusId).sort()).toEqual(
      [ADMIN_CAMPUS_ID, campusBId].sort(),
    );
    const list = (await service.accounts()) as {
      id: string;
      campusIds: string[];
    }[];
    const mine = list.find((x) => x.id === account.id);
    expect(mine?.campusIds.sort()).toEqual([ADMIN_CAMPUS_ID, campusBId].sort());
  });

  it('hq 重设授权：移出当前校区时账号自动挪到新集合首个', async () => {
    const account = await service.createAccount(
      {
        username: `${tag}-wh`,
        password: 'wh-pass-123',
        role: 'warehouse',
        campusId: ADMIN_CAMPUS_ID,
      },
      'spec-hq',
      '',
      'hq',
    );
    accountIds.push(account.id);
    await service.updateAccount(
      account.id,
      { campusIds: [campusBId] },
      'spec-hq',
      '',
      'hq',
    );
    const after = await db.adminAccount.findUniqueOrThrow({
      where: { id: account.id },
    });
    expect(after.campusId).toBe(campusBId);
    const rows = await db.adminCampusAccess.findMany({
      where: { accountId: account.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].campusId).toBe(campusBId);
  });

  it('空校区列表被拒绝；无效校区被拒绝', async () => {
    const [wh] = accountIds;
    await expect(
      service.updateAccount(wh, { campusIds: [] }, 'spec-hq', '', 'hq'),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.updateAccount(
        wh,
        { campusIds: [ADMIN_CAMPUS_ID, 'campus-not-exist'] },
        'spec-hq',
        '',
        'hq',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('顶栏切换：未授权校区被拒；授权校区换发 token 且落库', async () => {
    // 用第一个多校区账号登录
    const login = (await auth.adminLogin({
      username: `${tag}-ops`,
      password: 'ops-pass-123',
    })) as unknown as {
      data: { token: string; user: { id: string; campusId: string } };
    };
    const user = login.data.user;
    // 未授权（账号一只有两校区授权，切不存在的校区走授权拒绝前的存在性校验）
    await expect(
      auth.selectAdminCampus(
        { user: { ...user, role: 'operations' } } as never,
        { campusId: 'campus-not-exist' },
      ),
    ).rejects.toThrow(BadRequestException);
    // 授权校区切换成功：token 内 campusId 已换 + 账号表持久化
    const switched = (await auth.selectAdminCampus(
      { user: { ...user, role: 'operations' } } as never,
      { campusId: campusBId },
    )) as unknown as { data: { token: string; user: { campusId: string } } };
    expect(switched.data.user.campusId).toBe(campusBId);
    const payload = switched.data.token.split('.')[1];
    const claims = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as { campusId: string; role: string };
    expect(claims.campusId).toBe(campusBId);
    expect(claims.role).toBe('operations');
    const account = await db.adminAccount.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(account.campusId).toBe(campusBId);
    // 可运营校区列表：B 校为当前，A 校在列
    const campuses = (await auth.adminCampuses({
      user: { ...user, campusId: campusBId, role: 'operations' },
    } as never)) as unknown as {
      data: { id: string; current: boolean }[];
    };
    const ids = campuses.data.map((c) => c.id).sort();
    expect(ids).toEqual([ADMIN_CAMPUS_ID, campusBId].sort());
    expect(campuses.data.find((c) => c.current)?.id).toBe(campusBId);
    // 切回 A 校，不留脏状态
    await auth.selectAdminCampus(
      { user: { ...user, campusId: campusBId, role: 'operations' } } as never,
      { campusId: ADMIN_CAMPUS_ID },
    );
  });

  it('hq 与用户端角色不可切换', async () => {
    await expect(
      auth.selectAdminCampus(
        { user: { id: 'x', campusId: '', role: 'hq' } } as never,
        { campusId: campusBId },
      ),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      auth.selectAdminCampus(
        { user: { id: 'x', campusId: ADMIN_CAMPUS_ID, role: 'user' } } as never,
        { campusId: campusBId },
      ),
    ).rejects.toThrow(ForbiddenException);
  });
});
