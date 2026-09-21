import { AdminService } from './admin.service';
import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../app.module';
import { AuthController } from '../auth/auth.controller';
import { PrismaService } from '../database/prisma.service';
import { JwtService } from '@nestjs/jwt';
import { RbacService } from './rbac/rbac.service';
import type { AuthUser } from '../auth/jwt-auth.guard';
import { hash } from 'bcryptjs';
import { listAdminRoutes, concreteRoute } from './rbac/route-inventory';

/**
 * RBAC 蛋词体系集成测试（2026-09-19 拍板 B）：
 * 独立 PostgreSQL（本地 buchuqin_rbac_test，.env 指定）+ 真实 AppModule 启动
 *（onModuleInit 执行菜单树登记/存量迁移）+ supertest 走 HTTP 层（guard URL 判权）。
 * 覆盖：多角色并集/校区隔离/撤权余权/停用与旧 token/隐藏按钮直调/敏感字段夹带
 *（改价走 PATCH 复检 + 拆分端点）/越权参数/招募分权（含 idcard 拆分端点）/
 * 变更即时生效/超管保护/审计/permmenu 契约/菜单管理 CRUD/全端点矩阵扫描。
 */
jest.setTimeout(240_000);

describe('RBAC 蛋词体系 integration (real PG + HTTP)', () => {
  let app: any;
  let db: PrismaService;
  let jwt: JwtService;
  let rbac: RbacService;
  const suffix = `it${Date.now().toString(36)}`;
  const campusA = `c-a-${suffix}`;
  const campusB = `c-b-${suffix}`;
  let superAcc: { id: string; username: string };
  let multiAcc: { id: string; username: string };
  let soloAcc: { id: string; username: string };
  const created: {
    staff: string[]; accounts: string[]; campuses: string[]; products: string[];
    categories: string[]; buildings: string[]; users: string[];
    apps: string[]; roles: string[]; menus: string[];
  } = {
    staff: [], accounts: [], campuses: [], products: [], categories: [],
    buildings: [], users: [], apps: [], roles: [], menus: [],
  };

  const token = (acc: { id: string }, campusId: string, sv = 0, role = 'rbac') =>
    jwt.sign({ id: acc.id, campusId, role, sv } as AuthUser);

  const svOf = async (id: string) =>
    (await db.adminAccount.findUniqueOrThrow({ where: { id: id } })).sessionVersion;

  const authed = (t: string) =>
    request(app.getHttpServer()).get('/api/v1/admin/rbac/me').set('Authorization', `Bearer ${t}`);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    app.setGlobalPrefix('api/v1'); // 与 main.ts 一致
    await app.init();
    db = app.get(PrismaService);
    jwt = app.get(JwtService);
    rbac = app.get(RbacService);

    for (const [id, name] of [[campusA, '集成A'], [campusB, '集成B']] as const) {
      await db.campus.create({
        data: { id, name, shortName: name, warehouseName: `${name}仓`, type: 'campus' },
      });
      created.campuses.push(id);
    }
    for (const [campusId, bName] of [[campusA, 'A1 栋'], [campusB, 'B1 栋']] as const) {
      const b = await db.building.create({ data: { campusId, name: bName } });
      created.buildings.push(b.id);
    }
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
    await db.bmBill.deleteMany({ where: { staffId: { in: created.staff } } });
    await db.staff.deleteMany({ where: { id: { in: created.staff } } });
    await db.recruitingApplication.deleteMany({ where: { id: { in: created.apps } } });
    await db.user.deleteMany({ where: { id: { in: created.users } } });
    await db.building.deleteMany({ where: { id: { in: created.buildings } } });
    await db.product.deleteMany({ where: { id: { in: created.products } } });
    await db.category.deleteMany({ where: { id: { in: created.categories } } });
    await db.adminAccount.deleteMany({ where: { id: { in: created.accounts } } });
    await db.adminRoleMenu.deleteMany({ where: { roleId: { in: created.roles } } }).catch(() => undefined);
    await db.adminRole.deleteMany({ where: { id: { in: created.roles } } }).catch(() => undefined);
    await db.adminMenu.deleteMany({ where: { id: { in: created.menus } } }).catch(() => undefined);
    await db.campus.deleteMany({ where: { id: { in: created.campuses } } });
    await app.close();
  });

  it('rbac/me：超管 perms=["*"]；多角色账号返回全部授权与可切校区', async () => {
    const r1 = await authed(token(superAcc, '', await svOf(superAcc.id))).expect(200);
    expect(r1.body.data.super).toBe(true);
    expect(r1.body.data.platform).toBe(true);
    expect(r1.body.data.perms).toEqual(['*']);
    const r2 = await authed(token(multiAcc, campusA, await svOf(multiAcc.id))).expect(200);
    expect(r2.body.data.roles).toHaveLength(3);
    expect(r2.body.data.switchableCampuses.sort()).toEqual([campusA, campusB].sort());
    // 蛋词契约：perms 是 URL 模式串（ops@A ∪ finance@A 的菜单 perms 并集）
    expect(r2.body.data.perms).toContain('GET /admin/orders');
    expect(r2.body.data.perms).toContain('POST /admin/settlements/:id/confirm');
    expect(r2.body.data.perms).toContain('PATCH /admin/products/:id');
  });

  it('同校区多角色并集正确：ops@A 订单写 + finance@A 结算同时在 A 生效', async () => {
    const t = token(multiAcc, campusA, await svOf(multiAcc.id));
    await request(app.getHttpServer())
      .get('/api/v1/admin/orders').set('Authorization', `Bearer ${t}`).expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/admin/settlements').set('Authorization', `Bearer ${t}`).expect(200);
  });

  it('不同校区角色不串用：B 校区上下文只剩财务，商品域被拒；越权校区参数被忽略', async () => {
    const tA = token(multiAcc, campusA, await svOf(multiAcc.id));
    const r = await request(app.getHttpServer())
      .get(`/api/v1/admin/buildings?campus=${campusB}`)
      .set('Authorization', `Bearer ${tA}`).expect(200);
    const names = (r.body.data.items ?? r.body.data).map((x: { name: string }) => x.name);
    expect(names).toContain('A1 栋');
    expect(names).not.toContain('B1 栋');
    await db.adminAccount.update({ where: { id: multiAcc.id }, data: { campusId: campusB } });
    const t = token(multiAcc, campusB, await svOf(multiAcc.id));
    await request(app.getHttpServer())
      .get('/api/v1/admin/settlements').set('Authorization', `Bearer ${t}`).expect(200);
    // B 上下文只有 finance 角色：商品域 403（guard 模式不匹配）
    await request(app.getHttpServer())
      .get('/api/v1/admin/products?view=campus').set('Authorization', `Bearer ${t}`).expect(403);
    await db.adminAccount.update({ where: { id: multiAcc.id }, data: { campusId: campusA } });
  });

  it('撤销一个角色后其余授权仍有效（旧 token 因会话版本失效，重登后余权可用）', async () => {
    await rbac.setAccountRoles({ id: 'spec', username: 'spec' }, multiAcc.id, [
      { roleCode: 'campus-operations', scope: 'campus', campusId: campusA },
      { roleCode: 'campus-finance', scope: 'campus', campusId: campusB },
    ]);
    const t = token(multiAcc, campusA, await svOf(multiAcc.id));
    await request(app.getHttpServer())
      .get('/api/v1/admin/orders').set('Authorization', `Bearer ${t}`).expect(200);
    // 撤 finance@A 后：结算只读（运营模板含 finance 菜单）仍可看，写操作已失 → 403
    await request(app.getHttpServer())
      .get('/api/v1/admin/settlements').set('Authorization', `Bearer ${t}`).expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/admin/settlements/any-id/confirm')
      .set('Authorization', `Bearer ${t}`).expect(403);
    await db.adminAccount.update({ where: { id: multiAcc.id }, data: { campusId: campusB } });
    const tB = token(multiAcc, campusB, await svOf(multiAcc.id));
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
    const t = token(disabled, campusA, await svOf(disabled.id));
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
    const t = token(soloAcc, campusA, await svOf(soloAcc.id));
    await authed(t).expect(200);
    await rbac.resetAccountPassword({ username: 'spec' }, soloAcc.id, 'new-pass-12345');
    await authed(t).expect(401);
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/admin-login')
      .send({ username: `solo-${suffix}`, password: 'new-pass-12345' })
      .expect(200);
    expect(login.body.data.token).toBeTruthy();
  });

  it('隐藏按钮直调 API 仍被拒（guard URL 模式）：warehouse 无财务/招募/手机号明文/直入', async () => {
    const t = token(soloAcc, campusA, await svOf(soloAcc.id));
    const http = request(app.getHttpServer());
    await http.get('/api/v1/admin/settlements').set('Authorization', `Bearer ${t}`).expect(403);
    await http.get('/api/v1/admin/recruit-applications').set('Authorization', `Bearer ${t}`).expect(403);
    await http.get('/api/v1/admin/users/x/phone').set('Authorization', `Bearer ${t}`).expect(403);
    await http.post('/api/v1/admin/inventory/stock-in').set('Authorization', `Bearer ${t}`).expect(403);
    // 403 文案=蛋词同款
    const r = await request(app.getHttpServer())
      .get('/api/v1/admin/settlements').set('Authorization', `Bearer ${t}`);
    expect(r.body.message).toBe('所在用户组暂无权限');
  });

  it('白名单：账号可读取自己的权限，完整菜单目录仅超管可读', async () => {
    const t = token(soloAcc, campusA, await svOf(soloAcc.id));
    const http = request(app.getHttpServer());
    await http.get('/api/v1/admin/rbac/me').set('Authorization', `Bearer ${t}`).expect(200);
    await http.get('/api/v1/admin/rbac/menus').set('Authorization', `Bearer ${t}`).expect(403);
    const pm = await http.get('/api/v1/admin/rbac/permmenu').set('Authorization', `Bearer ${t}`).expect(200);
    expect(pm.body.data.perms).toContain('GET /admin/orders');
    // 但角色/权限目录非白名单 → 403
    await http.get('/api/v1/admin/rbac/roles').set('Authorization', `Bearer ${t}`).expect(403);
    await http.get('/api/v1/admin/rbac/permissions').set('Authorization', `Bearer ${t}`).expect(403);
  });

  it('permmenu 契约：超管 menus 全量目录+菜单；校区角色=角色菜单并集且不含未勾板块', async () => {
    const superPm = await request(app.getHttpServer())
      .get('/api/v1/admin/rbac/permmenu')
      .set('Authorization', `Bearer ${token(superAcc, campusA, await svOf(superAcc.id))}`)
      .expect(200);
    const superMenus: { code: string; type: number }[] = superPm.body.data.menus;
    expect(superMenus.length).toBeGreaterThanOrEqual(42); // 7 目录 + 35 菜单（自建另计）
    expect(superMenus.map((m) => m.code)).toContain('g.ops');
    expect(superMenus.map((m) => m.code)).toContain('finance');
    // menus 行 shape：parentId 输出父节点 code
    const orders = superMenus.find((m) => m.code === 'orders');
    expect(orders?.type).toBe(1);
    const ordersRow = superPm.body.data.menus.find((m: { code: string }) => m.code === 'orders');
    const parent = superPm.body.data.menus.find((m: { code: string }) => m.code === ordersRow.parentId);
    expect(parent?.type).toBe(0);
    // warehouse@A：含订单/商品/库存，不含财务/招募
    const whPm = await request(app.getHttpServer())
      .get('/api/v1/admin/rbac/permmenu')
      .set('Authorization', `Bearer ${token(soloAcc, campusA, await svOf(soloAcc.id))}`)
      .expect(200);
    const whCodes: string[] = whPm.body.data.menus.map((m: { code: string }) => m.code);
    for (const c of ['g.wh', 'orders', 'products', 'inventory', 'restock'])
      expect(whCodes).toContain(c);
    for (const c of ['finance', 'recruit', 'g.fin'])
      expect(whCodes).not.toContain(c);
  });

  it('角色管理契约：GET roles 返回 menuCodes；建角色按 menuCodes 勾选', async () => {
    const t = token(superAcc, '', await svOf(superAcc.id));
    const roles = await request(app.getHttpServer())
      .get('/api/v1/admin/rbac/roles').set('Authorization', `Bearer ${t}`).expect(200);
    const wh = roles.body.data.find((r: { code: string }) => r.code === 'campus-warehouse');
    expect(wh.menuCodes).toContain('products');
    expect(wh.menuCodes).toContain('products.price');
    expect(wh.menuCodes).not.toContain('finance');
    expect(wh.accountCount).toBeGreaterThanOrEqual(1);
  });

  it('改价分权：仅 products.write 的角色夹带改价 403；补 products.price 后合并端点与拆分端点都通', async () => {
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
    const mkEditor = async (code: string, menuCodes: string[]) => {
      const role = await rbac.createRole({ username: 'spec' }, { code, name: code, menuCodes });
      created.roles.push(role.id);
      const acc = await db.adminAccount.create({
        data: { username: `${code}-acc`, passwordHash: await hash('editor-pass-1', 4), role: 'rbac', campusId: campusA },
      });
      created.accounts.push(acc.id);
      await rbac.setAccountRoles({ id: 'spec', username: 'spec' }, acc.id, [
        { roleCode: role.code, scope: 'campus', campusId: campusA },
      ]);
      return token(acc, campusA, await svOf(acc.id));
    };
    // ① 仅 products+products.write：普通编辑通、夹带改价 403、拆分端点 403
    const tBasic = await mkEditor(`tmp-editor-${suffix}`, ['products', 'products.write']);
    const http = () => request(app.getHttpServer());
    await http().patch(`/api/v1/admin/products/${product.id}`)
      .set('Authorization', `Bearer ${tBasic}`).send({ subtitle: '改简介' }).expect(200);
    await http().patch(`/api/v1/admin/products/${product.id}`)
      .set('Authorization', `Bearer ${tBasic}`).send({ price: 999 }).expect(403);
    await http().patch(`/api/v1/admin/products/${product.id}/price`)
      .set('Authorization', `Bearer ${tBasic}`).send({ price: 999 }).expect(403);
    await http().patch(`/api/v1/admin/products/${product.id}`)
      .set('Authorization', `Bearer ${tBasic}`).send({ subtitle: '不应落库', status: 'off-sale' }).expect(403);
    await http().patch(`/api/v1/admin/products/${product.id}`)
      .set('Authorization', `Bearer ${tBasic}`).send({ subtitle: '夹带库存', stock: 99 }).expect(403);
    const unchanged = await db.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(unchanged.stock).toBe(10);
    expect(unchanged.status).toBe('on-sale');
    expect(unchanged.subtitle).toBe('改简介');
    // ② 加勾 products.price：夹带与拆分端点都通
    const tPrice = await mkEditor(`tmp-pricer-${suffix}`, ['products', 'products.write', 'products.price']);
    await http().patch(`/api/v1/admin/products/${product.id}`)
      .set('Authorization', `Bearer ${tPrice}`).send({ price: 999 }).expect(200);
    await http().patch(`/api/v1/admin/products/${product.id}/price`)
      .set('Authorization', `Bearer ${tPrice}`).send({ price: 1001, originalPrice: 1200 }).expect(200);
    const tStock = await mkEditor(`tmp-stock-${suffix}`, ['products', 'products.write', 'inventory.adjust']);
    await http().patch(`/api/v1/admin/products/${product.id}`)
      .set('Authorization', `Bearer ${tStock}`).send({ stock: 15 }).expect(200);
    expect((await db.product.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(15);
    // Platform product editing cannot widen the separate campus-only stock grant into the official catalog.
    const official = await db.product.create({ data: {
      campusId: 'campus-official', categoryId: cat.id, name: `official-${suffix}`, barcode: `OFF${suffix}`,
      subtitle: '', price: 500, originalPrice: 600, stock: 20, status: 'on-sale', sales: 0,
      tag: '', image: '', weight: 0.5,
    } });
    created.products.push(official.id);
    const officialRole = await rbac.createRole({ username: 'spec' }, {
      code: `official-stock-${suffix}`, name: '官方资料', menuCodes: ['products.official.write'],
    });
    created.roles.push(officialRole.id);
    const stockAcc = { id: (jwt.decode(tStock) as { id: string }).id };
    await rbac.setAccountRoles({ id: 'spec', username: 'spec' }, stockAcc.id, [
      { roleCode: `tmp-stock-${suffix}`, scope: 'campus', campusId: campusA },
      { roleCode: officialRole.code, scope: 'platform' },
    ]);
    const mixed = token(stockAcc, campusA, await svOf(stockAcc.id));
    await http().patch(`/api/v1/admin/products/${official.id}`)
      .set('Authorization', `Bearer ${mixed}`).send({ stock: 99 }).expect(403);
    expect((await db.product.findUniqueOrThrow({ where: { id: official.id } })).stock).toBe(20);
    // 空价格体 400
    await http().patch(`/api/v1/admin/products/${product.id}/price`)
      .set('Authorization', `Bearer ${tPrice}`).send({}).expect(400);
  });

  it('校区列表只返回当前操作校区；全局账号/权限预览/授权审计不能由校区角色获得', async () => {
    const role = await rbac.createRole({ username: 'spec' }, {
      code: `scope-read-${suffix}`, name: '范围读取验收',
      menuCodes: ['campuses', 'accounts', 'rbac-audit', 'campus-report'],
    });
    created.roles.push(role.id);
    const actor = { id: 'spec', username: 'spec' };
    const acc = await rbac.createAccount(actor, {
      username: `scope_${suffix}`, password: 'scope-pass-123',
      grants: [campusA, campusB].map(campusId => ({ roleCode: role.code, scope: 'campus' as const, campusId })),
    });
    created.accounts.push(acc.id);
    const t = token(acc, campusA, await svOf(acc.id));
    const rows = await request(app.getHttpServer()).get('/api/v1/admin/campuses')
      .query({ campus: campusB, campusId: campusB }).set('Authorization', `Bearer ${t}`).expect(200);
    expect(rows.body.data.map((row: { id: string }) => row.id)).toEqual([campusA]);
    for (const path of ['/admin/accounts', `/admin/rbac/accounts/${superAcc.id}/preview`, '/admin/rbac/audit', '/admin/reports/hq-daily']) {
      await request(app.getHttpServer()).get(`/api/v1${path}`).set('Authorization', `Bearer ${t}`).expect(403);
    }
    const me = await authed(t).expect(200);
    expect(me.body.data.perms).not.toContain('GET /admin/accounts');
    await rbac.setAccountRoles(actor, acc.id, [{ roleCode: role.code, scope: 'platform' }]);
    const global = await request(app.getHttpServer()).get('/api/v1/admin/campuses')
      .set('Authorization', `Bearer ${token(acc, campusA, await svOf(acc.id))}`).expect(200);
    expect(global.body.data.map((row: { id: string }) => row.id)).toEqual(expect.arrayContaining([campusA, campusB]));
  });

  it('越权目标校区：校区级账号把员工建到未授权校区被拒', async () => {
    const t = token(soloAcc, campusA, await svOf(soloAcc.id));
    await request(app.getHttpServer())
      .post('/api/v1/admin/staff')
      .set('Authorization', `Bearer ${t}`)
      .send({
        name: '越权员工', role: 'fulltime-rider', staffNo: `SN${Date.now()}`,
        phone: '13800000000', campusId: campusB,
      })
      .expect(403);
  });

  it('员工按 ID 修改/删除必须检查来源校区，不能把 B 员工拉到 A 绕过校验', async () => {
    const actor = { id: 'spec', username: 'spec' };
    const role = await rbac.createRole(actor, { code: `staff-scope-${suffix}`, name: '员工隔离', menuCodes: ['staff', 'staff.write'] });
    created.roles.push(role.id);
    const acc = await rbac.createAccount(actor, { username: `staff_${suffix}`, password: 'staff-pass-123', grants: [
      { roleCode: role.code, scope: 'campus', campusId: campusA },
      { roleCode: 'campus-finance', scope: 'campus', campusId: campusB },
    ] });
    created.accounts.push(acc.id);
    const staff = await db.staff.create({ data: { campusId: campusB, name: 'B员工', staffNo: `B-${suffix}`,
      onTimeRate: 100, income: 0, role: 'fulltime-rider', roleText: '配送员', building: 'B校', status: 'active' } });
    created.staff.push(staff.id);
    const t = token(acc, campusA, await svOf(acc.id));
    const http = () => request(app.getHttpServer());
    await http().patch(`/api/v1/admin/staff/${staff.id}`).set('Authorization', `Bearer ${t}`).send({ name: '越权改名' }).expect(404);
    await http().patch(`/api/v1/admin/staff/${staff.id}`).set('Authorization', `Bearer ${t}`).send({ campusId: campusA }).expect(404);
    await http().delete(`/api/v1/admin/staff/${staff.id}`).set('Authorization', `Bearer ${t}`).expect(404);
    expect(await db.staff.findUniqueOrThrow({ where: { id: staff.id } })).toMatchObject({ name: 'B员工', campusId: campusB, status: 'active' });
    await rbac.setAccountRoles(actor, acc.id, [{ roleCode: role.code, scope: 'platform' }]);
    await http().patch(`/api/v1/admin/staff/${staff.id}`)
      .set('Authorization', `Bearer ${token(acc, campusA, await svOf(acc.id))}`).send({ campusId: campusA }).expect(200);
    expect((await db.staff.findUniqueOrThrow({ where: { id: staff.id } })).campusId).toBe(campusA);
  });

  it('招募分权：仅备注角色可写备注不能动证件；idcard 拆分端点按按钮模式把关；运营全权可读证件且落审计', async () => {
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
    // 仅勾 recruit 菜单 + recruit.note 按钮
    const noteRole = await rbac.createRole(
      { username: 'spec' },
      { code: `tmp-note-${suffix}`, name: '招募专员', menuCodes: ['recruit', 'recruit.note'] },
    );
    created.roles.push(noteRole.id);
    const noter = await db.adminAccount.create({
      data: { username: `noter-${suffix}`, passwordHash: await hash('noter-pass-12', 4), role: 'rbac', campusId: campusA },
    });
    created.accounts.push(noter.id);
    await rbac.setAccountRoles({ id: 'spec', username: 'spec' }, noter.id, [
      { roleCode: noteRole.code, scope: 'campus', campusId: campusA },
    ]);
    const t = token(noter, campusA, await svOf(noter.id));
    // 列表可见但脱敏（无身份证/备注）
    const list = await request(app.getHttpServer())
      .get('/api/v1/admin/recruit-applications').set('Authorization', `Bearer ${t}`).expect(200);
    const rows = list.body.data.items ?? list.body.data;
    expect(rows.some((x: { idCardNo?: string }) => x.idCardNo)).toBe(false);
    // 备注可写，回显可见（note 模式持有者）
    const patched = await request(app.getHttpServer())
      .patch(`/api/v1/admin/recruit-applications/${app1.id}`)
      .set('Authorization', `Bearer ${t}`)
      .send({ staffRemark: '面试不错' })
      .expect(200);
    expect(patched.body.data.staffRemark).toBe('面试不错');
    const noteLogs = await db.auditLog.findMany({ where: { entityId: app1.id, action: 'recruit.update' } });
    expect(noteLogs.length).toBeGreaterThan(0);
    expect(JSON.stringify(noteLogs)).not.toContain('面试不错');

    // 夹带身份证 → 403（须 idcard.write 模式）；拆分端点直调 → 403
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/recruit-applications/${app1.id}`)
      .set('Authorization', `Bearer ${t}`)
      .send({ idCardNo: '110101199001011234' })
      .expect(403);
    await request(app.getHttpServer())
      .post(`/api/v1/admin/recruit-applications/${app1.id}/idcard`)
      .set('Authorization', `Bearer ${t}`)
      .send({ idCardNo: '110101199001011234' })
      .expect(403);
    // 有意变化：纯备注角色不再能经 GET :id/idcard 读备注（模式仅 idcard.read 持有）
    await request(app.getHttpServer())
      .get(`/api/v1/admin/recruit-applications/${app1.id}/idcard`)
      .set('Authorization', `Bearer ${t}`)
      .expect(403);
    // 审批/拒绝/面试全拒
    const http = request(app.getHttpServer());
    await http.post(`/api/v1/admin/recruit-applications/${app1.id}/approve`)
      .set('Authorization', `Bearer ${t}`).expect(403);
    await http.post(`/api/v1/admin/recruit-applications/${app1.id}/reject`)
      .set('Authorization', `Bearer ${t}`).send({ reason: 'x' }).expect(403);
    // 运营（模板全权）可读证件 + 敏感审计落库；idcard 拆分端点补录可写
    const opT = token(multiAcc, campusA, await svOf(multiAcc.id));
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/admin/recruit-applications/${app1.id}/idcard`)
      .set('Authorization', `Bearer ${opT}`).expect(200);
    expect(detail.body.data.idCardNo).toBe('110101199001011234');
    const audited = await db.auditLog.findFirst({
      where: { action: 'rbac.sensitive.idcard-read', entityId: app1.id },
    });
    expect(audited).toBeTruthy();
    const phone = await request(app.getHttpServer()).get(`/api/v1/admin/users/${user.id}/phone`)
      .set('Authorization', `Bearer ${opT}`).expect(200);
    expect(phone.body.data.phone).toBe('13900000000');
    const phoneAuditFailure = jest.spyOn(db.auditLog, 'create').mockRejectedValueOnce(new Error('audit unavailable'));
    try {
      const denied = await request(app.getHttpServer()).get(`/api/v1/admin/users/${user.id}/phone`)
        .set('Authorization', `Bearer ${opT}`).expect(503);
      expect(JSON.stringify(denied.body)).not.toContain('13900000000');
    } finally {
      phoneAuditFailure.mockRestore();
    }
    // Fault injection: authorization alone must not disclose sensitive fields when audit persistence fails.
    const auditFailure = jest.spyOn(db.auditLog, 'create').mockRejectedValueOnce(new Error('audit unavailable'));
    try {
      const denied = await request(app.getHttpServer())
        .get(`/api/v1/admin/recruit-applications/${app1.id}/idcard`)
        .set('Authorization', `Bearer ${opT}`).expect(503);
      expect(JSON.stringify(denied.body)).not.toContain('110101199001011234');
      expect(denied.body.data).toBeUndefined();
    } finally {
      auditFailure.mockRestore();
    }

    await request(app.getHttpServer())
      .post(`/api/v1/admin/recruit-applications/${app1.id}/idcard`)
      .set('Authorization', `Bearer ${opT}`)
      .send({ idCardNo: '110101199001011235' })
      .expect(201);
    // 响应脱敏：证件字段不回显
    const rewrite = await db.recruitingApplication.findUniqueOrThrow({ where: { id: app1.id } });
    expect(rewrite.idCardNo).toBe('110101199001011235');
    const documentLogs = await db.auditLog.findMany({ where: { entityId: app1.id, action: 'recruit.update' } });
    expect(JSON.stringify(documentLogs)).not.toContain('110101199001011235');
    // Historical snapshots can predate redaction; general audit readers must not recover private data.
    const historical = await db.auditLog.create({ data: { campusId: campusA, operator: 'spec',
      action: 'recruit.update', entityType: 'recruitingApplication', entityId: app1.id,
      after: { staffRemark: 'private-historical-note', idCardNo: '110101199001011235', idCardImages: ['private-document-url'] } } });
    try {
      const logs = await app.get(AdminService).auditLogs(campusA);
      const view = JSON.stringify(logs.find((log: { id: string }) => log.id === historical.id));
      expect(view).not.toContain('private-historical-note');
      expect(view).not.toContain('110101199001011235');
      expect(view).not.toContain('private-document-url');
    } finally { await db.auditLog.delete({ where: { id: historical.id } }); }

  });

  it('文件上传：停用/撤权/删除后台账号不能上传公开图片，无证件写权限不能上传私有图片', async () => {
    const actor = { id: 'spec', username: 'spec' };
    const acc = await rbac.createAccount(actor, { username: `upload_${suffix}`, password: 'upload-pass-123', grants: [
      { roleCode: 'campus-finance', scope: 'campus', campusId: campusA },
    ] });
    created.accounts.push(acc.id);
    const t = token(acc, campusA, await svOf(acc.id));
    const upload = (auth: string, folder: string) => request(app.getHttpServer())
      .post(`/api/v1/files/images?folder=${folder}`).set('Authorization', `Bearer ${auth}`)
      .attach('file', Buffer.from('synthetic-image'), { filename: 'fixture.png', contentType: 'image/png' });
    for (const folder of ['app/idcard', 'app/product', 'app/category', 'app', 'app/banner-detail', 'app/wheel', 'app/wechat-group', 'uploads']) {
      await upload(t, folder).expect(403);
    }
    await rbac.setAccountRoles(actor, acc.id, []);
    await upload(t, 'app/product').expect(401);
    const current = token(acc, campusA, await svOf(acc.id));
    await db.adminAccount.update({ where: { id: acc.id }, data: { status: 'disabled' } });
    await upload(current, 'uploads').expect(401);
    await db.adminAccount.delete({ where: { id: acc.id } });
    await upload(current, 'uploads').expect(403);
    // Non-admin tokens can never enter the private document folder.
    await upload(token({ id: 'absent-user' }, campusA, 0, 'user'), 'app/idcard').expect(403);
  });

  it('菜单管理：自建节点建改删；配置重启不覆盖，非法结构拒绝、内置节点不可删；role_menu 引用级联清', async () => {
    const t = token(superAcc, '', await svOf(superAcc.id));
    const http = () => request(app.getHttpServer());
    // 建：目录 + 子按钮
    const dir = await http().post('/api/v1/admin/rbac/menus')
      .set('Authorization', `Bearer ${t}`)
      .send({ name: '自建板块', type: 0, orderNum: 99 })
      .expect(201);
    expect(dir.body.data.code).toMatch(/^custom-/);
    created.menus.push(dir.body.data.id);
    const btn = await http().post('/api/v1/admin/rbac/menus')
      .set('Authorization', `Bearer ${t}`)
      .send({ name: '自建动作', type: 2, parentCode: dir.body.data.code, perms: ['GET /admin/orders'] })
      .expect(201);
    created.menus.push(btn.body.data.id);
    // 非法 perms 400
    await http().post('/api/v1/admin/rbac/menus')
      .set('Authorization', `Bearer ${t}`)
      .send({ name: '坏模式', type: 2, perms: ['not-a-pattern'] })
      .expect(400);
    // 改自建：结构+表现都可
    await http().patch(`/api/v1/admin/rbac/menus/${btn.body.data.id}`)
      .set('Authorization', `Bearer ${t}`)
      .send({ name: '自建动作改', perms: ['POST /admin/coupons'] })
      .expect(200);
    // builtin：表现字段可改（改完还原），结构字段 403、删除 403
    const menus = await http().get('/api/v1/admin/rbac/menus')
      .set('Authorization', `Bearer ${t}`).expect(200);
    const builtin = menus.body.data.find((m: { code: string }) => m.code === 'g.ops');
    await http().patch(`/api/v1/admin/rbac/menus/${builtin.id}`)
      .set('Authorization', `Bearer ${t}`)
      .send({ name: '运营中心改' }).expect(200);
    await http().patch(`/api/v1/admin/rbac/menus/${builtin.id}`)
      .set('Authorization', `Bearer ${t}`)
      .send({ name: '运营中心' }).expect(200);
    await http().patch(`/api/v1/admin/rbac/menus/${builtin.id}`)
      .set('Authorization', `Bearer ${t}`)
      .send({ perms: ['GET /admin/hack'] }).expect(400);
    await http().patch(`/api/v1/admin/rbac/menus/${builtin.id}`)
      .set('Authorization', `Bearer ${t}`)
      .send({ type: 2 }).expect(400);
    await http().delete(`/api/v1/admin/rbac/menus/${builtin.id}`)
      .set('Authorization', `Bearer ${t}`).expect(403);
    // role_menu 引用：角色勾自建按钮 → 删菜单级联清引用
    const role = await rbac.createRole(
      { username: 'spec' },
      { code: `tmp-menuref-${suffix}`, name: '菜单引用', menuCodes: [dir.body.data.code, btn.body.data.code] },
    );
    created.roles.push(role.id);
    const rolesAfter = await http().get('/api/v1/admin/rbac/roles')
      .set('Authorization', `Bearer ${t}`).expect(200);
    const refRole = rolesAfter.body.data.find((r: { code: string }) => r.code === role.code);
    expect(refRole.menuCodes.sort()).toEqual([dir.body.data.code, btn.body.data.code].sort());
    // 删目录级联删子按钮（递归非 builtin）
    const del = await http().delete(`/api/v1/admin/rbac/menus/${dir.body.data.id}`)
      .set('Authorization', `Bearer ${t}`).expect(200);
    expect(del.body.data.deleted).toBe(2);
    const rolesAfterDel = await http().get('/api/v1/admin/rbac/roles')
      .set('Authorization', `Bearer ${t}`).expect(200);
    const refRole2 = rolesAfterDel.body.data.find((r: { code: string }) => r.code === role.code);
    expect(refRole2.menuCodes).toEqual([]);
    // 菜单变更审计落库
    const audited = await db.auditLog.findFirst({
      where: { action: 'rbac.menu.delete', entityId: dir.body.data.id },
    });
    expect(audited).toBeTruthy();

  });

  it('超管保护：唯一超管不可自摘授权/自停/自删', async () => {
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
      const t = token(superAcc, '', await svOf(superAcc.id));
      const http = request(app.getHttpServer());
      await http.patch(`/api/v1/admin/accounts/${superAcc.id}`)
        .set('Authorization', `Bearer ${t}`)
        .send({ grants: [] })
        .expect(403);
      await http.patch(`/api/v1/admin/accounts/${superAcc.id}`)
        .set('Authorization', `Bearer ${t}`)
        .send({ status: 'disabled' })
        .expect(403);
      await http.delete(`/api/v1/admin/accounts/${superAcc.id}`)
        .set('Authorization', `Bearer ${t}`)
        .expect(400); // 不能删除当前登录账号
    } finally {
      for (const id of paused)
        await db.adminAccount.update({ where: { id }, data: { status: 'active' } });
    }
  });

  it('账号创建/资料/密码/状态/授权失败全部回滚，角色删除清理关联', async () => {
    const auth = `Bearer ${token(superAcc, '', await svOf(superAcc.id))}`;
    const username = `atomic_${suffix}`;
    await request(app.getHttpServer()).post('/api/v1/admin/accounts')
      .set('Authorization', auth).send({ username, password: 'atomic-pass-123',
        grants: [{ roleCode: 'missing-role', scope: 'platform' }],
      }).expect(400);
    expect(await db.adminAccount.findUnique({ where: { username } })).toBeNull();
    const result = await request(app.getHttpServer()).post('/api/v1/admin/accounts')
      .set('Authorization', auth).send({ username, password: 'atomic-pass-123', nickname: '原昵称',
        grants: [{ roleCode: 'campus-operations', scope: 'campus', campusId: campusA }],
      }).expect(201);
    const id = result.body.data.id;
    created.accounts.push(id);
    const before = await db.adminAccount.findUniqueOrThrow({ where: { id } });
    const auditCount = await db.auditLog.count({ where: { entityId: id } });
    await request(app.getHttpServer()).patch(`/api/v1/admin/accounts/${id}`)
      .set('Authorization', auth).send({ nickname: '不应保存', password: 'new-pass-123', status: 'disabled',
        grants: [{ roleCode: 'missing-role', scope: 'platform' }],
      }).expect(400);
    expect(await db.adminAccount.findUniqueOrThrow({ where: { id } })).toEqual(before);
    expect(await db.auditLog.count({ where: { entityId: id } })).toBe(auditCount);
    const role = await rbac.createRole({ username: 'spec' }, {
      code: `delete-${suffix}`, name: '可删除角色', menuCodes: ['products'],
    });
    created.roles.push(role.id);
    await request(app.getHttpServer()).delete(`/api/v1/admin/rbac/roles/${role.id}`)
      .set('Authorization', auth).expect(200);
    expect(await db.adminRoleMenu.count({ where: { roleId: role.id } })).toBe(0);
    expect(await db.adminRole.findUnique({ where: { id: role.id } })).toBeNull();
  });

  it('并发删除与撤权共用锁，不能移除最后一个有效超管', async () => {
    const actor = { id: 'test-concurrency', username: 'spec' };
    const peers = await Promise.all([0, 1].map(i => rbac.createAccount(actor, {
      username: `race${i}_${suffix}`, password: 'race-pass-123',
      grants: [{ roleCode: 'super-admin', scope: 'platform' }],
    })));
    created.accounts.push(...peers.map(p => p.id));
    const others = await db.adminAccount.findMany({ where: {
      status: 'active', id: { notIn: peers.map(p => p.id) },
      rbacRoles: { some: { scope: 'platform', role: { code: 'super-admin' } } },
    }, select: { id: true } });
    await db.adminAccount.updateMany({ where: { id: { in: others.map(a => a.id) } }, data: { status: 'disabled' } });
    try {
      const results = await Promise.allSettled([
        rbac.deleteAccount(actor, peers[0].id),
        rbac.setAccountRoles(actor, peers[1].id, []),
      ]);
      expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
      expect(await db.adminAccountRole.count({ where: {
        scope: 'platform', role: { code: 'super-admin', status: 'active' }, account: { status: 'active' },
      } })).toBe(1);
    } finally {
      await db.adminAccount.updateMany({ where: { id: { in: others.map(a => a.id) } }, data: { status: 'active' } });
      await db.adminAccount.deleteMany({ where: { id: { in: peers.map(p => p.id) } } });
    }
  });

  it('可配置单会话：默认并存，开启后新登录使旧令牌失效且不可自助改密', async () => {
    const previous = process.env.ADMIN_SINGLE_SESSION;
    const username = `single_${suffix}`, password = 'single-pass-123';
    const account = await rbac.createAccount({ id: 'spec', username: 'spec' }, { username, password });
    created.accounts.push(account.id);
    // Exercise login state changes directly to avoid sharing this suite's IP rate limit.
    // Token validity and change-password still run through real HTTP guards.
    const login = async () => ({ body: await app.get(AuthController).adminLogin({ username, password }) });
    try {
      delete process.env.ADMIN_SINGLE_SESSION;
      const first = await login();
      await login();
      await authed(first.body.data.token).expect(200);
      process.env.ADMIN_SINGLE_SESSION = 'true';
      const second = await login();
      await authed(first.body.data.token).expect(401);
      await authed(second.body.data.token).expect(200);
      const third = await login();
      await authed(second.body.data.token).expect(401);
      await authed(third.body.data.token).expect(200);
      await request(app.getHttpServer()).post('/api/v1/auth/change-password')
        .set('Authorization', `Bearer ${second.body.data.token}`)
        .send({ oldPassword: password, newPassword: 'must-not-change-123' }).expect(401);
    } finally {
      if (previous === undefined) delete process.env.ADMIN_SINGLE_SESSION;
      else process.env.ADMIN_SINGLE_SESSION = previous;
    }
  });

  it('授权审计：授权重设与菜单变更都有 rbac.* 审计行', async () => {
    const rows = await db.auditLog.findMany({
      where: { action: 'rbac.grant.set', entityId: multiAcc.id },
    });
    expect(rows.length).toBeGreaterThan(0);
  });

  it('未知菜单节点：建角色 400；平台域按钮校区级角色不可达（finance 角色无采购）', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/admin/rbac/roles')
      .set('Authorization', `Bearer ${token(superAcc, '', await svOf(superAcc.id))}`)
      .send({ code: `bad-${suffix}`, name: '坏角色', menuCodes: ['not.a.code'] })
      .expect(400);
    await db.adminAccount.update({ where: { id: multiAcc.id }, data: { campusId: campusB } });
    const tB = token(multiAcc, campusB, await svOf(multiAcc.id));
    await request(app.getHttpServer())
      .get('/api/v1/admin/purchase/orders').set('Authorization', `Bearer ${tB}`).expect(403);
    await db.adminAccount.update({ where: { id: multiAcc.id }, data: { campusId: campusA } });
  });

  it('非后台 token（C 端 user）访问 admin 一律 403', async () => {
    const userToken = jwt.sign({ id: 'no-such-admin', campusId: campusA, role: 'user' } satisfies AuthUser);
    await authed(userToken).expect(403);
  });

  it('全端点矩阵扫描（超管 token）：AdminController 每条路由非 403（403=模式漏配暴露）', async () => {
    await db.adminAccount.update({ where: { id: superAcc.id }, data: { campusId: campusA } });
    const t = token(superAcc, campusA, await svOf(superAcc.id));
    const routes = listAdminRoutes();
    expect(routes.length).toBeGreaterThan(120);
    const dispatch = (method: string, url: string): request.Request => {
      const agent = request(app.getHttpServer()) as unknown as Record<
        string,
        (u: string) => request.Request
      >;
      return agent[method.toLowerCase()](url);
    };
    const forbidden: string[] = [];
    for (const route of routes) {
      const { method, path } = concreteRoute(route);
      const url = `/api/v1${path}`;
      const r = await dispatch(method, url)
        .set('Authorization', `Bearer ${t}`)
        .send(method === 'GET' || method === 'DELETE' ? undefined : {});
      if (r.status === 403) forbidden.push(`${method} ${path} → 403`);
    }
    expect(forbidden).toEqual([]);
  });
  it('普通角色即使勾选管理接口也不能修改角色、菜单或账号授权', async () => {
    const role = await rbac.createRole({ username: 'spec' }, {
      code: `delegated-${suffix}`, name: '不能委派超管能力',
      menuCodes: ['rbac-roles', 'rbac.roles.write', 'rbac.menus.write', 'rbac.accounts.write'],
    });
    created.roles.push(role.id);
    const acc = await db.adminAccount.create({ data: {
      username: `delegated-${suffix}`, passwordHash: 'unused', role: 'rbac', campusId: campusA,
    } });
    created.accounts.push(acc.id);
    await rbac.setAccountRoles({ id: 'spec', username: 'spec' }, acc.id, [
      { roleCode: role.code, scope: 'platform' },
    ]);
    const auth = `Bearer ${token(acc, campusA, await svOf(acc.id))}`;
    await request(app.getHttpServer()).post('/api/v1/admin/rbac/roles').set('Authorization', auth)
      .send({ code: 'escalation', name: '越权', menuCodes: [] }).expect(403);
    await request(app.getHttpServer()).get('/api/v1/admin/rbac/menus').set('Authorization', auth).expect(403);
    await request(app.getHttpServer()).patch(`/api/v1/admin/accounts/${acc.id}`).set('Authorization', auth)
      .send({ grants: [{ roleCode: 'super-admin', scope: 'platform' }] }).expect(403);
  });

  it('平台只读角色不能把校区角色的平台操作扩权，超级管理员不能绑定校区范围', async () => {
    const role = await rbac.createRole({ username: 'spec' }, {
      code: `scope-${suffix}`, name: '错配平台功能的校区角色', menuCodes: ['campuses.manage'],
    });
    const reader = await rbac.createRole({ username: 'spec' }, {
      code: `reader-${suffix}`, name: '平台只读', menuCodes: ['dashboard'],
    });
    created.roles.push(role.id, reader.id);
    const acc = await db.adminAccount.create({ data: {
      username: `scope-${suffix}`, passwordHash: 'unused', role: 'rbac', campusId: campusA,
    } });
    created.accounts.push(acc.id);
    await rbac.setAccountRoles({ id: 'spec', username: 'spec' }, acc.id, [
      { roleCode: role.code, scope: 'campus', campusId: campusA },
      { roleCode: reader.code, scope: 'platform' },
    ]);
    await request(app.getHttpServer()).post('/api/v1/admin/campuses')
      .set('Authorization', `Bearer ${token(acc, campusA, await svOf(acc.id))}`)
      .send({ name: '不得创建' }).expect(403);
    await expect(rbac.setAccountRoles({ id: 'spec', username: 'spec' }, acc.id, [
      { roleCode: 'super-admin', scope: 'campus', campusId: campusA },
    ])).rejects.toThrow('超级管理员只能授予平台范围');
  });

  it('撤销旧角色账号全部授权以及清空旧角色菜单后，重复启动同步不恢复权限', async () => {
    const acc = await db.adminAccount.create({ data: {
      username: `legacy-${suffix}`, passwordHash: 'unused', role: 'operations', campusId: campusA,
    } });
    created.accounts.push(acc.id);
    const role = await db.adminRole.create({ data: {
      code: `legacy-${suffix}`, name: '旧版角色', menus: ['products', 'products.write'],
    } });
    created.roles.push(role.id);
    await rbac.syncRegistry();
    expect(await db.adminAccountRole.count({ where: { accountId: acc.id } })).toBeGreaterThan(0);
    expect(await db.adminRoleMenu.count({ where: { roleId: role.id } })).toBeGreaterThan(0);
    await rbac.setAccountRoles({ id: 'spec', username: 'spec' }, acc.id, []);
    await rbac.updateRole({ username: 'spec' }, role.id, { menuCodes: [] });
    await rbac.syncRegistry();
    await rbac.syncRegistry();
    expect(await db.adminAccountRole.count({ where: { accountId: acc.id } })).toBe(0);
    expect(await db.adminRoleMenu.count({ where: { roleId: role.id } })).toBe(0);
  });

  it('旧会话不能通过切换校区重新换发有效 token', async () => {
    const acc = await db.adminAccount.create({ data: {
      username: `session-${suffix}`, passwordHash: 'unused', role: 'rbac', campusId: campusA,
    } });
    created.accounts.push(acc.id);
    const stale = token(acc, campusA);
    await rbac.setAccountRoles({ id: 'spec', username: 'spec' }, acc.id, [
      { roleCode: 'campus-operations', scope: 'campus', campusId: campusA },
    ]);
    await request(app.getHttpServer()).get('/api/v1/auth/admin/campuses')
      .set('Authorization', `Bearer ${stale}`).expect(401);
    await request(app.getHttpServer()).post('/api/v1/auth/admin/campuses/select')
      .set('Authorization', `Bearer ${stale}`).send({ campusId: campusA }).expect(401);
  });

  it('校区切换后旧 token 的数据校区与当前权限校区保持一致', async () => {
    const acc = await db.adminAccount.create({ data: {
      username: `context-${suffix}`, passwordHash: 'unused', role: 'rbac', campusId: campusA,
    } });
    created.accounts.push(acc.id);
    await rbac.setAccountRoles({ id: 'spec', username: 'spec' }, acc.id, [
      { roleCode: 'campus-operations', scope: 'campus', campusId: campusA },
      { roleCode: 'campus-operations', scope: 'campus', campusId: campusB },
    ]);
    const oldToken = token(acc, campusA, await svOf(acc.id));
    await request(app.getHttpServer()).post('/api/v1/auth/admin/campuses/select')
      .set('Authorization', `Bearer ${oldToken}`).send({ campusId: campusB }).expect(200);
    const res = await request(app.getHttpServer()).get('/api/v1/admin/buildings')
      .set('Authorization', `Bearer ${oldToken}`).expect(200);
    const rows = res.body.data.items ?? res.body.data;
    expect(rows.map((x: { name: string }) => x.name)).toContain('B1 栋');
    expect(rows.map((x: { name: string }) => x.name)).not.toContain('A1 栋');
  });

  it('动态菜单：隐藏不撤权、祖先仅补展示、视图与修改重启持久化、循环和未知接口拒绝', async () => {
    const dir = await rbac.createMenu({ username: 'spec' }, {
      name: '导航父级', type: 0, perms: ['POST /admin/coupons'],
    });
    created.menus.push(dir.id);
    const menu = await rbac.createMenu({ username: 'spec' }, {
      name: '商品独立入口', type: 1, parentId: dir.id, path: `/catalog-${suffix}`,
      viewPath: 'products', keepAlive: true, isShow: false, perms: ['GET /admin/products'],
    });
    created.menus.push(menu.id);
    const role = await rbac.createRole({ username: 'spec' }, {
      code: `view-${suffix}`, name: '单页面', menuCodes: [menu.code],
    });
    created.roles.push(role.id);
    const acc = await db.adminAccount.create({ data: {
      username: `view-${suffix}`, passwordHash: 'unused', role: 'rbac', campusId: campusA,
    } });
    created.accounts.push(acc.id);
    await rbac.setAccountRoles({ id: 'spec', username: 'spec' }, acc.id, [
      { roleCode: role.code, scope: 'campus', campusId: campusA },
    ]);
    const me = await rbac.buildMeResponse(acc);
    expect(me.menus.find(m => m.code === dir.code)).toMatchObject({ authorized: false });
    expect(me.menus.find(m => m.code === menu.code)).toMatchObject({
      authorized: true, isShow: false, viewPath: 'products', keepAlive: true,
    });
    expect(me.perms).toEqual(['GET /admin/products']);
    await expect(rbac.updateMenu({ username: 'spec' }, dir.id, { parentId: menu.id }))
      .rejects.toThrow('子孙');
    await expect(rbac.updateMenu({ username: 'spec' }, menu.id, { viewPath: '../../secret' }))
      .rejects.toThrow('已登记');
    const builtin = await db.adminMenu.findUniqueOrThrow({ where: { code: 'products' } });
    await rbac.updateMenu({ username: 'spec' }, builtin.id, { path: `/products-${suffix}`, keepAlive: true });
    try {
      await rbac.syncRegistry();
      expect(await db.adminMenu.findUnique({ where: { id: builtin.id } }))
        .toMatchObject({ path: `/products-${suffix}`, keepAlive: true });
    } finally {
      await rbac.updateMenu({ username: 'spec' }, builtin.id, { path: builtin.path, keepAlive: builtin.keepAlive });
    }
  });

});
