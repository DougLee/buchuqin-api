import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { hash } from 'bcryptjs';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { BusinessService } from '../business/business.service';
import { CommissionService } from '../commission/commission.service';
import type {
  AdjustStockDto,
  CreateAccountDto,
  CreateBannerDto,
  CreateBuildingDto,
  CreateCategoryDto,
  CreateCommissionRuleDto,
  CreateCouponDto,
  CreateDispatchInvitationDto,
  CreateProductDto,
  UpdateProductDto,
  CreateRoomDto,
  CreateStaffDto,
  IssueCouponDto,
  StockInDto,
  UpdateAccountDto,
  UpdateBannerDto,
  UpdateBuildingDto,
  UpdateCategoryDto,
  UpdateCommissionRuleDto,
  UpdateCouponDto,
  UpdateDeliveryConfigDto,
  UpdateStaffDto,
} from './dto';

@Injectable()
export class AdminService {
  constructor(
    private readonly db: PrismaService,
    private readonly business: BusinessService,
    private readonly commissions: CommissionService = new CommissionService(db),
    // 渠道推送（IK8W5M）：可选注入——测试不传时跳过推送。
    @Optional() private readonly push?: NotificationsService,
  ) {}
  private num(x: unknown) {
    return Number(x);
  }
  /** 履约超时阈值：支付后 90 分钟仍未送达视为超时（MVP 口径，正式 SLA 见规则快照 IK8W5L）。 */
  private static readonly FULFILLMENT_TIMEOUT_MS = 90 * 60 * 1000;
  async dashboard(campusId: string) {
    const [campus, orders, buildings, trend, activities] = await Promise.all([
      this.db.campus.findFirstOrThrow({ where: { id: campusId } }),
      this.db.order.findMany({ where: { campusId } }),
      this.db.building.findMany({ where: { campusId } }),
      this.trend(campusId),
      this.activities(campusId),
    ]);
    // 有效单：排除待支付/已取消，后续所有口径基于有效单计算。
    const effective = orders.filter(
      (x) => !['pending-payment', 'cancelled'].includes(x.status),
    );
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    // 今日订单口径：createdAt >= 今日 0 点的有效单。
    const todayOrders = effective.filter(
      (x) => x.createdAt.getTime() >= startOfToday.getTime(),
    );
    // 支付金额口径：paidAt 落在今日（今日支付后退款的单计入支付额，退款额单独统计）。
    const paidToday = effective.filter(
      (x) => x.paidAt && x.paidAt.getTime() >= startOfToday.getTime(),
    );
    const refundedToday = paidToday.filter((x) => x.status === 'refunded');
    // 送达时间优先取送达凭证时间（delivered 动作写入），历史单回退 timeline 末节点。
    const deliveredAt = (order: (typeof orders)[number]) => {
      const proof = (order.package as Record<string, any> | null)?.proof;
      const steps = (order.timeline as Array<Record<string, unknown>>) ?? [];
      const time =
        (proof as Record<string, unknown> | undefined)?.time ??
        steps.at(-1)?.time;
      return time ? new Date(String(time)) : null;
    };
    // 送达口径：delivered（已送达待确认）与 completed 都计入履约完成。
    const completed = effective.filter((x) =>
      ['delivered', 'completed'].includes(x.status),
    );
    // 准时口径：estimatedArrival 是展示文案（“预计 30-60 分钟送达”）不可机读，
    // 暂按“支付当日送达”（当日达）计算，字段语义见 caliber 说明。
    const isOnTime = (order: (typeof orders)[number]) => {
      const time = deliveredAt(order);
      return (
        !!time &&
        !!order.paidAt &&
        time.toDateString() === order.paidAt.toDateString()
      );
    };
    const onTime = completed.filter(isOnTime);
    const rate = (n: number, d: number) =>
      d ? Number(((n / d) * 100).toFixed(1)) : 0;
    // 履约超时：真实统计支付后超过阈值仍未送达（未送达单按当前时刻算进行中超时）。
    const timeout = effective.filter((x) => {
      if (!x.paidAt) return false;
      const end = deliveredAt(x)?.getTime() ?? Date.now();
      return end - x.paidAt.getTime() > AdminService.FULFILLMENT_TIMEOUT_MS;
    }).length;
    // 楼栋排行：优先用 Building 表关联（address.buildingId）取规范楼栋名，
    // 关联缺失（历史快照/手填楼栋）时回退字符串聚合，保证不丢数据。
    const buildingNameById = new Map(buildings.map((b) => [b.id, b.name]));
    const buildingMap = new Map<
      string,
      {
        name: string;
        orders: number;
        revenue: number;
        completed: number;
        onTime: number;
      }
    >();
    for (const order of effective) {
      const addr = order.address as Record<string, unknown>;
      const name =
        buildingNameById.get(String(addr.buildingId ?? '')) ??
        String(addr.buildingName ?? '未知楼栋');
      const item = buildingMap.get(name) ?? {
        name,
        orders: 0,
        revenue: 0,
        completed: 0,
        onTime: 0,
      };
      item.orders += 1;
      item.revenue += this.num(order.payableAmount);
      if (['delivered', 'completed'].includes(order.status)) {
        item.completed += 1;
        if (isOnTime(order)) item.onTime += 1;
      }
      buildingMap.set(name, item);
    }
    return {
      campus,
      updatedAt: new Date().toISOString(),
      kpis: {
        // 金额单位:分——整数求和，无浮点误差（IK8W5K）。
        revenue: paidToday.reduce((s, x) => s + this.num(x.payableAmount), 0),
        orders: todayOrders.length,
        paidUsers: new Set(paidToday.map((x) => x.userId)).size,
        newUsers: await this.db.user.count({
          where: { campusId, createdAt: { gte: startOfToday } },
        }),
        refundedAmount: refundedToday.reduce(
          (s, x) => s + this.num(x.payableAmount),
          0,
        ),
        fulfillmentRate: rate(completed.length, effective.length),
        exceptions: effective.filter((x) => x.status === 'exception').length,
        onTimeRate: rate(onTime.length, completed.length),
      },
      // KPI 口径说明（前端标签需按此对齐 PRD §8.4）。
      caliber: {
        revenue:
          '今日支付金额：paidAt 为今日的有效单（待支付/已取消排除），含今日退款单',
        refundedAmount: '今日退款金额：今日支付且当前状态为 refunded 的单',
        orders: '今日订单：createdAt >= 今日 0 点的有效单（待支付/已取消排除）',
        newUsers: '今日新用户：createdAt >= 今日 0 点',
        fulfillmentRate:
          '履约完成率：全量有效单中 delivered+completed 占比（送达即完成，确认收货为终态）',
        onTimeRate:
          '准时率：送达时间（送达凭证时间，历史单取 timeline 末节点）与支付时间同日（当日达口径）；estimatedArrival 为展示文案不可机读，结构化后切换真实 SLA',
        timeout: `履约超时：支付后超过 ${AdminService.FULFILLMENT_TIMEOUT_MS / 60000} 分钟未送达（未送达单按当前时刻计）`,
        waitingHandover:
          'status=waiting-handover（骑手到楼下等待楼长交接，IK93GQ 拆分后的独立状态）',
        lastMile: 'status=last-mile（楼长送往寝室途中）',
      },
      trend,
      activities,
      fulfillment: {
        waitingPick: effective.filter((x) => x.status === 'picking').length,
        waitingFirstMile: effective.filter(
          (x) => x.status === 'waiting-first-mile',
        ).length,
        firstMile: effective.filter((x) => x.status === 'first-mile').length,
        waitingHandover: effective.filter(
          (x) => x.status === 'waiting-handover',
        ).length,
        lastMile: effective.filter((x) => x.status === 'last-mile').length,
        delivered: effective.filter((x) => x.status === 'delivered').length,
        timeout,
      },
      hotBuildings: [...buildingMap.values()]
        .sort((a, b) => b.orders - a.orders)
        .slice(0, 5)
        .map((item) => ({
          name: item.name,
          orders: item.orders,
          revenue: item.revenue,
          completionRate: rate(item.completed, item.orders),
          onTimeRate: rate(item.onTime, item.completed),
        })),
    };
  }
  /** 近 7 日订单/支付金额/新用户聚合（数据库分组，缺数据日期补零，按校园过滤）。 */
  private async trend(campusId: string) {
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - 6);
    const [orderRows, userRows] = await Promise.all([
      this.db.$queryRaw<
        Array<{ day: Date; orders: number; paidAmount: number | string }>
      >`
        SELECT "createdAt"::date AS day,
               COUNT(*)::int AS orders,
               COALESCE(SUM(CASE WHEN status NOT IN ('pending-payment', 'cancelled')
                            THEN "payableAmount" ELSE 0 END), 0) AS "paidAmount"
        FROM "Order"
        WHERE "createdAt" >= ${since} AND "campusId" = ${campusId}
        GROUP BY 1`,
      this.db.$queryRaw<Array<{ day: Date; newUsers: number }>>`
        SELECT "createdAt"::date AS day, COUNT(*)::int AS "newUsers"
        FROM "User"
        WHERE "createdAt" >= ${since} AND "campusId" = ${campusId}
        GROUP BY 1`,
    ]);
    const key = (d: Date) =>
      `${String(d.getMonth() + 1).padStart(2, '0')}-${String(
        d.getDate(),
      ).padStart(2, '0')}`;
    const byDay = new Map(
      orderRows.map((row) => [
        key(row.day),
        { orders: row.orders, paidAmount: Number(row.paidAmount) },
      ]),
    );
    const usersByDay = new Map(
      userRows.map((row) => [key(row.day), row.newUsers]),
    );
    return Array.from({ length: 7 }, (_, i) => {
      const day = new Date(since);
      day.setDate(since.getDate() + i);
      const bucket = byDay.get(key(day));
      return {
        date: key(day),
        orders: bucket?.orders ?? 0,
        paidAmount: bucket?.paidAmount ?? 0,
        newUsers: usersByDay.get(key(day)) ?? 0,
      };
    });
  }
  /** 最近订单事件 + 审计日志合并的活动流（取前 8 条，按校园过滤）。 */
  private async activities(campusId: string) {
    const [orders, audits] = await Promise.all([
      this.db.order.findMany({
        where: { campusId },
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: { createdAt: true, orderNo: true, statusText: true },
      }),
      this.db.auditLog.findMany({
        where: { campusId },
        orderBy: { createdAt: 'desc' },
        take: 8,
        select: {
          createdAt: true,
          operator: true,
          action: true,
          entityType: true,
        },
      }),
    ]);
    return [
      ...orders.map((x) => ({
        time: x.createdAt.toISOString(),
        text: `订单 ${x.orderNo} · ${x.statusText}`,
        type: 'order',
      })),
      ...audits.map((x) => ({
        time: x.createdAt.toISOString(),
        text: `${x.operator} 执行 ${x.action}（${x.entityType}）`,
        type: 'audit',
      })),
    ]
      .sort((a, b) => b.time.localeCompare(a.time))
      .slice(0, 8);
  }
  async products(campusId: string) {
    const xs = await this.db.product.findMany({
      where: { campusId },
      orderBy: { sales: 'desc' },
    });
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
  /**
   * 商品类别管理（2026-08-19 grilling）：全局字典（无 campusId 维度），
   * 名称应用层唯一（DB 无约束，避免迁移）；sort 升序 = 小程序分类 tab 顺序；
   * 有关联商品的类别拒绝删除（决策：提示数量，运营先转移再删）。
   */
  async categories() {
    const rows = await this.db.category.findMany({
      orderBy: [{ sort: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { products: true } } },
    });
    return rows.map(({ _count, ...row }) => ({
      ...row,
      productCount: _count.products,
    }));
  }
  async createCategory(
    body: CreateCategoryDto,
    operator: string,
    campusId: string,
  ) {
    const duplicate = await this.db.category.findFirst({
      where: { name: body.name },
    });
    if (duplicate) throw new BadRequestException('类别名称已存在');
    const category = await this.db.category.create({
      data: { name: body.name, sort: body.sort ?? 0, image: body.image ?? '' },
    });
    await this.audit(
      operator,
      'category.create',
      'category',
      category.id,
      null,
      { name: category.name, sort: category.sort, image: category.image },
      campusId,
    );
    return category;
  }
  async updateCategory(
    id: string,
    body: UpdateCategoryDto,
    operator: string,
    campusId: string,
  ) {
    const found = await this.db.category.findUnique({ where: { id } });
    if (!found) throw new NotFoundException('类别不存在');
    if (body.name && body.name !== found.name) {
      const duplicate = await this.db.category.findFirst({
        where: { name: body.name, id: { not: id } },
      });
      if (duplicate) throw new BadRequestException('类别名称已存在');
    }
    const category = await this.db.category.update({
      where: { id },
      // Prisma 惯例：undefined 字段跳过更新
      data: { name: body.name, sort: body.sort, image: body.image },
    });
    await this.audit(
      operator,
      'category.update',
      'category',
      id,
      { name: found.name, sort: found.sort, image: found.image },
      { name: category.name, sort: category.sort, image: category.image },
      campusId,
    );
    return category;
  }
  async deleteCategory(id: string, operator: string, campusId: string) {
    const found = await this.db.category.findUnique({
      where: { id },
      include: { _count: { select: { products: true } } },
    });
    if (!found) throw new NotFoundException('类别不存在');
    if (found._count.products)
      throw new BadRequestException(
        `该类别下还有 ${found._count.products} 个商品，请先在商品管理中转移到其他类别`,
      );
    await this.db.category.delete({ where: { id } });
    await this.audit(
      operator,
      'category.delete',
      'category',
      id,
      { name: found.name, sort: found.sort },
      null,
      campusId,
    );
  }
  /** 首页 Banner 管理（IK9RX2）：校园维度，sort 升序；删除为物理删。 */
  async banners(campusId: string) {
    return this.db.banner.findMany({
      where: { campusId },
      orderBy: [{ sort: 'asc' }, { id: 'asc' }],
    });
  }
  async createBanner(
    body: CreateBannerDto,
    operator: string,
    campusId: string,
  ) {
    const banner = await this.db.banner.create({
      data: {
        campusId,
        title: body.title,
        subtitle: body.subtitle ?? '',
        badge: body.badge ?? '',
        color: body.color,
        image: body.image || null,
        // IK9SNN：图文详情，空 = 不可点
        content: body.content || null,
        sort: body.sort ?? 0,
      },
    });
    await this.audit(
      operator,
      'banner.create',
      'banner',
      banner.id,
      null,
      { title: banner.title, sort: banner.sort },
      campusId,
    );
    return banner;
  }
  async updateBanner(
    id: string,
    body: UpdateBannerDto,
    operator: string,
    campusId: string,
  ) {
    const found = await this.db.banner.findFirst({ where: { id, campusId } });
    if (!found) throw new NotFoundException('Banner 不存在');
    const banner = await this.db.banner.update({
      where: { id },
      // Prisma 惯例：undefined 跳过更新；image 用空串语义清空（DTO 已限制非空 URL）
      data: {
        title: body.title,
        subtitle: body.subtitle,
        badge: body.badge,
        color: body.color,
        image: body.image,
        // IK9SNN：undefined 跳过；空串语义清空（存 null）
        content: body.content === undefined ? undefined : body.content || null,
        sort: body.sort,
        status: body.status,
      },
    });
    await this.audit(
      operator,
      'banner.update',
      'banner',
      id,
      { title: found.title, sort: found.sort, status: found.status },
      { title: banner.title, sort: banner.sort, status: banner.status },
      campusId,
    );
    return banner;
  }
  async deleteBanner(id: string, operator: string, campusId: string) {
    const found = await this.db.banner.findFirst({ where: { id, campusId } });
    if (!found) throw new NotFoundException('Banner 不存在');
    await this.db.banner.delete({ where: { id } });
    await this.audit(
      operator,
      'banner.delete',
      'banner',
      id,
      { title: found.title },
      null,
      campusId,
    );
  }
  async lookupBarcode(barcode: string, campusId: string) {
    const product = await this.db.product.findUnique({ where: { barcode } });
    // 跨校园：条码命中他校商品时视作库内未录入，走公共条码库/人工录入。
    if (product && product.campusId === campusId)
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
  async createProduct(
    body: CreateProductDto,
    operator: string,
    campusId: string,
  ) {
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
        campusId,
        barcode: body.barcode,
        name: body.name,
        subtitle: body.subtitle ?? '',
        categoryId: body.categoryId,
        price: body.price,
        originalPrice: body.originalPrice ?? body.price,
        stock: body.stock,
        tag: body.tag ?? '新品',
        image: body.image ?? '',
        // IK9SNS/IK9U40：详情多图（顺序即轮播顺序）与库位拣货指引
        images: body.images,
        location: body.location ?? '',
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
      campusId,
    );
    return product;
  }
  async updateProduct(
    id: string,
    body: UpdateProductDto,
    operator: string,
    campusId: string,
  ) {
    const before = await this.db.product.findFirst({
      where: { id, campusId },
    });
    if (!before) throw new NotFoundException('商品不存在');
    const after = await this.db.product.update({ where: { id }, data: body });
    await this.audit(
      operator,
      'product.update',
      'product',
      id,
      before,
      after,
      campusId,
    );
    return after;
  }
  async inventory(campusId: string) {
    const [items, campus] = await Promise.all([
      this.products(campusId),
      this.db.campus.findFirstOrThrow({ where: { id: campusId } }),
    ]);
    return items.map((x, i) => ({
      ...x,
      warehouse: campus.warehouseName,
      batchNo: `B${new Date().toISOString().slice(0, 10).replaceAll('-', '')}${String(i + 1).padStart(2, '0')}`,
      expiryDate: '2026-12-31',
      warning: x.availableStock < 20,
    }));
  }
  async stockIn(body: StockInDto, operator: string, campusId: string) {
    const product = await this.db.product.findFirst({
      where: { id: body.productId, campusId },
    });
    if (!product) throw new NotFoundException('商品不存在');
    const txn = await this.db.$transaction(async (tx) => {
      const record = await tx.inventoryTxn.create({
        data: {
          productId: body.productId,
          type: 'stock-in',
          delta: body.quantity,
          reason: body.reason,
          operator,
        },
      });
      await tx.product.update({
        where: { id: body.productId },
        data: { stock: { increment: body.quantity } },
      });
      return record;
    });
    await this.audit(
      operator,
      'inventory.stock-in',
      'product',
      body.productId,
      { stock: product.stock },
      { stock: product.stock + body.quantity, txnId: txn.id },
      campusId,
    );
    return txn;
  }
  async adjustStock(body: AdjustStockDto, operator: string, campusId: string) {
    if (!body.delta) throw new BadRequestException('调整数量不能为 0');
    const product = await this.db.product.findFirst({
      where: { id: body.productId, campusId },
    });
    if (!product) throw new NotFoundException('商品不存在');
    const txn = await this.db.$transaction(async (tx) => {
      const current = await tx.product.findUniqueOrThrow({
        where: { id: body.productId },
        select: { stock: true },
      });
      if (current.stock + body.delta < 0)
        throw new BadRequestException('调整后库存不能为负数');
      const record = await tx.inventoryTxn.create({
        data: {
          productId: body.productId,
          type: 'adjust',
          delta: body.delta,
          reason: body.reason,
          operator,
        },
      });
      await tx.product.update({
        where: { id: body.productId },
        data: { stock: { increment: body.delta } },
      });
      return record;
    });
    await this.audit(
      operator,
      'inventory.adjust',
      'product',
      body.productId,
      { stock: product.stock },
      { stock: product.stock + body.delta, txnId: txn.id },
      campusId,
    );
    return txn;
  }
  async inventoryTxns(productId: string | undefined, campusId: string) {
    return this.db.inventoryTxn.findMany({
      where: {
        product: { campusId },
        ...(productId ? { productId } : {}),
      },
      include: { product: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }
  /** 手机号脱敏：保留前 3 后 4，中间四位打码（后台列表不落明文）。 */
  private maskPhone(phone: string) {
    return phone.length === 11
      ? `${phone.slice(0, 3)}****${phone.slice(7)}`
      : phone;
  }
  async orders(status: string | undefined, campusId: string) {
    const xs = await this.db.order.findMany({
      where: {
        campusId,
        ...(status && status !== 'all' ? { status } : {}),
      },
      include: {
        user: { select: { id: true, nickname: true, phone: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return xs.map((x) => ({
      ...x,
      productAmount: this.num(x.productAmount),
      deliveryFee: this.num(x.deliveryFee),
      discount: this.num(x.discount),
      payableAmount: this.num(x.payableAmount),
      // 用户信息脱敏：只回 id/昵称/打码手机号。
      user: {
        id: x.user.id,
        nickname: x.user.nickname,
        phone: this.maskPhone(x.user.phone),
      },
      userPhone: this.maskPhone(x.user.phone),
      packageNo: (x.package as any)?.id ?? '--',
    }));
  }
  async order(id: string, campusId: string) {
    const x = await this.db.order.findFirst({
      where: { id, campusId },
    });
    if (!x) throw new NotFoundException('订单不存在');
    return x;
  }
  async orderAction(
    id: string,
    action: string,
    operator: string,
    campusId: string,
  ) {
    const order = await this.order(id, campusId);
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
    await this.audit(
      operator,
      `order.${action}`,
      'order',
      id,
      order,
      result,
      campusId,
    );
    return result;
  }
  async staff(campusId: string) {
    const xs = await this.db.staff.findMany({
      where: { campusId, status: { not: 'deleted' } },
      include: { buildingRef: true },
      orderBy: { staffNo: 'asc' },
    });
    return xs.map((x) => ({
      ...x,
      onTimeRate: this.num(x.onTimeRate),
      proofRate: x.proofRate == null ? null : this.num(x.proofRate),
      income: this.num(x.income),
      online: x.status === 'online',
    }));
  }
  async createStaff(body: CreateStaffDto, operator: string, campusId: string) {
    const duplicate = await this.db.staff.findUnique({
      where: { staffNo: body.staffNo },
    });
    if (duplicate) throw new BadRequestException('工号已存在');
    // IK9U3Y：骑手不绑楼栋；IK9U3X：楼长必须绑定且一楼一在职楼长
    const RIDER_ROLES = ['fulltime-rider', 'parttime-rider'];
    if (RIDER_ROLES.includes(body.role) && body.buildingId)
      throw new BadRequestException('配送员角色无需绑定楼栋');
    if (body.role === 'building-manager') {
      if (!body.buildingId)
        throw new BadRequestException('楼长必须绑定楼栋');
      const clash = await this.db.staff.findFirst({
        where: {
          buildingId: body.buildingId,
          role: 'building-manager',
          status: { not: 'deleted' },
        },
      });
      if (clash) throw new BadRequestException('该楼栋已有在职楼长');
    }
    let buildingName = '湖北工业大学';
    if (body.buildingId) {
      const building = await this.db.building.findFirst({
        where: { id: body.buildingId, campusId },
      });
      if (!building) throw new BadRequestException('楼栋不存在');
      buildingName = building.name;
    }
    const roleText =
      body.role === 'building-manager'
        ? `${buildingName}楼长`
        : body.role === 'fulltime-rider'
          ? '全职配送员'
          : '兼职配送员';
    const staff = await this.db.staff.create({
      data: {
        campusId,
        name: body.name,
        role: body.role,
        roleText,
        staffNo: body.staffNo,
        buildingId: body.buildingId ?? null,
        building: buildingName,
        status: body.status ?? 'online',
        onTimeRate: 100,
        income: 0,
      },
    });
    await this.audit(
      operator,
      'staff.create',
      'staff',
      staff.id,
      null,
      {
        name: staff.name,
        staffNo: staff.staffNo,
      },
      campusId,
    );
    return staff;
  }
  async updateStaff(
    id: string,
    body: UpdateStaffDto,
    operator: string,
    campusId: string,
  ) {
    const before = await this.db.staff.findFirst({
      where: { id, campusId },
    });
    if (!before || before.status === 'deleted')
      throw new NotFoundException('员工不存在');
    if (
      body.staffNo &&
      body.staffNo !== before.staffNo &&
      (await this.db.staff.findUnique({ where: { staffNo: body.staffNo } }))
    )
      throw new BadRequestException('工号已存在');
    const data: Prisma.StaffUpdateInput = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.role !== undefined) data.role = body.role;
    if (body.staffNo !== undefined) data.staffNo = body.staffNo;
    if (body.status !== undefined) data.status = body.status;
    let buildingName = before.building;
    // IK9U3X/IK9U3Y：仅在本次请求改角色或改楼栋时校验，避免历史数据阻塞改名等普通编辑
    if (body.role !== undefined || body.buildingId !== undefined) {
      const nextRole = body.role ?? before.role;
      const nextBuildingId =
        body.buildingId !== undefined ? body.buildingId : before.buildingId;
      if (['fulltime-rider', 'parttime-rider'].includes(nextRole)) {
        // 骑手自动解绑楼栋（角色切换场景无需两步操作）
        if (nextBuildingId) {
          data.buildingRef = { disconnect: true };
          data.building = '湖北工业大学';
          buildingName = '湖北工业大学';
        }
      } else {
        if (!nextBuildingId)
          throw new BadRequestException('楼长必须绑定楼栋');
        if (
          nextBuildingId !== before.buildingId ||
          nextRole !== before.role
        ) {
          const clash = await this.db.staff.findFirst({
            where: {
              buildingId: nextBuildingId,
              role: 'building-manager',
              status: { not: 'deleted' },
              id: { not: id },
            },
          });
          if (clash) throw new BadRequestException('该楼栋已有在职楼长');
        }
      }
    }
    if (body.buildingId !== undefined) {
      if (body.buildingId === null) {
        data.buildingRef = { disconnect: true };
        buildingName = '湖北工业大学';
      } else {
        const building = await this.db.building.findFirst({
          where: { id: body.buildingId, campusId },
        });
        if (!building) throw new BadRequestException('楼栋不存在');
        data.buildingRef = { connect: { id: building.id } };
        data.building = building.name;
        buildingName = building.name;
      }
    }
    if (body.role !== undefined || body.buildingId !== undefined) {
      const role = body.role ?? before.role;
      data.roleText =
        role === 'building-manager'
          ? `${buildingName}楼长`
          : role === 'fulltime-rider'
            ? '全职配送员'
            : '兼职配送员';
    }
    const after = await this.db.staff.update({ where: { id }, data });
    await this.audit(
      operator,
      'staff.update',
      'staff',
      id,
      before,
      after,
      campusId,
    );
    return after;
  }
  async deleteStaff(id: string, operator: string, campusId: string) {
    const before = await this.db.staff.findFirst({
      where: { id, campusId },
    });
    if (!before || before.status === 'deleted')
      throw new NotFoundException('员工不存在');
    const after = await this.db.staff.update({
      where: { id },
      data: { status: 'deleted' },
    });
    await this.audit(
      operator,
      'staff.delete',
      'staff',
      id,
      before,
      after,
      campusId,
    );
    return { id, deleted: true };
  }
  /** IK9SO6：配送费/起送门槛按校园配置（business.cart/checkout 已按此生效）。 */
  async deliveryConfig(campusId: string) {
    const campus = await this.db.campus.findFirstOrThrow({
      where: { id: campusId },
      select: {
        deliveryFeeInstant: true,
        deliveryFeeScheduled: true,
        deliveryThreshold: true,
      },
    });
    return campus;
  }
  async updateDeliveryConfig(
    body: UpdateDeliveryConfigDto,
    operator: string,
    campusId: string,
  ) {
    const before = await this.deliveryConfig(campusId);
    const after = await this.db.campus.update({
      where: { id: campusId },
      data: {
        deliveryFeeInstant: body.deliveryFeeInstant,
        deliveryFeeScheduled: body.deliveryFeeScheduled,
        deliveryThreshold: body.deliveryThreshold,
      },
      select: {
        deliveryFeeInstant: true,
        deliveryFeeScheduled: true,
        deliveryThreshold: true,
      },
    });
    await this.audit(
      operator,
      'campus.updateDeliveryConfig',
      'campus',
      campusId,
      before,
      after,
      campusId,
    );
    return after;
  }
  async buildings(campusId: string) {
    const xs = await this.db.building.findMany({
      where: { campusId },
      include: {
        _count: { select: { rooms: true } },
        staff: { where: { status: { not: 'deleted' } } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return xs.map((x) => ({
      id: x.id,
      name: x.name,
      floors: x.floors,
      hasElevator: x.hasElevator,
      gender: x.gender,
      roomsCount: x._count.rooms,
      staffName: x.staff.map((s) => s.name).join('、') || undefined,
    }));
  }
  async createBuilding(
    body: CreateBuildingDto,
    operator: string,
    campusId: string,
  ) {
    const duplicate = await this.db.building.findFirst({
      where: { name: body.name, campusId },
    });
    if (duplicate) throw new BadRequestException('楼栋名称已存在');
    const building = await this.db.building.create({
      data: {
        campusId,
        name: body.name,
        floors: body.floors,
        hasElevator: body.hasElevator,
        gender: body.gender,
      },
    });
    await this.audit(
      operator,
      'building.create',
      'building',
      building.id,
      null,
      building,
      campusId,
    );
    return building;
  }
  async updateBuilding(
    id: string,
    body: UpdateBuildingDto,
    operator: string,
    campusId: string,
  ) {
    const before = await this.db.building.findFirst({
      where: { id, campusId },
    });
    if (!before) throw new NotFoundException('楼栋不存在');
    const after = await this.db.building.update({ where: { id }, data: body });
    await this.audit(
      operator,
      'building.update',
      'building',
      id,
      before,
      after,
      campusId,
    );
    return after;
  }
  async deleteBuilding(id: string, operator: string, campusId: string) {
    const building = await this.db.building.findFirst({
      where: { id, campusId },
      include: {
        _count: { select: { rooms: true } },
        staff: { where: { status: { not: 'deleted' } } },
      },
    });
    if (!building) throw new NotFoundException('楼栋不存在');
    if (building._count.rooms)
      throw new BadRequestException('楼栋下存在寝室，无法删除');
    if (building.staff.length)
      throw new BadRequestException('楼栋下仍有在职员工，无法删除');
    await this.db.building.delete({ where: { id } });
    await this.audit(
      operator,
      'building.delete',
      'building',
      id,
      building,
      null,
      campusId,
    );
    return { id, deleted: true };
  }
  async rooms(buildingId: string, campusId: string) {
    const building = await this.db.building.findFirst({
      where: { id: buildingId, campusId },
    });
    if (!building) throw new NotFoundException('楼栋不存在');
    const xs = await this.db.room.findMany({
      where: { buildingId },
      orderBy: [{ floor: 'asc' }, { roomNo: 'asc' }],
    });
    return xs.map((x) => ({
      id: x.id,
      floor: x.floor,
      roomNo: x.roomNo,
      qrToken: x.qrToken,
    }));
  }
  async createRoom(
    buildingId: string,
    body: CreateRoomDto,
    operator: string,
    campusId: string,
  ) {
    const building = await this.db.building.findFirst({
      where: { id: buildingId, campusId },
    });
    if (!building) throw new NotFoundException('楼栋不存在');
    if (body.floor > building.floors)
      throw new BadRequestException('楼层超出楼栋总层数');
    const duplicate = await this.db.room.findUnique({
      where: {
        buildingId_floor_roomNo: {
          buildingId,
          floor: body.floor,
          roomNo: body.roomNo,
        },
      },
    });
    if (duplicate) throw new BadRequestException('该寝室已存在');
    const room = await this.db.room.create({
      data: {
        buildingId,
        floor: body.floor,
        roomNo: body.roomNo,
        qrToken: `qr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      },
    });
    await this.audit(
      operator,
      'room.create',
      'room',
      room.id,
      null,
      room,
      campusId,
    );
    return room;
  }
  async deleteRoom(
    buildingId: string,
    roomId: string,
    operator: string,
    campusId: string,
  ) {
    const room = await this.db.room.findFirst({
      where: { id: roomId, buildingId, building: { campusId } },
    });
    if (!room) throw new NotFoundException('寝室不存在');
    await this.db.room.delete({ where: { id: roomId } });
    await this.audit(
      operator,
      'room.delete',
      'room',
      roomId,
      room,
      null,
      campusId,
    );
    return { id: roomId, deleted: true };
  }
  async afterSales(campusId: string) {
    return this.db.afterSale.findMany({
      where: { order: { campusId } },
      include: { order: true },
      orderBy: { createdAt: 'desc' },
    });
  }
  /** 提成规则列表（版本倒序，含失效规则）。 */
  async commissionRules(campusId: string) {
    const xs = await this.db.commissionRule.findMany({
      where: { campusId },
      orderBy: [{ status: 'asc' }, { version: 'desc' }],
    });
    return xs.map((x) => ({
      ...x,
      price: this.num(x.price),
      weightFrom: x.weightFrom == null ? null : this.num(x.weightFrom),
      weightTo: x.weightTo == null ? null : this.num(x.weightTo),
      effectiveAt: x.effectiveAt.toISOString(),
      createdAt: x.createdAt.toISOString(),
    }));
  }
  async createCommissionRule(
    body: CreateCommissionRuleDto,
    operator: string,
    campusId: string,
  ) {
    if (body.buildingId) {
      const building = await this.db.building.findFirst({
        where: { id: body.buildingId, campusId },
      });
      if (!building) throw new BadRequestException('楼栋不存在');
    }
    if (body.floor && body.floor < 1)
      throw new BadRequestException('楼层必须为正整数');
    // 版本号：校园内自增，快照引用（同校园并发建规则极端情况下版本可能并列，择优时按版本+生效时间兜底）
    const latest = await this.db.commissionRule.findFirst({
      where: { campusId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const rule = await this.db.commissionRule.create({
      data: {
        campusId,
        buildingId: body.buildingId ?? null,
        floor: body.floor ?? null,
        weightFrom: body.weightFrom ?? null,
        weightTo: body.weightTo ?? null,
        mode: body.mode ?? null,
        price: body.price,
        version: (latest?.version ?? 0) + 1,
        status: 'active',
        effectiveAt: body.effectiveAt ? new Date(body.effectiveAt) : new Date(),
      },
    });
    await this.audit(
      operator,
      'commission-rule.create',
      'commission-rule',
      rule.id,
      null,
      { ...rule, price: this.num(rule.price) },
      campusId,
    );
    return rule;
  }
  async updateCommissionRule(
    id: string,
    body: UpdateCommissionRuleDto,
    operator: string,
    campusId: string,
  ) {
    const before = await this.db.commissionRule.findFirst({
      where: { id, campusId },
    });
    if (!before) throw new NotFoundException('提成规则不存在');
    const changed =
      (body.price !== undefined && body.price !== this.num(before.price)) ||
      body.status !== undefined;
    // 价格/状态变更即版本自增：在途 Commission 仍引用旧版本快照，不追溯。
    const after = await this.db.commissionRule.update({
      where: { id },
      data: {
        ...(body.price !== undefined ? { price: body.price } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(changed ? { version: { increment: 1 } } : {}),
      },
    });
    await this.audit(
      operator,
      'commission-rule.update',
      'commission-rule',
      id,
      { ...before, price: this.num(before.price) },
      { ...after, price: this.num(after.price) },
      campusId,
    );
    return after;
  }
  /**
   * 月度结算账单（IK8W5L）：按月聚合 Commission + 底薪，物化为 BmBill 返回。
   * 已确认/已支付的账单金额锁定（历史凭证不可变），仅待复核账单跟随记录重算。
   */
  async settlements(campusId: string, month?: string) {
    const period = month ?? new Date().toISOString().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(period))
      throw new BadRequestException('月份格式必须为 YYYY-MM');
    const staffList = await this.db.staff.findMany({
      where: { campusId, status: { not: 'deleted' } },
    });
    for (const s of staffList) {
      const { commissionTotal, adjustment } = await this.commissions.monthly(
        s.id,
        period,
      );
      // 楼长底薪 500 元 = 50000 分（IK8W5K，金额单位:分）。
      const baseSalary = s.role === 'building-manager' ? 50000 : 0;
      const payable = baseSalary + commissionTotal + adjustment;
      const existing = await this.db.bmBill.findUnique({
        where: { staffId_period: { staffId: s.id, period } },
      });
      if (!existing) {
        await this.db.bmBill.create({
          data: {
            staffId: s.id,
            campusId,
            period,
            baseSalary,
            commissionTotal,
            adjustment,
            payable,
            status: 'pending-review',
          },
        });
      } else if (existing.status === 'pending-review') {
        await this.db.bmBill.update({
          where: { id: existing.id },
          data: { baseSalary, commissionTotal, adjustment, payable },
        });
      }
    }
    const bills = await this.db.bmBill.findMany({
      where: { campusId, period },
      include: {
        staff: { select: { name: true, roleText: true, staffNo: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    return bills.map((x) => ({
      id: x.id,
      staffId: x.staffId,
      staffName: x.staff.name,
      staffNo: x.staff.staffNo,
      roleText: x.staff.roleText,
      period: x.period,
      baseSalary: this.num(x.baseSalary),
      commissionTotal: this.num(x.commissionTotal),
      adjustment: this.num(x.adjustment),
      payable: this.num(x.payable),
      status: x.status,
      confirmedAt: x.confirmedAt?.toISOString() ?? null,
      paidAt: x.paidAt?.toISOString() ?? null,
    }));
  }
  /** 账单确认：pending-review → confirmed（条件更新防重复确认）。 */
  async confirmSettlement(id: string, operator: string, campusId: string) {
    const bill = await this.db.bmBill.findFirst({ where: { id, campusId } });
    if (!bill) throw new NotFoundException('结算账单不存在');
    const won = await this.db.bmBill.updateMany({
      where: { id, status: 'pending-review' },
      data: { status: 'confirmed', confirmedAt: new Date() },
    });
    if (!won.count) throw new BadRequestException('账单已确认或已支付');
    const after = await this.db.bmBill.findUniqueOrThrow({ where: { id } });
    await this.audit(
      operator,
      'settlement.confirm',
      'bm-bill',
      id,
      { status: bill.status },
      { status: after.status },
      campusId,
    );
    return after;
  }
  /** 账单支付：confirmed → paid，并把同期 pending 提成标记 settled（后续退款走跨期负向调整）。 */
  async paySettlement(id: string, operator: string, campusId: string) {
    const bill = await this.db.bmBill.findFirst({ where: { id, campusId } });
    if (!bill) throw new NotFoundException('结算账单不存在');
    const paid = await this.db.$transaction(async (tx) => {
      // 条件更新：未确认的账单不可支付，重复支付只有一笔生效。
      const won = await tx.bmBill.updateMany({
        where: { id, status: 'confirmed' },
        data: { status: 'paid', paidAt: new Date() },
      });
      if (!won.count) throw new BadRequestException('账单未确认或已支付');
      await tx.commission.updateMany({
        where: {
          staffId: bill.staffId,
          period: bill.period,
          status: 'pending',
        },
        data: { status: 'settled' },
      });
      return tx.bmBill.findUniqueOrThrow({ where: { id } });
    });
    await this.audit(
      operator,
      'settlement.pay',
      'bm-bill',
      id,
      { status: bill.status },
      { status: paid.status },
      campusId,
    );
    return paid;
  }
  async campuses() {
    const xs = await this.db.campus.findMany();
    return Promise.all(
      xs.map(async (x) => ({
        ...x,
        buildings: await this.db.building.count({
          where: { campusId: x.id },
        }),
        rooms: await this.db.room.count({
          where: { building: { campusId: x.id } },
        }),
        users: await this.db.user.count({ where: { campusId: x.id } }),
      })),
    );
  }
  /** 请假列表（IK8W5Y）：含请假人角色与所属楼栋（楼长调配决策依据）。 */
  async leaveRequests(campusId: string) {
    const xs = await this.db.leaveRequest.findMany({
      where: { staff: { campusId } },
      include: {
        staff: {
          select: {
            id: true,
            name: true,
            role: true,
            roleText: true,
            staffNo: true,
            building: true,
            buildingId: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return xs.map((x) => ({
      ...x,
      startAt: x.startAt.toISOString(),
      endAt: x.endAt.toISOString(),
      createdAt: x.createdAt.toISOString(),
    }));
  }
  /** 调配邀请列表（IK8W5Y）：含目标楼长信息。 */
  async dispatchInvitations(campusId: string) {
    const xs = await this.db.dispatchInvitation.findMany({
      where: { staff: { campusId } },
      include: {
        staff: {
          select: { id: true, name: true, roleText: true, staffNo: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return xs.map((x) => ({
      ...x,
      reward: this.num(x.reward),
      startAt: x.startAt.toISOString(),
      endAt: x.endAt.toISOString(),
      createdAt: x.createdAt.toISOString(),
    }));
  }
  /**
   * 创建调配邀请（IK8W5Y）：楼长请假 → 平台邀请其他楼长代管楼栋。
   * 校验：目标为在职楼长、且不是该楼当前绑定的楼长（自己无需被调配）。
   */
  async createDispatchInvitation(
    body: CreateDispatchInvitationDto,
    operator: string,
    campusId: string,
  ) {
    const staff = await this.db.staff.findFirst({
      where: { id: body.targetStaffId, campusId },
    });
    if (!staff || staff.status === 'deleted')
      throw new NotFoundException('目标员工不存在');
    if (staff.role !== 'building-manager')
      throw new BadRequestException('调配目标必须是楼长');
    const building = await this.db.building.findFirst({
      where: { id: body.buildingId, campusId },
    });
    if (!building) throw new BadRequestException('楼栋不存在');
    if (staff.buildingId === building.id)
      throw new BadRequestException('目标楼长已是该楼绑定楼长，无需调配');
    const startAt = new Date(body.startAt),
      endAt = new Date(body.endAt);
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime()))
      throw new BadRequestException('时间格式不正确');
    if (startAt.getTime() >= endAt.getTime())
      throw new BadRequestException('结束时间必须晚于开始时间');
    const invitation = await this.db.dispatchInvitation.create({
      data: {
        staffId: staff.id,
        buildingId: building.id,
        building: building.name,
        startAt,
        endAt,
        reward: body.reward ?? 0,
        status: 'invited',
        statusText: '待接受调配',
      },
    });
    await this.audit(
      operator,
      'dispatch-invitation.create',
      'dispatch-invitation',
      invitation.id,
      null,
      { ...invitation, reward: this.num(invitation.reward) },
      campusId,
    );
    return invitation;
  }
  /** 取消调配邀请：仅"待接受"可取消（条件更新，与楼长接受/拒绝互斥）。 */
  async cancelDispatchInvitation(
    id: string,
    operator: string,
    campusId: string,
  ) {
    const before = await this.db.dispatchInvitation.findFirst({
      where: { id, staff: { campusId } },
    });
    if (!before) throw new NotFoundException('调配邀请不存在');
    const won = await this.db.dispatchInvitation.updateMany({
      where: { id, status: 'invited' },
      data: { status: 'cancelled', statusText: '平台已取消' },
    });
    if (!won.count) throw new BadRequestException('邀请已处理，无法取消');
    const after = await this.db.dispatchInvitation.findUniqueOrThrow({
      where: { id },
    });
    await this.audit(
      operator,
      'dispatch-invitation.cancel',
      'dispatch-invitation',
      id,
      { status: before.status },
      { status: after.status },
      campusId,
    );
    return after;
  }
  users(campusId: string) {
    return this.db.user.findMany({
      where: { campusId },
      select: { id: true, nickname: true, phone: true },
      orderBy: { createdAt: 'asc' },
    });
  }
  async coupons(campusId: string) {
    const xs = await this.db.coupon.findMany({ where: { campusId } });
    return xs.map((x) => ({
      ...x,
      amount: this.num(x.amount),
      threshold: this.num(x.threshold),
      remain: Math.max(0, x.total - x.claimed),
    }));
  }
  async createCoupon(
    body: CreateCouponDto,
    operator: string,
    campusId: string,
  ) {
    const expiresAt = new Date(body.expiresAt);
    if (Number.isNaN(expiresAt.getTime()))
      throw new BadRequestException('过期时间格式不正确');
    if (expiresAt.getTime() <= Date.now())
      throw new BadRequestException('过期时间必须晚于当前时间');
    const coupon = await this.db.coupon.create({
      data: {
        campusId,
        name: body.name,
        amount: body.amount,
        threshold: body.threshold,
        total: body.total,
        status: 'active',
        expiresAt,
        issued: 0,
        claimed: 0,
        used: 0,
      },
    });
    await this.audit(
      operator,
      'coupon.create',
      'coupon',
      coupon.id,
      null,
      {
        name: coupon.name,
        total: coupon.total,
      },
      campusId,
    );
    return coupon;
  }
  async updateCoupon(
    id: string,
    body: UpdateCouponDto,
    operator: string,
    campusId: string,
  ) {
    const before = await this.db.coupon.findFirst({
      where: { id, campusId },
    });
    if (!before) throw new NotFoundException('优惠券不存在');
    const after = await this.db.coupon.update({
      where: { id },
      data: { status: body.status },
    });
    await this.audit(
      operator,
      'coupon.update',
      'coupon',
      id,
      before,
      after,
      campusId,
    );
    return after;
  }
  async issueCoupon(
    id: string,
    body: IssueCouponDto,
    operator: string,
    campusId: string,
  ) {
    const coupon = await this.db.coupon.findFirst({
      where: { id, campusId },
    });
    if (!coupon) throw new NotFoundException('优惠券不存在');
    if (coupon.status !== 'active')
      throw new BadRequestException('已下架的优惠券不能发放');
    if (coupon.expiresAt.getTime() <= Date.now())
      throw new BadRequestException('已过期的优惠券不能发放');
    const userIds = [...new Set(body.userIds)];
    if (!userIds.length) throw new BadRequestException('请选择发放对象');
    // 券跨校园：只能给本校用户发放。
    const users = await this.db.user.findMany({
      where: { id: { in: userIds }, campusId },
      select: { id: true },
    });
    if (users.length !== userIds.length)
      throw new BadRequestException('部分用户不存在或不在当前校园');
    const holdings = await this.db.userCoupon.findMany({
      where: { couponId: id, userId: { in: userIds }, status: { not: 'used' } },
      select: { userId: true },
    });
    const heldBy = new Set(holdings.map((x) => x.userId));
    const targets = userIds.filter((userId) => !heldBy.has(userId));
    if (!targets.length)
      throw new BadRequestException('所选用户均持有该券，无需重复发放');
    const result = await this.db.$transaction(async (tx) => {
      // 条件更新兜底并发：已领取数加上本次发放数不能超过总量。
      const won = await tx.coupon.updateMany({
        where: { id, claimed: { lte: coupon.total - targets.length } },
        data: {
          claimed: { increment: targets.length },
          issued: { increment: targets.length },
        },
      });
      if (!won.count)
        throw new BadRequestException('发放数量超过优惠券剩余额度');
      return tx.userCoupon.createMany({
        data: targets.map((userId) => ({
          userId,
          couponId: id,
          status: 'claimed',
        })),
      });
    });
    await this.audit(
      operator,
      'coupon.issue',
      'coupon',
      id,
      coupon,
      {
        targets,
        skipped: userIds.filter((userId) => heldBy.has(userId)),
      },
      campusId,
    );
    return { issued: result.count, targets, couponId: id };
  }
  auditLogs(campusId: string) {
    return this.db.auditLog.findMany({
      where: { campusId },
      orderBy: { createdAt: 'desc' },
    });
  }

  /* ---------- 后台账号管理（IK9KWO）：仅 admin 可达（矩阵守卫在 controller） ---------- */
  /** 列表不回 passwordHash。 */
  async accounts() {
    const xs = await this.db.adminAccount.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        username: true,
        nickname: true,
        role: true,
        campusId: true,
        createdAt: true,
      },
    });
    return xs;
  }
  async createAccount(
    body: CreateAccountDto,
    operator: string,
    campusId: string,
  ) {
    const duplicate = await this.db.adminAccount.findUnique({
      where: { username: body.username },
    });
    if (duplicate) throw new BadRequestException('用户名已存在');
    const account = await this.db.adminAccount.create({
      data: {
        username: body.username,
        passwordHash: await hash(body.password, 10),
        nickname: body.nickname ?? '',
        role: body.role,
        campusId,
      },
    });
    await this.audit(
      operator,
      'account.create',
      'admin-account',
      account.id,
      null,
      { username: account.username, role: account.role },
      campusId,
    );
    return { id: account.id, username: account.username, role: account.role };
  }
  async updateAccount(
    id: string,
    body: UpdateAccountDto,
    operator: string,
    campusId: string,
  ) {
    const before = await this.db.adminAccount.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('账号不存在');
    // 保护：最后一个 admin 不可降级（否则后台再无超管，权限体系锁死）。
    if (before.role === 'admin' && body.role && body.role !== 'admin')
      await this.assertNotLastAdmin(id);
    const after = await this.db.adminAccount.update({
      where: { id },
      data: {
        ...(body.nickname != null ? { nickname: body.nickname } : {}),
        ...(body.role ? { role: body.role } : {}),
        ...(body.password
          ? { passwordHash: await hash(body.password, 10) }
          : {}),
      },
      select: { id: true, username: true, nickname: true, role: true },
    });
    await this.audit(
      operator,
      body.password ? 'account.reset-password' : 'account.update',
      'admin-account',
      id,
      { username: before.username, role: before.role },
      after,
      campusId,
    );
    return after;
  }
  async deleteAccount(
    id: string,
    operator: string,
    campusId: string,
  ) {
    const before = await this.db.adminAccount.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('账号不存在');
    if (id === operator) throw new BadRequestException('不能删除当前登录账号');
    if (before.role === 'admin') await this.assertNotLastAdmin(id);
    await this.db.adminAccount.delete({ where: { id } });
    await this.audit(
      operator,
      'account.delete',
      'admin-account',
      id,
      { username: before.username, role: before.role },
      null,
      campusId,
    );
    return { id, deleted: true };
  }
  private async assertNotLastAdmin(id: string) {
    const admins = await this.db.adminAccount.count({
      where: { role: 'admin', id: { not: id } },
    });
    if (!admins) throw new BadRequestException('至少需要保留一个超管账号');
  }
  private audit(
    operator: string,
    action: string,
    entityType: string,
    entityId: string,
    before: unknown,
    after: unknown,
    campusId: string,
  ) {
    return this.db.auditLog.create({
      data: {
        campusId,
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
