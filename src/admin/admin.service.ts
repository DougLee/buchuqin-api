import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { BusinessService } from '../business/business.service';
import type { CreateProductDto } from './dto';

@Injectable()
export class AdminService {
  constructor(
    private readonly db: PrismaService,
    private readonly business: BusinessService,
  ) {}
  private num(x: unknown) {
    return Number(x);
  }
  async dashboard() {
    const [campus, orders] = await Promise.all([
      this.db.campus.findFirstOrThrow(),
      this.db.order.findMany(),
    ]);
    const paid = orders.filter(
      (x) => !['pending-payment', 'cancelled'].includes(x.status),
    );
    const buildingMap = new Map<
      string,
      { name: string; orders: number; revenue: number; completed: number }
    >();
    for (const order of orders) {
      const name = String(
        (order.address as Record<string, unknown>).buildingName ?? '未知楼栋',
      );
      const item = buildingMap.get(name) ?? {
        name,
        orders: 0,
        revenue: 0,
        completed: 0,
      };
      item.orders += 1;
      item.revenue += this.num(order.payableAmount);
      if (order.status === 'completed') item.completed += 1;
      buildingMap.set(name, item);
    }
    return {
      campus,
      updatedAt: new Date().toISOString(),
      kpis: {
        revenue: Number(
          paid.reduce((s, x) => s + this.num(x.payableAmount), 0).toFixed(2),
        ),
        orders: orders.length,
        paidUsers: new Set(paid.map((x) => x.userId)).size,
        newUsers: await this.db.user.count(),
        fulfillmentRate: orders.length
          ? Number(
              (
                (orders.filter((x) => x.status === 'completed').length /
                  orders.length) *
                100
              ).toFixed(1),
            )
          : 0,
        exceptions: orders.filter((x) => x.status === 'exception').length,
      },
      orderTrend: [0, 0, 0, 0, 0, 0, paid.length],
      fulfillment: {
        waitingPick: orders.filter((x) => x.status === 'picking').length,
        firstMile: orders.filter((x) => x.status === 'first-mile').length,
        waitingHandover: orders.filter((x) => x.status === 'last-mile').length,
        lastMile: orders.filter((x) => x.status === 'last-mile').length,
        timeout: 0,
      },
      hotBuildings: [...buildingMap.values()]
        .sort((a, b) => b.orders - a.orders)
        .slice(0, 5)
        .map((item) => ({
          name: item.name,
          orders: item.orders,
          revenue: Number(item.revenue.toFixed(2)),
          onTimeRate: item.orders
            ? Number(((item.completed / item.orders) * 100).toFixed(1))
            : 0,
        })),
    };
  }
  async products() {
    const xs = await this.db.product.findMany({ orderBy: { sales: 'desc' } });
    return xs.map((x) => ({
      ...x,
      price: this.num(x.price),
      originalPrice: this.num(x.originalPrice),
      weight: this.num(x.weight),
      skuNo: `SKU-${x.id.toUpperCase()}`,
      actualStock: x.stock + x.lockedStock,
      availableStock: x.stock,
      status: x.stock ? x.status : 'sold-out',
    }));
  }
  async lookupBarcode(barcode: string) {
    const product = await this.db.product.findUnique({ where: { barcode } });
    if (product)
      return {
        found: true,
        source: 'product-database',
        product: {
          ...product,
          price: this.num(product.price),
          originalPrice: this.num(product.originalPrice),
          weight: this.num(product.weight),
        },
      };
    try {
      const response = await fetch(
        `https://world.openfoodfacts.org/api/v2/product/${barcode}.json?fields=product_name_zh,product_name,brands,quantity,image_front_url,categories_tags`,
        {
          headers: { 'User-Agent': 'BuChuQinShiShe/1.0 (product-entry)' },
          signal: AbortSignal.timeout(3500),
        },
      );
      const body = (await response.json()) as {
        status?: number;
        product?: Record<string, unknown>;
      };
      if (body.status === 1 && body.product) {
        const item = body.product;
        const name = String(item.product_name_zh || item.product_name || '');
        const tags = Array.isArray(item.categories_tags)
          ? item.categories_tags.join(' ')
          : '';
        const categoryId = /instant|noodle|方便|速食/i.test(tags)
          ? 'instant'
          : /fruit|水果/i.test(tags)
            ? 'fruit'
            : 'snack';
        return {
          found: true,
          exists: false,
          source: 'open-food-facts',
          product: {
            barcode,
            name,
            subtitle: [item.brands, item.quantity].filter(Boolean).join(' · '),
            categoryId,
            price: 0,
            originalPrice: 0,
            stock: 0,
            tag: '新品',
            image: String(item.image_front_url || ''),
            weight: 0,
          },
        };
      }
    } catch {
      // 公共条码库不可用时继续人工录入，不阻断仓库作业。
    }
    return {
      found: false,
      source: 'manual',
      product: {
        barcode,
        name: '',
        subtitle: '',
        categoryId: 'snack',
        price: 0,
        originalPrice: 0,
        stock: 0,
        tag: '新品',
        image: '',
        weight: 0,
      },
    };
  }
  async createProduct(body: CreateProductDto, operator: string) {
    const duplicate = await this.db.product.findUnique({
      where: { barcode: body.barcode },
    });
    if (duplicate) throw new BadRequestException('该条码已录入商品库');
    const category = await this.db.category.findUnique({
      where: { id: body.categoryId },
    });
    if (!category) throw new BadRequestException('商品分类不存在');
    const product = await this.db.product.create({
      data: {
        id: `p-${Date.now()}`,
        campusId: 'campus-hbut',
        barcode: body.barcode,
        name: body.name,
        subtitle: body.subtitle ?? '',
        categoryId: body.categoryId,
        price: body.price,
        originalPrice: body.originalPrice ?? body.price,
        stock: body.stock,
        tag: body.tag ?? '新品',
        image: body.image ?? '',
        weight: body.weight ?? 0,
        sales: 0,
        status: 'on-sale',
      },
    });
    await this.audit(
      operator,
      'product.create',
      'product',
      product.id,
      null,
      product,
    );
    return product;
  }
  async updateProduct(
    id: string,
    body: { price?: number; stock?: number },
    operator: string,
  ) {
    const before = await this.db.product.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('商品不存在');
    const after = await this.db.product.update({ where: { id }, data: body });
    await this.audit(operator, 'product.update', 'product', id, before, after);
    return after;
  }
  async inventory() {
    const [items, campus] = await Promise.all([
      this.products(),
      this.db.campus.findFirstOrThrow(),
    ]);
    return items.map((x, i) => ({
      ...x,
      warehouse: campus.warehouseName,
      batchNo: `B${new Date().toISOString().slice(0, 10).replaceAll('-', '')}${String(i + 1).padStart(2, '0')}`,
      expiryDate: '2026-12-31',
      warning: x.availableStock < 20,
    }));
  }
  async orders(status?: string) {
    const xs = await this.db.order.findMany({
      where: status && status !== 'all' ? { status } : {},
      include: { user: true },
      orderBy: { createdAt: 'desc' },
    });
    return xs.map((x) => ({
      ...x,
      productAmount: this.num(x.productAmount),
      deliveryFee: this.num(x.deliveryFee),
      discount: this.num(x.discount),
      payableAmount: this.num(x.payableAmount),
      userPhone: x.user.phone,
      packageNo: (x.package as any)?.id ?? '--',
    }));
  }
  async order(id: string) {
    const x = await this.db.order.findUnique({ where: { id } });
    if (!x) throw new NotFoundException('订单不存在');
    return x;
  }
  async orderAction(id: string, action: string, operator: string) {
    const order = await this.order(id);
    let result: unknown;
    if (action === 'cancel')
      result = await this.business.cancel(order.userId, id);
    else if (action === 'advance')
      result = await this.business.advance(order.userId, id);
    else if (action === 'mark-exception')
      result = await this.db.order.update({
        where: { id },
        data: { status: 'exception', statusText: '运营标记异常' },
      });
    else throw new BadRequestException('不支持的订单操作');
    await this.audit(operator, `order.${action}`, 'order', id, order, result);
    return result;
  }
  async staff() {
    const xs = await this.db.staff.findMany();
    return xs.map((x) => ({
      ...x,
      onTimeRate: this.num(x.onTimeRate),
      proofRate: x.proofRate == null ? null : this.num(x.proofRate),
      income: this.num(x.income),
      online: x.status === 'online',
    }));
  }
  async afterSales() {
    return this.db.afterSale.findMany({
      include: { order: true },
      orderBy: { createdAt: 'desc' },
    });
  }
  async reviewAfterSale(id: string, approved: boolean, operator: string) {
    const x = await this.db.afterSale.findUnique({ where: { id } });
    if (!x) throw new NotFoundException('售后单不存在');
    if (x.status !== 'pending') throw new BadRequestException('售后单已处理');
    const result = await this.db.$transaction(async (tx) => {
      const after = await tx.afterSale.update({
        where: { id },
        data: { status: approved ? 'approved' : 'rejected' },
      });
      if (approved) {
        const order = await tx.order.findUniqueOrThrow({
          where: { id: x.orderId },
        });
        await tx.refund.create({
          data: {
            id: `refund-${Date.now()}`,
            userId: x.userId,
            orderId: x.orderId,
            amount: order.payableAmount,
            reason: x.description,
            status: 'succeeded',
          },
        });
        await tx.order.update({
          where: { id: x.orderId },
          data: { status: 'refunded', statusText: '已退款' },
        });
      }
      return after;
    });
    await this.audit(
      operator,
      'after-sale.review',
      'after-sale',
      id,
      x,
      result,
    );
    return result;
  }
  async settlements() {
    const xs = await this.staff();
    return xs.map((x, i) => ({
      id: `bill-${i + 1}`,
      staffId: x.id,
      staffName: x.name,
      roleText: x.roleText,
      period: new Date().toISOString().slice(0, 7),
      baseSalary: x.role === 'building-manager' ? 500 : 0,
      commission: x.income,
      adjustment: 0,
      payable: (x.role === 'building-manager' ? 500 : 0) + x.income,
      status: 'pending-review',
    }));
  }
  async campuses() {
    const xs = await this.db.campus.findMany();
    return Promise.all(
      xs.map(async (x) => ({
        ...x,
        buildings: 12,
        rooms: 864,
        users: await this.db.user.count({ where: { campusId: x.id } }),
      })),
    );
  }
  async coupons() {
    const xs = await this.db.coupon.findMany();
    return xs.map((x) => ({
      ...x,
      amount: this.num(x.amount),
      threshold: this.num(x.threshold),
    }));
  }
  auditLogs() {
    return this.db.auditLog.findMany({ orderBy: { createdAt: 'desc' } });
  }
  private audit(
    operator: string,
    action: string,
    entityType: string,
    entityId: string,
    before: unknown,
    after: unknown,
  ) {
    return this.db.auditLog.create({
      data: {
        campusId: 'campus-hbut',
        operator,
        action,
        entityType,
        entityId,
        before: before as Prisma.InputJsonValue,
        after: after as Prisma.InputJsonValue,
      },
    });
  }
}
