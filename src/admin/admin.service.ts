import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { BusinessService } from '../business/business.service';
import type {
  AdjustStockDto,
  CreateBuildingDto,
  CreateCouponDto,
  CreateProductDto,
  CreateRoomDto,
  CreateStaffDto,
  IssueCouponDto,
  StockInDto,
  UpdateBuildingDto,
  UpdateCouponDto,
  UpdateStaffDto,
} from './dto';

@Injectable()
export class AdminService {
  constructor(
    private readonly db: PrismaService,
    private readonly business: BusinessService,
  ) {}
  private num(x: unknown) {
    return Number(x);
  }
  /** 履约超时阈值：支付后 90 分钟仍未送达视为超时（MVP 口径，正式 SLA 见规则快照 IK8W5L）。 */
  private static readonly FULFILLMENT_TIMEOUT_MS = 90 * 60 * 1000;
  /** timeline 指定节点是否已完成。 */
  private stepDone(order: { timeline: Prisma.JsonValue }, key: string) {
    const steps = (order.timeline as Array<Record<string, unknown>>) ?? [];
    return Boolean(steps.find((s) => s.key === key)?.done);
  }
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
    // 送达时间取 timeline 最后节点（与履约端绩效一致）。
    const deliveredAt = (order: (typeof orders)[number]) => {
      const steps = (order.timeline as Array<Record<string, unknown>>) ?? [];
      const time = steps.at(-1)?.time;
      return time ? new Date(String(time)) : null;
    };
    const completed = effective.filter((x) => x.status === 'completed');
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
    // waiting-handover 尚未拆独立状态（不在本批）：status=last-mile 且
    // last-mile 节点未完成 = 骑手到楼下等待楼长交接；节点已完成 = 楼长送上楼途中。
    const lastMileOrders = effective.filter((x) => x.status === 'last-mile');
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
      if (order.status === 'completed') {
        item.completed += 1;
        if (isOnTime(order)) item.onTime += 1;
      }
      buildingMap.set(name, item);
    }
    return {
      campus,
      updatedAt: new Date().toISOString(),
      kpis: {
        revenue: Number(
          paidToday.reduce((s, x) => s + this.num(x.payableAmount), 0).toFixed(
            2,
          ),
        ),
        orders: todayOrders.length,
        paidUsers: new Set(paidToday.map((x) => x.userId)).size,
        newUsers: await this.db.user.count({
          where: { campusId, createdAt: { gte: startOfToday } },
        }),
        refundedAmount: Number(
          refundedToday
            .reduce((s, x) => s + this.num(x.payableAmount), 0)
            .toFixed(2),
        ),
        fulfillmentRate: rate(completed.length, effective.length),
        exceptions: effective.filter((x) => x.status === 'exception').length,
        onTimeRate: rate(onTime.length, completed.length),
      },
      // KPI 口径说明（前端标签需按此对齐 PRD §8.4）。
      caliber: {
        revenue: '今日支付金额：paidAt 为今日的有效单（待支付/已取消排除），含今日退款单',
        refundedAmount: '今日退款金额：今日支付且当前状态为 refunded 的单',
        orders: '今日订单：createdAt >= 今日 0 点的有效单（待支付/已取消排除）',
        newUsers: '今日新用户：createdAt >= 今日 0 点',
        fulfillmentRate: '履约完成率：全量有效单中 completed 占比',
        onTimeRate: '准时率：送达时间（timeline 末节点）与支付时间同日（当日达口径）；estimatedArrival 为展示文案不可机读，结构化后切换真实 SLA',
        timeout: `履约超时：支付后超过 ${AdminService.FULFILLMENT_TIMEOUT_MS / 60000} 分钟未送达（未送达单按当前时刻计）`,
        waitingHandover: 'last-mile 且 last-mile 节点未完成（骑手到楼下等待楼长交接）',
        lastMile: 'last-mile 且 last-mile 节点已完成（楼长送往寝室途中）',
      },
      trend,
      activities,
      fulfillment: {
        waitingPick: effective.filter((x) => x.status === 'picking').length,
        firstMile: effective.filter((x) => x.status === 'first-mile').length,
        waitingHandover: lastMileOrders.filter(
          (x) => !this.stepDone(x, 'last-mile'),
        ).length,
        lastMile: lastMileOrders.filter((x) =>
          this.stepDone(x, 'last-mile'),
        ).length,
        timeout,
      },
      hotBuildings: [...buildingMap.values()]
        .sort((a, b) => b.orders - a.orders)
        .slice(0, 5)
        .map((item) => ({
          name: item.name,
          orders: item.orders,
          revenue: Number(item.revenue.toFixed(2)),
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
        Array<{ day: Date; orders: number; paidAmount: Prisma.Decimal }>
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
        paidAmount: Number((bucket?.paidAmount ?? 0).toFixed(2)),
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
    body: { price?: number; stock?: number },
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
    return phone.length === 11 ? `${phone.slice(0, 3)}****${phone.slice(7)}` : phone;
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
  async createStaff(
    body: CreateStaffDto,
    operator: string,
    campusId: string,
  ) {
    const duplicate = await this.db.staff.findUnique({
      where: { staffNo: body.staffNo },
    });
    if (duplicate) throw new BadRequestException('工号已存在');
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
  async reviewAfterSale(
    id: string,
    approved: boolean,
    operator: string,
    campusId: string,
  ) {
    const x = await this.db.afterSale.findFirst({
      where: { id, order: { campusId } },
    });
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
      campusId,
    );
    return result;
  }
  async settlements(campusId: string) {
    const xs = await this.staff(campusId);
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
