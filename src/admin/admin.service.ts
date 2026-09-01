import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { hash } from 'bcryptjs';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrinterService } from '../printer/printer.service';
import { BusinessService } from '../business/business.service';
import { CommissionService } from '../commission/commission.service';
import type {
  AdjustStockDto,
  CreateAccountDto,
  CreateBannerDto,
  CreateBuildingDto,
  CreateCampusDto,
  CreateCategoryDto,
  CreateCommissionRuleDto,
  CreateCouponDto,
  BindPrinterDto,
  CreateDispatchInvitationDto,
  CreateLocationDto,
  CreateProductDto,
  CreatePromotionDto,
  UpdateCampusDto,
  UpdatePromotionDto,
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
  UpdateLocationDto,
  UpdateOrderStatusDto,
  UpdateStaffDto,
} from './dto';
import {
  ORDER_STATUSES,
  ORDER_STATUS_TEXT,
  markTimelineStep,
  type OrderStatus,
} from '../common/order-state';
import { OFFICIAL_CAMPUS_ID } from '../common/campus';

@Injectable()
export class AdminService {
  constructor(
    private readonly db: PrismaService,
    private readonly business: BusinessService,
    private readonly commissions: CommissionService = new CommissionService(db),
    // 渠道推送（IK8W5M）：可选注入——测试不传时跳过推送。
    @Optional() private readonly push?: NotificationsService,
    // 小票打印（IKBT6N）：可选注入——补打端点用；测试不传时报「未配置」。
    @Optional() private readonly printer?: PrinterService,
  ) {}
  private num(x: unknown) {
    return Number(x);
  }
  /** 履约超时阈值：支付后 90 分钟仍未送达视为超时（MVP 口径，正式 SLA 见规则快照 IK8W5L）。 */
  private static readonly FULFILLMENT_TIMEOUT_MS = 90 * 60 * 1000;
  /**
   * 跨校区汇总看板（IKAJSL 总部工作台）：每校区今日营业概览 + 总部合计。
   * 口径：营业额/订单 = 今日支付的有效单；新用户 = 今日注册；异常 = 状态
   * exception 的未结单（不限当日，代表当前待处理）。轻量 groupBy，不复用
   * 单校区 dashboard 的重查询。
   */
  private async hqDashboard() {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const [campuses, paidAgg, userAgg, exceptionAgg, buildingAgg] =
      await Promise.all([
        // status=official 是官方商品库伪校区（IKAJSM），不进运营汇总
        this.db.campus.findMany({
          where: { status: { not: 'official' } },
          orderBy: { createdAt: 'asc' },
        }),
        this.db.order.groupBy({
          by: ['campusId'],
          where: { createdAt: { gte: startOfToday }, paidAt: { not: null } },
          _count: { _all: true },
          _sum: { payableAmount: true },
        }),
        this.db.user.groupBy({
          by: ['campusId'],
          where: { createdAt: { gte: startOfToday } },
          _count: { _all: true },
        }),
        this.db.order.groupBy({
          by: ['campusId'],
          where: { status: 'exception' },
          _count: { _all: true },
        }),
        this.db.building.groupBy({ by: ['campusId'], _count: { _all: true } }),
      ]);
    const paidByCampus = new Map(paidAgg.map((r) => [r.campusId, r]));
    const usersByCampus = new Map(userAgg.map((r) => [r.campusId, r._count._all]));
    const exceptionByCampus = new Map(
      exceptionAgg.map((r) => [r.campusId, r._count._all]),
    );
    const buildingsByCampus = new Map(
      buildingAgg.map((r) => [r.campusId, r._count._all]),
    );
    const campusRows = campuses.map((c) => {
      const paid = paidByCampus.get(c.id);
      return {
        campusId: c.id,
        name: c.name,
        shortName: c.shortName,
        status: c.status,
        buildings: buildingsByCampus.get(c.id) ?? 0,
        revenue: this.num(paid?._sum.payableAmount ?? 0),
        orders: paid?._count._all ?? 0,
        newUsers: usersByCampus.get(c.id) ?? 0,
        exceptions: exceptionByCampus.get(c.id) ?? 0,
      };
    });
    return {
      campusRows,
      kpis: {
        revenue: campusRows.reduce((sum, r) => sum + r.revenue, 0),
        orders: campusRows.reduce((sum, r) => sum + r.orders, 0),
        newUsers: campusRows.reduce((sum, r) => sum + r.newUsers, 0),
        exceptions: campusRows.reduce((sum, r) => sum + r.exceptions, 0),
        campuses: campusRows.length,
      },
      caliber: {
        revenue: '全部校区今日支付的有效单实付金额合计（分）',
        orders: '全部校区今日支付的有效单合计',
        newUsers: '全部校区今日新增用户',
        exceptions: '状态为异常的未结订单（不限当日）',
      },
    };
  }
  async dashboard(campusId: string) {
    // IKAJSL：总部账号 campusId 空 → 跨校区汇总；带 ?campus= 可看单校区明细
    if (!campusId) return this.hqDashboard();
    const [campus, orders, buildings, trend, activities, staffRows, stageRows] =
      await Promise.all([
        this.db.campus.findFirstOrThrow({ where: { id: campusId } }),
        this.db.order.findMany({ where: { campusId } }),
        this.db.building.findMany({ where: { campusId } }),
        this.trend(campusId),
        this.activities(campusId),
        // IKAJSS 水位下钻：在职履约人员按角色计数
        this.db.staff.groupBy({
          by: ['role'],
          where: { campusId },
          _count: { _all: true },
        }),
        // IKAJSS 水位下钻：各节点平均停留（自支付起算的分钟数；paid+picking 并入待拣货）
        this.db.$queryRaw<Array<{ node: string; minutes: number | null }>>`
          SELECT CASE WHEN status IN ('paid','picking') THEN 'waitingPick' ELSE status END AS node,
                 (AVG(EXTRACT(EPOCH FROM (now() - "paidAt")) / 60))::int AS minutes
          FROM "Order"
          WHERE "campusId" = ${campusId} AND "paidAt" IS NOT NULL
            AND status IN ('paid','picking','waiting-first-mile','first-mile','waiting-handover','last-mile')
          GROUP BY 1`,
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
    // IKAJSS：超时从计数扩为 Top5 列表（单号+超时时长），工作台可直达处理。
    const overtimes = effective.filter((x) => {
      if (!x.paidAt) return false;
      const end = deliveredAt(x)?.getTime() ?? Date.now();
      return end - x.paidAt.getTime() > AdminService.FULFILLMENT_TIMEOUT_MS;
    });
    const timeout = overtimes.length;
    const timeoutOrders = overtimes
      .map((x) => ({
        id: x.id,
        orderNo: x.orderNo,
        overtimeMinutes: Math.round(
          ((deliveredAt(x)?.getTime() ?? Date.now()) - x.paidAt!.getTime()) /
            60000,
        ),
      }))
      .sort((a, b) => b.overtimeMinutes - a.overtimeMinutes)
      .slice(0, 5);
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
    // IKAJSS 水位下钻数据：作业人数按节点角色（骑手接 waiting-first-mile/first-mile，
    // 楼长接 waiting-handover/last-mile；仓库出库是后台账号不在 Staff 表，记 0）。
    const staffByRole = new Map(staffRows.map((r) => [r.role, r._count._all]));
    const riders =
      (staffByRole.get('fulltime-rider') ?? 0) +
      (staffByRole.get('parttime-rider') ?? 0);
    const managers = staffByRole.get('building-manager') ?? 0;
    const minutesByNode = new Map(
      stageRows.map((r) => [r.node, Number(r.minutes) || 0]),
    );
    const detail = (
      staff: number,
      node?: string,
    ): { staff: number; avgMinutes: number | null } => ({
      staff,
      avgMinutes: node ? minutesByNode.get(node) ?? null : null,
    });
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
        // IKAJSS：待拣货口径对齐订单 Tab「待出库」= paid+picking（v1 出库一步制）
        waitingPick: effective.filter((x) =>
          ['paid', 'picking'].includes(x.status),
        ).length,
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
      // IKAJSS 水位下钻：作业人数 + 平均停留分钟（自支付起算，见 dashboard 头部说明）
      fulfillmentDetail: {
        waitingPick: detail(0, 'waitingPick'),
        waitingFirstMile: detail(riders, 'waiting-first-mile'),
        firstMile: detail(riders, 'first-mile'),
        waitingHandover: detail(managers, 'waiting-handover'),
        lastMile: detail(managers, 'last-mile'),
        delivered: detail(managers),
        timeout: detail(riders + managers),
      },
      timeoutOrders,
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
  /** IKB5P8：审计动作中文名（动态流与审计列表共用）；未收录的动作回落「后台操作」，
   *  原始代码（promotion.create 等）不再透出到界面。 */
  private static readonly AUDIT_ACTION_TEXTS: Record<string, string> = {
    'account.create': '创建账号',
    'account.update': '更新账号',
    'account.delete': '删除账号',
    'banner.create': '创建 Banner',
    'banner.update': '更新 Banner',
    'banner.delete': '删除 Banner',
    'building.create': '创建楼栋',
    'building.update': '更新楼栋',
    'building.delete': '删除楼栋',
    'campus.create': '创建校区',
    'campus.update': '更新校区',
    'campus.updateDeliveryConfig': '更新配送配置',
    'category.create': '创建类别',
    'category.update': '更新类别',
    'category.delete': '删除类别',
    'commission-rule.create': '创建提成规则',
    'commission-rule.update': '更新提成规则',
    'coupon.create': '创建优惠券',
    'coupon.update': '更新优惠券',
    'coupon.issue': '发放优惠券',
    'dispatch-invitation.create': '创建调配邀请',
    'dispatch-invitation.cancel': '取消调配邀请',
    'inventory.adjust': '调整库存',
    'inventory.stock-in': '采购入库',
    'location.create': '创建库位',
    'location.update': '更新库位',
    'location.delete': '删除库位',
    'order.cancel': '取消订单',
    'order.advance': '推进订单',
    'order.outbound': '订单出库',
    'order.mark-exception': '标记订单异常',
    'order.print-receipt': '补打小票',
    'order.manual-status': '手动改单状态',
    'product.create': '创建商品',
    'product.update': '更新商品',
    'product.import': '导入商品',
    'product.pull-upstream': '同步官方商品',
    'promotion.create': '创建促销',
    'promotion.update': '更新促销',
    'room.create': '创建房间',
    'room.delete': '删除房间',
    'settlement.confirm': '确认结算单',
    'settlement.pay': '支付结算单',
    'staff.create': '创建人员',
    'staff.update': '更新人员',
    'staff.delete': '删除人员',
    'wechat-group.upsert': '更新微信群码',
    'wechat-group.delete': '删除微信群码',
  };
  /** IKB5P8：审计对象中文名（account/banner/... → 人话），未知对象回落「后台数据」。 */
  private static readonly AUDIT_ENTITY_TEXTS: Record<string, string> = {
    'admin-account': '后台账号',
    banner: 'Banner',
    building: '楼栋',
    campus: '校区',
    category: '商品类别',
    coupon: '优惠券',
    product: '商品',
    location: '库位',
    promotion: '促销活动',
    room: '房间',
    'bm-bill': '结算单',
    'commission-rule': '提成规则',
    'dispatch-invitation': '调配邀请',
    'wechat-group': '微信群码',
    staff: '履约人员',
    order: '订单',
  };
  /** IKB5P8：operator 存的是账号 id，回查昵称/用户名；查不到（含历史测试号）回落「系统」。 */
  private async operatorNames(ids: string[]) {
    const uniq = [...new Set(ids.filter(Boolean))];
    if (!uniq.length) return new Map<string, string>();
    const rows = await this.db.adminAccount.findMany({
      where: { id: { in: uniq } },
      select: { id: true, nickname: true, username: true },
    });
    return new Map(rows.map((r) => [r.id, r.nickname || r.username]));
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
    // IKB5P8：审计事件人话化（操作人昵称 + 中文动作，未知代码不外露）
    const names = await this.operatorNames(audits.map((x) => x.operator));
    return [
      ...orders.map((x) => ({
        time: x.createdAt.toISOString(),
        text: `订单 ${x.orderNo} · ${x.statusText}`,
        type: 'order',
        // IKAJSS：动态流直达路由用（前端按 entityType 跳对应处理页）
        entityType: 'order',
        orderNo: x.orderNo,
      })),
      ...audits.map((x) => ({
        time: x.createdAt.toISOString(),
        text: `${names.get(x.operator) ?? '系统'} · ${
          AdminService.AUDIT_ACTION_TEXTS[x.action] ?? '后台操作'
        }`,
        type: 'audit',
        entityType: x.entityType,
      })),
    ]
      .sort((a, b) => b.time.localeCompare(a.time))
      .slice(0, 8);
  }
  async products(campusId: string, statuses?: string[]) {
    const xs = await this.db.product.findMany({
      where: { campusId },
      orderBy: { sales: 'desc' },
    });
    // IKAJSO「上游已更新」角标：官方库 updatedAt 晚于本校区同步时间即标记
    const sourceIds = xs
      .map((x) => x.sourceProductId)
      .filter((id): id is string => !!id);
    const upstream = sourceIds.length
      ? await this.db.product.findMany({
          where: { id: { in: sourceIds }, campusId: OFFICIAL_CAMPUS_ID },
          select: { id: true, updatedAt: true },
        })
      : [];
    const upstreamAt = new Map(upstream.map((u) => [u.id, u.updatedAt.getTime()]));
    const isOfficial = campusId === OFFICIAL_CAMPUS_ID;
    const rows = xs.map((x) => ({
      ...x,
      price: this.num(x.price),
      originalPrice: this.num(x.originalPrice),
      // IKC1AC：价格三层输出（校区端展示批发价快照；进货价由前端按角色显隐）
      costPrice: this.num(x.costPrice),
      wholesalePrice: this.num(x.wholesalePrice),
      weight: this.num(x.weight),
      skuNo: `SKU-${x.id.toUpperCase()}`,
      // 官方库不记库存（IKAJSM）：库存归校区，不参与售罄映射
      actualStock: x.stock + x.lockedStock,
      availableStock: x.stock,
      status: isOfficial || x.stock ? x.status : 'sold-out',
      upstreamChanged: !!(
        x.sourceProductId &&
        x.sourceSyncedAt &&
        (upstreamAt.get(x.sourceProductId) ?? 0) > x.sourceSyncedAt.getTime()
      ),
    }));
    // IKB3K9：状态 Tab 服务端过滤（口径含售罄映射，直接滤映射后状态）
    return statuses?.length
      ? rows.filter((x) => statuses.includes(x.status))
      : rows;
  }
  /** 商品状态计数（IKB3K9 Tab 角标）：口径同列表（售罄=在售但库存 0）。 */
  async productStatusCounts(campusId: string) {
    const rows = await this.products(campusId);
    return rows.reduce<Record<string, number>>((acc, x) => {
      acc[x.status] = (acc[x.status] ?? 0) + 1;
      return acc;
    }, {});
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
      data: {
        name: body.name,
        sort: body.sort ?? 0,
        image: body.image ?? '',
        hidden: body.hidden ?? false,
      },
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
      // Prisma 惯例：undefined 字段跳过更新（hidden 为类目可见性开关 IKC9M4）
      data: {
        name: body.name,
        sort: body.sort,
        image: body.image,
        hidden: body.hidden,
      },
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
  /** Banner 列表（IKAJSL）：campusId 空 = 总部视角查全部并附 campusName。
   *  IKB5PB：placement 可选过滤（支付广告位独立菜单只看 pay-success）。 */
  async banners(campusId: string, placement?: string, status?: string) {
    const xs = await this.db.banner.findMany({
      where: {
        ...(campusId ? { campusId } : {}),
        ...(placement ? { placement } : {}),
        ...(status ? { status } : {}),
      },
      orderBy: [{ sort: 'asc' }, { id: 'asc' }],
    });
    if (campusId) return xs;
    const campuses = await this.db.campus.findMany({
      where: { status: { not: 'official' } },
      select: { id: true, name: true, shortName: true },
    });
    const nameById = new Map(
      campuses.map((c) => [c.id, c.shortName || c.name]),
    );
    return xs.map((x) => ({
      ...x,
      campusName: x.campusId ? nameById.get(x.campusId) ?? '' : '全部校区',
    }));
  }
  async createBanner(
    body: CreateBannerDto,
    operator: string,
    campusId: string,
  ) {
    // IKAJSL→IKBW0A：Banner 校区自管——投放范围固定为操作者本校区（多校区
    // 账号经切换校区换 token），不再接受 body.campusId 指定投放面；
    // hq 投放通道已随权限矩阵移除。
    if (!campusId) throw new BadRequestException('仅校区账号可创建 Banner');
    const campus = await this.db.campus.findUnique({ where: { id: campusId } });
    if (!campus || campus.status === 'official')
      throw new BadRequestException('投放校区不存在');
    const banner = await this.db.banner.create({
      data: {
        campusId,
        title: body.title,
        subtitle: body.subtitle ?? '',
        badge: body.badge ?? '',
        color: body.color,
        image: body.image || null,
        // IK9SNN：图文详情，空 = 不可点；IKC1AD：详情长图为主口径
        content: body.content || null,
        detailImage: body.detailImage || null,
        // IKA57F：展示位置，缺省首页轮播
        placement: body.placement ?? 'home',
        sort: body.sort ?? 0,
      },
    });
    await this.audit(
      operator,
      'banner.create',
      'banner',
      banner.id,
      null,
      { title: banner.title, sort: banner.sort, campusId },
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
    // hq（campusId 空）不受校区范围限制；校区视角仍限定本校区
    const found = campusId
      ? await this.db.banner.findFirst({ where: { id, campusId } })
      : await this.db.banner.findUnique({ where: { id } });
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
        // IK9SNN：undefined 跳过；空串语义清空（存 null）。
        // IKC1AD：detailImage 与 image 同款——undefined 跳过，空串清空
        content: body.content === undefined ? undefined : body.content || null,
        detailImage:
          body.detailImage === undefined ? undefined : body.detailImage || null,
        // IKA57F：undefined 跳过
        placement: body.placement,
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
    const found = campusId
      ? await this.db.banner.findFirst({ where: { id, campusId } })
      : await this.db.banner.findUnique({ where: { id } });
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
  /** 促销活动管理（ADR-0006 / IKAHFF）：无 campusId，校园维度经 product 过滤；
   *  无删除（留审计），已结束不可改。 */
  /** IKB5PA：state 过滤（live/upcoming/ended/disabled，按时间窗读时判定），
   *  不传 = 全部。口径与前台 promoState 一致。 */
  async promotions(campusId: string, state?: string) {
    const xs = await this.db.promotion.findMany({
      where: { product: { campusId } },
      orderBy: { createdAt: 'desc' },
      include: {
        product: {
          select: { id: true, name: true, image: true, price: true, status: true },
        },
      },
    });
    if (!state) return xs;
    const now = Date.now();
    return xs.filter((x) => {
      if (x.status === 'disabled') return state === 'disabled';
      if (new Date(x.startsAt).getTime() > now) return state === 'upcoming';
      if (new Date(x.endsAt).getTime() <= now) return state === 'ended';
      return state === 'live';
    });
  }
  /** 同商品同期唯一（ADR-0006）：active 且窗口相交即拒（运行时兜底取 endsAt 最近）。 */
  private async assertPromotionWindowFree(
    productId: string,
    startsAt: Date,
    endsAt: Date,
    selfId?: string,
  ) {
    const clash = await this.db.promotion.findFirst({
      where: {
        productId,
        status: 'active',
        ...(selfId ? { id: { not: selfId } } : {}),
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
      },
    });
    if (clash)
      throw new BadRequestException(
        '该商品已有时间窗重叠的生效活动，同商品同期仅允许一个',
      );
  }
  async createPromotion(
    body: CreatePromotionDto,
    operator: string,
    campusId: string,
  ) {
    const product = await this.db.product.findFirst({
      where: { id: body.productId, campusId },
    });
    if (!product || product.status !== 'on-sale')
      throw new BadRequestException('商品不存在或未上架');
    const startsAt = new Date(body.startsAt);
    const endsAt = new Date(body.endsAt);
    if (!(endsAt > startsAt))
      throw new BadRequestException('结束时间必须晚于开始时间');
    if (endsAt.getTime() <= Date.now())
      throw new BadRequestException('结束时间必须晚于当前时间');
    if (body.price >= product.price)
      throw new BadRequestException('促销价必须低于商品现价');
    await this.assertPromotionWindowFree(body.productId, startsAt, endsAt);
    const promo = await this.db.promotion.create({
      data: {
        productId: body.productId,
        type: body.type,
        price: body.price,
        startsAt,
        endsAt,
      },
    });
    await this.audit(
      operator,
      'promotion.create',
      'promotion',
      promo.id,
      null,
      { product: product.name, type: promo.type, price: promo.price },
      campusId,
    );
    return promo;
  }
  async updatePromotion(
    id: string,
    body: UpdatePromotionDto,
    operator: string,
    campusId: string,
  ) {
    const found = await this.db.promotion.findFirst({
      where: { id, product: { campusId } },
      include: { product: true },
    });
    if (!found) throw new NotFoundException('活动不存在');
    if (found.endsAt.getTime() <= Date.now())
      throw new BadRequestException('已结束的活动不可修改');
    const startsAt = body.startsAt ? new Date(body.startsAt) : found.startsAt;
    const endsAt = body.endsAt ? new Date(body.endsAt) : found.endsAt;
    if (body.startsAt || body.endsAt) {
      if (!(endsAt > startsAt))
        throw new BadRequestException('结束时间必须晚于开始时间');
      // 改窗后必须仍未结束
      if (endsAt.getTime() <= Date.now())
        throw new BadRequestException('结束时间必须晚于当前时间');
    }
    const price = body.price ?? found.price;
    if (body.price !== undefined && price >= found.product.price)
      throw new BadRequestException('促销价必须低于商品现价');
    // 重新启用或改窗都需保证窗口独占
    if (body.status === 'active' || body.startsAt || body.endsAt)
      await this.assertPromotionWindowFree(
        found.productId,
        startsAt,
        endsAt,
        id,
      );
    const promo = await this.db.promotion.update({
      where: { id },
      data: {
        price: body.price,
        startsAt: body.startsAt ? startsAt : undefined,
        endsAt: body.endsAt ? endsAt : undefined,
        status: body.status,
      },
    });
    await this.audit(
      operator,
      'promotion.update',
      'promotion',
      id,
      { price: found.price, status: found.status },
      { price: promo.price, status: promo.status },
      campusId,
    );
    return promo;
  }
  async lookupBarcode(barcode: string, campusId: string) {
    // 条码唯一改校区维度（IKAJSM）：本校区库内命中优先
    const product = await this.db.product.findFirst({
      where: { barcode, campusId },
    });
    if (product)
      return {
        found: true,
        source: 'product-database',
        product: {
          // IKC1AC：进货价不下发校区端（扫码回填场景同样剔除）
          ...product,
          costPrice: undefined,
          price: this.num(product.price),
          originalPrice: this.num(product.originalPrice),
          weight: this.num(product.weight),
        },
      };
    // IKAJSO：本校区未录入时先查官方库——命中即可一键导入，不再走人工建档。
    // IKC1AB：与导入候选池同口径，仅命中总部放行（on-sale）的商品
    if (campusId !== OFFICIAL_CAMPUS_ID) {
      const official = await this.db.product.findFirst({
        where: {
          barcode,
          campusId: OFFICIAL_CAMPUS_ID,
          status: 'on-sale',
        },
      });
      if (official)
        return {
          found: true,
          source: 'official-library',
          product: {
            ...official,
            price: this.num(official.price),
            originalPrice: this.num(official.originalPrice),
            weight: this.num(official.weight),
          },
        };
    }
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
    // 条码唯一改校区维度（IKAJSM）：同校区内去重，官方库/他校区可同码
    const duplicate = await this.db.product.findFirst({
      where: { barcode: body.barcode, campusId },
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
        // IKC1AB：官方库商品默认「不可售」，总部核对后手动放行（校区导入
        // 候选池只见可售）；校区自建商品仍默认在售
        status: campusId === OFFICIAL_CAMPUS_ID ? 'off-sale' : 'on-sale',
        // IKC1AC：进货价/批发价格仅官方库行维护；批发价缺省取 price
        ...(campusId === OFFICIAL_CAMPUS_ID
          ? {
              costPrice: body.costPrice ?? 0,
              wholesalePrice: body.wholesalePrice ?? body.price,
            }
          : {}),
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
    // 资料可编辑（IKAHAT）：空白名拒绝；换分类校验目标存在（Category 为全局字典）
    if (body.name !== undefined && !body.name.trim())
      throw new BadRequestException('商品名称不能为空');
    if (body.name !== undefined) body.name = body.name.trim();
    if (body.categoryId !== undefined && body.categoryId !== before.categoryId) {
      const category = await this.db.category.findUnique({
        where: { id: body.categoryId },
      });
      if (!category) throw new BadRequestException('分类不存在');
    }
    // IKC1AC：进货价/批发价格仅官方库行可改（校区视角不可见也不可写）
    const data: UpdateProductDto = campusId === OFFICIAL_CAMPUS_ID
      ? body
      : { ...body, costPrice: undefined, wholesalePrice: undefined };
    const after = await this.db.product.update({ where: { id }, data });
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
  /** 批量放行/回收（IKCKX4）：作用域=campusId（官方库视角只动官方行，
   *  本校区视角只动本校区行）；越界 id 由 updateMany 天然忽略，返回实际更新数。 */
  async batchUpdateProductStatus(
    ids: string[],
    status: 'on-sale' | 'off-sale',
    operator: string,
    campusId: string,
  ) {
    if (!ids.length) return { count: 0 };
    const result = await this.db.product.updateMany({
      where: { id: { in: ids }, campusId },
      data: { status },
    });
    await this.audit(
      operator,
      'product.batch-status',
      'product',
      `batch:${ids.length}`,
      { ids, campusId },
      { status, count: result.count },
      campusId,
    );
    return { count: result.count };
  }
  /**
   * 校区从官方库导入商品（IKAJSO 道哥决策版）：复制官方资料落本校区，
   * 本地售价（price）/上下架（status）/库存（stock）自管——导入初始下架 +
   * 零库存，校区定价备货后自行上架。幂等：同 sourceProductId 已导入跳过；
   * 条码撞本校区自建商品跳过（@@unique[campusId,barcode]）。
   */
  async importProducts(
    productIds: string[],
    operator: string,
    campusId: string,
  ) {
    const officials = await this.db.product.findMany({
      // IKC1AB：仅总部放行（on-sale）的商品可导入——候选池与导入双保险
      where: {
        id: { in: productIds },
        campusId: OFFICIAL_CAMPUS_ID,
        status: 'on-sale',
      },
    });
    const officialById = new Map(officials.map((o) => [o.id, o]));
    const existing = await this.db.product.findMany({
      where: { campusId },
      select: { sourceProductId: true, barcode: true },
    });
    const importedSources = new Set(
      existing.map((x) => x.sourceProductId).filter(Boolean),
    );
    const campusBarcodes = new Set(existing.map((x) => x.barcode).filter(Boolean));
    const imported: string[] = [];
    const skipped: { id: string; name: string; reason: string }[] = [];
    for (const id of productIds) {
      const official = officialById.get(id);
      if (!official) {
        skipped.push({ id, name: id, reason: '官方库中不存在该商品' });
        continue;
      }
      if (importedSources.has(official.id)) {
        skipped.push({ id, name: official.name, reason: '已导入过，无需重复导入' });
        continue;
      }
      if (official.barcode && campusBarcodes.has(official.barcode)) {
        skipped.push({
          id,
          name: official.name,
          reason: `条码 ${official.barcode} 与本校区现有商品冲突`,
        });
        continue;
      }
      const created = await this.db.product.create({
        data: {
          campusId,
          barcode: official.barcode,
          name: official.name,
          subtitle: official.subtitle,
          categoryId: official.categoryId,
          // 售价/划线价取官方价起步，校区可改；库存归校区，导入为 0
          price: official.price,
          originalPrice: official.originalPrice,
          // IKC1AC：批发价/进货价快照随导入落校区行（校区端展示批发价，
          // 进货价仅数据留档、校区出口剔除）
          costPrice: official.costPrice,
          wholesalePrice: official.price,
          stock: 0,
          tag: official.tag,
          image: official.image,
          images: (official.images as Prisma.InputJsonValue) ?? undefined,
          description: official.description,
          weight: official.weight,
          sales: 0,
          status: 'off-sale',
          sourceProductId: official.id,
          sourceSyncedAt: official.updatedAt,
        },
      });
      importedSources.add(official.id);
      if (official.barcode) campusBarcodes.add(official.barcode);
      imported.push(created.id);
      await this.audit(
        operator,
        'product.import',
        'product',
        created.id,
        null,
        {
          name: created.name,
          sourceProductId: official.id,
          officialName: official.name,
        },
        campusId,
      );
    }
    return {
      importedCount: imported.length,
      importedProductIds: imported,
      skipped,
    };
  }
  /**
   * 一键拉取官方库最新资料（IKAJSO）：只同步资料字段（名称/副题/划线价/
   * 标签/重量/图片/介绍/分类），不动本校区售价、上下架状态与库存；
   * 拉完记 sourceSyncedAt，「上游已更新」角标清零。
   */
  async pullUpstream(id: string, operator: string, campusId: string) {
    const local = await this.db.product.findFirst({
      where: { id, campusId },
    });
    if (!local) throw new NotFoundException('商品不存在');
    if (!local.sourceProductId)
      throw new BadRequestException('自建商品无官方库来源，无需拉取');
    const official = await this.db.product.findFirst({
      where: { id: local.sourceProductId, campusId: OFFICIAL_CAMPUS_ID },
    });
    if (!official)
      throw new BadRequestException('官方库中该商品已被删除，无法拉取');
    const after = await this.db.product.update({
      where: { id },
      data: {
        name: official.name,
        subtitle: official.subtitle,
        originalPrice: official.originalPrice,
        // IKC1AC：总部改价（批发价/进货价）随拉取同步到校区行
        wholesalePrice: official.price,
        costPrice: official.costPrice,
        tag: official.tag,
        image: official.image,
        images: (official.images as Prisma.InputJsonValue) ?? undefined,
        description: official.description,
        categoryId: official.categoryId,
        weight: official.weight,
        sourceSyncedAt: official.updatedAt,
      },
    });
    await this.audit(
      operator,
      'product.pull-upstream',
      'product',
      id,
      { name: local.name, sourceSyncedAt: local.sourceSyncedAt },
      { name: after.name, sourceSyncedAt: after.sourceSyncedAt },
      campusId,
    );
    return after;
  }
  async inventory(campusId: string) {
    // IKA0VB 去批次：合成批次号/有效期已移除（零食饮料初期不做效期批次管理）。
    const [items, campus] = await Promise.all([
      this.products(campusId),
      this.db.campus.findFirstOrThrow({ where: { id: campusId } }),
    ]);
    return items.map((x) => ({
      ...x,
      warehouse: campus.warehouseName,
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
  /**
   * 订单列表（IKAJSP）：status 支持逗号分隔多状态——运营 Tab 是原始状态的
   * 分组（如「配送中」= waiting-first-mile,first-mile,last-mile），单值兼容旧下拉。
   * IKAJSL：campusId 空 = 总部跨校区视角（附 campusName 列）。
   */
  async orders(status: string | undefined, campusId: string) {
    const statuses =
      status && status !== 'all'
        ? status.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
    const xs = await this.db.order.findMany({
      where: {
        ...(campusId ? { campusId } : {}),
        ...(statuses.length ? { status: { in: statuses } } : {}),
      },
      include: {
        user: { select: { id: true, nickname: true, phone: true } },
        // warehouseName：小票票头（IKBT6N）
        campus: { select: { name: true, shortName: true, warehouseName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    // IKB5P5：items 快照不含库位，按 productId 回查实时库位（拣货看当前库位，
    // 商品调位后历史单也指向新位置）；查不到（官方库下架）回落空。
    const productIds = [
      ...new Set(
        xs.flatMap((x) =>
          ((x.items as any as Array<{ product?: { id?: string } }>) ?? [])
            .map((line) => line?.product?.id)
            .filter((id): id is string => !!id),
        ),
      ),
    ];
    const locationRows = productIds.length
      ? await this.db.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, location: true, locationCode: true },
        })
      : [];
    const locationById = new Map(locationRows.map((p) => [p.id, p]));
    return xs.map((x) => ({
      ...x,
      items: (((x.items as any as Array<{ product?: object }>) ?? []).map(
        (line) => {
          const live = line?.product
            ? locationById.get((line.product as { id?: string }).id ?? '')
            : undefined;
          return {
            ...line,
            product: {
              ...line.product,
              ...(live
                ? { location: live.location, locationCode: live.locationCode }
                : {}),
            },
          };
        },
      ) as unknown as Prisma.InputJsonValue),
      productAmount: this.num(x.productAmount),
      deliveryFee: this.num(x.deliveryFee),
      discount: this.num(x.discount),
      payableAmount: this.num(x.payableAmount),
      // IKAJSL：跨校区列表需要校区列（单校区视角冗余无害）
      campusName: x.campus?.shortName || x.campus?.name || '',
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
  /** 订单状态计数（IKAJSP）：一次 groupBy 拉全量状态分布，Tab 角标用；先不做缓存，量级到了再说。
   *  IKAJSL：campusId 空 = 全校区合计。 */
  async orderStatusCounts(campusId: string) {
    const groups = await this.db.order.groupBy({
      by: ['status'],
      where: campusId ? { campusId } : {},
      _count: { _all: true },
    });
    return Object.fromEntries(groups.map((g) => [g.status, g._count._all]));
  }
  async order(id: string, campusId: string) {
    const x = await this.db.order.findFirst({
      where: { id, ...(campusId ? { campusId } : {}) },
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
    // 仓库出库（IKA0UQ）：paid/picking 一步转待配送 + 出库流水，仓储角色可用。
    else if (action === 'outbound')
      result = await this.business.outbound(id, operator);
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
  /**
   * 补打小票（IKBT6N）：芯烨云重推订单小票（出库时已自动打，本端点兜底
   * 缺纸/卡纸重打场景）。校区隔离复用 this.order；写审计日志留痕。
   */
  async reprintReceipt(id: string, operator: string, campusId: string) {
    if (!this.printer?.accountConfigured)
      throw new BadRequestException(
        '打印机未配置，请联系平台管理员配置芯烨云凭证',
      );
    const order = (await this.order(id, campusId)) as Record<string, any>;
    // IKBW0Q：校区绑定打印机优先，未绑定回落 env 试点单机
    const sn = await this.resolvePrinterSn(order.campusId);
    if (!sn)
      throw new BadRequestException('本校区尚未绑定打印机，请先在「打印机」页绑定');
    const campus = await this.db.campus.findUnique({
      where: { id: order.campusId },
      select: { warehouseName: true },
    });
    await this.printer.printOrderReceipt(
      {
      id: order.id,
      orderNo: order.orderNo,
      campusId: order.campusId,
      warehouseName: campus?.warehouseName ?? '',
      deliveryMode: order.deliveryMode,
      deliverySlot: order.deliverySlot,
      estimatedArrival: order.estimatedArrival,
      remark: order.remark,
      createdAt: order.createdAt,
      address: order.address,
      items: order.items,
      productAmount: Number(order.productAmount),
      deliveryFee: Number(order.deliveryFee),
      discount: Number(order.discount),
      payableAmount: Number(order.payableAmount),
      },
      sn,
    );
    await this.audit(
      operator,
      'order.print-receipt',
      'order',
      id,
      null,
      { orderNo: order.orderNo },
      campusId,
    );
    return { printed: true, orderNo: order.orderNo };
  }
  /* ---------- 校区打印机绑定（IKBW0Q） ---------- */
  /** 校区绑定打印机终端号：active 记录优先，未绑定返回 null（调用方回落 env）。 */
  private async resolvePrinterSn(campusId: string): Promise<string | null> {
    const bound = await this.db.printer.findUnique({ where: { campusId } });
    return bound && bound.status === 'active' ? bound.sn : null;
  }
  // IKC1AF 口径：打印机与校区为一对一（一校区一台，campusId 唯一约束），
  // 后台按「编辑页」形态管理；一台多机需求出现时再扩 Printer.campusId 唯一约束。
  async printers(campusId: string) {
    const rows = await this.db.printer.findMany({
      where: { campusId },
      orderBy: { createdAt: 'desc' },
      // IKC1AF：带出归属校区（列表/编辑页展示）
      include: { campus: { select: { name: true, shortName: true } } },
    });
    return rows.map((r) => ({
      ...r,
      campusName: r.campus?.shortName || r.campus?.name || '',
    }));
  }
  /** 绑定/换绑（IKBW0Q）：先在芯烨云侧把终端加进开发者账号（幂等），成功后
   *  upsert 本校区记录（一校区一台，换绑覆盖原记录）。 */
  async bindPrinter(
    body: BindPrinterDto,
    operator: string,
    campusId: string,
  ) {
    if (!campusId)
      throw new BadRequestException('仅校区账号可绑定打印机');
    if (!this.printer)
      throw new BadRequestException('打印服务未启用');
    // IKC3FF：芯烨云无按台密钥，绑定只凭 SN（归属校验在云端）
    await this.printer.addPrinter(body.sn, body.name);
    let row;
    try {
      row = await this.db.printer.upsert({
        where: { campusId },
        create: { campusId, name: body.name, sn: body.sn, key: '' },
        update: { name: body.name, sn: body.sn, key: '', status: 'active' },
      });
    } catch (error) {
      // sn 全局唯一：被其他校区占用时给可读提示
      if (String(error).includes('Unique'))
        throw new BadRequestException('该打印机已被其他校区绑定');
      throw error;
    }
    await this.audit(
      operator,
      'printer.bind',
      'printer',
      row.id,
      null,
      { name: row.name, sn: row.sn },
      campusId,
    );
    return row;
  }
  async unbindPrinter(id: string, operator: string, campusId: string) {
    const row = await this.db.printer.findFirst({ where: { id, campusId } });
    if (!row) throw new NotFoundException('打印机不存在');
    await this.db.printer.delete({ where: { id: row.id } });
    // 仅删本地绑定记录；芯烨云账号侧的终端绑定保留（无害，重绑幂等）
    await this.audit(
      operator,
      'printer.unbind',
      'printer',
      id,
      { name: row.name, sn: row.sn },
      null,
      campusId,
    );
    return row;
  }
  /** 测试打印（IKBW0Q）：绑定后连通性验证；云端失败原样透传给后台提示。 */
  async testPrintPrinter(id: string, operator: string, campusId: string) {
    const row = await this.db.printer.findFirst({ where: { id, campusId } });
    if (!row) throw new NotFoundException('打印机不存在');
    if (!this.printer)
      throw new BadRequestException('打印服务未启用');
    try {
      await this.printer.printTest(row.sn);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : '测试打印失败',
      );
    }
    await this.audit(
      operator,
      'printer.test-print',
      'printer',
      id,
      null,
      { sn: row.sn },
      campusId,
    );
    return { printed: true, sn: row.sn };
  }
  /**
   * 手动改订单状态（IKA0UT）：测试与上线初期兜底。仅接受 12 态白名单，
   * statusText 用标准文案，原因写入审计日志（after.reason）留痕。
   */
  async updateOrderStatus(
    id: string,
    body: UpdateOrderStatusDto,
    operator: string,
    campusId: string,
  ) {
    const before = await this.order(id, campusId);
    if (!ORDER_STATUSES.includes(body.status as OrderStatus))
      throw new BadRequestException(`未知订单状态：${body.status}`);
    if (before.status === body.status) return before;
    const after = await this.db.order.update({
      where: { id },
      data: {
        status: body.status,
        statusText: ORDER_STATUS_TEXT[body.status as OrderStatus],
        timeline: markTimelineStep(before.timeline, body.status),
      },
    });
    await this.audit(
      operator,
      'order.manual-status',
      'order',
      id,
      { status: before.status, statusText: before.statusText },
      { status: after.status, reason: body.reason ?? '' },
      campusId,
    );
    return after;
  }
  /* ---------- 库位管理（IKA0VG）：库位字典 CRUD，商品表单下拉消费 ---------- */
  async locations(campusId: string) {
    return this.db.storageLocation.findMany({
      where: { campusId },
      orderBy: [{ sort: 'asc' }, { createdAt: 'asc' }],
    });
  }
  async createLocation(
    body: CreateLocationDto,
    operator: string,
    campusId: string,
  ) {
    const after = await this.db.storageLocation.create({
      data: {
        campusId,
        name: body.name.trim(),
        note: body.note?.trim() ?? '',
        sort: body.sort ?? 0,
      },
    });
    await this.audit(operator, 'location.create', 'location', after.id, null, after, campusId);
    return after;
  }
  async updateLocation(
    id: string,
    body: UpdateLocationDto,
    operator: string,
    campusId: string,
  ) {
    const before = await this.db.storageLocation.findFirst({
      where: { id, campusId },
    });
    if (!before) throw new NotFoundException('库位不存在');
    const after = await this.db.storageLocation.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name.trim() } : {}),
        ...(body.note !== undefined ? { note: body.note.trim() } : {}),
        ...(body.sort !== undefined ? { sort: body.sort } : {}),
      },
    });
    await this.audit(operator, 'location.update', 'location', id, before, after, campusId);
    return after;
  }
  async deleteLocation(id: string, operator: string, campusId: string) {
    const before = await this.db.storageLocation.findFirst({
      where: { id, campusId },
    });
    if (!before) throw new NotFoundException('库位不存在');
    // 商品仍引用该库位时拒绝删除，避免商品表单下拉出现空引用。
    const using = await this.db.product.count({
      where: { campusId, location: before.name },
    });
    if (using > 0)
      throw new BadRequestException(
        `仍有 ${using} 个商品使用该库位，请先调整商品的库位`,
      );
    await this.db.storageLocation.delete({ where: { id } });
    await this.audit(operator, 'location.delete', 'location', id, before, null, campusId);
  }
  /** IKB5PA：status 过滤（online/paused/offline），不传 = 全部在职口径（除 deleted）。 */
  async staff(campusId: string, status?: string) {
    const xs = await this.db.staff.findMany({
      where: {
        campusId,
        ...(status ? { status } : { status: { not: 'deleted' } }),
      },
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
        // IKBW0E：楼长允许显式解绑（清空绑定进「待分配」态，见下方 buildingId null
        // 分支）；绑有楼栋时才校验一楼一在职楼长，编辑改名等操作不受历史数据阻塞
        if (
          nextBuildingId &&
          (nextBuildingId !== before.buildingId ||
            nextRole !== before.role)
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
        // IKBW0E：快照列与 roleText 必须同步置「待分配」——此前只 disconnect 外键，
        // building 残留旧楼名，列表/履约端看起来像「没解除」
        data.building = '待分配';
        buildingName = '待分配';
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
  /** IKB5PA：status 过滤（pending/cancelled），不传 = 全部。 */
  async afterSales(campusId: string, status?: string) {
    return this.db.afterSale.findMany({
      where: { order: { campusId }, ...(status ? { status } : {}) },
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
  /** IKB5PA：status 过滤（pending-review/confirmed/paid），不传 = 全部。 */
  async settlements(campusId: string, month?: string, status?: string) {
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
      where: { campusId, period, ...(status ? { status } : {}) },
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
    // status=official 是官方商品库伪校区（IKAJSM），不出现在校区列表
    const xs = await this.db.campus.findMany({
      where: { status: { not: 'official' } },
      orderBy: { createdAt: 'asc' },
    });
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
  /** 校区本体新增（IKAJSL）：新校区接入入口，仅总部长（controller 守卫）。 */
  async createCampus(body: CreateCampusDto, operator: string) {
    const campus = await this.db.campus.create({
      data: {
        name: body.name,
        shortName: body.shortName,
        warehouseName: body.warehouseName,
        address: body.address ?? '',
        ...(body.deliveryFeeInstant != null
          ? { deliveryFeeInstant: body.deliveryFeeInstant }
          : {}),
        ...(body.deliveryFeeScheduled != null
          ? { deliveryFeeScheduled: body.deliveryFeeScheduled }
          : {}),
        ...(body.deliveryThreshold != null
          ? { deliveryThreshold: body.deliveryThreshold }
          : {}),
      },
    });
    await this.audit(
      operator,
      'campus.create',
      'campus',
      campus.id,
      null,
      { name: campus.name, shortName: campus.shortName },
      campus.id,
    );
    return campus;
  }
  /** 校区信息修改（IKAJSL）：仅总部长；官方库伪校区不可改。 */
  async updateCampus(
    id: string,
    body: UpdateCampusDto,
    operator: string,
  ) {
    const before = await this.db.campus.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('校区不存在');
    if (before.status === 'official')
      throw new BadRequestException('官方商品库校区不可修改');
    const after = await this.db.campus.update({
      where: { id },
      data: {
        ...(body.name != null ? { name: body.name } : {}),
        ...(body.shortName != null ? { shortName: body.shortName } : {}),
        ...(body.warehouseName != null
          ? { warehouseName: body.warehouseName }
          : {}),
        ...(body.address != null ? { address: body.address } : {}),
        ...(body.status ? { status: body.status } : {}),
        ...(body.deliveryFeeInstant != null
          ? { deliveryFeeInstant: body.deliveryFeeInstant }
          : {}),
        ...(body.deliveryFeeScheduled != null
          ? { deliveryFeeScheduled: body.deliveryFeeScheduled }
          : {}),
        ...(body.deliveryThreshold != null
          ? { deliveryThreshold: body.deliveryThreshold }
          : {}),
      },
    });
    await this.audit(
      operator,
      'campus.update',
      'campus',
      id,
      { name: before.name, status: before.status },
      { name: after.name, status: after.status },
      id,
    );
    return after;
  }
  /** 请假列表（IK8W5Y）：含请假人角色与所属楼栋（楼长调配决策依据）。
   *  IKB5PA：status 过滤（pending/approved/rejected/cancelled），不传 = 全部。 */
  async leaveRequests(campusId: string, status?: string) {
    const xs = await this.db.leaveRequest.findMany({
      where: { staff: { campusId }, ...(status ? { status } : {}) },
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
  /** 调配邀请列表（IK8W5Y）：含目标楼长信息。
   *  IKB5PA：status 过滤（invited/accepted/rejected/cancelled），不传 = 全部。 */
  async dispatchInvitations(campusId: string, status?: string) {
    const xs = await this.db.dispatchInvitation.findMany({
      where: { staff: { campusId }, ...(status ? { status } : {}) },
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
  /** IKB5PA：status 过滤（active/paused），不传 = 全部。 */
  async coupons(campusId: string, status?: string) {
    const xs = await this.db.coupon.findMany({
      where: { campusId, ...(status ? { status } : {}) },
    });
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
  /** 审计日志：IKAJSL campusId 空 = 总部跨校区视角。 */
  /** IKB5P8：审计列表同样人话化——附操作人昵称/中文动作/中文对象，原始代码只留 entityId 备查。 */
  async auditLogs(campusId: string) {
    const rows = await this.db.auditLog.findMany({
      where: campusId ? { campusId } : {},
      orderBy: { createdAt: 'desc' },
    });
    const names = await this.operatorNames(rows.map((x) => x.operator));
    return rows.map((x) => ({
      ...x,
      operatorName: names.get(x.operator) ?? '系统',
      actionText: AdminService.AUDIT_ACTION_TEXTS[x.action] ?? '后台操作',
      entityText: AdminService.AUDIT_ENTITY_TEXTS[x.entityType] ?? '后台数据',
    }));
  }

  /* ---------- 后台账号管理（IK9KWO）：admin 管本校区职能账号，hq 管全部（IKAJSL） ---------- */
  /** 列表不回 passwordHash；campusId 传空 = hq 查全部并附 campusName。 */
  async accounts(campusId?: string) {
    const xs = await this.db.adminAccount.findMany({
      where: campusId ? { campusId } : {},
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
    // IKB3KG：附带可运营校区全集（账号管理多选回显）
    const accesses = await this.db.adminCampusAccess.findMany({
      where: { accountId: { in: xs.map((x) => x.id) } },
      select: { accountId: true, campusId: true },
    });
    const scopeByAccount = new Map<string, string[]>();
    for (const a of accesses) {
      scopeByAccount.set(a.accountId, [
        ...(scopeByAccount.get(a.accountId) ?? []),
        a.campusId,
      ]);
    }
    const withScope = xs.map((x) => ({
      ...x,
      campusIds: x.campusId ? scopeByAccount.get(x.id) ?? [x.campusId] : [],
    }));
    if (campusId) return withScope;
    const campuses = await this.db.campus.findMany({
      select: { id: true, name: true, shortName: true },
    });
    const nameById = new Map(
      campuses.map((c) => [c.id, c.shortName || c.name]),
    );
    // IKB5PC：hq 视角附全量可运营校区名（多校区账号逐个列出），campusName 保留当前校区口径
    return withScope.map((x) => ({
      ...x,
      campusName: x.campusId ? nameById.get(x.campusId) ?? '' : '总部',
      campusNames: x.campusIds
        .map((id) => nameById.get(id) ?? '')
        .filter(Boolean),
    }));
  }
  async createAccount(
    body: CreateAccountDto,
    operator: string,
    operatorCampusId: string,
    operatorRole: string,
  ) {
    const duplicate = await this.db.adminAccount.findUnique({
      where: { username: body.username },
    });
    if (duplicate) throw new BadRequestException('用户名已存在');
    // IKBFJ4（2026-08-27）：平台超管 admin 与 hq 同权管账号——建任意角色/跨校区。
    // 校区归属：hq 无本校上下文必须显式选；admin 建 hq 不绑校区、建校区角色缺省落本校。
    const isPlatform = operatorRole === 'hq' || operatorRole === 'admin';
    if (!isPlatform && body.role === 'hq')
      throw new ForbiddenException('仅总部账号可创建总部角色账号');
    const campusId =
      operatorRole === 'hq'
        ? body.campusId ?? ''
        : body.role === 'hq'
          ? ''
          : body.campusId ?? operatorCampusId;
    if (body.role === 'hq' && campusId)
      throw new BadRequestException('总部角色账号不绑定校区');
    if (isPlatform && body.role !== 'hq' && !campusId)
      throw new BadRequestException('请为校区账号选择所属校区');
    if (campusId) {
      const campus = await this.db.campus.findUnique({ where: { id: campusId } });
      if (!campus || campus.status === 'official')
        throw new BadRequestException('所属校区不存在');
    }
    const account = await this.db.adminAccount.create({
      data: {
        username: body.username,
        passwordHash: await hash(body.password, 10),
        nickname: body.nickname ?? '',
        role: body.role,
        campusId,
      },
    });
    // IKB3KG：校区账号落可运营校区授权（缺省=所属校区；须包含所属校区）
    if (account.role !== 'hq' && campusId) {
      const campusIds = [
        ...new Set(
          isPlatform && body.campusIds?.length
            ? [...body.campusIds, campusId]
            : [campusId],
        ),
      ];
      await this.replaceCampusAccess(account.id, campusIds, campusId);
    }
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
    operatorCampusId: string,
    operatorRole: string,
  ) {
    const before = await this.db.adminAccount.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('账号不存在');
    // IKAJSL→IKBFJ4：平台角色（hq/admin）管全部账号；其余视角只能改本校区职能账号
    if (operatorRole !== 'hq' && operatorRole !== 'admin') {
      if (before.role === 'hq' || before.campusId !== operatorCampusId)
        throw new ForbiddenException('只能管理本校区的后台账号');
      if (body.role === 'hq')
        throw new ForbiddenException('仅总部账号可授予总部角色');
    }
    // 保护：最后一个 admin/hq 不可降级/删除（否则权限体系锁死）。
    if (before.role === 'admin' && body.role && body.role !== 'admin')
      await this.assertNotLastAdmin(id);
    if (before.role === 'hq' && body.role && body.role !== 'hq')
      await this.assertNotLastRole(id, 'hq');
    // IKB3KG 方案A：hq 重设可运营校区全集（整体替换授权行）；
    // 若当前登录校区被移出授权，顺带把 campusId 挪到新集合首个校区。
    let campusIdNext = before.campusId;
    const rescope =
      operatorRole === 'hq' &&
      before.role !== 'hq' &&
      before.campusId &&
      body.campusIds;
    if (rescope) {
      campusIdNext = await this.replaceCampusAccess(
        id,
        body.campusIds!,
        before.campusId,
      );
    }
    const after = await this.db.adminAccount.update({
      where: { id },
      data: {
        ...(body.nickname != null ? { nickname: body.nickname } : {}),
        ...(body.role ? { role: body.role } : {}),
        ...(body.password
          ? { passwordHash: await hash(body.password, 10) }
          : {}),
        ...(rescope ? { campusId: campusIdNext } : {}),
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
      operatorCampusId,
    );
    return after;
  }
  /** 整体替换账号的可运营校区授权（IKB3KG 方案A）：
   *  校验校区真实存在（官方库伪校区排除）、至少一个；返回账号应驻留的
   *  campusId（原校区仍在授权内则保持不变，否则挪到集合首个）。 */
  private async replaceCampusAccess(
    accountId: string,
    campusIds: string[],
    currentCampusId: string,
  ): Promise<string> {
    const ids = [...new Set(campusIds.map((x) => x.trim()).filter(Boolean))];
    if (!ids.length)
      throw new BadRequestException('请至少保留一个可运营校区');
    const campuses = await this.db.campus.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true },
    });
    const valid = new Set(
      campuses.filter((c) => c.status !== 'official').map((c) => c.id),
    );
    const unknown = ids.filter((x) => !valid.has(x));
    if (unknown.length)
      throw new BadRequestException('可运营校区中包含无效校区');
    await this.db.$transaction([
      this.db.adminCampusAccess.deleteMany({ where: { accountId } }),
      this.db.adminCampusAccess.createMany({
        data: ids.map((campusId) => ({ accountId, campusId })),
      }),
    ]);
    return ids.includes(currentCampusId) ? currentCampusId : ids[0];
  }
  async deleteAccount(
    id: string,
    operator: string,
    operatorCampusId: string,
    operatorRole: string,
  ) {
    const before = await this.db.adminAccount.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('账号不存在');
    if (id === operator) throw new BadRequestException('不能删除当前登录账号');
    // IKBFJ4：平台角色（hq/admin）可删任意账号；其余视角限本校区职能账号
    if (
      operatorRole !== 'hq' &&
      operatorRole !== 'admin' &&
      (before.role === 'hq' || before.campusId !== operatorCampusId)
    )
      throw new ForbiddenException('只能管理本校区的后台账号');
    if (before.role === 'admin') await this.assertNotLastAdmin(id);
    if (before.role === 'hq') await this.assertNotLastRole(id, 'hq');
    await this.db.adminAccount.delete({ where: { id } });
    await this.audit(
      operator,
      'account.delete',
      'admin-account',
      id,
      { username: before.username, role: before.role },
      null,
      operatorCampusId,
    );
    return { id, deleted: true };
  }
  /* ---------- 微信群二维码（IKAJSY）：楼栋群 + 校级大群，轻量 upsert ---------- */
  /** 群码列表：校级大群排最前，其余按楼栋名；buildingName 供前端直接展示。 */
  async wechatGroups(campusId: string) {
    const [groups, buildings] = await Promise.all([
      this.db.wechatGroup.findMany({
        where: { campusId },
        orderBy: { buildingId: 'asc' },
      }),
      this.db.building.findMany({
        where: { campusId },
        select: { id: true, name: true },
      }),
    ]);
    const nameById = new Map(buildings.map((b) => [b.id, b.name]));
    return groups.map((g) => ({
      ...g,
      // buildingId 空串 = 校级大群
      buildingName: g.buildingId ? nameById.get(g.buildingId) ?? '未知楼栋' : '校级大群',
    }));
  }
  /** 新增/替换群码：每楼栋至多一群 + 每校至多一大群（唯一约束兜底）。 */
  async upsertWechatGroup(
    body: { buildingId?: string; image: string },
    operator: string,
    campusId: string,
  ) {
    if (!body.image) throw new BadRequestException('请上传群二维码图片');
    const buildingId = body.buildingId ?? '';
    if (buildingId) {
      const building = await this.db.building.findFirst({
        where: { id: buildingId, campusId },
      });
      if (!building) throw new BadRequestException('楼栋不存在');
    }
    const group = await this.db.wechatGroup.upsert({
      where: { campusId_buildingId: { campusId, buildingId } },
      create: { campusId, buildingId, image: body.image },
      update: { image: body.image },
    });
    await this.audit(
      operator,
      'wechat-group.upsert',
      'wechat-group',
      group.id,
      null,
      { buildingId, image: body.image },
      campusId,
    );
    return group;
  }
  async deleteWechatGroup(id: string, operator: string, campusId: string) {
    const before = await this.db.wechatGroup.findFirst({
      where: { id, campusId },
    });
    if (!before) throw new NotFoundException('群码不存在');
    await this.db.wechatGroup.delete({ where: { id } });
    await this.audit(
      operator,
      'wechat-group.delete',
      'wechat-group',
      id,
      { buildingId: before.buildingId },
      null,
      campusId,
    );
    return { id, deleted: true };
  }
  /* ---------- C 端用户管理（IKAJSW）：列表 + 订单/消费聚合 + 统计 ---------- */
  /**
   * 用户列表（分页 + 楼栋/注册时间/关键词筛选）。订单数与累计消费按
   * 有效支付单（paidAt 非空）聚合；默认地址取 isDefault，无默认取最新一条。
   */
  async users(
    campusId: string,
    opts: {
      buildingId?: string;
      dateFrom?: string;
      dateTo?: string;
      keyword?: string;
      page: number;
      pageSize: number;
    },
  ) {
    const where: Prisma.UserWhereInput = {
      // IKAJSL：campusId 空 = 总部跨校区视角
      ...(campusId ? { campusId } : {}),
      ...(opts.keyword
        ? {
            OR: [
              { nickname: { contains: opts.keyword } },
              { phone: { contains: opts.keyword } },
              { openid: { contains: opts.keyword } },
            ],
          }
        : {}),
      ...(opts.dateFrom || opts.dateTo
        ? {
            createdAt: {
              ...(opts.dateFrom ? { gte: new Date(opts.dateFrom) } : {}),
              ...(opts.dateTo ? { lte: new Date(`${opts.dateTo}T23:59:59`) } : {}),
            },
          }
        : {}),
      // 楼栋筛选：该楼栋存在地址（含非默认）即命中——搬家用户也能被筛出
      ...(opts.buildingId
        ? { addresses: { some: { buildingId: opts.buildingId } } }
        : {}),
    };
    const [total, pageUsers] = await Promise.all([
      this.db.user.count({ where }),
      this.db.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (opts.page - 1) * opts.pageSize,
        take: opts.pageSize,
      }),
    ]);
    const ids = pageUsers.map((u) => u.id);
    // 订单聚合（本页用户）：有效支付单的笔数与实付金额
    const [orderAgg, addresses] = await Promise.all([
      ids.length
        ? this.db.order.groupBy({
            by: ['userId'],
            where: {
              userId: { in: ids },
              paidAt: { not: null },
              ...(campusId ? { campusId } : {}),
            },
            _count: { _all: true },
            _sum: { payableAmount: true },
          })
        : Promise.resolve([]),
      ids.length
        ? this.db.address.findMany({
            where: { userId: { in: ids } },
            // Address 无 createdAt：默认地址优先，其余取首条（无时间戳可排序）
            orderBy: { isDefault: 'desc' },
          })
        : Promise.resolve([]),
    ]);
    const aggById = new Map(
      orderAgg.map((row) => [
        row.userId,
        {
          orderCount: row._count._all,
          totalSpend: this.num(row._sum.payableAmount ?? 0),
        },
      ]),
    );
    const defaultAddressByUser = new Map<string, (typeof addresses)[number]>();
    for (const addr of addresses)
      if (!defaultAddressByUser.has(addr.userId))
        defaultAddressByUser.set(addr.userId, addr);
    const mask = (value: string) =>
      value && value.length > 6 ? `${value.slice(0, 3)}****${value.slice(-3)}` : value;
    return {
      total,
      items: pageUsers.map((u) => {
        const addr = defaultAddressByUser.get(u.id);
        return {
          id: u.id,
          nickname: u.nickname,
          // 脱敏口径与订单列表一致（管理员看不到完整手机号/openid）
          openidMasked: mask(u.openid ?? ''),
          phoneMasked: this.maskPhone(u.phone),
          buildingName: addr?.buildingName ?? '',
          room: addr?.room ?? '',
          createdAt: u.createdAt.toISOString(),
          ...aggById.get(u.id) ?? { orderCount: 0, totalSpend: 0 },
        };
      }),
    };
  }
  /** 用户统计（IKAJSW）：总量/今日新增/本月活跃/人均订单；企微绑定率字段预留。
   *  IKAJSL：campusId 空 = 全校区合计。 */
  async userStats(campusId: string) {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    // scope 复用四处：campusId 空 = 总部不限定
    const scope = campusId ? { campusId } : {};
    const [total, todayNew, monthActiveUsers, paidAgg] = await Promise.all([
      this.db.user.count({ where: scope }),
      this.db.user.count({
        where: { ...scope, createdAt: { gte: startOfToday } },
      }),
      this.db.order.findMany({
        where: { ...scope, createdAt: { gte: startOfMonth }, paidAt: { not: null } },
        select: { userId: true },
        distinct: ['userId'],
      }),
      this.db.order.aggregate({
        where: { ...scope, paidAt: { not: null } },
        _count: { _all: true },
      }),
    ]);
    return {
      total,
      todayNew,
      monthActive: monthActiveUsers.length,
      // 人均订单：有效支付单总量 / 有过消费的用户数（分母为 0 时记 0）
      avgOrders: total
        ? Number((paidAgg._count._all / total).toFixed(1))
        : 0,
      // 企微绑定率（IKAJSW 预留）：接入企微 API 后供数
      wechatWorkBindRate: null,
    };
  }
  /** 单个用户的订单流水（IKAJSW 详情抽屉）：复用订单列表口径（金额分、手机脱敏）。
   *  IKAJSL：campusId 空 = 总部跨校区视角。 */
  async userOrders(userId: string, campusId: string) {
    const xs = await this.db.order.findMany({
      where: { userId, ...(campusId ? { campusId } : {}) },
      include: { user: { select: { id: true, nickname: true, phone: true } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return xs.map((x) => ({
      id: x.id,
      orderNo: x.orderNo,
      status: x.status,
      statusText: x.statusText,
      payableAmount: this.num(x.payableAmount),
      createdAt: x.createdAt.toISOString(),
    }));
  }
  private async assertNotLastAdmin(id: string) {
    await this.assertNotLastRole(id, 'admin');
  }
  /** 最后一个指定角色账号保护（IKAJSL 扩展到 hq，避免总部权限锁死）。 */
  private async assertNotLastRole(id: string, role: 'admin' | 'hq') {
    const others = await this.db.adminAccount.count({
      where: { role, id: { not: id } },
    });
    if (!others)
      throw new BadRequestException(
        role === 'admin' ? '至少需要保留一个超管账号' : '至少需要保留一个总部账号',
      );
  }
  /** 审计留痕（全局 ~49 处调用）：写入失败只 warn 不抛——业务更新在审计前
   *  已提交，审计故障不应把成功的操作变成 500（IKC1AA「更新报错但实际
   *  已生效」的假报错即此形状）。 */
  private async audit(
    operator: string,
    action: string,
    entityType: string,
    entityId: string,
    before: unknown,
    after: unknown,
    campusId: string,
  ) {
    try {
      await this.db.auditLog.create({
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
    } catch (error) {
      console.warn(
        `[audit] 审计写入失败（不影响业务操作）: ${action} ${entityType}/${entityId}`,
        error instanceof Error ? error.message : error,
      );
    }
  }
}
