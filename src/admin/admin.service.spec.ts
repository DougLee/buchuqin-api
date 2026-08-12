import { BusinessService } from '../business/business.service';
import { FulfillmentService } from '../fulfillment/fulfillment.service';
import { MockStore } from '../mock/mock.store';
import { AdminService } from './admin.service';

describe('AdminService', () => {
  let service: AdminService;
  beforeEach(() => {
    const store = new MockStore();
    service = new AdminService(
      store,
      new BusinessService(store),
      new FulfillmentService(store),
    );
  });
  it('aggregates dashboard and operational modules', () => {
    expect(service.dashboard().campus.name).toBe('湖北工业大学');
    expect(service.products().length).toBeGreaterThan(10);
    expect(service.orders()).toHaveLength(6);
    expect(service.staff()).toHaveLength(3);
  });
  it('updates products and writes an audit trail', () => {
    const product = service.updateProduct(
      'p001',
      { price: 6.2, stock: 30 },
      'admin-001',
    );
    expect(product.price).toBe(6.2);
    expect(service.auditLogs()[0]).toMatchObject({
      action: 'product.update',
      entityId: 'p001',
    });
  });
});
