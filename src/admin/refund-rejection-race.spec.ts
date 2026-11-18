import { AdminService } from './admin.service';
import { BusinessService } from '../business/business.service';
import { PrismaService } from '../database/prisma.service';

describe('退款拒绝与并发审核', () => {
  it('其他操作已抢占申请后，拒绝不能覆盖状态或恢复订单', async () => {
    const refund = { id: 'refund', status: 'pending', orderId: 'order', userId: 'buyer', beforeStatus: 'paid', order: { id: 'order', campusId: 'campus', status: 'after-sales', payableAmount: 1000, deliveryFee: 200 } };
    const db: any = {
      refund: { findUnique: jest.fn().mockResolvedValue(refund), updateMany: jest.fn().mockResolvedValue({ count: 0 }), update: jest.fn().mockResolvedValue({ ...refund, status: 'rejected' }) },
      campus: { findUnique: jest.fn().mockResolvedValue({ refundDeliveryFeeBeforeArrive: false }) },
      order: { updateMany: jest.fn() }, auditLog: { create: jest.fn() },
    };
    db.$transaction = (action: any) => action(db);
    const service = new AdminService(db as PrismaService, new BusinessService(db as PrismaService));
    await expect(service.auditRefund('refund', 'reject', 'admin', null)).rejects.toThrow('状态已变化');
    expect(db.order.updateMany).not.toHaveBeenCalled();
  });
});
