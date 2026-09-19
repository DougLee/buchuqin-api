import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../app.module';
import { PrismaService } from '../database/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { RbacService } from './rbac/rbac.service';
import type { AuthUser } from '../auth/jwt-auth.guard';
import { hash } from 'bcryptjs';

/**
 * RBAC V1 集成测试（2026-09-19 goal）：
 * 独立 PostgreSQL（本地 buchuqin_rbac_test，.env 指定）+ 真实 AppModule 启动
 *（onModuleInit 执行权限/角色登记同步）+ supertest 走 HTTP 层——覆盖
 * goal「测试至少覆盖」清单：多角色并集/校区隔离/撤权余权/停用与旧 token/
 * 隐藏按钮直调/敏感字段夹带/越权参数/招募分权/变更即时生效/超管保护/审计。
 */
describe('RBAC V1 integration (real PG + HTTP)', () => {
  let app: ReturnType<Test['createTestingModule']['compile']> extends never ? never : any;
  let db: PrismaService;
  let jwt: JwtService;
  let rbac: RbacService;
  const suffix = `it${Date.now().toString(36)}`;
  const campusA = `c-a-${suffix}`;
  const campusB = `c-b-${suffix}`;
  let superAcc: { id: string; username: string };
  let multiAcc: { id: string; username: string };
  let soloAcc: { id: string; username: string };
  let customRole: { id: string; code: string } | undefined;
  const created: { accounts: string[]; campuses: string[]; products: string[]; categories: string[]; buildings: string[]; users: string[]; apps: string[] } = {
    accounts: [], campuses: [], products: [], categories: [], buildings: [], users: [], apps: [],
  };

  const token = (acc: { id: string }, campusId: string, sv = 0, role = 'rbac') =>
    jwt.sign({ id: acc.id, campusId, role, sv } satisfies AuthUser);

  const authed = (t: string) =>
    request(app.getHttpServer()).get('/api/v1/admin/rbac/me').set('Authorization', `Bearer ${t}`);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1'); // 与 main.ts 一致
    await app.init();
    db = app.get(PrismaService);
    jwt = app.get(JwtService);
    rbac = app.get(RbacService);

    // 基础校区
    for (const [id, name] of [[campusA, '集成A'], [campusB, '集成B']] as const) {
      await db.campus.create({
        data: { id, name, shortName: name, warehouseName: `${name}仓`, type: 'campus' },
      });
      created.campuses.push(id);
    }
    // 楼栋（A/B 各一，用于校区隔离断言）
    for (const [campusId, bName] of [[campusA, 'A1 栋'], [campusB, 'B1 栋']] as const) {
      const b = await db.building.create({ data: { campusId, name: bName } });
      created.buildings.push(b.id);
    }
    // 超管（super-admin 平台级）
    superAcc = await db.adminAccount.create({
      data: {
        username: `super-${suffix}`, passwordHash: await hash('super-pass-123', 4), role: 'rbac', campusId: '',
      },
    });
    created.accounts.push(superAcc.id);
    await rbac.setAccountRoles({ id: 'spec', username: 'spec' }, superAcc.id, [
      { roleCode: 'super-admin', scope: 'platform' },
    ]);
    // 多角色账号：ops@A + finance@A + finance@B
    multiAcc = await db.adminAccount.create({
      data: {
        username: `multi-${suffix}`, passwordHash: await hash('multi-pass-123', 4), role: 'rbac', campusId: campusA,
      },
    });
    created.accounts.push(multiAcc.id);
    await rbac.setAccountRoles({ id: 'spec', username: 'spec' }, multiAcc.id, [
      { roleCode: 'campus-operations', scope: 'campus', campusId: campusA },
      { roleCode: 'campus-finance', scope: 'campus', campusId: campusA },
      { roleCode: 'campus-finance', scope: 'campus', campusId: campusB },
    ]);
    // 单角色账号：warehouse@A
    soloAcc = await db.adminAccount.create({
      data: {
        username: `solo-${suffix}`, passwordHash: await hash('solo-pass-1234', 4), role: 'rbac', campusId: campusA,
      },
    });
    created.accounts.push(soloAcc.id);
    await rbac.setAccountRoles({ id: 'spec', username: 'spec' }, soloAcc.id, [
      { roleCode: 'campus-warehouse', scope: 'campus', campusId: campusA },
    ]);
  });

  afterAll(async () => {
    await db.recruitingApplication.deleteMany({ where: { id: { in: created.apps } } });
    await db.user.deleteMany({ where: { id: { in: created.users } } });
    await db.building.deleteMany({ where: { id: { in: created.buildings } } });
    await db.product.deleteMany({ where: { id: { in: created.products } } });
    await db.category.deleteMany({ where: { id: { in: created.categories } } });
    await db.adminAccount.deleteMany({ where: { id: { in: created.accounts } } });
    if (customRole) await db.adminRole.deleteMany({ where: { id: customRole.id } }).catch(() => undefined);
    await db.campus.deleteMany({ where: { id: { in: created.campuses } } });
    await app.close();
  });

  it('rbac/me：超管通配；多角色账号返回全部授权与可切校区', async () => {
    const superSv = (await db.adminAccount.findUniqueOrThrow({ where: { id: superAcc.id } })).sessionVersion;
    const r1 = await authed(token(superAcc, '', superSv)).expect(200);
    expect(r1.body.data.super).toBe(true);
    expect(r1.body.data.platform).toBe(true);
    const multiSv = (await db.adminAccount.findUniqueOrThrow({ where: { id: multiAcc.id } })).sessionVersion;
    const r2 = await authed(token(multiAcc, campusA, multiSv)).expect(200);
    expect(r2.body.data.roles).toHaveLength(3);
    expect(r2.body.data.switchableCampuses.sort()).toEqual([campusA, campusB].sort());
    expect(r2.body.data.permissions.map((p: { code: string }) => p.code)).toContain('orders.write');
    expect(r2.body.data.permissions.map((p: { code: string }) => p.code)).toContain('finance.confirm');
  });

  it('同校区多角色并集正确：ops@A 订单写 + finance@A 结算读同时在 A 生效', async () => {
    const sv = (await db.adminAccount.findUniqueOrThrow({ where: { id: multiAcc.id } })).sessionVersion;
    const t = token(multiAcc, campusA, sv);
    await request(app.getHttpServer())
      .get('/api/v1/admin/orders').set('Authorization', `Bearer ${t}`).expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/admin/settlements').set('Authorization', `Bearer ${t}`).expect(200);
  });

  it('不同校区角色不串用：B 校区上下文只剩财务，商品域被拒；越权校区参数被忽略', async () => {
    // 先在 A 上下文（运营有楼栋权）：?campus=B 越权参数被忽略，恒返回 A 楼栋
    const svA = (await db.adminAccount.findUniqueOrThrow({ where: { id: multiAcc.id } })).sessionVersion;
    const tA = token(multiAcc, campusA, svA);
    const r = await request(app.getHttpServer())
      .get(`/api/v1/admin/buildings?campus=${campusB}`)
      .set('Authorization', `Bearer ${tA}`).expect(200);
    const names = (r.body.data.items ?? r.body.data).map((x: { name: string }) => x.name);
    expect(names).toContain('A1 栋');
    expect(names).not.toContain('B1 栋');
    // 切到 B 上下文：只剩财务
    await db.adminAccount.update({ where: { id: multiAcc.id }, data: { campusId: campusB } });
    const sv = (await db.adminAccount.findUniqueOrThrow({ where: { id: multiAcc.id } })).sessionVersion;
    const t = token(multiAcc, campusB, sv);
    await request(app.getHttpServer())
      .get('/api/v1/admin/settlements').set('Authorization', `Bearer ${t}`).expect(200);
    // products.read 在 B 无授权（B 只有财务角色；财务模板无商品域）→ 403。
    // 注意 orders.read 财务模板是有的（旧矩阵无缩水迁移），不能拿来断言隔离。
    await request(app.getHttpServer())
      .get('/api/v1/admin/products?view=campus').set('Authorization', `Bearer ${t}`).expect(403);
    await db.adminAccount.update({ where: { id: multiAcc.id }, data: { campusId: campusA } });
  });

  it('撤销一个角色后其余授权仍有效（旧 token 因会话版本失效，重登后余权可用）', async () => {
    await rbac.setAccountRoles({ id: 'spec', username: 'spec' }, multiAcc.id, [
      { roleCode: 'campus-operations', scope: 'campus', campusId: campusA },
      { roleCode: 'campus-finance', scope: 'campus', campusId: campusB },
    ]);
    const sv = (await db.adminAccount.findUniqueOrThrow({ where: { id: multiAcc.id } })).sessionVersion;
    const t = token(multiAcc, campusA, sv);
    await request(app.getHttpServer())
      .get('/api/v1/admin/orders').set('Authorization', `Bearer ${t}`).expect(200);
    // 撤销 finance@A 后：结算只读（finance.read 运营模板本就有）仍可看，
    // 但写操作（finance.confirm）已失 → 403
    await request(app.getHttpServer())
      .get('/api/v1/admin/settlements').set('Authorization', `Bearer ${t}`).expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/admin/settlements/any-id/confirm')
      .set('Authorization', `Bearer ${t}`).expect(403);
    // B 校区财务仍在
    await db.adminAccount.update({ where: { id: multiAcc.id }, data: { campusId: campusB } });
    const tB = token(multiAcc, campusB, sv);
    await request(app.getHttpServer())
      .get('/api/v1/admin/settlements').set('Authorization', `Bearer ${tB}`).expect(200);
    await db.adminAccount.update({ where: { id: multiAcc.id }, data: { campusId: campusA } });
  });

  it('停用账号：旧 token 即刻 401，登录被拒；恢复后正常', async () => {
    const disabled = await db.adminAccount.create({
      data: { username: `off-${suffix}`, passwordHash: await hash('off-pass-1234', 4), role: 'rbac', campusId: campusA },
    });
    created.accounts.push(disabled.id);
    await rbac.setAccountRoles({ id: 'spec', username: 'spec' }, disabled.id, [
      { roleCode: 'campus-operations', scope: 'campus', campusId: campusA },
    ]);
    const sv = (await db.adminAccount.findUniqueOrThrow({ where: { id: disabled.id } })).sessionVersion;
    const t = token(disabled, campusA, sv);
    await authed(t).expect(200);
    await rbac.setAccountStatus({ username: 'spec' }, disabled.id, 'disabled');
    await authed(t).expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/auth/admin-login')
      .send({ username: `off-${suffix}`, password: 'off-pass-1234' })
      .expect(401);
    await rbac.setAccountStatus({ username: 'spec' }, disabled.id, 'active');
    await authed(t).expect(401); // 停用已 bump 会话版本，恢复也要求重登
  });

  it('超管重置密码后目标账号旧 token 失效', async () => {
    const sv = (await db.adminAccount.findUniqueOrThrow({ where: { id: soloAcc.id } })).sessionVersion;
    const t = token(soloAcc, campusA, sv);
    await authed(t).expect(200);
    await rbac.resetAccountPassword({ username: 'spec' }, soloAcc.id, 'new-pass-12345');
    await authed(t).expect(401);
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/admin-login')
      .send({ username: `solo-${suffix}`, password: 'new-pass-12345' })
      .expect(200);
    expect(login.body.data.token).toBeTruthy();
  });

  it('隐藏按钮直调 API 仍被拒：warehouse 无财务/招募/手机号明文', async () => {
    const sv = (await db.adminAccount.findUniqueOrThrow({ where: { id: soloAcc.id } })).sessionVersion;
    const t = token(soloAcc, campusA, sv);
    await request(app.getHttpServer())
      .get('/api/v1/admin/settlements').set('Authorization', `Bearer ${t}`).expect(403);
    await request(app.getHttpServer())
      .get('/api/v1/admin/recruit-applications').set('Authorization', `Bearer ${t}`).expect(403);
    await request(app.getHttpServer())
      .get('/api/v1/admin/users/x/phone').set('Authorization', `Bearer ${t}`).expect(403);
  });

  it('普通编辑不能夹带敏感字段：仅 products.write 的角色 PATCH 改价被拒', async () => {
    const cat = await db.category.create({ data: { name: `cat-${suffix}` } });
    created.categories.push(cat.id);
    const product = await db.product.create({
      data: {
        campusId: campusA, categoryId: cat.id, name: `p-${suffix}`, barcode: `BC${Date.now()}`,
        subtitle: '', price: 500, originalPrice: 600, stock: 10, status: 'on-sale', sales: 0,
        tag: '', image: '', weight: 0.5,
      } as never,
    });
    created.products.push(product.id);
    const role = await rbac.createRole(
      { username: 'spec' },
      { code: `tmp-editor-${suffix}`, name: '仅普通编辑', permissionCodes: ['products.read', 'products.write'] },
    );
    customRole = role;
    const editor = await db.adminAccount.create({
      data: { username: `editor-${suffix}`, passwordHash: await hash('editor-pass-1', 4), role: 'rbac', campusId: campusA },
    });
    created.accounts.push(editor.id);
    await rbac.setAccountRoles({ id: 'spec', username: 'spec' }, editor.id, [
      { roleCode: role.code, scope: 'campus', campusId: campusA },
    ]);
    const sv = (await db.adminAccount.findUniqueOrThrow({ where: { id: editor.id } })).sessionVersion;
    const t = token(editor, campusA, sv);
    // 不带价格字段：放行（普通编辑）
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/products/${product.id}`)
      .set('Authorization', `Bearer ${t}`)
      .send({ subtitle: '改简介' })
      .expect(200);
    // 夹带改价：403（products.price 缺失）
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/products/${product.id}`)
      .set('Authorization', `Bearer ${t}`)
      .send({ price: 999 })
      .expect(403);
  });

  it('越权目标校区：校区级账号把员工建到未授权校区被拒', async () => {
    const sv = (await db.adminAccount.findUniqueOrThrow({ where: { id: soloAcc.id } })).sessionVersion;
    const t = token(soloAcc, campusA, sv);
    await request(app.getHttpServer())
      .post('/api/v1/admin/staff')
      .set('Authorization', `Bearer ${t}`)
      .send({
        name: '越权员工', role: 'fulltime-rider', staffNo: `SN${Date.now()}`,
        phone: '13800000000', campusId: campusB,
      })
      .expect(403);
  });

  it('招募分权：仅有备注权限的角色可写备注，不能审批/读证件；运营全权可读证件且落审计', async () => {
    // 数据：A 校区一条已补录身份证的报名
    const user = await db.user.create({
      data: { campusId: campusA, nickname: '报名人', phone: '13900000000', role: 'user' },
    });
    created.users.push(user.id);
    const app1 = await db.recruitingApplication.create({
      data: {
        userId: user.id, campusId: campusA, buildingId: 'b-any', buildingName: 'A1 栋',
        name: '候选人', phone: '13900000000', idCardNo: '110101199001011234',
        idCardImages: ['https://example.com/a.jpg'],
      } as never,
    });
    created.apps.push(app1.id);
    const noteRole = await rbac.createRole(
      { username: 'spec' },
      { code: `tmp-note-${suffix}`, name: '招募专员', permissionCodes: ['recruit.read', 'recruit.note'] },
    );
    const noter = await db.adminAccount.create({
      data: { username: `noter-${suffix}`, passwordHash: await hash('noter-pass-12', 4), role: 'rbac', campusId: campusA },
    });
    created.accounts.push(noter.id);
    await rbac.setAccountRoles({ id: 'spec', username: 'spec' }, noter.id, [
      { roleCode: noteRole.code, scope: 'campus', campusId: campusA },
    ]);
    const sv = (await db.adminAccount.findUniqueOrThrow({ where: { id: noter.id } })).sessionVersion;
    const t = token(noter, campusA, sv);
    // 列表可见但脱敏（无身份证/备注）
    const list = await request(app.getHttpServer())
      .get('/api/v1/admin/recruit-applications').set('Authorization', `Bearer ${t}`).expect(200);
    const rows = list.body.data.items ?? list.body.data;
    expect(rows.some((x: { idCardNo?: string }) => x.idCardNo)).toBe(false);
    // 备注可写
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/recruit-applications/${app1.id}`)
      .set('Authorization', `Bearer ${t}`)
      .send({ staffRemark: '面试不错' })
      .expect(200);
    // 审批/拒绝/面试/证件读取全拒
    await request(app.getHttpServer())
      .post(`/api/v1/admin/recruit-applications/${app1.id}/approve`)
      .set('Authorization', `Bearer ${t}`).expect(403);
    await request(app.getHttpServer())
      .post(`/api/v1/admin/recruit-applications/${app1.id}/reject`)
      .set('Authorization', `Bearer ${t}`).send({ reason: 'x' }).expect(403);
    await request(app.getHttpServer())
      .get(`/api/v1/admin/recruit-applications/${app1.id}/idcard`)
      .set('Authorization', `Bearer ${t}`)
      .expect((r) => {
        if (r.status === 200) {
          // 备注持有者可读但证件字段为空
          expect(r.body.data.idCardNo).toBe('');
          expect(r.body.data.idCardImages).toEqual([]);
        } else expect(r.status).toBe(403);
      });
    // 运营（模板全权）可读证件 + 敏感审计落库
    const opSv = (await db.adminAccount.findUniqueOrThrow({ where: { id: multiAcc.id } })).sessionVersion;
    const opT = token(multiAcc, campusA, opSv);
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/admin/recruit-applications/${app1.id}/idcard`)
      .set('Authorization', `Bearer ${opT}`).expect(200);
    expect(detail.body.data.idCardNo).toBe('110101199001011234');
    const audited = await db.auditLog.findFirst({
      where: { action: 'rbac.sensitive.idcard-read', entityId: app1.id },
    });
    expect(audited).toBeTruthy();
  });

  it('超管保护：唯一超管不可自摘授权/自停/自删', async () => {
    // 测试库常驻联调超管（super001 等）——先临时停用，保证本账号是唯一有效超管，
    // 断言完恢复（联调环境不受影响）。
    const others = await db.adminAccountRole.findMany({
      where: {
        scope: 'platform',
        role: { code: 'super-admin' },
        account: { status: 'active' },
        accountId: { not: superAcc.id },
      },
      select: { accountId: true },
    });
    const paused = others.map((o) => o.accountId);
    for (const id of paused)
      await db.adminAccount.update({ where: { id }, data: { status: 'disabled' } });
    try {
      const sv = (await db.adminAccount.findUniqueOrThrow({ where: { id: superAcc.id } })).sessionVersion;
      const t = token(superAcc, '', sv, 'rbac');
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/accounts/${superAcc.id}`)
        .set('Authorization', `Bearer ${t}`)
        .send({ grants: [] })
        .expect(403);
      await request(app.getHttpServer())
        .patch(`/api/v1/admin/accounts/${superAcc.id}`)
        .set('Authorization', `Bearer ${t}`)
        .send({ status: 'disabled' })
        .expect(403);
      await request(app.getHttpServer())
        .delete(`/api/v1/admin/accounts/${superAcc.id}`)
        .set('Authorization', `Bearer ${t}`)
        .expect(400); // 不能删除当前登录账号
    } finally {
      for (const id of paused)
        await db.adminAccount.update({ where: { id }, data: { status: 'active' } });
    }
  });

  it('授权审计：授权重设与敏感访问都有 rbac.* 审计行', async () => {
    const rows = await db.auditLog.findMany({
      where: { action: 'rbac.grant.set', entityId: multiAcc.id },
    });
    expect(rows.length).toBeGreaterThan(0);
  });

  it('未知权限码：建角色 400；平台功能码校区级授权无效（finance 角色无采购）', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/rbac/roles')
      .set('Authorization', `Bearer ${token(superAcc, '', (await db.adminAccount.findUniqueOrThrow({ where: { id: superAcc.id } })).sessionVersion)}`)
      .send({ code: `bad-${suffix}`, name: '坏角色', permissionCodes: ['not.a.code'] })
      .expect(400);
    const svB = (await db.adminAccount.findUniqueOrThrow({ where: { id: multiAcc.id } })).sessionVersion;
    await db.adminAccount.update({ where: { id: multiAcc.id }, data: { campusId: campusB } });
    const tB = token(multiAcc, campusB, svB);
    await request(app.getHttpServer())
      .get('/api/v1/admin/purchase/orders').set('Authorization', `Bearer ${tB}`).expect(403);
    await db.adminAccount.update({ where: { id: multiAcc.id }, data: { campusId: campusA } });
  });

  it('非后台 token（C 端 user）访问 admin 一律 403', async () => {
    const userToken = jwt.sign({ id: 'no-such-admin', campusId: campusA, role: 'user' } satisfies AuthUser);
    await authed(userToken).expect(403);
  });
});
