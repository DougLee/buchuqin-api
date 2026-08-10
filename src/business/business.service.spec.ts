import { BusinessService } from './business.service';
import { MockStore } from '../mock/mock.store';
describe('BusinessService', () => {
  let service: BusinessService;
  beforeEach(() => {
    service = new BusinessService(new MockStore());
  });
  it('calculates instant delivery checkout', () => {
    const result = service.checkout('user-001', {
      addressId: 'address-001',
      deliveryMode: 'instant',
      couponId: 'coupon-001',
    });
    expect(result.productAmount).toBe(20.5);
    expect(result.deliveryFee).toBe(4);
    expect(result.payableAmount).toBe(19.5);
  });
  it('creates, pays and snapshots an order', () => {
    const order = service.createOrder('user-001', {
      addressId: 'address-001',
      deliveryMode: 'scheduled',
      deliverySlot: '20:00-21:00',
    });
    expect(order.status).toBe('pending-payment');
    service.pay('user-001', order.id);
    expect(order.status).toBe('paid');
    expect(service.cart('user-001').items).toHaveLength(0);
    expect(order.package?.status).toBe('waiting-pick');
  });
  it('does not allow an unpaid order to enter fulfillment', () => {
    const order = service.createOrder('user-001', {
      addressId: 'address-001',
      deliveryMode: 'instant',
    });
    expect(() => service.advance('user-001', order.id)).toThrow(
      '当前状态不可推进履约',
    );
  });
  it('rejects payment after the 15-minute deadline', () => {
    const order = service.createOrder('user-001', {
      addressId: 'address-001',
      deliveryMode: 'instant',
    });
    order.createdAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    expect(() => service.pay('user-001', order.id)).toThrow('订单支付已超时');
    expect(order.status).toBe('cancelled');
  });
  it('cancels an unpaid order without creating a refund', () => {
    const refundCount = service.refunds('user-001').length;
    const order = service.createOrder('user-001', {
      addressId: 'address-001',
      deliveryMode: 'instant',
    });
    service.cancel('user-001', order.id);
    expect(order.statusText).toBe('订单已取消');
    expect(service.refunds('user-001')).toHaveLength(refundCount);
  });
  it('completes delivery and creates an after-sales refund', () => {
    const refundCount = service.refunds('user-001').length;
    const order = service.createOrder('user-001', {
      addressId: 'address-001',
      deliveryMode: 'instant',
      couponId: 'coupon-001',
    });
    service.pay('user-001', order.id);
    service.advance('user-001', order.id);
    service.advance('user-001', order.id);
    service.advance('user-001', order.id);
    expect(order.status).toBe('completed');
    const record = service.createAfterSales('user-001', order.id, {
      type: 'quality',
      description: '商品包装破损且无法食用',
      images: ['mock://proof.jpg'],
    });
    expect(record.status).toBe('approved');
    expect(order.status).toBe('refunded');
    expect(service.refunds('user-001')).toHaveLength(refundCount + 1);
  });
});
