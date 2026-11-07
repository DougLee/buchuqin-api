import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { randomUUID } from 'node:crypto';

/** Real Nest routes, JWT guards, DTO validation and isolated PostgreSQL.
 * External WeChat credentials/payment are deliberately not exercised here. */
describe('用户日夜 HTTP 契约（独立测试 schema）', () => {
  let app: INestApplication;
  let db: PrismaService;
  let token: string, staffToken: string;
  let campusId: string, userId: string, otherId: string;
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL || '');
    if (!url.pathname.endsWith('_spec') || !url.searchParams.get('schema')?.startsWith('night_stock_parity_')) throw Error('E2E 仅允许独立 parity schema');
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    db = app.get(PrismaService);
    const campus = await db.campus.create({ data: { name: 'HTTP日夜验收-' + randomUUID(), shortName: 'HTTP验收', warehouseName: '独立测试仓', manualClosed: true, nightEnabled: true, nightStartAt: '00:00', nightEndAt: '23:59' } });
    campusId = campus.id;
    const user = await db.user.create({ data: { campusId, nickname: 'HTTP本人', phone: randomUUID() } });
    const other = await db.user.create({ data: { campusId, nickname: 'HTTP他人', phone: randomUUID() } });
    userId = user.id; otherId = other.id;
    const jwt = app.get(JwtService);
    token = jwt.sign({ id: userId, campusId, role: 'user', appKind: 'user' });
    staffToken = jwt.sign({ id: 'staff-fixture', campusId, role: 'building-manager', appKind: 'delivery' });
    await db.notification.createMany({ data: [
      { userId, businessType: 'day', type: 'order', title: '白天本人', content: '测试' },
      { userId, businessType: 'night', type: 'order', title: '夜宵本人', content: '测试' },
      { userId: otherId, businessType: 'night', type: 'order', title: '夜宵他人', content: '测试' },
    ] });
  }, 90000);
  afterAll(async () => {
    if (db && userId && otherId) {
      await db.notification.deleteMany({ where: { userId: { in: [userId, otherId] } } });
      await db.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
      await db.campus.delete({ where: { id: campusId } });
    }
    await app?.close();
  }, 30000);
  const http = () => request(app.getHttpServer());
  it('旧测试登录入口保持下线', async () => { await http().post('/api/v1/auth/test-login').send({ identity: 'user' }).expect(404); });
  it('夜宵接口拒绝未登录和配送角色，真实用户可读取所在校区配置', async () => {
    await http().get('/api/v1/night/entry').expect(401);
    await http().get('/api/v1/night/entry').auth(staffToken, { type: 'bearer' }).expect(403);
    const response = await http().get('/api/v1/night/entry').auth(token, { type: 'bearer' }).expect(200);
    expect(response.body.data).toMatchObject({ campusId, nightEnabled: true, dayClosed: true });
  });
  it('夜宵消息列表/全部已读不串白天和他人数据，非法渠道报错', async () => {
    const night = await http().get('/api/v1/notifications?businessType=night').auth(token, { type: 'bearer' }).expect(200);
    expect(night.body.data.items.map((item: { title: string }) => item.title)).toEqual(['夜宵本人']);
    await http().post('/api/v1/notifications/read-all').auth(token, { type: 'bearer' }).send({ businessType: 'night' }).expect(201);
    const day = await http().get('/api/v1/notifications?businessType=day').auth(token, { type: 'bearer' }).expect(200);
    expect(day.body.data.items).toEqual([expect.objectContaining({ title: '白天本人', read: false })]);
    expect(await db.notification.count({ where: { userId: otherId, read: false } })).toBe(1);
    await http().get('/api/v1/notifications?businessType=invalid').auth(token, { type: 'bearer' }).expect(400);
  });
  it('售后分页正常，撤销不属于本人的订单报不存在，非法申请在 DTO 层拒绝', async () => {
    const list = await http().get('/api/v1/night/after-sales?pageSize=1000').auth(token, { type: 'bearer' }).expect(200);
    expect(list.body.data).toMatchObject({ items: [], total: 0, refundedAmount: 0, pageSize: 100 });
    await http().post('/api/v1/night/orders/foreign/after-sale/withdraw').auth(token, { type: 'bearer' }).send({}).expect(404);
    await http().post('/api/v1/night/orders/foreign/after-sale').auth(token, { type: 'bearer' }).send({ type: 'invented', description: '有效的测试说明', productIds: [1] }).expect(400);
  });
  it('用户校区变更后旧JWT失效，履约端或旧组织身份不能冒用用户端令牌', async () => {
    const campus = await db.campus.create({ data: { name: 'HTTP上下文变更-' + randomUUID(), shortName: '边界验收', warehouseName: '独立测试仓' } });
    try {
      await db.user.update({ where: { id: userId }, data: { campusId: campus.id } });
      await http().get('/api/v1/night/entry').auth(token, { type: 'bearer' }).expect(401);
      await http().get('/api/v1/cart').auth(token, { type: 'bearer' }).expect(401);
    } finally {
      await db.user.update({ where: { id: userId }, data: { campusId } });
      await db.campus.delete({ where: { id: campus.id } });
    }
    const jwt = app.get(JwtService);
    const wrongApp = jwt.sign({ id: userId, campusId, role: 'user', appKind: 'delivery' });
    await http().get('/api/v1/night/entry').auth(wrongApp, { type: 'bearer' }).expect(403);
    const oldOrganization = jwt.sign({ id: userId, campusId, role: 'user', appKind: 'user', organizationId: 'old-organization' });
    await http().get('/api/v1/night/entry').auth(oldOrganization, { type: 'bearer' }).expect(401);
  });
});
