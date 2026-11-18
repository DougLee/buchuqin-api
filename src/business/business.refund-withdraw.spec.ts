import { BusinessService } from './business.service';
import { PrismaService } from '../database/prisma.service';

describe('白天退款撤销与审核竞争', () => {
  it('审核已抢占申请后，用户撤销不得把审核中状态覆盖成已撤销', async () => {
    const db: any = { refund: {
      findFirst: jest.fn().mockResolvedValue({ id: 'refund', userId: 'buyer', orderId: 'order', status: 'pending', beforeStatus: 'paid' }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      update: jest.fn().mockResolvedValue({ id: 'refund', orderId: 'order', status: 'cancelled', beforeStatus: 'paid', createdAt: new Date(), updatedAt: new Date() }),
    }, order: { updateMany: jest.fn() } };
    db.$transaction = (action: any) => action(db);
    const service = new BusinessService(db as PrismaService);
    await expect(service.cancelAfterSale('buyer', 'refund')).rejects.toThrow('状态已变化');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });
});
