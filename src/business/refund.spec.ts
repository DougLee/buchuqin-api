import { PrismaService } from '../database/prisma.service';
import { BusinessService } from './business.service';
import { AdminService } from '../admin/admin.service';
import type { ApplyPreDeliveryRefundDto } from './dto';
import type { Prisma } from '@prisma/client';

/**
 * 退款功能 v1 集成测试（IKHZKA）：
 * 悔单（pre-delivery）申请/金额口径/重复拦截、售后（after-sale）迁移 Refund、
 * 后台拒绝回滚与重新申请、approve 未就绪兜底。微信真实退款链路在测试环境
 * 小额真退人工验证，不在本套件内。
 */
describe('refund v1 (IKHZKA)', () => {
  const db = new PrismaService();
  const business = new BusinessService(db);
  // payments 不注入：approve 应报「支付服务未就绪」而非卡死申请
  const admin = new AdminService(db, business);
  const CAMPUS = 'campus-hbut';
  const json = (value: unknown) =>
    JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
  let userId = '';
  let addressSnapshot: Prisma.InputJsonValue;
  const createdOrderIds: string[] = [];

  const makeOrder = async (status: string) => {
    const product = await db.product.findUniqueOrThrow({
      where: { id: 'p001' },
    });
    const order = await db.order.create({
      data: {
        orderNo: `BCQR${Date.now()}${Math.random()
          .toString(36)
          .slice(2, 6)
          .toUpperCase()}`,
        userId,
        campusId: CAMPUS,
        status,
        statusText: '测试退款单',
        address: addressSnapshot,
        deliveryMode: 'instant',
        items: json([
          { product: { id: product.id, name: product.name }, quantity: 1 },
        ]),
        productAmount: 1000,
        totalQuantity: 1,
        deliveryThreshold: 0,
        deliveryFee: 150,
        discount: 0,
        // 实付 = 1000 + 150 = 1150；退款金额应为 1150 - 150 = 1000（配送费不退）
        payableAmount: 1150,
        estimatedArrival: '预计 30-60 分钟送达',
        timeline: json([]),
      },
    });
    createdOrderIds.push(order.id);
    return order;
  };

  beforeAll(async () => {
    const suffix = Date.now().toString(36);
    const user = await db.user.create({
      data: {
        openid: `test-refund-${suffix}`,
        nickname: `退款测试${suffix}`,
        phone: `139${Date.now()}`.slice(0, 11),
        role: 'user',
        campusId: CAMPUS,
      },
    });
    userId = user.id;
    addressSnapshot = json({
      buildingId: 'b001',
      buildingName: '测试楼栋',
      room: '101',
      campusId: CAMPUS,
    });
  });

  afterAll(async () => {
    // 先删退款申请（orderId 唯一外键），再删订单与用户
    await db.refund.deleteMany({ where: { orderId: { in: createdOrderIds } } });
    await db.afterSale.deleteMany({ where: { orderId: { in: createdOrderIds } } });
    await db.order.deleteMany({ where: { id: { in: createdOrderIds } } });
    await db.notification.deleteMany({ where: { userId } });
    await db.user.delete({ where: { id: userId } }).catch(() => undefined);
    await db.$disconnect();
  });

  test('悔单申请：paid 单建立 pending 申请并转售后态，金额=实付−配送费', async () => {
    const order = await makeOrder('paid');
    const refund = await business.applyPreDeliveryRefund(userId, order.id, {
      reason: '下错单了',
    });
    expect(refund.status).toBe('pending');
    expect(refund.source).toBe('pre-delivery');
    expect(refund.amount).toBe(1000); // 1150 - 150（配送费不退）
    expect(refund.reason).toBe('下错单了');
    const after = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe('after-sales');
    expect(after.statusText).toBe('退款审核中');
  });

  test('悔单申请：重复申请被拦截', async () => {
    const order = await makeOrder('paid');
    await business.applyPreDeliveryRefund(userId, order.id, { reason: '测试' });
    await expect(
      business.applyPreDeliveryRefund(userId, order.id, { reason: '再试' }),
    ).rejects.toThrow('已有退款申请在审核中');
  });

  test('悔单申请：出库后（waiting-first-mile）不可申请', async () => {
    const order = await makeOrder('waiting-first-mile');
    await expect(
      business.applyPreDeliveryRefund(userId, order.id, { reason: '测试退款' }),
    ).rejects.toThrow('订单已出库');
  });

  test('原因必填（道哥 2026-09-23）：空/纯空白被拒', async () => {
    const order = await makeOrder('paid');
    await expect(
      business.applyPreDeliveryRefund(
        userId,
        order.id,
        {} as ApplyPreDeliveryRefundDto,
      ),
    ).rejects.toThrow('请填写退款原因');
    await expect(
      business.applyPreDeliveryRefund(userId, order.id, { reason: '   ' }),
    ).rejects.toThrow('请填写退款原因');
    // 该单仍可带原因正常申请（校验不占坑）
    const refund = await business.applyPreDeliveryRefund(userId, order.id, {
      reason: '下错单',
    });
    expect(refund.status).toBe('pending');
  });

  test('金额口径：券抵扣后实付过低时钳 0 不出负数', async () => {
    const order = await makeOrder('paid');
    await db.order.update({
      where: { id: order.id },
      data: { discount: 1200, payableAmount: 0 }, // 券超抵：实付 0
    });
    const refund = await business.applyPreDeliveryRefund(userId, order.id, { reason: '测试退款' });
    expect(refund.amount).toBe(0);
  });

  test('后台拒绝：订单回滚 paid，可重新申请且 rejectCount 留痕', async () => {
    const order = await makeOrder('paid');
    const first = await business.applyPreDeliveryRefund(userId, order.id, {
      reason: '第一次',
    });
    await admin.auditRefund(first.id, 'reject', 'tester', CAMPUS, '理由不充分');
    const after = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe('paid');
    const again = await business.applyPreDeliveryRefund(userId, order.id, {
      reason: '第二次',
    });
    expect(again.id).toBe(first.id); // 复用同一条记录
    expect(again.status).toBe('pending');
    const row = await db.refund.findUniqueOrThrow({ where: { id: first.id } });
    expect(row.rejectCount).toBe(1);
  });

  test('后台拒绝：售后单回滚 delivered（beforeStatus 快照）', async () => {
    const order = await makeOrder('delivered');
    const proof = { time: new Date().toISOString() };
    await db.order.update({
      where: { id: order.id },
      data: { package: json({ proof }) },
    });
    const refund = await business.createAfterSales(userId, order.id, {
      type: 'damaged',
      description: '包装破损',
      images: ['https://example.com/a.jpg'],
    });
    expect(refund.source).toBe('after-sale');
    expect(refund.amount).toBe(1000);
    await admin.auditRefund(refund.id, 'reject', 'tester', CAMPUS, '证据不足');
    const after = await db.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe('delivered');
  });

  test('approve 无支付通道：报「未就绪」且申请仍为 pending（不卡死）', async () => {
    const order = await makeOrder('paid');
    const refund = await business.applyPreDeliveryRefund(userId, order.id, { reason: '测试退款' });
    await expect(
      admin.auditRefund(refund.id, 'approve', 'tester', CAMPUS),
    ).rejects.toThrow('支付服务未就绪');
    const row = await db.refund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(row.status).toBe('pending');
  });

  test('校区隔离：跨校区审核不可见（NotFound）', async () => {
    const order = await makeOrder('paid');
    const refund = await business.applyPreDeliveryRefund(userId, order.id, { reason: '测试退款' });
    await expect(
      admin.auditRefund(refund.id, 'reject', 'tester', 'campus-other', ''),
    ).rejects.toThrow('退款申请不存在');
  });
});
