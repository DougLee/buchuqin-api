import { NightOrderService } from './night-order.service';
import { PrismaService } from '../database/prisma.service';
import { PaymentsService } from '../payments/payments.service';
import { NightInventoryService } from './night-inventory.service';

describe('夜宵售后撤销', () => {
  const fixture = (status = 'requested') => {
    const order = { id: 'order', userId: 'buyer', storeId: 'store', status: 'completed', afterSaleStatus: status, timeline: [] };
    const db: any = { nightOrder: {
      findFirst: jest.fn(async ({ where }) => where.userId === order.userId ? { ...order } : null),
      findUniqueOrThrow: jest.fn(async () => ({ ...order })),
      updateMany: jest.fn(async ({ where, data }) => {
        if (order.afterSaleStatus !== where.afterSaleStatus) return { count: 0 };
        Object.assign(order, data); return { count: 1 };
      }),
    }, nightCommissionTxn: { updateMany: jest.fn() } };
    db.$transaction = async (action: any) => action(db);
    const inventory = { lockStore: jest.fn() };
    const service = new NightOrderService(db as PrismaService, { registerNightPaymentHandler() {} } as unknown as PaymentsService, undefined, inventory as unknown as NightInventoryService);
    return { order, service };
  };
  it('仅申请本人尚待审核的售后可撤销，撤销后保留时间线', async () => {
    const { order, service } = fixture();
    await expect(service.withdrawAfterSale('foreign', 'order')).rejects.toThrow('订单不存在');
    expect(order.afterSaleStatus).toBe('requested');
    await expect(service.withdrawAfterSale('buyer', 'order')).resolves.toMatchObject({ afterSaleStatus: 'withdrawn' });
    expect(order.timeline).toEqual([expect.objectContaining({ key: 'after-sale-withdrawn', title: '用户撤销售后申请' })]);
  });
  it('网关核对中的退款不能通过撤销解冻', async () => {
    const { order, service } = fixture('refund-processing');
    await expect(service.withdrawAfterSale('buyer', 'order')).rejects.toThrow('不可撤销');
    expect(order.afterSaleStatus).toBe('refund-processing');
  });
});
