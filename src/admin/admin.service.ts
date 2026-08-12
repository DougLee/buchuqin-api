import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BusinessService } from '../business/business.service';
import { FulfillmentService } from '../fulfillment/fulfillment.service';
import { MockStore } from '../mock/mock.store';

@Injectable()
export class AdminService {
  private audits: Array<Record<string, unknown>> = [];
  constructor(
    private readonly store: MockStore,
    private readonly business: BusinessService,
    private readonly fulfillment: FulfillmentService,
  ) {}

  dashboard() {
    const orders = this.store.orders;
    const paid = orders.filter(
      (item) => !['pending-payment', 'cancelled'].includes(item.status),
    );
    return {
      campus: this.store.campus,
      updatedAt: new Date().toISOString(),
      kpis: {
        revenue: Number(
          paid.reduce((sum, item) => sum + item.payableAmount, 0).toFixed(2),
        ),
        orders: orders.length,
        paidUsers: 86,
        newUsers: 23,
        fulfillmentRate: 96.8,
        exceptions: orders.filter((item) => item.status === 'exception').length,
      },
      orderTrend: [1680, 2350, 1980, 3180, 2860, 3920, 4650],
      fulfillment: {
        waitingPick: 8,
        firstMile: 5,
        waitingHandover: 3,
        lastMile: 6,
        timeout: 2,
      },
      hotBuildings: [
        { name: '西区 5 栋', orders: 126, revenue: 2868, onTimeRate: 97 },
        { name: '西区 7 栋', orders: 98, revenue: 2160, onTimeRate: 94 },
        { name: '西区 6 栋', orders: 83, revenue: 1896, onTimeRate: 96 },
      ],
    };
  }
  products() {
    return this.store.products.map((product) => ({
      ...product,
      skuNo: `SKU-${product.id.toUpperCase()}`,
      actualStock: product.stock + Math.floor(product.stock * 0.18),
      lockedStock: Math.floor(product.stock * 0.18),
      availableStock: product.stock,
      status: product.stock ? 'on-sale' : 'sold-out',
    }));
  }
  updateProduct(
    id: string,
    body: { price?: number; stock?: number },
    operator: string,
  ) {
    const product = this.store.products.find((item) => item.id === id);
    if (!product) throw new NotFoundException('商品不存在');
    const before = structuredClone(product);
    if (body.price !== undefined) product.price = body.price;
    if (body.stock !== undefined) product.stock = body.stock;
    this.audit(operator, 'product.update', 'product', id, before, product);
    return product;
  }
  inventory() {
    return this.products().map((item, index) => ({
      ...item,
      warehouse: this.store.campus.warehouseName,
      batchNo: `B202608${String(index + 1).padStart(2, '0')}`,
      expiryDate: `2026-${index % 3 === 0 ? '09' : '12'}-${String(12 + index).padStart(2, '0')}`,
      warning: item.availableStock < 20,
    }));
  }
  orders(status?: string) {
    return this.store.orders
      .filter((item) => !status || status === 'all' || item.status === status)
      .map((item) => ({
        ...item,
        userPhone: '138****2026',
        packageNo: item.package?.id ?? '--',
      }));
  }
  order(id: string) {
    const item = this.store.orders.find((order) => order.id === id);
    if (!item) throw new NotFoundException('订单不存在');
    return item;
  }
  orderAction(id: string, action: string, operator: string) {
    const order = this.order(id);
    if (action === 'cancel') return this.business.cancel(order.userId, id);
    if (action === 'advance') return this.business.advance(order.userId, id);
    if (action !== 'mark-exception')
      throw new BadRequestException('不支持的订单操作');
    order.status = 'exception';
    order.statusText = '运营标记异常';
    this.audit(operator, `order.${action}`, 'order', id, null, order);
    return order;
  }
  staff() {
    return (
      ['building-manager', 'fulltime-rider', 'parttime-rider'] as const
    ).map((role) => ({
      ...this.fulfillment.profile(role),
      completedToday: role === 'building-manager' ? 18 : 12,
      onTimeRate: role === 'parttime-rider' ? 92 : 97,
      proofRate: role === 'building-manager' ? 99 : null,
      income: role === 'building-manager' ? 42.6 : 36.8,
    }));
  }
  afterSales() {
    return this.store.afterSales.map((item) => ({
      ...item,
      order: this.order(item.orderId),
    }));
  }
  reviewAfterSale(id: string, approved: boolean, operator: string) {
    const item = this.store.afterSales.find((record) => record.id === id);
    if (!item) throw new NotFoundException('售后单不存在');
    const before = item.status;
    item.status = approved ? 'approved' : 'rejected';
    this.audit(
      operator,
      'after-sale.review',
      'after-sale',
      id,
      before,
      item.status,
    );
    return item;
  }
  settlements() {
    return this.staff().map((staff, index) => ({
      id: `bill-${index + 1}`,
      staffId: staff.id,
      staffName: staff.name,
      roleText: staff.roleText,
      period: '2026-08',
      baseSalary: staff.role === 'building-manager' ? 500 : 0,
      commission: staff.role === 'building-manager' ? 326.8 : 286.4,
      adjustment: index === 0 ? -8.5 : 0,
      payable: staff.role === 'building-manager' ? 818.3 : 286.4,
      status: index === 0 ? 'pending-review' : 'confirmed',
    }));
  }
  campuses() {
    return [
      {
        ...this.store.campus,
        status: 'active',
        buildings: 12,
        rooms: 864,
        users: 3286,
      },
    ];
  }
  coupons() {
    return this.store.coupons.map((item, index) => ({
      ...item,
      issued: 500 + index * 180,
      claimed: 286 + index * 92,
      used: 128 + index * 47,
    }));
  }
  auditLogs() {
    return [
      ...this.audits,
      {
        id: 'audit-seed',
        operator: '平台管理员',
        action: 'system.login',
        entityType: 'session',
        entityId: 'admin-001',
        createdAt: new Date().toISOString(),
      },
    ];
  }
  private audit(
    operator: string,
    action: string,
    entityType: string,
    entityId: string,
    before: unknown,
    after: unknown,
  ) {
    this.audits.unshift({
      id: `audit-${Date.now()}`,
      operator,
      action,
      entityType,
      entityId,
      before,
      after,
      createdAt: new Date().toISOString(),
    });
  }
}
