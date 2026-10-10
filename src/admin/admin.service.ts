import { RbacService } from './rbac/rbac.service';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { hash } from 'bcryptjs';
import ExcelJS from 'exceljs';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrinterService } from '../printer/printer.service';
import { BusinessService } from '../business/business.service';
import { perRetailUnitCostFen } from '../common/product-units';
import { maskIdCard } from '../common/sensitive';
import { presignCosUrl } from '../files/cos-presign';
import { CommissionService } from '../commission/commission.service';
import { REFUND_STATUS_TEXT } from '../business/business.service';
import { PaymentsService } from '../payments/payments.service';
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
  CreateOrganizationDto,
  CreateProductDto,
  CreatePromotionDto,
  CreateRestockBatchDto,
  CreateOrgProductDto,
  OrganizationBootstrapDto,
  UpdateOrgProductDto,
  UpdateOrganizationDto,
  UpdateRestockBatchDto,
  SaveRestockOrderDto,
  AuditRestockOrderDto,
  CreatePurchaseOrderDto,
  ReceivePurchaseOrderDto,
  ClosePurchaseOrderDto,
  ShipRestockOrderDto,
  UpdateCampusDto,
  UpdatePromotionDto,
  UpdateProductDto,
  CreateRoomDto,
  CreateStaffDto,
  IssueCouponDto,
  StockInDto,
  StocktakeDto,
  UpdateAccountDto,
  UpdateBannerDto,
  UpdateRecruitApplicationDto,
  UpdateBuildingDto,
  UpdateCategoryDto,
  UpdateCommissionRuleDto,
  UpdateCouponDto,
  UpdateDeliveryConfigDto,
  UpdateLocationDto,
  CreateSlotDto,
  UpdateSlotDto,
  CreateNoticeDto,
  UpdateNoticeDto,
  UpdateOrderStatusDto,
  UpdateStaffDto,
} from './dto';
import {
  ORDER_STATUSES,
  ORDER_STATUS_TEXT,
  markTimelineStep,
  type OrderStatus,
} from '../common/order-state';
import { HQ_CAMPUS_ID, OFFICIAL_CAMPUS_ID } from '../common/campus';

/* ==================== 成本 capability 输出裁剪（IKKRMY，2026-10-10） ====================
 * allowCapability(ctx,'cost.read')=false 的账号，商品/订单/报表响应统一剔除
 * 成本与毛利字段（admin 前端 CSV 导出同源列，服务端裁剪=导出同口径）。
 * - 判权锚点=capability 字典（IKKRMR）：持任一毛利口径端点（dashboard/
 *   campus-daily/hq-daily）即视为可读成本——控制器计算布尔后透传 service；
 * - 语义=字段缺席（delete）而非置 null：null 会被误读为「未填成本」，
 *   缺席即「不可见」，与 C 端 productView/stripCostSnapshot 的既有手法一致；
 * - 三张成本口径端点（dashboard/两张日报）本身就是 cost.read 的授权锚点：
 *   能调用的账号必持 cost.read，裁剪分支结构上不可达——保留是为把「报表
 *   无毛利泄露」做成局部不变量（capability 模式集将来调整也不破防）。
 * 导出（CSV）由 admin 前端按同一响应列生成，服务端裁剪即同口径。 */
/** 商品行成本字段：进货价/批发价/本地采购价/采购来源（校区行与组织行共用）。 */
export const PRODUCT_COST_FIELDS = [
  'costPrice',
  'wholesalePrice',
  'localPurchasePrice',
  'procurementMode',
  'supplyMode',
] as const;
/** 订单行内成本快照字段（支付时写入）+ 列表回查的当前进货价估算。 */
export const ORDER_ITEM_COST_FIELDS = [
  'unitGrossCost',
  'unitWholesaleCost',
  'unitPurchaseCost',
  'costSource',
  'unitsPerCase',
  'currentUnitPurchaseCost',
] as const;
/** 报表/看板毛利口径字段：成本合计、毛利额与毛利率（含看板 margin/profit）。 */
export const REPORT_COST_FIELDS = [
  'costTotal',
  'marginTotal',
  'gross',
  'marginRate',
  'marginRawRate',
  'margin',
  'profit',
] as const;

/** 浅拷贝并删除指定键（裁剪统一原语；缺省不拷贝场景仅用于本地构造对象）。 */
function omitCostKeys<T>(row: T, keys: readonly string[]): T {
  const rest = { ...(row as Record<string, unknown>) };
  for (const k of keys) delete rest[k];
  return rest as T;
}

/** 商品行裁剪：剔除 PRODUCT_COST_FIELDS（含组织目录行 supplyMode 口径）。 */
export function trimProductCost<T extends object>(row: T): T {
  return omitCostKeys(row, PRODUCT_COST_FIELDS);
}

/** 订单行裁剪：剔除 items[].product 上的成本快照字段（快照属内部数据，
 *  与 C 端 stripCostSnapshot 同一黑名单再加列表估算字段）。 */
export function trimOrderCost<T extends { items?: unknown }>(row: T): T {
  const items = row.items as
    | Array<{ product?: object } | null | undefined>
    | null;
  if (!Array.isArray(items)) return row;
  return {
    ...row,
    items: items.map((line) =>
      line?.product && typeof line.product === 'object'
        ? { ...line, product: omitCostKeys(line.product, ORDER_ITEM_COST_FIELDS) }
        : line,
    ),
  };
}

/** 报表/看板裁剪：totals/kpis/campusRows/caliber/rows 容器内剔除毛利口径字段。 */
export function trimReportCost<T extends object>(report: T): T {
  const out = { ...(report as Record<string, unknown>) };
  for (const key of ['totals', 'kpis', 'campusRows', 'caliber', 'rows']) {
    const v = out[key];
    if (Array.isArray(v))
      out[key] = v.map((r) =>
        r && typeof r === 'object' ? omitCostKeys(r, REPORT_COST_FIELDS) : r,
      );
    else if (v && typeof v === 'object') out[key] = omitCostKeys(v, REPORT_COST_FIELDS);
  }
  return out as T;
}

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
    // 微信退款（IKHZKA）：可选注入——审核批准时原路退回；测试不传时报「未就绪」。
    @Optional() private readonly payments?: PaymentsService,
    private readonly rbac: RbacService = new RbacService(db),
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
  private async hqDashboard(costRead = true) {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const [campuses, paidAgg, userAgg, exceptionAgg, buildingAgg, profitRows] =
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
        // 校区概览毛利（2026-09-18 道哥）：口径与校区经营日报一致——
        // 综合毛利=实付−配送费 − 行级 unitWholesaleCost 快照×数量（IKJ92S：
        // 配送费交付配送员属配送成本，不进毛利；快照前历史单按 0 成本计）；
        // IKISZ2 增毛利（未扣券）=商品金额 − 同口径成本
        this.db.order.findMany({
          where: { createdAt: { gte: startOfToday }, paidAt: { not: null } },
          select: {
            campusId: true,
            payableAmount: true,
            productAmount: true,
            deliveryFee: true,
            discount: true,
            items: true,
          },
        }),
      ]);
    const paidByCampus = new Map(paidAgg.map((r) => [r.campusId, r]));
    const usersByCampus = new Map(
      userAgg.map((r) => [r.campusId, r._count._all]),
    );
    const exceptionByCampus = new Map(
      exceptionAgg.map((r) => [r.campusId, r._count._all]),
    );
    const buildingsByCampus = new Map(
      buildingAgg.map((r) => [r.campusId, r._count._all]),
    );
    const profitByCampus = new Map<string, number>();
    const marginByCampus = new Map<string, number>();
    const couponByCampus = new Map<string, number>();
    for (const o of profitRows) {
      const lines =
        (o.items as unknown as Array<{
          quantity: number;
          product?: { unitGrossCost?: number; unitWholesaleCost?: number };
        }>) ?? [];
      const cost = lines.reduce(
        (sum, line) =>
          sum +
          line.quantity *
            (line.product?.unitGrossCost ??
              line.product?.unitWholesaleCost ??
              0),
        0,
      );
      profitByCampus.set(
        o.campusId,
        (profitByCampus.get(o.campusId) ?? 0) +
          (o.payableAmount - o.deliveryFee - cost),
      );
      marginByCampus.set(
        o.campusId,
        (marginByCampus.get(o.campusId) ?? 0) + (o.productAmount - cost),
      );
      couponByCampus.set(
        o.campusId,
        (couponByCampus.get(o.campusId) ?? 0) + o.discount,
      );
    }
    const campusRows = campuses.map((c) => {
      const paid = paidByCampus.get(c.id);
      return {
        campusId: c.id,
        name: c.name,
        shortName: c.shortName,
        status: c.status,
        buildings: buildingsByCampus.get(c.id) ?? 0,
        revenue: this.num(paid?._sum.payableAmount ?? 0),
        // IKISZ2 双口径：margin=毛利（未扣券） / profit=综合毛利（实付−成本）
        margin: this.num(marginByCampus.get(c.id) ?? 0),
        // 今日优惠券消耗（订单优惠抵扣，IKJ9YP）
        coupon: this.num(couponByCampus.get(c.id) ?? 0),
        profit: this.num(profitByCampus.get(c.id) ?? 0),
        orders: paid?._count._all ?? 0,
        newUsers: usersByCampus.get(c.id) ?? 0,
        exceptions: exceptionByCampus.get(c.id) ?? 0,
      };
    });
    return {
      campusRows,
      kpis: {
        revenue: campusRows.reduce((sum, r) => sum + r.revenue, 0),
        margin: campusRows.reduce((sum, r) => sum + r.margin, 0),
        coupon: campusRows.reduce((sum, r) => sum + r.coupon, 0),
        profit: campusRows.reduce((sum, r) => sum + r.profit, 0),
        orders: campusRows.reduce((sum, r) => sum + r.orders, 0),
        newUsers: campusRows.reduce((sum, r) => sum + r.newUsers, 0),
        exceptions: campusRows.reduce((sum, r) => sum + r.exceptions, 0),
        campuses: campusRows.length,
      },
      caliber: {
        revenue: '全部校区今日支付的有效单实付金额合计（分）',
        margin:
          '全部校区今日支付的有效单毛利合计（商品金额−行级批发成本快照，未扣券，分）',
        coupon:
          '全部校区今日支付的有效单优惠券抵扣合计（订单 discount 字段，分）',
        profit:
          '全部校区今日支付的有效单综合毛利合计（实付−配送费−行级批发成本快照，扣券且剔除交付配送员的配送费，分）',
        orders: '全部校区今日支付的有效单合计',
        newUsers: '全部校区今日新增用户',
        exceptions: '状态为异常的未结订单（不限当日）',
      },
    };
  }
  async dashboard(campusId: string, costRead = true) {
    // IKAJSL：总部账号 campusId 空 → 跨校区汇总；带 ?campus= 可看单校区明细
    // IKKRMY：总部汇总含校区毛利/综合毛利，无 cost.read 时裁剪（单校区看板
    // 无成本字段，天然干净）
    if (!campusId) {
      const report = await this.hqDashboard();
      return costRead ? report : trimReportCost(report);
    }
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
      avgMinutes: node ? (minutesByNode.get(node) ?? null) : null,
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
        exceptions: '状态为异常的未结订单（不限当日）',
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
      `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
    'coupon.delete': '删除优惠券',
    'dispatch-invitation.create': '创建调配邀请',
    'dispatch-invitation.cancel': '取消调配邀请',
    'inventory.adjust': '调整库存',
    'inventory.stock-in': '采购入库',
    'inventory.stocktake': '盘点校准',
    'inventory.purchase-apply': '提交采购申请',
    'inventory.purchase-audit': '采购审核',
    'restock.batch-create': '创建订货批次',
    'restock.batch-update': '更新订货批次',
    'restock.batch-close': '关闭订货批次',
    'restock.order-save': '保存订货单',
    'restock.order-submit': '提交订货单',
    'restock.order-withdraw': '撤回订货单',
    'restock.order-confirm': '确认订货单',
    'purchase.generate': '生成采购单',
    'purchase.receive': '采购验收入库',
    'purchase.close': '关闭采购单',
    'purchase.reopen': '重开采购单',
    'restock.order-reject': '驳回订货单',
    'restock.order-revoke': '撤销订货确认',
    'restock.ship': '订货分拨发货',
    'restock.receipt': '订货确认到货',
    'room.import': '批量导入寝室',
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
    'product.procurement-switch': '切换采购来源',
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
    'restock-batch': '订货批次',
    'purchase-order': '采购单',
    'restock-shipment': '发货单',
    'restock-order': '订货单',
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
        text: `${names.get(x.operator) ?? '系统'} · ${AdminService.AUDIT_ACTION_TEXTS[x.action] ?? '后台操作'}`,
        type: 'audit',
        entityType: x.entityType,
      })),
    ]
      .sort((a, b) => b.time.localeCompare(a.time))
      .slice(0, 8);
  }
  async products(
    campusId: string,
    statuses?: string[],
    categoryId?: string,
    // 导入弹窗去重（道哥 2026-09-09）：传操作者本校区 id 时，排除该校区
    // 已导入（sourceProductId 指向）的官方商品。仅 official-library 端点
    // 传此参数；官方库管理视角（GET /admin/products view=official）与
    // 状态计数不受影响，各校区互不干扰。
    excludeImportedBy?: string,
    // IKKRMW（ADR-0001 决策 3）：平台目录视角按 catalogScope='platform' 过滤
    // （campus-official 伪校区的解绑过渡标记）。缺省不过滤——现有全部调用方
    // （含 /admin/products view=official 旧路径）查询语义零改动。
    catalogScope?: 'platform',
    // IKKRMY：cost.read=false 时输出剔除成本字段（控制器按 capability 计算）
    costRead = true,
  ) {
    // 先取本校区已导入行指向的官方商品 id 集；为空必须跳过 notIn
    // （Prisma notIn: [] 会排除全部行）
    const importedSourceIds = excludeImportedBy
      ? (
          await this.db.product.findMany({
            where: {
              campusId: excludeImportedBy,
              sourceProductId: { not: null },
            },
            select: { sourceProductId: true },
          })
        )
          .map((x) => x.sourceProductId)
          .filter((id): id is string => !!id)
      : [];
    const xs = await this.db.product.findMany({
      // IKD6FG：categoryId 分类筛选（官方库/本校区/库存共用）
      where: {
        campusId,
        ...(categoryId ? { categoryId } : {}),
        ...(catalogScope ? { catalogScope } : {}),
        // IKKRMX：组织目录行也落 campus-official 伪校区（复用校区模型不建
        // 新表）——平台/官方库视角（未显式传 catalogScope 的调用方）一律排除
        // 组织行，组织目录只经 /admin/org-products 数据面出入
        ...(campusId === OFFICIAL_CAMPUS_ID && !catalogScope
          ? { organizationId: null }
          : {}),
        ...(importedSourceIds.length
          ? { id: { notIn: importedSourceIds } }
          : {}),
      },
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
    const upstreamAt = new Map(
      upstream.map((u) => [u.id, u.updatedAt.getTime()]),
    );
    const isOfficial = campusId === OFFICIAL_CAMPUS_ID;
    const rows = xs.map((x) => ({
      ...x,
      price: this.num(x.price),
      originalPrice: this.num(x.originalPrice),
      // IKC1AC：价格三层输出（校区端展示批发价快照；进货价由前端按角色显隐）
      costPrice: this.num(x.costPrice),
      wholesalePrice: this.num(x.wholesalePrice),
      localPurchasePrice:
        x.localPurchasePrice == null ? null : this.num(x.localPurchasePrice),
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
    // IKKRMY：无 cost.read 时输出层统一裁剪成本字段（CSV 导出同口径）
    const scoped = statuses?.length
      ? rows.filter((x) => statuses.includes(x.status))
      : rows;
    return costRead ? scoped : scoped.map((x) => trimProductCost(x));
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
   * 平台商品目录（IKKRMW，ADR-0001 决策 3）：catalogScope='platform' 行 =
   * 原官方商品库数据源（落 campus-official 伪校区，物理解绑留 IKKRMX）。
   * /admin/platform-products 的数据面——语义别名复用官方库链路（读写仍走
   * products/createProduct/updateProduct 传 OFFICIAL_CAMPUS_ID），为 IKKRMX
   * 组织导入做准备；旧 /admin/products view=official 路径保留兼容。
   */
  platformProducts(statuses?: string[], categoryId?: string, costRead = true) {
    return this.products(
      OFFICIAL_CAMPUS_ID,
      statuses,
      categoryId,
      undefined,
      'platform',
      costRead,
    );
  }

  /* ---------- 组织商品目录（IKKRMX，ADR-0001 决策 4）---------- */
  // 组织目录行=organizationId 非空且 catalogScope='org' 的 Product 行（复用
  // 校区模型不建新表：行物理上仍落 campus-official 伪校区，平台/官方库视角
  // 查询一律 organizationId IS NULL 排除）。字段语义与校区行不同：
  // price=组织供货价、costPrice=组织进货价、supplyMode=采购来源
  // （'platform'=平台供货 / 'local'=自主采购）。
  //
  // 组织毛利口径钉死（本 issue 仅注释+字段，报表属后续 issue）：
  //   组织毛利 = 组织供货价(price) − 当前明确成本
  //     - 平台供货（supplyMode='platform'）：成本=平台批发价快照(wholesalePrice)
  //     - 自主采购（supplyMode='local'）：成本=组织进货价(costPrice)

  /** 目标组织存在性收口（平台账号 ?organizationId / 组织级账号固定组织）。 */
  private async assertOrganization(organizationId: string) {
    const org = await this.db.organization.findUnique({
      where: { id: organizationId },
      select: { id: true },
    });
    if (!org) throw new BadRequestException(`组织不存在: ${organizationId}`);
  }

  /** 组织目录列表：本组织 org 行全集（不依赖 campusId 维度）。 */
  async orgProducts(
    organizationId: string,
    statuses?: string[],
    categoryId?: string,
    // IKKRMY：组织目录成本字段（组织进货价/平台批发价快照）同口径裁剪
    costRead = true,
  ) {
    await this.assertOrganization(organizationId);
    const xs = await this.db.product.findMany({
      where: {
        organizationId,
        catalogScope: 'org',
        ...(categoryId ? { categoryId } : {}),
      },
      orderBy: { sales: 'desc' },
    });
    // 目录行不记库存（同官方库口径，库存归校区副本），无售罄映射
    const rows = xs.map((x) => ({
      ...x,
      price: this.num(x.price),
      originalPrice: this.num(x.originalPrice),
      costPrice: this.num(x.costPrice),
      wholesalePrice: this.num(x.wholesalePrice),
      weight: this.num(x.weight),
      skuNo: `SKU-${x.id.toUpperCase()}`,
      actualStock: x.stock + x.lockedStock,
      availableStock: x.stock,
    }));
    // IKKRMY：组织目录行无 cost.read 账号剔除成本字段（supplyMode 一并隐藏）
    const scoped = statuses?.length
      ? rows.filter((x) => statuses.includes(x.status))
      : rows;
    return costRead ? scoped : scoped.map((x) => trimProductCost(x));
  }

  /**
   * 组织目录建档（IKKRMX）：默认不可售（IKC1AB 同口径——目录行核对后放行，
   * 放行后方可导入校区）；组织供货价(price)/组织进货价(costPrice)/采购来源
   * (supplyMode) 为组织层经营字段，毛利口径见本节注释钉死。
   */
  async createOrgProduct(
    body: CreateOrgProductDto,
    operator: string,
    organizationId: string,
  ) {
    await this.assertOrganization(organizationId);
    const supplyMode = body.supplyMode ?? 'platform';
    if (supplyMode === 'local' && body.costPrice == null)
      throw new BadRequestException('自主采购商品必须填写组织进货价');
    // 条码在 campus-official 伪校区维度去重（@@unique[campusId,barcode]）：
    // 组织行与平台行同落伪校区，撞码需换码或不填（跨组织/跨层撞码同理）
    if (body.barcode != null) {
      const duplicate = await this.db.product.findFirst({
        where: { barcode: body.barcode, campusId: OFFICIAL_CAMPUS_ID },
      });
      if (duplicate) throw new BadRequestException('该条码已录入商品库');
    }
    const category = await this.db.category.findUnique({
      where: { id: body.categoryId },
    });
    if (!category) throw new BadRequestException('商品分类不存在');
    const product = await this.db.product.create({
      data: {
        // 复用校区模型不建新表：行落 campus-official 伪校区（schema campusId
        // 仍 NOT NULL 的过渡口径），归属按 organizationId+catalogScope 圈定
        campusId: OFFICIAL_CAMPUS_ID,
        catalogScope: 'org',
        organizationId,
        supplyMode,
        barcode: body.barcode,
        name: body.name,
        subtitle: body.subtitle ?? '',
        categoryId: body.categoryId,
        // price=组织供货价（组织层经营字段，非零售价）
        price: body.price,
        originalPrice: body.originalPrice ?? body.price,
        // costPrice=组织进货价（自主采购口径的成本）；wholesalePrice=平台
        // 批发价快照（平台供货口径的成本基数），毛利公式二选一按 supplyMode
        costPrice: body.costPrice ?? 0,
        wholesalePrice: body.wholesalePrice ?? 0,
        stock: 0,
        tag: body.tag ?? '新品',
        image: body.image ?? '',
        images: body.images,
        location: body.location ?? '',
        weight: body.weight ?? 0,
        retailUnit: body.retailUnit?.trim() ?? '',
        wholesaleUnit: body.wholesaleUnit?.trim() || '件',
        unitsPerCase: body.unitsPerCase ?? 1,
        sales: 0,
        status: 'off-sale',
      },
    });
    await this.audit(
      operator,
      'product.create',
      'product',
      product.id,
      null,
      product,
      OFFICIAL_CAMPUS_ID,
    );
    return product;
  }

  /**
   * 组织目录编辑（IKKRMX）：组织供货价/进货价/采购来源/资料/放行回收。
   * 切换采购来源为自主采购必须显式带组织进货价（成本口径重新确认）；
   * 校区行专属字段（库存/校区采购方式/本地进货价）不在组织端点可写集。
   */
  async updateOrgProduct(
    id: string,
    body: UpdateOrgProductDto,
    operator: string,
    organizationId: string,
  ) {
    // 行隔离按组织收口：越组织/已删/非 org 行一律 404（不泄露存在性）
    const before = await this.db.product.findFirst({
      where: { id, organizationId, catalogScope: 'org' },
    });
    if (!before) throw new NotFoundException('商品不存在');
    if (
      body.supplyMode !== undefined &&
      body.supplyMode !== (before.supplyMode ?? 'platform') &&
      body.supplyMode === 'local' &&
      body.costPrice == null
    )
      throw new BadRequestException('自主采购商品必须填写组织进货价');
    if (body.name !== undefined && !body.name.trim())
      throw new BadRequestException('商品名称不能为空');
    if (body.name !== undefined) body.name = body.name.trim();
    if (
      body.categoryId !== undefined &&
      body.categoryId !== before.categoryId
    ) {
      const category = await this.db.category.findUnique({
        where: { id: body.categoryId },
      });
      if (!category) throw new BadRequestException('分类不存在');
    }
    if (body.unitsPerCase != null && body.unitsPerCase < 1)
      throw new BadRequestException('每件含量不能小于 1');
    const after = await this.db.product.update({
      where: { id },
      data: {
        ...(body.supplyMode !== undefined ? { supplyMode: body.supplyMode } : {}),
        ...(body.price !== undefined ? { price: body.price } : {}),
        ...(body.originalPrice !== undefined
          ? { originalPrice: body.originalPrice }
          : {}),
        ...(body.costPrice !== undefined ? { costPrice: body.costPrice } : {}),
        ...(body.wholesalePrice !== undefined
          ? { wholesalePrice: body.wholesalePrice }
          : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.subtitle !== undefined ? { subtitle: body.subtitle } : {}),
        ...(body.tag !== undefined ? { tag: body.tag } : {}),
        ...(body.image !== undefined ? { image: body.image } : {}),
        ...(body.images !== undefined ? { images: body.images } : {}),
        ...(body.weight !== undefined ? { weight: body.weight } : {}),
        ...(body.categoryId !== undefined ? { categoryId: body.categoryId } : {}),
        ...(body.description !== undefined
          ? { description: body.description }
          : {}),
        ...(body.location !== undefined ? { location: body.location } : {}),
        ...(body.locationCode !== undefined
          ? { locationCode: body.locationCode }
          : {}),
        ...(body.retailUnit !== undefined ? { retailUnit: body.retailUnit } : {}),
        ...(body.wholesaleUnit !== undefined
          ? { wholesaleUnit: body.wholesaleUnit }
          : {}),
        ...(body.unitsPerCase !== undefined
          ? { unitsPerCase: body.unitsPerCase }
          : {}),
      },
    });
    await this.audit(
      operator,
      'product.update',
      'product',
      id,
      before,
      after,
      OFFICIAL_CAMPUS_ID,
    );
    return after;
  }

  /**
   * 组织目录→组织内校区导入（IKKRMX，复用 importProducts 模式）：复制组织
   * 目录资料落目标校区，副本行以 orgCatalogId 指回组织目录行（三层来源链
   * platform←org←campus 的第二跳），导入后即解耦——组织行调价/停用不连坐
   * 校区副本；校区售价(price)/上下架(status)/库存(stock)自管，导入初始
   * 下架+零库存。幂等：同 orgCatalogId 已导入/条码撞本校区商品时跳过并回因。
   * 目标校区必须属于该组织（越组织 403）。
   */
  async importOrgProduct(
    id: string,
    campusId: string,
    operator: string,
    organizationId: string,
  ) {
    await this.assertOrganization(organizationId);
    const campus = await this.db.campus.findUnique({
      where: { id: campusId },
      select: { id: true, organizationId: true },
    });
    if (!campus) throw new BadRequestException('目标校区不存在');
    if ((campus.organizationId ?? null) !== organizationId)
      throw new ForbiddenException('目标校区不属于该组织');
    // IKC1AB 同口径：仅放行（on-sale）的组织商品可导入——双保险
    const orgRow = await this.db.product.findFirst({
      where: { id, organizationId, catalogScope: 'org', status: 'on-sale' },
    });
    if (!orgRow) {
      const any = await this.db.product.findFirst({
        where: { id, organizationId, catalogScope: 'org' },
      });
      if (!any) throw new NotFoundException('商品不存在');
      throw new BadRequestException('仅放行（在售）的组织商品可导入');
    }
    const existing = await this.db.product.findFirst({
      where: { campusId, orgCatalogId: id },
      select: { id: true },
    });
    if (existing)
      return {
        imported: false,
        reason: '已导入过，无需重复导入',
        campusProductId: existing.id,
      };
    if (orgRow.barcode) {
      const clash = await this.db.product.findFirst({
        where: { campusId, barcode: orgRow.barcode },
        select: { id: true },
      });
      if (clash)
        return {
          imported: false,
          reason: `条码 ${orgRow.barcode} 与本校区现有商品冲突`,
          campusProductId: null,
        };
    }
    // IKKA1S：类别重映射到本校区副本（缺失自动建）
    const campusCategoryId = await this.remapCategoryToCampus(
      orgRow.categoryId,
      campusId,
    );
    const created = await this.db.product.create({
      data: {
        campusId,
        // 副本=组织校区行；组织归属走 campus.organizationId（不落组织字段），
        // 上游关系走 orgCatalogId（sourceProductId 仍专属平台目录链，本副本无）
        catalogScope: 'campus',
        organizationId: null,
        orgCatalogId: orgRow.id,
        barcode: orgRow.barcode,
        name: orgRow.name,
        subtitle: orgRow.subtitle,
        categoryId: campusCategoryId,
        // 售价起步=组织供货价，校区可改；库存归校区，导入为 0
        price: orgRow.price,
        originalPrice: orgRow.originalPrice,
        // 成本快照随导入落校区行：批发价快照=组织供货价、进货价留档=组织
        // 进货价（口径同官方库导入的快照链）
        costPrice: orgRow.costPrice,
        wholesalePrice: orgRow.price,
        // 校区从组织获得供货（非校区自主采购），procurementMode=HQ
        procurementMode: 'HQ',
        stock: 0,
        tag: orgRow.tag,
        image: orgRow.image,
        images: (orgRow.images as Prisma.InputJsonValue) ?? undefined,
        description: orgRow.description,
        weight: orgRow.weight,
        retailUnit: orgRow.retailUnit,
        wholesaleUnit: orgRow.wholesaleUnit,
        unitsPerCase: orgRow.unitsPerCase,
        sales: 0,
        status: 'off-sale',
        sourceSyncedAt: orgRow.updatedAt,
      },
    });
    await this.audit(
      operator,
      'product.import',
      'product',
      created.id,
      null,
      {
        name: created.name,
        orgCatalogId: orgRow.id,
        organizationId,
        orgName: orgRow.name,
      },
      campusId,
    );
    return { imported: true, reason: '', campusProductId: created.id };
  }
  /**
   * 商品类别管理（2026-08-19 grilling）：全局字典（无 campusId 维度），
   * 名称应用层唯一（DB 无约束，避免迁移）；sort 升序 = 小程序分类 tab 顺序；
   * 有关联商品的类别拒绝删除（决策：提示数量，运营先转移再删）。
   */
  /** 首页推荐位（IKH0EK）：本校区已选推荐商品，featuredSort 升序 */
  async featured(campusId: string) {
    return this.db.product.findMany({
      where: { campusId, featured: true },
      orderBy: { featuredSort: 'asc' },
      select: {
        id: true,
        name: true,
        price: true,
        image: true,
        status: true,
        stock: true,
        sales: true,
        categoryId: true,
      },
    });
  }
  /** 推荐位保存（IKH0EK）：全量有序提交，事务清位重设；越界/跨校区 id 静默剔除 */
  async saveFeatured(ids: string[], campusId: string) {
    const own = await this.db.product.findMany({
      where: { id: { in: ids }, campusId },
      select: { id: true },
    });
    const ownIds = new Set(own.map((r) => r.id));
    const valid = ids.filter((id) => ownIds.has(id));
    await this.db.$transaction([
      this.db.product.updateMany({
        where: { campusId, featured: true },
        data: { featured: false, featuredSort: 0 },
      }),
      // 逐行写序（数组序=展示序，1 起）
      ...valid.map((id, i) =>
        this.db.product.update({
          where: { id },
          data: { featured: true, featuredSort: i + 1 },
        }),
      ),
    ]);
    return { count: valid.length };
  }
  /**
   * 类别重映射到目标校区（IKKA1S）：官方模板类别 → 本校区同名副本，
   * 缺失自动建（资料跟模板）。官方库导入/发货建行等跨校区商品落地的类别对齐。
   */
  private async remapCategoryToCampus(
    officialCategoryId: string,
    campusId: string,
  ): Promise<string> {
    const template = await this.db.category.findUnique({
      where: { id: officialCategoryId },
    });
    if (!template) return officialCategoryId;
    const existing = await this.db.category.findFirst({
      where: { campusId, name: template.name },
    });
    if (existing) return existing.id;
    const created = await this.db.category.create({
      data: {
        campusId,
        name: template.name,
        sort: template.sort,
        image: template.image,
        hidden: false,
      },
    });
    return created.id;
  }

  /** 类别列表（IKKA1S 校区隔离）：campusId 非空按校区过滤（商品数同口径）；
   *  空（平台缺省）=全量，商品数为全校区合计。 */
  async categories(campusId?: string) {
    const rows = await this.db.category.findMany({
      where: campusId ? { campusId } : {},
      orderBy: [{ sort: 'asc' }, { name: 'asc' }],
      include: {
        _count: {
          select: { products: campusId ? { where: { campusId } } : true },
        },
      },
    });
    return rows.map(({ _count, ...row }) => ({
      ...row,
      productCount: _count.products,
    }));
  }
  /** 新建类别（IKKA1S）：落上下文校区，名称校区内唯一。 */
  async createCategory(
    body: CreateCategoryDto,
    operator: string,
    campusId: string,
  ) {
    const duplicate = await this.db.category.findFirst({
      where: { name: body.name, campusId },
    });
    if (duplicate) throw new BadRequestException('类别名称已存在');
    const category = await this.db.category.create({
      data: {
        campusId,
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
  /** 修改类别（IKKA1S）：仅本校区类别可改；名称查重限本校区。 */
  async updateCategory(
    id: string,
    body: UpdateCategoryDto,
    operator: string,
    campusId: string,
  ) {
    const found = await this.db.category.findUnique({ where: { id } });
    if (!found || found.campusId !== campusId)
      throw new NotFoundException('类别不存在');
    if (body.name && body.name !== found.name) {
      const duplicate = await this.db.category.findFirst({
        where: { name: body.name, campusId, id: { not: id } },
      });
      if (duplicate) throw new BadRequestException('类别名称已存在');
    }
    const category = await this.db.category.update({
      where: { id },
      // Prisma 惯例：undefined 字段跳过更新（hidden 为类目可见性开关，校区级 IKKA1S）
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
  /** 删除类别（IKKA1S）：仅本校区类别可删；商品数按本校区统计。 */
  async deleteCategory(id: string, operator: string, campusId: string) {
    const found = await this.db.category.findUnique({
      where: { id },
      include: {
        _count: { select: { products: { where: { campusId } } } },
      },
    });
    if (!found || found.campusId !== campusId)
      throw new NotFoundException('类别不存在');
    if (found._count.products)
      throw new BadRequestException(
        `本校区该类别下还有 ${found._count.products} 个商品，请先在商品管理中转移到其他类别`,
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
      campusName: x.campusId ? (nameById.get(x.campusId) ?? '') : '全部校区',
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
    // IKE9YC：page 跳转必须带路径（400 拦住后台漏填）
    if (body.linkType === 'page' && !body.linkUrl?.trim())
      throw new BadRequestException('配置了站内跳转，需填写页面路径');
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
        // IKE9YC：点击跳转，none=不跳（存量行为）；跳转优先于图文详情
        linkType: body.linkType ?? 'none',
        linkUrl: body.linkUrl?.trim() ?? '',
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
    // IKE9YC：page 跳转必须带路径（undefined 跳过校验，仅显式提交时拦）
    if (body.linkType === 'page' && !body.linkUrl?.trim())
      throw new BadRequestException('配置了站内跳转，需填写页面路径');
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
        // IKE9YC：undefined 跳过；linkType 显式 none 或 linkUrl 空串即清空跳转
        linkType: body.linkType,
        linkUrl: body.linkUrl === undefined ? undefined : body.linkUrl.trim(),
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
  async promotions(campusId: string, state?: string, categoryId?: string) {
    const xs = await this.db.promotion.findMany({
      where: { product: { campusId } },
      orderBy: { createdAt: 'desc' },
      include: {
        product: {
          select: {
            id: true,
            name: true,
            image: true,
            price: true,
            status: true,
            categoryId: true,
          },
        },
      },
    });
    // 搜索修复（2026-09-21 道哥反馈「秒杀搜索框搜不出」）：keywordHaystack 只
    // 展开第一层字段，商品名在 product.name 第二层恒不命中——平铺 productName
    // 进第一层（精准修，不动全局搜索深度）
    let rows = xs.map((x) => ({
      ...x,
      productName: x.product?.name ?? '',
      // 类别筛选（2026-09-21 道哥）：与商品库分类筛选同款 categoryId 参数，
      // 平铺进第一层供 paginate keyword 与前端下拉消费
      categoryId: x.product?.categoryId ?? '',
    }));
    if (categoryId) rows = rows.filter((x) => x.categoryId === categoryId);
    if (!state) return rows;
    const now = Date.now();
    return rows.filter((x) => {
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
  async lookupBarcode(barcode: string, campusId: string, costRead = true) {
    // 条码唯一改校区维度（IKAJSM）：本校区库内命中优先
    const product = await this.db.product.findFirst({
      where: { barcode, campusId },
    });
    if (product)
      return {
        found: true,
        source: 'product-database',
        product: {
          // IKC1AC：进货价不下发校区端（扫码回填场景同样剔除）；
          // IKKRMY：无 cost.read 连批发价/本地采购价/采购来源一并剔除
          ...(costRead
            ? { ...product, costPrice: undefined }
            : trimProductCost(product)),
          price: this.num(product.price),
          originalPrice: this.num(product.originalPrice),
          weight: this.num(product.weight),
        },
      };
    // IKAJSO：本校区未录入时先查官方库——命中即可一键导入，不再走人工建档。
    // IKC1AB：与导入候选池同口径，仅命中总部放行（on-sale）的商品；
    // IKKRMX：组织目录行（同落伪校区）不参与扫码命中
    if (campusId !== OFFICIAL_CAMPUS_ID) {
      const official = await this.db.product.findFirst({
        where: {
          barcode,
          campusId: OFFICIAL_CAMPUS_ID,
          status: 'on-sale',
          organizationId: null,
        },
      });
      if (official)
        return {
          found: true,
          source: 'official-library',
          product: {
            // IKKRMY：官方库命中同口径（默认含成本，供导入建档回填）
            ...(costRead ? official : trimProductCost(official)),
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
    if (campusId !== OFFICIAL_CAMPUS_ID && body.localPurchasePrice == null)
      throw new BadRequestException('本地采购商品必须填写进货价');
    // 条码唯一改校区维度（IKAJSM）：同校区内去重，官方库/他校区可同码。
    // IKFQQ0：条码选填后必须前置非空判断——where.barcode 为 undefined 时
    // Prisma 会忽略该条件，把同校区任意商品误判成重复
    if (body.barcode != null) {
      const duplicate = await this.db.product.findFirst({
        where: { barcode: body.barcode, campusId },
      });
      if (duplicate) throw new BadRequestException('该条码已录入商品库');
    }
    const category = await this.db.category.findUnique({
      where: { id: body.categoryId },
    });
    if (!category) throw new BadRequestException('商品分类不存在');
    const product = await this.db.product.create({
      data: {
        campusId,
        // IKKRMW：官方库行=平台目录行（解绑过渡标记）；组织校区行走缺省
        // 'campus'，显式落值防未来缺省口径变化
        catalogScope: campusId === OFFICIAL_CAMPUS_ID ? 'platform' : 'campus',
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
        // 单位属性（IKFOPU）：零售单位空 = 展示不显示单位；批发单位缺省「件」、
        // 含量缺省 1（无件概念），订货/入库链路按它换算
        retailUnit: body.retailUnit?.trim() ?? '',
        wholesaleUnit: body.wholesaleUnit?.trim() || '件',
        unitsPerCase: body.unitsPerCase ?? 1,
        sales: 0,
        // IKC1AB：官方库商品默认「不可售」，总部核对后手动放行（校区导入
        // 候选池只见可售）；校区自建商品仍默认在售
        status: campusId === OFFICIAL_CAMPUS_ID ? 'off-sale' : 'on-sale',
        // IKC1AC：进货价/批发价格仅官方库行维护；批发价缺省取 price
        // IKFOPQ：校区自建行接受批发价（自报，行内毛利基数），进货价仍仅官方
        ...(campusId === OFFICIAL_CAMPUS_ID
          ? {
              costPrice: body.costPrice ?? 0,
              wholesalePrice: body.wholesalePrice ?? body.price,
              procurementMode: 'HQ',
            }
          : {
              // 校区手工建档只能代表本地采购；总部供货必须经官方库导入/到货。
              procurementMode: 'LOCAL',
              localPurchasePrice: body.localPurchasePrice,
              wholesalePrice: body.wholesalePrice ?? 0,
            }),
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
      where: {
        id,
        campusId,
        // IKKRMX：平台端点不碰组织目录行（伪校区上的组织行走 org-products
        // 链路，越层 id 一律 404 不泄露存在性）
        ...(campusId === OFFICIAL_CAMPUS_ID ? { organizationId: null } : {}),
      },
    });
    if (!before) throw new NotFoundException('商品不存在');
    if (
      body.procurementMode !== undefined &&
      body.procurementMode !== before.procurementMode
    ) {
      // IKKRMZ / ADR-0001 决策 4：有剩余库存禁止切换采购来源——旧库存直接
      // 套新成本会污染毛利口径，清零（盘点/出库）后才允许切。null 是历史数据
      // 首次确认（认领来源），并非切换，允许有存量时认领。lockedStock 恒 0
      // （IKJC1R 确认不再锁库存），存量脏数据的残余防御由下方条件 updateMany
      // 的 stock:0+lockedStock:0 前置兜底。
      if (before.procurementMode != null && before.stock > 0)
        throw new BadRequestException(
          `还有剩余库存 ${before.stock} 件，不能切换采购来源；` +
            '请先清零库存（盘点/出库）后再切换',
        );
      if (
        body.procurementMode === 'LOCAL' &&
        body.localPurchasePrice == null &&
        before.localPurchasePrice == null
      )
        throw new BadRequestException('本地采购商品必须填写进货价');
      const [pendingPurchase, pendingRestock] = await Promise.all([
        this.db.purchaseRequest.count({
          where: { productId: id, status: 'pending' },
        }),
        this.db.restockOrderItem.count({
          where: {
            productId: before.sourceProductId ?? '__none__',
            order: {
              campusId,
              status: { in: ['submitted', 'confirmed', 'shipped'] },
            },
          },
        }),
      ]);
      if (pendingPurchase || pendingRestock)
        throw new BadRequestException(
          '商品存在待处理采购或订货单，不能切换采购方式',
        );
    }
    if (
      (body.procurementMode ?? before.procurementMode) === 'LOCAL' &&
      body.localPurchasePrice === null
    )
      throw new BadRequestException('本地采购商品必须填写进货价');
    // 资料可编辑（IKAHAT）：空白名拒绝；换分类校验目标存在（Category 为全局字典）
    if (body.name !== undefined && !body.name.trim())
      throw new BadRequestException('商品名称不能为空');
    if (body.name !== undefined) body.name = body.name.trim();
    if (
      body.categoryId !== undefined &&
      body.categoryId !== before.categoryId
    ) {
      const category = await this.db.category.findUnique({
        where: { id: body.categoryId },
      });
      if (!category) throw new BadRequestException('分类不存在');
    }
    // IKC1AC：进货价仅官方库行可改（校区视角不可见也不可写）
    // IKFOPU：单位属性同属官方资料——校区「导入行」（有来源）剔除三字段只读，
    // 校区自建行（无来源）保留可改
    // IKFOPQ：校区自建行放开批发价编辑——其行内毛利 = 售价 − 自报批发价
    const data: UpdateProductDto =
      campusId === OFFICIAL_CAMPUS_ID
        ? body
        : before.sourceProductId
          ? {
              ...body,
              costPrice: undefined,
              wholesalePrice: undefined,
              retailUnit: undefined,
              wholesaleUnit: undefined,
              unitsPerCase: undefined,
            }
          : { ...body, costPrice: undefined, wholesalePrice: undefined };
    if (data.unitsPerCase != null && data.unitsPerCase < 1)
      throw new BadRequestException('每件含量不能小于 1');
    // 采购方式变化使用带旧值/零库存前置条件的条件更新，避免校验后并发入库
    // 或另一管理员改来源导致覆盖。普通资料更新仍走唯一 id。
    let after;
    if (
      body.procurementMode !== undefined &&
      body.procurementMode !== before.procurementMode
    ) {
      const changed = await this.db.product.updateMany({
        where: {
          id,
          procurementMode: before.procurementMode,
          ...(before.procurementMode == null
            ? {}
            : { stock: 0, lockedStock: 0 }),
        },
        data,
      });
      if (changed.count !== 1)
        throw new BadRequestException('商品库存或采购方式已变化，请刷新后重试');
      after = await this.db.product.findUniqueOrThrow({ where: { id } });
    } else {
      after = await this.db.product.update({ where: { id }, data });
    }
    // 进货价自动下发（2026-09-19 道哥定版「统一用校区价格」）：官方库调进货价
    // → 全部同步行的快照即时跟随（此前是导入时快照，总部调价后校区不自动跟，
    // 促销弹窗与官方库出现两个进货价）。自建行（无来源）不受影响。
    if (
      campusId === OFFICIAL_CAMPUS_ID &&
      body.costPrice !== undefined &&
      body.costPrice !== before.costPrice
    ) {
      await this.db.product.updateMany({
        where: { sourceProductId: id },
        data: { costPrice: body.costPrice },
      });
    }
    await this.audit(
      operator,
      'product.update',
      'product',
      id,
      before,
      after,
      campusId,
    );
    // IKKRMZ：采购来源切换专项留痕（ADR-0001 决策 4 验收：操作人+切换前后
    // 来源+成本依据）。通用 product.update 已落全行快照；专项 action 让切换
    // 流水可按动作直接检索（null→值 的首次认领同样落此 action，before 为
    // null 可区分认领与切换）。
    if (
      body.procurementMode !== undefined &&
      body.procurementMode !== before.procurementMode
    )
      await this.audit(
        operator,
        'product.procurement-switch',
        'product',
        id,
        {
          procurementMode: before.procurementMode,
          localPurchasePrice: before.localPurchasePrice,
          costPrice: before.costPrice,
          wholesalePrice: before.wholesalePrice,
          stock: before.stock,
        },
        {
          procurementMode: after.procurementMode,
          localPurchasePrice: after.localPurchasePrice,
          costPrice: after.costPrice,
          wholesalePrice: after.wholesalePrice,
          stock: after.stock,
        },
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
      where: {
        id: { in: ids },
        campusId,
        // IKKRMX：官方库视角的批量放行/回收不连坐组织目录行（组织行自管）
        ...(campusId === OFFICIAL_CAMPUS_ID ? { organizationId: null } : {}),
      },
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
   *
   * IKKRMW（ADR-0001 决策 3）导入副本保护钉死：
   * - 副本行以 sourceProductId 保留来源关系（指向平台目录行），导入后即与
   *   源行解耦——平台行停用/回收（batch-status 按 campusId 作用域）不删除、
   *   不改动组织校区已有行；上游变化只产生「待同步」提示（pullUpstream 钉死）。
   * - 平台目录行是导入「源」不是「目标」：伪校区不可作为导入落点（最小校验）。
   */
  async importProducts(
    productIds: string[],
    operator: string,
    campusId: string,
  ) {
    if (campusId === OFFICIAL_CAMPUS_ID)
      throw new BadRequestException('平台目录行不可作为导入目标');
    const officials = await this.db.product.findMany({
      // IKC1AB：仅总部放行（on-sale）的商品可导入——候选池与导入双保险；
      // IKKRMW：导入源=平台目录行（catalogScope='platform'，伪校区解绑后
      // 仍按此口径收口，组织级导入属 IKKRMX 另立端点）
      where: {
        id: { in: productIds },
        campusId: OFFICIAL_CAMPUS_ID,
        catalogScope: 'platform',
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
    const campusBarcodes = new Set(
      existing.map((x) => x.barcode).filter(Boolean),
    );
    const imported: string[] = [];
    const skipped: { id: string; name: string; reason: string }[] = [];
    for (const id of productIds) {
      const official = officialById.get(id);
      if (!official) {
        skipped.push({ id, name: id, reason: '官方库中不存在该商品' });
        continue;
      }
      if (importedSources.has(official.id)) {
        skipped.push({
          id,
          name: official.name,
          reason: '已导入过，无需重复导入',
        });
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
      // IKKA1S：类别重映射到本校区副本（缺失自动建）
      const campusCategoryId = await this.remapCategoryToCampus(
        official.categoryId,
        campusId,
      );
      const created = await this.db.product.create({
        data: {
          campusId,
          // IKKRMW：导入副本=组织校区行（显式钉死口径；与缺省一致）
          catalogScope: 'campus',
          barcode: official.barcode,
          name: official.name,
          subtitle: official.subtitle,
          categoryId: campusCategoryId,
          // 售价/划线价取官方价起步，校区可改；库存归校区，导入为 0
          price: official.price,
          originalPrice: official.originalPrice,
          // IKC1AC：批发价/进货价快照随导入落校区行（校区端展示批发价，
          // 进货价仅数据留档、校区出口剔除）
          costPrice: official.costPrice,
          wholesalePrice: official.price,
          procurementMode: 'HQ',
          stock: 0,
          tag: official.tag,
          image: official.image,
          images: (official.images as Prisma.InputJsonValue) ?? undefined,
          description: official.description,
          weight: official.weight,
          // 单位属性（IKFOPU）：官方资料随导入落地校区行（校区只读）
          retailUnit: official.retailUnit,
          wholesaleUnit: official.wholesaleUnit,
          unitsPerCase: official.unitsPerCase,
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
   *
   * IKKRMW（ADR-0001 决策 3）钉死：上游=平台目录行；上层修改只产生
   * 「待同步」提示（列表 upstreamChanged 角标），永不自动覆盖下层经营
   * 字段（售价/库存/状态）——资料也只有校区显式拉取才同步。
   *
   * IKKRMX（ADR-0001 决策 4）上游同步保护钉死（三层来源链 platform←org←campus
   * 逐层同口径）：组织目录行的 pullUpstream（后续 issue 落地）从平台目录行
   * 拉资料时，同样**永不自动覆盖组织层的经营字段**——组织供货价(price)/
   * 采购来源(supplyMode)/经营状态(status) 只由组织显式修改；组织行→校区
   * 副本（orgCatalogId 链）亦然。上层变化一律只产生「待同步」提示。
   */
  async pullUpstream(id: string, operator: string, campusId: string) {
    const local = await this.db.product.findFirst({
      where: { id, campusId },
    });
    if (!local) throw new NotFoundException('商品不存在');
    if (!local.sourceProductId)
      throw new BadRequestException('自建商品无官方库来源，无需拉取');
    // 上游=平台目录行（campus-official 伪校区；IKKRMX 解绑后改按
    // catalogScope='platform' 定位，行为不变）
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
        // 单位属性（IKFOPU）：官方改动随拉取同步（校区行只读语义闭环）
        retailUnit: official.retailUnit,
        wholesaleUnit: official.wholesaleUnit,
        unitsPerCase: official.unitsPerCase,
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
  async inventory(campusId: string, categoryId?: string, costRead = true) {
    // IKA0VB 去批次：合成批次号/有效期已移除（零食饮料初期不做效期批次管理）。
    const [items, campus] = await Promise.all([
      // IKKRMY：库存总览复用商品行——成本字段同口径裁剪
      this.products(campusId, undefined, categoryId, undefined, undefined, costRead),
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
    if (campusId !== OFFICIAL_CAMPUS_ID && product.procurementMode !== 'LOCAL')
      throw new BadRequestException('只有本地采购商品可以手工采购入库');
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
      const stocked = await tx.product.updateMany({
        where: {
          id: body.productId,
          ...(campusId === OFFICIAL_CAMPUS_ID
            ? {}
            : { procurementMode: 'LOCAL' }),
        },
        data: { stock: { increment: body.quantity } },
      });
      if (stocked.count !== 1)
        throw new BadRequestException('商品采购方式已变化，请刷新后重试');
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
  /**
   * 盘点校准（IKD6FJ）：盘点 = 提交仓库实际清点数量，与 adjustStock 的增量调整
   * 语义不同——这里只报「账面 vs 实际」的差额，系统自动算 delta 落 adjust 流水；
   * 账实相符（delta=0）时不落流水，仅返回核对结果。
   */
  async stocktake(body: StocktakeDto, operator: string, campusId: string) {
    const product = await this.db.product.findFirst({
      where: { id: body.productId, campusId },
    });
    if (!product) throw new NotFoundException('商品不存在');
    const delta = body.countedQty - product.stock;
    if (!delta)
      return {
        productId: product.id,
        before: product.stock,
        countedQty: body.countedQty,
        delta: 0,
        applied: false,
      };
    if (body.countedQty < 0)
      throw new BadRequestException('清点数量不能为负数');
    const txn = await this.db.$transaction(async (tx) => {
      const record = await tx.inventoryTxn.create({
        data: {
          productId: product.id,
          type: 'adjust',
          delta,
          reason: body.reason?.trim()
            ? `盘点校准：${body.reason.trim()}`
            : '盘点校准',
          operator,
        },
      });
      await tx.product.update({
        where: { id: product.id },
        data: { stock: body.countedQty },
      });
      return record;
    });
    await this.audit(
      operator,
      'inventory.stocktake',
      'product',
      product.id,
      { stock: product.stock },
      { stock: body.countedQty, delta, txnId: txn.id },
      campusId,
    );
    return {
      productId: product.id,
      before: product.stock,
      countedQty: body.countedQty,
      delta,
      applied: true,
    };
  }
  /**
   * 采购申请列表（IKD6FJ）：校区看本校区，hq 跨校区（附校区名）。
   * status 空查全部；默认按提交时间倒序。
   */
  // ==================== 订货批次（IKFOQ0 2026-09-15 grilling 定版）====================
  // 批次=总部起止窗口+可订商品范围；校区一批次一张订货单按件订（unitsPerCase
  // 快照换算）；审核确认不锁库存（IKJC1R 订货驱动采购），发货只扣实库（IKFOQ2）。

  /** 批次阶段（grilling #9）：时间窗推导 + 手动关闭，不落状态字段。 */
  private restockPhase(b: {
    startAt: Date;
    endAt: Date;
    closedAt: Date | null;
  }) {
    if (b.closedAt) return 'closed' as const;
    const now = Date.now();
    if (now < b.startAt.getTime()) return 'upcoming' as const;
    if (now > b.endAt.getTime()) return 'ended' as const;
    return 'open' as const;
  }

  private restockBatchView(b: {
    id: string;
    name: string;
    startAt: Date;
    endAt: Date;
    closedAt: Date | null;
    createdBy: string;
    createdByName: string;
    createdAt: Date;
  }) {
    return { ...b, phase: this.restockPhase(b) };
  }

  /** 官方库在售全集（IKFOQ0 第二轮：批次范围恒等此集合，不再勾选落快照）。 */
  private officialOnSaleProducts() {
    return this.db.product.findMany({
      // IKKRMX：批次范围=平台目录在售行，组织目录行（同落伪校区）不入池
      where: {
        campusId: OFFICIAL_CAMPUS_ID,
        status: 'on-sale',
        organizationId: null,
      },
      select: {
        id: true,
        name: true,
        price: true,
        image: true,
        retailUnit: true,
        wholesaleUnit: true,
        unitsPerCase: true,
        status: true,
        // IKG7B9：订货单编辑器商品筛选（类别下拉）需要类别归属
        categoryId: true,
        category: { select: { name: true } },
      },
      orderBy: { name: 'asc' },
    });
  }

  async restockBatches(hqScope: boolean, campusId: string) {
    const rows = await this.db.restockBatch.findMany({
      orderBy: { startAt: 'desc' },
    });
    const orders = await this.db.restockOrder.findMany({
      where: hqScope ? {} : { campusId },
      select: { batchId: true, status: true },
    });
    const agg = new Map<
      string,
      {
        orderTotal: number;
        orderConfirmed: number;
        orderShipped: number;
        orderReceived: number;
      }
    >();
    for (const o of orders) {
      const cur = agg.get(o.batchId) ?? {
        orderTotal: 0,
        orderConfirmed: 0,
        orderShipped: 0,
        orderReceived: 0,
      };
      cur.orderTotal += 1;
      // IKFOQ2：shipped/received 是 confirmed 的下游态，统计按最远进度
      if (['confirmed', 'shipped', 'received'].includes(o.status))
        cur.orderConfirmed += 1;
      if (['shipped', 'received'].includes(o.status)) cur.orderShipped += 1;
      if (o.status === 'received') cur.orderReceived += 1;
      agg.set(o.batchId, cur);
    }
    return rows.map((b) => ({
      ...this.restockBatchView(b),
      orderTotal: agg.get(b.id)?.orderTotal ?? 0,
      orderConfirmed: agg.get(b.id)?.orderConfirmed ?? 0,
      orderShipped: agg.get(b.id)?.orderShipped ?? 0,
      orderReceived: agg.get(b.id)?.orderReceived ?? 0,
    }));
  }

  async createRestockBatch(body: CreateRestockBatchDto, operator: string) {
    const startAt = new Date(body.startAt);
    const endAt = new Date(body.endAt);
    if (endAt <= startAt)
      throw new BadRequestException('结束时间必须晚于开始时间');
    const account = await this.db.adminAccount.findUnique({
      where: { id: operator },
      select: { nickname: true },
    });
    const row = await this.db.restockBatch.create({
      data: {
        name: body.name.trim(),
        startAt,
        endAt,
        createdBy: operator,
        createdByName: account?.nickname ?? '',
      },
    });
    await this.audit(
      operator,
      'restock.batch-create',
      'restock-batch',
      row.id,
      null,
      { name: row.name, startAt, endAt },
      HQ_CAMPUS_ID,
    );
    return this.restockBatchView(row);
  }

  async updateRestockBatch(
    id: string,
    body: UpdateRestockBatchDto,
    operator: string,
  ) {
    const before = await this.db.restockBatch.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('订货批次不存在');
    const phase = this.restockPhase(before);
    if (phase === 'ended' || phase === 'closed')
      throw new BadRequestException('批次已结束或已关闭，不可修改');
    const startAt = body.startAt ? new Date(body.startAt) : before.startAt;
    const endAt = body.endAt ? new Date(body.endAt) : before.endAt;
    if (endAt <= startAt)
      throw new BadRequestException('结束时间必须晚于开始时间');
    const row = await this.db.restockBatch.update({
      where: { id },
      data: { name: body.name?.trim() ?? before.name, startAt, endAt },
    });
    await this.audit(
      operator,
      'restock.batch-update',
      'restock-batch',
      id,
      { name: before.name, startAt: before.startAt, endAt: before.endAt },
      { name: row.name, startAt, endAt },
      HQ_CAMPUS_ID,
    );
    return this.restockBatchView(row);
  }

  async closeRestockBatch(id: string, operator: string) {
    const before = await this.db.restockBatch.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('订货批次不存在');
    if (before.closedAt) return this.restockBatchView(before); // 幂等
    const row = await this.db.restockBatch.update({
      where: { id },
      data: { closedAt: new Date() },
    });
    await this.audit(
      operator,
      'restock.batch-close',
      'restock-batch',
      id,
      { closedAt: null },
      { closedAt: row.closedAt },
      HQ_CAMPUS_ID,
    );
    return this.restockBatchView(row);
  }

  /** 批次详情：可订商品=官方在售实时全集（IKFOQ0 第二轮恒等全集）+ 订货单。 */
  async restockBatchDetail(id: string, hqScope: boolean, campusId: string) {
    const batch = await this.db.restockBatch.findUnique({ where: { id } });
    if (!batch) throw new NotFoundException('订货批次不存在');
    const items = (await this.officialOnSaleProducts()).map((p) => ({
      productId: p.id,
      product: p,
    }));
    const orders = await this.db.restockOrder.findMany({
      where: hqScope ? { batchId: id } : { batchId: id, campusId },
      include: {
        campus: { select: { id: true, name: true, shortName: true } },
        items: true,
        shipment: { select: { shippedAt: true, receivedAt: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });
    // IKFOQ1 毛利预估：批发价合计（confirmed 单，实时价）− 全部采购单已收金额
    const confirmedItems = orders
      .filter((o) => o.status === 'confirmed')
      .flatMap((o) => o.items);
    const priceById = new Map(
      (
        await this.db.product.findMany({
          where: {
            id: { in: [...new Set(confirmedItems.map((i) => i.productId))] },
          },
          select: { id: true, price: true },
        })
      ).map((p) => [p.id, p.price]),
    );
    const wholesaleTotal = confirmedItems.reduce(
      (sum, i) =>
        sum + i.cases * i.unitsPerCase * (priceById.get(i.productId) ?? 0),
      0,
    );
    const pos = hqScope
      ? await this.db.purchaseOrder.findMany({
          where: { batchId: id },
          select: {
            id: true,
            closedAt: true,
            items: {
              select: {
                receivedCases: true,
                unitCost: true,
                unitsPerCase: true,
              },
            },
          },
        })
      : [];
    // IKFOPR 按听报价：已收金额=件数×听数×每听单价
    const purchaseReceivedTotal = pos.reduce(
      (sum, po) =>
        sum +
        po.items.reduce(
          (s2, i) => s2 + i.receivedCases * i.unitCost * i.unitsPerCase,
          0,
        ),
      0,
    );
    return {
      ...this.restockBatchView(batch),
      items,
      wholesaleTotal,
      // 采购和毛利是平台财务数据，校区只能读取自己的订货金额。
      ...(hqScope
        ? {
            purchaseReceivedTotal,
            grossEstimate: wholesaleTotal - purchaseReceivedTotal,
          }
        : {}),
      orders: orders.map((o) => ({
        id: o.id,
        campusId: o.campusId,
        campusName: o.campus.name,
        campusShortName: o.campus.shortName,
        status: o.status,
        shippedAt: o.shipment?.shippedAt ?? null,
        receivedAt: o.shipment?.receivedAt ?? null,
        totalCases: o.items.reduce((s, i) => s + i.cases, 0),
        totalUnits: o.items.reduce((s, i) => s + i.cases * i.unitsPerCase, 0),
        submitByName: o.submitByName,
        submittedAt: o.submittedAt,
        auditByName: o.auditByName,
        auditNote: o.auditNote,
        auditAt: o.auditAt,
        items: o.items,
      })),
    };
  }

  async restockOrders(
    hqScope: boolean,
    campusId: string,
    query: { batchId?: string; status?: string },
  ) {
    const rows = await this.db.restockOrder.findMany({
      where: {
        ...(hqScope ? {} : { campusId }),
        ...(query.batchId ? { batchId: query.batchId } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      include: {
        batch: {
          select: {
            id: true,
            name: true,
            startAt: true,
            endAt: true,
            closedAt: true,
          },
        },
        campus: { select: { id: true, name: true, shortName: true } },
        items: true,
        shipment: { select: { shippedAt: true, receivedAt: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map((o) => ({
      id: o.id,
      batchId: o.batchId,
      batchName: o.batch.name,
      batchPhase: this.restockPhase(o.batch),
      campusId: o.campusId,
      campusName: o.campus.name,
      campusShortName: o.campus.shortName,
      status: o.status,
      shippedAt: o.shipment?.shippedAt ?? null,
      receivedAt: o.shipment?.receivedAt ?? null,
      totalCases: o.items.reduce((s, i) => s + i.cases, 0),
      totalUnits: o.items.reduce((s, i) => s + i.cases * i.unitsPerCase, 0),
      itemCount: o.items.length,
      submitByName: o.submitByName,
      submittedAt: o.submittedAt,
      auditByName: o.auditByName,
      auditNote: o.auditNote,
      auditAt: o.auditAt,
      updatedAt: o.updatedAt,
    }));
  }

  /** 订货单详情（行含官方商品资料与换算）。校区只能看本校区单。 */
  async restockOrderDetail(id: string, hqScope: boolean, campusId: string) {
    const o = await this.db.restockOrder.findUnique({
      where: { id },
      include: {
        batch: {
          select: {
            id: true,
            name: true,
            startAt: true,
            endAt: true,
            closedAt: true,
          },
        },
        campus: { select: { id: true, name: true, shortName: true } },
        items: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                image: true,
                retailUnit: true,
                wholesaleUnit: true,
                unitsPerCase: true,
              },
            },
          },
        },
        shipment: true,
      },
    });
    if (!o) throw new NotFoundException('订货单不存在');
    if (!hqScope && o.campusId !== campusId)
      throw new ForbiddenException('只能查看本校区订货单');
    return {
      ...o,
      batchPhase: this.restockPhase(o.batch),
      batchName: o.batch.name,
      campusName: o.campus.name,
      campusShortName: o.campus.shortName,
    };
  }

  private async restockOrderForCampus(batchId: string, campusId: string) {
    const batch = await this.db.restockBatch.findUnique({
      where: { id: batchId },
    });
    if (!batch) throw new NotFoundException('订货批次不存在');
    const phase = this.restockPhase(batch);
    if (phase !== 'open')
      throw new BadRequestException(
        phase === 'upcoming'
          ? '批次尚未开始，开始后才能订货'
          : '批次已结束或已关闭，不能再订货',
      );
    return batch;
  }

  /**
   * 提交订货单（IKJCJF 多单制）：填完即提交，每次生成一张新单（无草稿）；
   * 一批次一校区可多张，各自独立流转（审核/发货/到货）。
   * 商品必须是官方库在售行（IKFOQ0 第二轮恒等全集）。
   */
  async saveRestockOrder(
    batchId: string,
    body: SaveRestockOrderDto,
    operator: string,
    campusId: string,
  ) {
    await this.restockOrderForCampus(batchId, campusId);
    if (!body.items.length) throw new BadRequestException('请先填写订货商品');
    // 去重 + 行内校验；商品必须是官方库在售行（IKFOQ0 第二轮恒等全集）
    const seen = new Set<string>();
    const items = body.items.filter((i) => {
      if (seen.has(i.productId)) return false;
      seen.add(i.productId);
      return true;
    });
    const officials = await this.db.product.findMany({
      where: {
        id: { in: items.map((i) => i.productId) },
        campusId: OFFICIAL_CAMPUS_ID,
        status: 'on-sale',
        // IKKRMX：订货范围=平台目录行，组织目录行（同落伪校区）不可订
        organizationId: null,
      },
      select: { id: true, unitsPerCase: true },
    });
    if (officials.length !== items.length)
      throw new BadRequestException('部分商品不在官方库在售范围，无法订货');
    const unitsById = new Map(officials.map((p) => [p.id, p.unitsPerCase]));
    const account = await this.db.adminAccount.findUnique({
      where: { id: operator },
      select: { nickname: true },
    });
    const row = await this.db.$transaction(async (tx) => {
      const order = await tx.restockOrder.create({
        data: {
          batchId,
          campusId,
          status: 'submitted',
          submitBy: operator,
          submitByName: account?.nickname ?? '',
          submittedAt: new Date(),
          items: {
            create: items.map((i) => ({
              productId: i.productId,
              cases: i.cases,
              unitsPerCase: unitsById.get(i.productId) ?? 1,
              remark: i.remark?.trim() ?? '',
            })),
          },
        },
        include: {
          items: {
            include: {
              product: {
                select: {
                  id: true,
                  name: true,
                  image: true,
                  retailUnit: true,
                  wholesaleUnit: true,
                  unitsPerCase: true,
                },
              },
            },
          },
          // IKFOQ2：shipped 横幅+确认到货入口；received 展示到货时间
          shipment: {
            select: { id: true, shippedAt: true, receivedAt: true, note: true },
          },
        },
      });
      return order;
    });
    await this.audit(
      operator,
      'restock.order-submit',
      'restock-order',
      row.id,
      null,
      { status: 'submitted', itemCount: items.length },
      campusId,
    );
    return row;
  }

  /**
   * 校区删除订货单（IKJCJF，替代原撤回）：仅 submitted（总部审核前）可删，
   * 物理删除（连同行）；confirmed 起已进采购聚合不可删。
   */
  async deleteRestockOrder(
    orderId: string,
    operator: string,
    campusId: string,
  ) {
    const order = await this.db.restockOrder.findUnique({
      where: { id: orderId },
      select: { id: true, status: true, campusId: true },
    });
    if (!order || order.campusId !== campusId)
      throw new NotFoundException('订货单不存在');
    if (order.status !== 'submitted')
      throw new BadRequestException('只有待审核的订货单可以删除');
    await this.db.$transaction(async (tx) => {
      await tx.restockOrderItem.deleteMany({ where: { orderId } });
      await tx.restockOrder.delete({ where: { id: orderId } });
    });
    await this.audit(
      operator,
      'restock.order-delete',
      'restock-order',
      orderId,
      { status: 'submitted' },
      { deleted: true },
      campusId,
    );
    return { id: orderId, deleted: true };
  }

  /** 总部审核（IKJC1R 不锁库存）：confirm 确认、reject 驳回、revoke 撤销回待审核。 */
  async auditRestockOrder(
    orderId: string,
    body: AuditRestockOrderDto,
    operator: string,
  ) {
    const order = await this.db.restockOrder.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order) throw new NotFoundException('订货单不存在');
    const account = await this.db.adminAccount.findUnique({
      where: { id: operator },
      select: { nickname: true },
    });
    const note = body.note?.trim() ?? '';
    const auditData = {
      auditBy: operator,
      auditByName: account?.nickname ?? '',
      auditNote: note,
      auditAt: new Date(),
    };

    if (body.action === 'confirm') {
      if (order.status !== 'submitted')
        throw new BadRequestException('只有已提交的订货单可以确认');
      // IKJC1R（2026-09-30 道哥定稿）：订货=需求单驱动采购（先订后买），
      // 不再校验总部仓铺货/可用量、不再锁库存——货按订货量向供应商采购，
      // 到货经验收入库进总部仓（未铺货行自动建档）。
      const row = await this.db.restockOrder.update({
        where: { id: order.id },
        data: { status: 'confirmed', ...auditData },
      });
      await this.audit(
        operator,
        'restock.order-confirm',
        'restock-order',
        order.id,
        { status: order.status },
        { status: 'confirmed', note },
        order.campusId,
      );
      return { id: row.id, status: row.status };
    }

    if (body.action === 'reject') {
      if (order.status !== 'submitted')
        throw new BadRequestException('只有已提交的订货单可以驳回');
      const row = await this.db.restockOrder.update({
        where: { id: order.id },
        data: { status: 'rejected', ...auditData },
      });
      await this.audit(
        operator,
        'restock.order-reject',
        'restock-order',
        order.id,
        { status: order.status },
        { status: 'rejected', note },
        order.campusId,
      );
      return { id: row.id, status: row.status };
    }

    // revoke：confirmed → submitted（IKJC1R：无锁可释放，仅回状态）。
    // IKFOQ1：批次已生成采购单的订货单禁撤销——采购依据不能被抽走。
    if (order.status !== 'confirmed')
      throw new BadRequestException('只有已确认的订货单可以撤销确认');
    const poExists = await this.db.purchaseOrder.findFirst({
      where: { batchId: order.batchId },
      select: { id: true },
    });
    if (poExists)
      throw new BadRequestException(
        '该批次已生成采购单，订货单不能撤销确认；如需调整请走采购单关闭/重开',
      );
    // IKJC1R：确认已不锁库存，撤销对称不释放
    const row = await this.db.restockOrder.update({
      where: { id: order.id },
      data: { status: 'submitted', ...auditData },
    });
    await this.audit(
      operator,
      'restock.order-revoke',
      'restock-order',
      order.id,
      { status: 'confirmed' },
      { status: 'submitted', note },
      order.campusId,
    );
    return { id: row.id, status: 'submitted' as const };
  }

  // ==================== 采购单（IKFOQ1 2026-09-15 grilling 定版）====================
  // 批次已确认订货单一键聚合生成（供应商名称必填，一期不建档案）；快捷全收
  // （预填欠收可改小）；坏品入库再出库（到货全入库存，坏品自动出库扣回）；
  // 状态推导（待到货/部分到货/已收齐）+手动关闭可重开；金额=行单价×已收数量，
  // 行单价快照预填 costPrice 可改（IQ7）；批次详情预估毛利=批发价合计−已收金额（IQ8）。

  /** 采购单推导状态：closedAt 优先；已收 0 待到货 / 部分 / 已收齐（grilling #5）。 */
  private purchasePhase(
    po: { closedAt: Date | null },
    items: { requiredCases: number; receivedCases: number }[],
  ) {
    if (po.closedAt) return 'closed';
    const required = items.reduce((s, i) => s + i.requiredCases, 0);
    const received = items.reduce((s, i) => s + i.receivedCases, 0);
    if (received === 0) return 'pending';
    return received >= required ? 'completed' : 'partial';
  }

  async purchaseOrders() {
    const rows = await this.db.purchaseOrder.findMany({
      include: {
        batch: {
          select: {
            id: true,
            name: true,
            startAt: true,
            endAt: true,
            closedAt: true,
          },
        },
        items: {
          select: {
            requiredCases: true,
            receivedCases: true,
            badCases: true,
            unitCost: true,
            unitsPerCase: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((po) => {
      const requiredCases = po.items.reduce((s, i) => s + i.requiredCases, 0);
      const receivedCases = po.items.reduce((s, i) => s + i.receivedCases, 0);
      const badCases = po.items.reduce((s, i) => s + i.badCases, 0);
      return {
        id: po.id,
        batchId: po.batchId,
        batchName: po.batch.name,
        batchPhase: this.restockPhase(po.batch),
        supplierName: po.supplierName,
        phase: this.purchasePhase(po, po.items),
        lineCount: po.items.length,
        requiredCases,
        receivedCases,
        badCases,
        // 金额口径（IQ7+IKFOPR 按听报价）：行金额=件数×听数×每听单价
        totalCost: po.items.reduce(
          (s, i) => s + i.requiredCases * i.unitCost * i.unitsPerCase,
          0,
        ),
        receivedCost: po.items.reduce(
          (s, i) => s + i.receivedCases * i.unitCost * i.unitsPerCase,
          0,
        ),
        closedAt: po.closedAt,
        createdByName: po.createdByName,
        createdAt: po.createdAt,
        updatedAt: po.updatedAt,
      };
    });
  }

  /** 采购单详情（行含商品资料、应收/已收/欠收、单价）。 */
  async purchaseOrderDetail(id: string) {
    const po = await this.db.purchaseOrder.findUnique({
      where: { id },
      include: {
        batch: {
          select: {
            id: true,
            name: true,
            startAt: true,
            endAt: true,
            closedAt: true,
          },
        },
        items: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                image: true,
                retailUnit: true,
                wholesaleUnit: true,
              },
            },
          },
          orderBy: { id: 'asc' },
        },
      },
    });
    if (!po) throw new NotFoundException('采购单不存在');
    return {
      id: po.id,
      batchId: po.batchId,
      batchName: po.batch.name,
      batchPhase: this.restockPhase(po.batch),
      supplierName: po.supplierName,
      phase: this.purchasePhase(po, po.items),
      supplier: po.supplierName,
      closedAt: po.closedAt,
      closedNote: po.closedNote,
      closedByName: po.closedByName,
      createdByName: po.createdByName,
      createdAt: po.createdAt,
      items: po.items.map((i) => ({
        id: i.id,
        productId: i.productId,
        name: i.product.name,
        image: i.product.image,
        retailUnit: i.product.retailUnit,
        wholesaleUnit: i.product.wholesaleUnit,
        requiredCases: i.requiredCases,
        receivedCases: i.receivedCases,
        badCases: i.badCases,
        unitCost: i.unitCost,
        lastNote: i.lastNote,
        unitsPerCase: i.unitsPerCase,
      })),
    };
  }

  /** 一键聚合生成采购单（grilling #2）：行=该批次全部已确认订货单按商品求和。 */
  async createPurchaseOrder(
    batchId: string,
    body: CreatePurchaseOrderDto,
    operator: string,
  ) {
    const batch = await this.db.restockBatch.findUnique({
      where: { id: batchId },
    });
    if (!batch) throw new NotFoundException('订货批次不存在');
    const openPo = await this.db.purchaseOrder.findFirst({
      where: { batchId, closedAt: null },
      select: { id: true },
    });
    if (openPo)
      throw new BadRequestException(
        '该批次已有进行中的采购单，请先验收完毕或关闭后再生成（补采走新单）',
      );
    // 聚合快照：confirmed 订货单行按 productId 求 cases 和（应收以聚合为准）
    const confirmed = await this.db.restockOrder.findMany({
      where: { batchId, status: 'confirmed' },
      select: {
        items: { select: { productId: true, cases: true, unitsPerCase: true } },
      },
    });
    const agg = new Map<string, { cases: number; unitsPerCase: number }>();
    for (const o of confirmed) {
      for (const i of o.items) {
        const prev = agg.get(i.productId);
        agg.set(i.productId, {
          cases: (prev?.cases ?? 0) + i.cases,
          unitsPerCase: i.unitsPerCase,
        });
      }
    }
    if (!agg.size)
      throw new BadRequestException(
        '该批次还没有已确认的订货单，无法生成采购单',
      );
    const costByLine = new Map(
      body.lines.map((l) => [l.productId, l.unitCost]),
    );
    const unknown = body.lines
      .filter((l) => !agg.has(l.productId))
      .map((l) => l.productId);
    if (unknown.length)
      throw new BadRequestException('采购行包含不属于本批次已确认订货的商品');
    if (costByLine.size !== body.lines.length)
      throw new BadRequestException('采购行存在重复商品');
    // 行必须 ⊆ 聚合集合；允许部分行（关闭旧单后的补采可只采欠收部分，
    // 前端主入口仍按一键全量预填，IQ2 口径不变）
    // if 覆盖校验由前端全量预填保证，后端不硬拦部分行
    const account = await this.db.adminAccount.findUnique({
      where: { id: operator },
      select: { nickname: true },
    });
    const row = await this.db.purchaseOrder.create({
      data: {
        batchId,
        supplierName: body.supplierName.trim(),
        createdBy: operator,
        createdByName: account?.nickname ?? '',
        // 行集合=实际提交的 lines（应收数量/含量仍以聚合快照为准）；
        // 部分行补采单不再带出未采商品的 0 价行（IKFOQ2 修复）
        items: {
          create: body.lines.map((l) => ({
            productId: l.productId,
            requiredCases: agg.get(l.productId)!.cases,
            unitCost: costByLine.get(l.productId)!,
            unitsPerCase: agg.get(l.productId)!.unitsPerCase,
          })),
        },
      },
    });
    await this.audit(
      operator,
      'purchase.generate',
      'purchase-order',
      row.id,
      null,
      { batchId, supplierName: body.supplierName.trim(), lines: agg.size },
      '',
    );
    return { id: row.id };
  }

  /**
   * 验收入库（grilling #3/#4）：快捷全收（前端预填欠收可改小）；单事务内
   * 已收累计 + 总部仓入库 + 坏品自动出库 + 双流水；禁超收、已关闭拒收。
   */
  async receivePurchaseOrder(
    id: string,
    body: ReceivePurchaseOrderDto,
    operator: string,
  ) {
    const po = await this.db.purchaseOrder.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!po) throw new NotFoundException('采购单不存在');
    if (po.closedAt) throw new BadRequestException('采购单已关闭，不能再验收');
    const byProduct = new Map(po.items.map((i) => [i.productId, i]));
    const account = await this.db.adminAccount.findUnique({
      where: { id: operator },
      select: { nickname: true },
    });
    type Line = {
      item: (typeof po.items)[number];
      receive: number;
      bad: number;
      note: string;
    };
    const lines: Line[] = [];
    const seen = new Set<string>();
    for (const l of body.lines) {
      if (seen.has(l.productId)) continue;
      seen.add(l.productId);
      const item = byProduct.get(l.productId);
      if (!item)
        throw new BadRequestException('验收行包含不属于本采购单的商品');
      const shortage = item.requiredCases - item.receivedCases;
      if (l.receiveCases > shortage)
        throw new BadRequestException(
          `${item.productId} 超收：欠收仅 ${shortage} 件`,
        );
      if (l.badCases > l.receiveCases)
        throw new BadRequestException('坏品数不能大于本次到货数');
      if (l.receiveCases > 0)
        lines.push({
          item,
          receive: l.receiveCases,
          bad: l.badCases,
          note: l.note?.trim() ?? '',
        });
      else if (l.badCases > 0)
        throw new BadRequestException('未到货的行不能登记坏品');
    }
    if (!lines.length)
      throw new BadRequestException('本次验收数量全为 0，无需提交');
    // 总部仓铺货行定位（同锁定口径）：官方行 id → sourceProductId 反查。
    // IKJC1R：未铺货自动建总部仓行再入库（订货驱动采购——到货必能收）。
    const hqRows = await this.db.product.findMany({
      where: {
        campusId: HQ_CAMPUS_ID,
        sourceProductId: { in: lines.map((l) => l.item.productId) },
      },
      select: { id: true, sourceProductId: true, name: true },
    });
    const hqBySource = new Map(hqRows.map((r) => [r.sourceProductId, r]));
    await this.db.$transaction(async (tx) => {
      for (const l of lines) {
        const units = l.receive * l.item.unitsPerCase;
        const badUnits = l.bad * l.item.unitsPerCase;
        let hqId = hqBySource.get(l.item.productId)?.id;
        if (!hqId) {
          // 未铺货：复制官方资料建总部仓行（有货即铺，上架仍由总部仓自管）
          const official = await tx.product.findUnique({
            where: { id: l.item.productId },
          });
          if (!official)
            throw new BadRequestException(`商品不存在：${l.item.productId}`);
          const created = await tx.product.create({
            data: {
              campusId: HQ_CAMPUS_ID,
              categoryId: official.categoryId,
              name: official.name,
              subtitle: official.subtitle,
              price: official.price,
              originalPrice: official.originalPrice,
              costPrice: official.costPrice,
              wholesalePrice: official.price,
              procurementMode: 'HQ',
              stock: 0,
              tag: official.tag,
              image: official.image,
              images: (official.images as Prisma.InputJsonValue) ?? undefined,
              description: official.description,
              weight: official.weight,
              retailUnit: official.retailUnit,
              wholesaleUnit: official.wholesaleUnit,
              unitsPerCase: official.unitsPerCase,
              sales: 0,
              status: 'off-sale',
              sourceProductId: official.id,
              sourceSyncedAt: official.updatedAt,
            },
          });
          hqId = created.id;
        }
        await tx.product.update({
          where: { id: hqId },
          data: { stock: { increment: units - badUnits } },
        });
        if (units)
          await tx.inventoryTxn.create({
            data: {
              productId: hqId,
              type: 'purchase-receive',
              delta: units,
              reason: `采购验收入库：${po.supplierName}（单 ${po.id.slice(-6)}）`,
              operator,
            },
          });
        if (badUnits)
          await tx.inventoryTxn.create({
            data: {
              productId: hqId,
              type: 'purchase-bad',
              delta: -badUnits,
              reason: `采购坏品出库：${po.supplierName}（单 ${po.id.slice(-6)}）`,
              operator,
            },
          });
        await tx.purchaseOrderItem.update({
          where: { id: l.item.id },
          data: {
            receivedCases: { increment: l.receive },
            badCases: { increment: l.bad },
            lastNote: l.note,
          },
        });
      }
    });
    await this.audit(
      operator,
      'purchase.receive',
      'purchase-order',
      po.id,
      null,
      {
        lines: lines.map((l) => ({
          productId: l.item.productId,
          receive: l.receive,
          bad: l.bad,
        })),
      },
      '',
    );
    const fresh = await this.db.purchaseOrder.findUnique({
      where: { id },
      select: {
        items: { select: { requiredCases: true, receivedCases: true } },
        closedAt: true,
      },
    });
    return {
      id,
      phase: fresh ? this.purchasePhase(fresh, fresh.items) : 'pending',
    };
  }

  /** 关闭采购单：欠收作废禁验收（grilling #5），可重开继续收。 */
  async closePurchaseOrder(
    id: string,
    body: ClosePurchaseOrderDto,
    operator: string,
  ) {
    const po = await this.db.purchaseOrder.findUnique({ where: { id } });
    if (!po) throw new NotFoundException('采购单不存在');
    if (po.closedAt) throw new BadRequestException('采购单已关闭');
    const account = await this.db.adminAccount.findUnique({
      where: { id: operator },
      select: { nickname: true },
    });
    await this.db.purchaseOrder.update({
      where: { id },
      data: {
        closedAt: new Date(),
        closedNote: body.note?.trim() ?? '',
        closedBy: operator,
        closedByName: account?.nickname ?? '',
      },
    });
    await this.audit(
      operator,
      'purchase.close',
      'purchase-order',
      id,
      null,
      { note: body.note?.trim() ?? '' },
      '',
    );
    return { id, phase: 'closed' as const };
  }

  async reopenPurchaseOrder(id: string, operator: string) {
    const po = await this.db.purchaseOrder.findUnique({ where: { id } });
    if (!po) throw new NotFoundException('采购单不存在');
    if (!po.closedAt) throw new BadRequestException('采购单未关闭，无需重开');
    const openPo = await this.db.purchaseOrder.findFirst({
      where: { batchId: po.batchId, closedAt: null, id: { not: id } },
      select: { id: true },
    });
    if (openPo)
      throw new BadRequestException(
        '该批次已有另一张进行中的采购单，不能重开两张',
      );
    await this.db.purchaseOrder.update({
      where: { id },
      data: { closedAt: null, closedNote: '', closedBy: '', closedByName: '' },
    });
    await this.audit(
      operator,
      'purchase.reopen',
      'purchase-order',
      id,
      null,
      null,
      '',
    );
    return { id };
  }

  // ==================== 分拨发货（IKFOQ2 2026-09-15 grilling 定版）====================
  // 已确认订货单一对一整单发货（不拆包）：总部仓 stock/lockedStock 双降（确认时
  // 锁定转实扣），行落进货价/批发价快照（毛利② IKFOPR 数据源），出库流水
  // restock-out；不支持撤销（grilling #4，发错线下调）。校区确认到货按发货数
  // 全额入账（grilling #3 不登记差异），校区行缺失自动建（官方资料、下架态），
  // 入账流水 restock-in。

  async shipRestockOrder(
    id: string,
    body: ShipRestockOrderDto,
    operator: string,
  ) {
    const order = await this.db.restockOrder.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!order) throw new NotFoundException('订货单不存在');
    if (order.status !== 'confirmed')
      throw new BadRequestException('只有已确认的订货单可以发货');
    const shipped = await this.db.restockShipment.findUnique({
      where: { orderId: id },
      select: { id: true },
    });
    if (shipped) throw new BadRequestException('该订货单已发货');
    const account = await this.db.adminAccount.findUnique({
      where: { id: operator },
      select: { nickname: true },
    });
    // 总部仓行定位（同确认锁定口径）：官方行 id → sourceProductId 反查
    const hqRows = await this.db.product.findMany({
      where: {
        campusId: HQ_CAMPUS_ID,
        sourceProductId: { in: order.items.map((i) => i.productId) },
      },
      select: { id: true, sourceProductId: true, name: true, stock: true },
    });
    const hqBySource = new Map(hqRows.map((r) => [r.sourceProductId, r]));
    // 成本快照（口径 #4）：批次采购单实际成交价（IQ7 可改后的真实价）优先，
    // 多张采购单取最新一张；无采购单回退官方 costPrice
    const poItems = await this.db.purchaseOrderItem.findMany({
      where: {
        productId: { in: order.items.map((i) => i.productId) },
        order: { batchId: order.batchId },
      },
      select: {
        productId: true,
        unitCost: true,
        order: { select: { createdAt: true } },
      },
      orderBy: { order: { createdAt: 'desc' } },
    });
    const costBySource = new Map<string, number>();
    for (const pi of poItems)
      // 0 价视为未报价（防御：历史 0 价行不污染成本快照）
      if (pi.unitCost > 0 && !costBySource.has(pi.productId))
        costBySource.set(pi.productId, pi.unitCost);
    const officials = await this.db.product.findMany({
      where: { id: { in: order.items.map((i) => i.productId) } },
    });
    const officialById = new Map(officials.map((p) => [p.id, p]));
    // IKJC1R 追加（2026-09-30 道哥）：发货零校验——未铺货自动建行、库存不足
    // 照发（负库存=账实差异由盘点修），不再阻断。
    await this.db.$transaction(async (tx) => {
      const shipment = await tx.restockShipment.create({
        data: {
          orderId: order.id,
          batchId: order.batchId,
          campusId: order.campusId,
          note: body?.note?.trim() ?? '',
          shippedBy: operator,
          shippedByName: account?.nickname ?? '',
          items: {
            create: order.items.map((it) => ({
              productId: it.productId,
              cases: it.cases,
              unitsPerCase: it.unitsPerCase,
              // 每件价=听价×听数（IKFOPR 拍板按听报价）：行金额=件数×每件价，整除无尾差
              costPerCase:
                (costBySource.get(it.productId) ??
                  officialById.get(it.productId)?.costPrice ??
                  0) * it.unitsPerCase,
              wholesalePerCase:
                (officialById.get(it.productId)?.price ?? 0) * it.unitsPerCase,
            })),
          },
        },
      });
      for (const it of order.items) {
        const units = it.cases * it.unitsPerCase;
        // 未铺货自动建总部仓行（扣成负库存=账实差异，验收/盘点回正）
        let hqId = hqBySource.get(it.productId)?.id;
        if (!hqId) {
          const official = officialById.get(it.productId);
          if (!official)
            throw new BadRequestException(`商品不存在：${it.productId}`);
          const created = await tx.product.create({
            data: {
              campusId: HQ_CAMPUS_ID,
              categoryId: official.categoryId,
              name: official.name,
              subtitle: official.subtitle,
              price: official.price,
              originalPrice: official.originalPrice,
              costPrice: official.costPrice,
              wholesalePrice: official.price,
              procurementMode: 'HQ',
              stock: 0,
              tag: official.tag,
              image: official.image,
              images: (official.images as Prisma.InputJsonValue) ?? undefined,
              description: official.description,
              weight: official.weight,
              retailUnit: official.retailUnit,
              wholesaleUnit: official.wholesaleUnit,
              unitsPerCase: official.unitsPerCase,
              sales: 0,
              status: 'off-sale',
              sourceProductId: official.id,
              sourceSyncedAt: official.updatedAt,
            },
          });
          hqId = created.id;
        }
        // IKJC1R：确认环节已不锁库存，发货只扣实库（可负）
        await tx.product.update({
          where: { id: hqId },
          data: { stock: { decrement: units } },
        });
        await tx.inventoryTxn.create({
          data: {
            productId: hqId,
            type: 'restock-out',
            delta: -units,
            reason: `分拨发货（单 ${shipment.id.slice(-6)}）`,
            operator,
          },
        });
      }
      await tx.restockOrder.update({
        where: { id: order.id },
        data: { status: 'shipped' },
      });
    });
    await this.audit(
      operator,
      'restock.ship',
      'restock-order',
      order.id,
      { status: 'confirmed' },
      { status: 'shipped', note: body?.note?.trim() ?? '' },
      order.campusId,
    );
    return { id: order.id, status: 'shipped' as const };
  }

  /** 校区确认到货：按发货数全额入账；收货校区本人操作（hq 不代确认）。 */
  async confirmRestockReceipt(id: string, operator: string, campusId: string) {
    const order = await this.db.restockOrder.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!order) throw new NotFoundException('订货单不存在');
    if (!campusId || order.campusId !== campusId)
      throw new ForbiddenException('只有收货校区可以确认到货');
    const shipment = await this.db.restockShipment.findUnique({
      where: { orderId: id },
      include: { items: true },
    });
    if (!shipment || order.status !== 'shipped')
      throw new BadRequestException('只有已发货的订货单可以确认到货');
    const account = await this.db.adminAccount.findUnique({
      where: { id: operator },
      select: { nickname: true },
    });
    const officials = await this.db.product.findMany({
      where: { id: { in: order.items.map((i) => i.productId) } },
    });
    const officialById = new Map(officials.map((p) => [p.id, p]));
    const campusRows = await this.db.product.findMany({
      where: {
        campusId: order.campusId,
        sourceProductId: { in: order.items.map((i) => i.productId) },
      },
      select: { id: true, sourceProductId: true, procurementMode: true },
    });
    const campusBySource = new Map(
      campusRows.map((r) => [r.sourceProductId, r]),
    );
    await this.db.$transaction(async (tx) => {
      for (const it of order.items) {
        const units = it.cases * it.unitsPerCase;
        const official = officialById.get(it.productId);
        if (!official)
          throw new BadRequestException(
            `商品 ${it.productId} 官方资料缺失，无法入账`,
          );
        const campusRow = campusBySource.get(it.productId);
        let rowId = campusRow?.id;
        if (rowId) {
          if (campusRow?.procurementMode === 'LOCAL')
            throw new BadRequestException(
              `${official.name}是本地采购商品，不能接收总部订货`,
            );
          const accepted = await tx.product.updateMany({
            where: {
              id: rowId,
              OR: [{ procurementMode: null }, { procurementMode: 'HQ' }],
            },
            data: {
              stock: { increment: units },
              procurementMode: 'HQ',
            },
          });
          if (accepted.count !== 1)
            throw new BadRequestException(
              `${official.name}采购方式已变化，不能接收总部订货`,
            );
        } else {
          // 自动建档（grilling #2）：复制官方资料、下架态、库存=到货数，校区自己上架
          // 条码撞该校区已有自建行时置空（货已到入账优先，条码可人工补）
          const bcTaken = official.barcode
            ? await tx.product.findFirst({
                where: { campusId: order.campusId, barcode: official.barcode },
                select: { id: true },
              })
            : null;
          const created = await tx.product.create({
            data: {
              barcode: bcTaken ? null : official.barcode,
              campusId: order.campusId,
              categoryId: official.categoryId,
              name: official.name,
              subtitle: official.subtitle,
              price: official.price,
              originalPrice: official.originalPrice,
              costPrice: official.costPrice,
              wholesalePrice: official.price,
              procurementMode: 'HQ',
              stock: units,
              tag: official.tag,
              image: official.image,
              images: (official.images as Prisma.InputJsonValue) ?? undefined,
              description: official.description,
              weight: official.weight,
              retailUnit: official.retailUnit,
              wholesaleUnit: official.wholesaleUnit,
              unitsPerCase: official.unitsPerCase,
              sales: 0,
              status: 'off-sale',
              sourceProductId: official.id,
              sourceSyncedAt: official.updatedAt,
            },
          });
          rowId = created.id;
        }
        await tx.inventoryTxn.create({
          data: {
            productId: rowId,
            type: 'restock-in',
            delta: units,
            reason: `订货到货入账（单 ${shipment.id.slice(-6)}）`,
            operator,
          },
        });
      }
      await tx.restockShipment.update({
        where: { id: shipment.id },
        data: {
          receivedBy: operator,
          receivedByName: account?.nickname ?? '',
          receivedAt: new Date(),
        },
      });
      await tx.restockOrder.update({
        where: { id: order.id },
        data: { status: 'received' },
      });
    });
    await this.audit(
      operator,
      'restock.receipt',
      'restock-shipment',
      shipment.id,
      null,
      { orderId: order.id, lineCount: order.items.length },
      order.campusId,
    );
    return { id: order.id, status: 'received' as const };
  }

  // ==================== 总部经营日报（IKFOPR 2026-09-15 grilling 定版）====================
  // 实时聚合发货单：按到货确认时点（receivedAt）计收，只计闭环单，收入/成本
  // 同一张发货单同口径；行=日期×校区，毛利率万分比整数。不建跑批表
  // （T+1 语义=昨日数已落定不再变，聚合即对账）。

  async hqDailyReport(
    start: string,
    end: string,
    campusId?: string,
    // IKKRMY：无 cost.read 剔除成本/毛利列（结构性不可达防御，见文件头注释）
    costRead = true,
  ) {
    // 业务日界按北京时间切
    const startAt = new Date(`${start}T00:00:00+08:00`);
    const endAt = new Date(`${end}T23:59:59.999+08:00`);
    if (
      Number.isNaN(startAt.getTime()) ||
      Number.isNaN(endAt.getTime()) ||
      startAt > endAt
    )
      throw new BadRequestException('日期范围不合法');
    const shipments = await this.db.restockShipment.findMany({
      where: {
        receivedAt: { gte: startAt, lte: endAt },
        ...(campusId ? { campusId } : {}),
      },
      include: {
        items: {
          select: { cases: true, costPerCase: true, wholesalePerCase: true },
        },
        order: {
          select: { campus: { select: { name: true, shortName: true } } },
        },
      },
    });
    const agg = new Map<
      string,
      {
        date: string;
        campusId: string;
        campusName: string;
        campusShortName: string;
        shipments: number;
        wholesaleTotal: number;
        costTotal: number;
      }
    >();
    for (const s of shipments) {
      const date = new Date(s.receivedAt!.getTime() + 8 * 3600 * 1000)
        .toISOString()
        .slice(0, 10);
      const k = `${date}|${s.campusId}`;
      const cur = agg.get(k) ?? {
        date,
        campusId: s.campusId,
        campusName: s.order.campus.name,
        campusShortName: s.order.campus.shortName,
        shipments: 0,
        wholesaleTotal: 0,
        costTotal: 0,
      };
      cur.shipments += 1;
      cur.wholesaleTotal += s.items.reduce(
        (sum, i) => sum + i.cases * i.wholesalePerCase,
        0,
      );
      cur.costTotal += s.items.reduce(
        (sum, i) => sum + i.cases * i.costPerCase,
        0,
      );
      agg.set(k, cur);
    }
    const rows = [...agg.values()]
      .map((r) => {
        const gross = r.wholesaleTotal - r.costTotal;
        return {
          ...r,
          gross,
          marginRate: r.wholesaleTotal
            ? Math.round((gross / r.wholesaleTotal) * 10000)
            : 0,
        };
      })
      .sort((a, b) =>
        a.date < b.date
          ? 1
          : a.date > b.date
            ? -1
            : a.campusName.localeCompare(b.campusName, 'zh'),
      );
    const tWholesale = rows.reduce((s, r) => s + r.wholesaleTotal, 0);
    const tCost = rows.reduce((s, r) => s + r.costTotal, 0);
    const tGross = tWholesale - tCost;
    return costRead
      ? {
          totals: {
            shipments: rows.reduce((s, r) => s + r.shipments, 0),
            wholesaleTotal: tWholesale,
            costTotal: tCost,
            gross: tGross,
            marginRate: tWholesale
              ? Math.round((tGross / tWholesale) * 10000)
              : 0,
          },
          rows,
        }
      : // IKKRMY：无 cost.read 输出零成本口径（costTotal/gross/marginRate 剔除）
        trimReportCost({
          totals: {
            shipments: rows.reduce((s, r) => s + r.shipments, 0),
            wholesaleTotal: tWholesale,
            costTotal: tCost,
            gross: tGross,
            marginRate: tWholesale
              ? Math.round((tGross / tWholesale) * 10000)
              : 0,
          },
          rows,
        });
  }

  // ==================== 校区经营日报（IKFOPS）：C 端订单实时聚合 ====================
  // 口径（2026-09-16 道哥拍板，与 IKFOPR 同族）：paidAt 支付时间落日、只计 completed；
  // 销售额=payableAmount 实付；综合毛利=实付−配送费−成本（IKJ92S：配送费
  // 交付配送员属配送成本，不进毛利）；毛利=商品金额−成本（未扣券）；
  // 成本=IKFOPQ 行级 unitWholesaleCost 快照×数量（快照上线前历史单按 0 计）；
  // 实时聚合不建跑批表；行=日期×校区（校区角色查询天然单校区）。
  async campusDailyReport(
    start: string,
    end: string,
    opts: {
      campusId?: string;
      buildingId?: string;
      hqScope: boolean;
      userCampusId?: string;
      /** IKKRMY：无 cost.read 剔除成本/毛利口径字段（结构性不可达防御） */
      costRead?: boolean;
    },
  ) {
    // 业务日界按北京时间切
    const startAt = new Date(`${start}T00:00:00+08:00`);
    const endAt = new Date(`${end}T23:59:59.999+08:00`);
    if (
      Number.isNaN(startAt.getTime()) ||
      Number.isNaN(endAt.getTime()) ||
      startAt > endAt
    )
      throw new BadRequestException('日期范围不合法');
    // 数据范围：平台视角（hq/admin）可跨校区筛选；校区角色锁本校区
    const campusId = opts.hqScope ? opts.campusId : opts.userCampusId;
    const orders = await this.db.order.findMany({
      where: {
        status: 'completed',
        paidAt: { gte: startAt, lte: endAt },
        ...(campusId ? { campusId } : {}),
      },
      select: {
        campusId: true,
        paidAt: true,
        payableAmount: true,
        productAmount: true,
        deliveryFee: true,
        items: true,
        address: true,
        campus: { select: { name: true, shortName: true } },
      },
    });
    // 楼栋筛选：address Json 的 buildingId（老单缺失自然剔除）
    const scoped = opts.buildingId
      ? orders.filter(
          (o) =>
            (o.address as { buildingId?: string } | null)?.buildingId ===
            opts.buildingId,
        )
      : orders;
    const agg = new Map<
      string,
      {
        date: string;
        campusId: string;
        campusName: string;
        campusShortName: string;
        orders: number;
        salesTotal: number;
        productTotal: number;
        deliveryTotal: number;
        costTotal: number;
      }
    >();
    for (const o of scoped) {
      const date = new Date(o.paidAt!.getTime() + 8 * 3600 * 1000)
        .toISOString()
        .slice(0, 10);
      const k = `${date}|${o.campusId}`;
      const cur = agg.get(k) ?? {
        date,
        campusId: o.campusId,
        campusName: o.campus.name,
        campusShortName: o.campus.shortName,
        orders: 0,
        salesTotal: 0,
        productTotal: 0,
        deliveryTotal: 0,
        costTotal: 0,
      };
      cur.orders += 1;
      cur.salesTotal += o.payableAmount;
      // IKISZ2 商品金额合计（毛利未扣券口径的分母项）
      cur.productTotal += o.productAmount;
      // IKJ92S 配送费合计（综合毛利剔除项：交付配送员的配送成本）
      cur.deliveryTotal += o.deliveryFee;
      // 行成本=数量×IKFOPQ 每零售单位批发成本快照（缺快照按 0）
      cur.costTotal += (
        o.items as Array<{
          quantity: number;
          product?: { unitGrossCost?: number; unitWholesaleCost?: number };
        }>
      ).reduce(
        (sum, line) =>
          sum +
          line.quantity *
            (line.product?.unitGrossCost ??
              line.product?.unitWholesaleCost ??
              0),
        0,
      );
      agg.set(k, cur);
    }
    const rows = [...agg.values()]
      .map((r) => {
        // IKISZ2 双口径：毛利=商品金额−成本（未扣券，同详情逐行加总）；
        // gross=综合毛利=实付−配送费−成本（IKJ92S：剔除交付配送员的配送费）；
        // marginRawRate=毛利率（未扣券基数=商品金额），marginRate=综合毛利率（基数=实付）
        const gross = r.salesTotal - r.deliveryTotal - r.costTotal;
        const marginTotal = r.productTotal - r.costTotal;
        return {
          ...r,
          marginTotal,
          gross,
          marginRawRate: r.productTotal
            ? Math.round((marginTotal / r.productTotal) * 10000)
            : 0,
          marginRate: r.salesTotal
            ? Math.round((gross / r.salesTotal) * 10000)
            : 0,
        };
      })
      .sort((a, b) =>
        a.date < b.date
          ? 1
          : a.date > b.date
            ? -1
            : a.campusName.localeCompare(b.campusName, 'zh'),
      );
    const tSales = rows.reduce((s, r) => s + r.salesTotal, 0);
    const tCost = rows.reduce((s, r) => s + r.costTotal, 0);
    const tDelivery = rows.reduce((s, r) => s + r.deliveryTotal, 0);
    const tGross = tSales - tDelivery - tCost;
    const tMargin = rows.reduce((s, r) => s + r.marginTotal, 0);
    // IKISZ2+：合计毛利率按合计金额重算（非行均值），productTotal 随 rows 带出
    const tProduct = rows.reduce((s, r) => s + (r.productTotal ?? 0), 0);
    // IKKRMY：无 cost.read 输出零成本口径（costTotal/毛利额/毛利率全剔除）
    if (opts.costRead === false)
      return trimReportCost({
        totals: {
          orders: rows.reduce((s, r) => s + r.orders, 0),
          salesTotal: tSales,
          costTotal: tCost,
          productTotal: tProduct,
          marginTotal: tMargin,
          gross: tGross,
          marginRawRate: tProduct
            ? Math.round((tMargin / tProduct) * 10000)
            : 0,
          marginRate: tSales ? Math.round((tGross / tSales) * 10000) : 0,
        },
        rows,
      });
    return {
      totals: {
        orders: rows.reduce((s, r) => s + r.orders, 0),
        salesTotal: tSales,
        costTotal: tCost,
        productTotal: tProduct,
        marginTotal: tMargin,
        gross: tGross,
        marginRawRate: tProduct ? Math.round((tMargin / tProduct) * 10000) : 0,
        marginRate: tSales ? Math.round((tGross / tSales) * 10000) : 0,
      },
      rows,
    };
  }

  // ==================== 营销作战地图（IKFOQ3）：寝室级下单覆盖 ====================
  // 口径（2026-09-17 道哥拍板）：🟢 paidAt 非空即算已下单（付过钱=被触达，含退款/
  // 履约中）；🟡 有注册用户（Address buildingId+roomNo 二元匹配，roomNo 全楼唯一）
  // 但无订单；⚪ 均无=未开发。实时聚合不建跑批表。
  private async battleMapBuildingChecked(campusId: string, buildingId: string) {
    const building = await this.db.building.findUnique({
      where: { id: buildingId },
    });
    // 防串校区：校区级恒本校区；空串=平台全校区视角放行（IKISDN 页内选校区）
    if (!building || (campusId && building.campusId !== campusId))
      throw new NotFoundException('楼栋不存在');
    return building;
  }

  async battleMapBuilding(campusId: string, buildingId: string) {
    const building = await this.battleMapBuildingChecked(campusId, buildingId);
    const rooms = await this.db.room.findMany({
      where: { buildingId },
      orderBy: [{ floor: 'asc' }, { roomNo: 'asc' }],
      select: { id: true, floor: true, roomNo: true },
    });
    // 已支付订单按房号聚合（address Json 的 buildingId+room 二元匹配）
    const orders = await this.db.order.findMany({
      where: {
        paidAt: { not: null },
        address: { path: ['buildingId'], equals: buildingId },
      },
      select: { address: true },
    });
    const ordersByRoom = new Map<string, number>();
    for (const o of orders) {
      const room = (o.address as { room?: string } | null)?.room ?? '';
      ordersByRoom.set(room, (ordersByRoom.get(room) ?? 0) + 1);
    }
    // 注册用户按房号聚合（去重：一人多地址同寝室只算一次）
    const addrs = await this.db.address.findMany({
      where: { buildingId },
      select: { room: true, userId: true },
    });
    const usersByRoom = new Map<string, Set<string>>();
    for (const a of addrs) {
      const set = usersByRoom.get(a.room) ?? new Set<string>();
      set.add(a.userId);
      usersByRoom.set(a.room, set);
    }
    // 按楼层组装：格子三色 + 汇总
    const floorMap = new Map<
      number,
      {
        floor: number;
        total: number;
        ordered: number;
        registered: number;
        fresh: number;
        rooms: Array<{
          roomId: string;
          roomNo: string;
          status: 'ordered' | 'registered' | 'fresh';
          userCount: number;
          orderCount: number;
        }>;
      }
    >();
    for (const r of rooms) {
      const f = floorMap.get(r.floor) ?? {
        floor: r.floor,
        total: 0,
        ordered: 0,
        registered: 0,
        fresh: 0,
        rooms: [],
      };
      f.total += 1;
      const userCount = usersByRoom.get(r.roomNo)?.size ?? 0;
      const orderCount = ordersByRoom.get(r.roomNo) ?? 0;
      const status =
        orderCount > 0 ? 'ordered' : userCount > 0 ? 'registered' : 'fresh';
      if (status === 'ordered') f.ordered += 1;
      else if (status === 'registered') f.registered += 1;
      else f.fresh += 1;
      f.rooms.push({
        roomId: r.id,
        roomNo: r.roomNo,
        status,
        userCount,
        orderCount,
      });
      floorMap.set(r.floor, f);
    }
    return {
      building: { id: building.id, name: building.name },
      floors: [...floorMap.values()].map((f) => ({
        ...f,
        coverageRate: f.total ? Math.round((f.ordered / f.total) * 10000) : 0,
      })),
    };
  }

  async battleMapRoom(campusId: string, roomId: string) {
    const room = await this.db.room.findUnique({ where: { id: roomId } });
    if (!room) throw new NotFoundException('寝室不存在');
    await this.battleMapBuildingChecked(campusId, room.buildingId);
    // 寝室注册用户（Address 归属去重）
    const addrs = await this.db.address.findMany({
      where: { buildingId: room.buildingId, room: room.roomNo },
      select: { userId: true },
    });
    const userIds = [...new Set(addrs.map((a) => a.userId))];
    const users = userIds.length
      ? await this.db.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, nickname: true, phone: true, createdAt: true },
          orderBy: { createdAt: 'asc' },
        })
      : [];
    // 每人已支付订单统计：累计 + 近 30 天（高频=近 30 天 ≥3）
    const since = new Date(Date.now() - 30 * 86400 * 1000);
    const [totalByUser, recentByUser, roomOrders] = await Promise.all([
      this.db.order.groupBy({
        by: ['userId'],
        where: { userId: { in: userIds }, paidAt: { not: null } },
        _count: { _all: true },
        _sum: { payableAmount: true },
      }),
      this.db.order.groupBy({
        by: ['userId'],
        where: { userId: { in: userIds }, paidAt: { gte: since, not: null } },
        _count: { _all: true },
      }),
      // 该寝室的已支付订单数（按订单地址 buildingId+room 匹配，与格子绿态同口径；
      // Json filter 不支持字段内 AND，顶层 AND 组合两个 Json 条件）
      this.db.order.count({
        where: {
          paidAt: { not: null },
          AND: [
            { address: { path: ['buildingId'], equals: room.buildingId } },
            { address: { path: ['room'], equals: room.roomNo } },
          ],
        },
      }),
    ]);
    const totalMap = new Map(totalByUser.map((x) => [x.userId, x]));
    const recentMap = new Map(
      recentByUser.map((x) => [x.userId, x._count._all]),
    );
    return {
      room: { id: room.id, roomNo: room.roomNo, floor: room.floor },
      orderCount: roomOrders,
      users: users.map((u) => {
        const total = totalMap.get(u.id);
        const recent = recentMap.get(u.id) ?? 0;
        return {
          userId: u.id,
          nickname: u.nickname,
          phone: this.maskPhone(u.phone),
          registeredAt: u.createdAt.toISOString(),
          orderCount: total?._count._all ?? 0,
          totalAmount: total?._sum.payableAmount ?? 0,
          recentCount: recent,
          highFrequency: recent >= 3,
        };
      }),
    };
  }

  /** 发货单详情（按订货单）：行快照价+发货/收货信息。校区限本单。 */
  async restockShipmentDetail(
    orderId: string,
    hqScope: boolean,
    campusId: string,
  ) {
    const shipment = await this.db.restockShipment.findUnique({
      where: { orderId },
      include: {
        items: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                image: true,
                retailUnit: true,
                wholesaleUnit: true,
              },
            },
          },
          orderBy: { id: 'asc' },
        },
        order: {
          select: {
            campusId: true,
            status: true,
            campus: { select: { name: true, shortName: true } },
          },
        },
        batch: { select: { name: true } },
      },
    });
    if (!shipment) throw new NotFoundException('发货单不存在');
    if (!hqScope && shipment.order.campusId !== campusId)
      throw new ForbiddenException('只能查看本校区发货单');
    return {
      id: shipment.id,
      orderId: shipment.orderId,
      orderStatus: shipment.order.status,
      batchId: shipment.batchId,
      batchName: shipment.batch.name,
      campusName: shipment.order.campus.name,
      campusShortName: shipment.order.campus.shortName,
      note: shipment.note,
      shippedByName: shipment.shippedByName,
      shippedAt: shipment.shippedAt,
      receivedByName: shipment.receivedByName,
      receivedAt: shipment.receivedAt,
      totalCases: shipment.items.reduce((s, i) => s + i.cases, 0),
      totalUnits: shipment.items.reduce(
        (s, i) => s + i.cases * i.unitsPerCase,
        0,
      ),
      // IKFOPR 单据毛利（每件价口径）：批发金额−进货金额，gross=两者差
      wholesaleTotal: shipment.items.reduce(
        (s, i) => s + i.cases * i.wholesalePerCase,
        0,
      ),
      costTotal: shipment.items.reduce(
        (s, i) => s + i.cases * i.costPerCase,
        0,
      ),
      items: shipment.items.map((i) => ({
        productId: i.productId,
        name: i.product.name,
        image: i.product.image,
        retailUnit: i.product.retailUnit,
        wholesaleUnit: i.product.wholesaleUnit,
        cases: i.cases,
        unitsPerCase: i.unitsPerCase,
        costPerCase: i.costPerCase,
        wholesalePerCase: i.wholesalePerCase,
      })),
    };
  }

  async inventoryTxns(productId: string | undefined, campusId: string) {
    const rows = await this.db.inventoryTxn.findMany({
      where: {
        product: { campusId },
        ...(productId ? { productId } : {}),
      },
      include: { product: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    // IKDG9X：操作人人话化（同审计日志 IKB5P8）——operator 为 AdminAccount.id，
    // 批量解析昵称/账号名；miss（历史/已删账号）回退原值可追查
    const names = await this.operatorNames(rows.map((x) => x.operator));
    return rows.map((x) => ({
      ...x,
      operatorName: names.get(x.operator) ?? x.operator,
    }));
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
  async orders(
    status: string | undefined,
    campusId: string,
    deliveryMode?: string,
    start?: string,
    end?: string,
    // IKKRMY：无 cost.read 时 items 行内成本快照/估算字段剔除（毛利列口径来源）
    costRead = true,
  ) {
    const statuses =
      status && status !== 'all'
        ? status
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
    const xs = await this.db.order.findMany({
      where: {
        ...(campusId ? { campusId } : {}),
        ...(statuses.length ? { status: { in: statuses } } : {}),
        // IKD6FG：配送方式筛选（instant/scheduled）
        ...(deliveryMode ? { deliveryMode } : {}),
        // IKJ9XQ 对账：创建时间范围（北京时间日界，与列表「下单时间」列同字段）
        ...(start || end
          ? {
              createdAt: {
                ...(start ? { gte: new Date(`${start}T00:00:00+08:00`) } : {}),
                ...(end ? { lte: new Date(`${end}T23:59:59.999+08:00`) } : {}),
              },
            }
          : {}),
      },
      include: {
        user: { select: { id: true, nickname: true, phone: true } },
        // warehouseName：小票票头（IKBT6N）
        campus: {
          select: { name: true, shortName: true, warehouseName: true },
        },
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
          select: {
            id: true,
            location: true,
            locationCode: true,
            // IKFTK7 第三轮：历史单毛利估算用进货价（换算成每零售单位，与快照同口径）
            costPrice: true,
            unitsPerCase: true,
          },
        })
      : [];
    const locationById = new Map(locationRows.map((p) => [p.id, p]));
    const mapped = xs.map((x) => ({
      ...x,
      items: ((x.items as any as Array<{ product?: object }>) ?? []).map(
        (line) => {
          const live = line?.product
            ? locationById.get((line.product as { id?: string }).id ?? '')
            : undefined;
          // IKFTK7 第三轮（道哥拍板）：毛利成本口径 = 进货价。快照前历史单无
          // unitPurchaseCost 时补当前每单位进货成本供前端标「估算」展示；
          // 有快照的行绝不覆盖（快照是毛利的唯一精确口径）。
          // 进货价 0 = 成本 0 照补（道哥 2026-09-15：0 就按 0 计算，毛利=实收）
          const snapshotCost = (
            line?.product as { unitPurchaseCost?: number } | undefined
          )?.unitPurchaseCost;
          let estimate: number | undefined;
          if (live && snapshotCost == null) {
            estimate = perRetailUnitCostFen(live.costPrice, live.unitsPerCase);
          }
          return {
            ...line,
            product: {
              ...line.product,
              ...(live
                ? {
                    location: live.location,
                    locationCode: live.locationCode,
                    ...(estimate != null
                      ? { currentUnitPurchaseCost: estimate }
                      : {}),
                  }
                : {}),
            },
          };
        },
      ),
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
    // IKKRMY：成本快照字段输出层裁剪（无 cost.read 不可见，前端毛利列同源隐藏）
    return costRead ? mapped : mapped.map((row) => trimOrderCost(row));
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
  /**
   * 新订单水位线（IKHFWV 30s 轮询）：今日（上海时区）已支付累计数 + 最新一单摘要。
   * 累计口径（paidAt ≥ 今日0点 count）不随状态流转回落——增量即新单，防漏报。
   */
  async newOrderWatch(campusId: string) {
    const start = new Date();
    start.setUTCHours(16, 0, 0, 0); // 上海 00:00 = UTC 16:00（前一日）
    if (start.getTime() > Date.now())
      start.setTime(start.getTime() - 86400_000);
    const where = { paidAt: { gte: start }, ...(campusId ? { campusId } : {}) };
    const [count, latest] = await Promise.all([
      this.db.order.count({ where }),
      this.db.order.findFirst({
        where,
        orderBy: { paidAt: 'desc' },
        select: { id: true, orderNo: true, payableAmount: true },
      }),
    ]);
    return { todayPaid: count, latest };
  }
  async order(id: string, campusId: string, costRead = true) {
    const x = await this.db.order.findFirst({
      where: { id, ...(campusId ? { campusId } : {}) },
    });
    if (!x) throw new NotFoundException('订单不存在');
    // IKKRMY：订单详情同列表口径——无 cost.read 剔除行内成本快照（内部
    // 调用方（orderAction/补打小票）走缺省 true，不受影响）
    return costRead ? x : trimOrderCost(x);
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
   * 补打小票（IKBT6N）：芯烨云重推订单小票（支付成功时已自动打，本端点兜底
   * 缺纸/卡纸重打场景）。校区隔离复用 this.order；写审计日志留痕。
   * 补打跟随绑定打印机联数（IKCZOX）：补=重现整套票。
   */
  async reprintReceipt(id: string, operator: string, campusId: string) {
    if (!this.printer?.accountConfigured)
      throw new BadRequestException(
        '打印机未配置，请联系平台管理员配置芯烨云凭证',
      );
    const order = (await this.order(id, campusId)) as Record<string, any>;
    // IKBW0Q：校区绑定打印机优先，未绑定回落 env 试点单机；copies 随绑定带出；
    // IKFFHO：联间发送间隔随绑定带出（补打同样应用间隔）
    const bound = await this.db.printer.findUnique({
      where: { campusId: order.campusId },
      select: { sn: true, status: true, copies: true, copiesGapSeconds: true },
    });
    const active = bound && bound.status === 'active' ? bound : null;
    if (!active?.sn)
      throw new BadRequestException(
        '本校区尚未绑定打印机，请先在「打印机」页绑定',
      );
    const campus = await this.db.campus.findUnique({
      where: { id: order.campusId },
      select: { warehouseName: true },
    });
    const receiptContext = {
      id: order.id,
      orderNo: order.orderNo,
      campusId: order.campusId,
      // IKHFDZ：带出已有序号→printOrderReceipt 复用（补打同单同号）
      dailySeq: order.dailySeq,
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
    };
    // IKD6H4：库位实时注入（分拣备货单要「现在放哪」）
    receiptContext.items = await this.printer.attachLocations(
      receiptContext.items,
    );
    await this.printer.printOrderReceipt(
      receiptContext,
      active.sn,
      active.copies,
      active.copiesGapSeconds,
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
  async bindPrinter(body: BindPrinterDto, operator: string, campusId: string) {
    if (!campusId) throw new BadRequestException('仅校区账号可绑定打印机');
    if (!this.printer) throw new BadRequestException('打印服务未启用');
    // IKC3FF：芯烨云无按台密钥，绑定只凭 SN（归属校验在云端）
    await this.printer.addPrinter(body.sn, body.name);
    let row;
    try {
      // IKCZOX：copies 随绑定表单落库（缺省 1=旧票面）；
      // IKFFHO：联间发送间隔随表单落库（缺省 0=单次 POST 拼联）
      const copies = body.copies ?? 1;
      const copiesGapSeconds = body.copiesGapSeconds ?? 0;
      row = await this.db.printer.upsert({
        where: { campusId },
        create: {
          campusId,
          name: body.name,
          sn: body.sn,
          key: '',
          copies,
          copiesGapSeconds,
        },
        update: {
          name: body.name,
          sn: body.sn,
          key: '',
          copies,
          copiesGapSeconds,
          status: 'active',
        },
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
    if (!this.printer) throw new BadRequestException('打印服务未启用');
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
   * 手动改订单状态（IKA0UT）：运营兜底工具（异常处理/客服纠偏）。仅接受
   * 12 态白名单，statusText 用标准文案，原因写入审计日志（after.reason）留痕。
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
    // 2026-09-09：手动置「已到楼下待交接」与履约端 arrive 同口径——补推该楼栋
    // 全部楼长/实习楼长订阅消息（fire-and-forget 静默；上方同态早退已兜住幂等）。
    // 道哥 2026-09-09：配送中（first-mile）同样补推，双时点与履约端一致。
    if (body.status === 'waiting-handover')
      void this.push?.notifyManagerOnArrive(id);
    if (body.status === 'first-mile')
      void this.push?.notifyManagersOnDepart(id);
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
    await this.audit(
      operator,
      'location.create',
      'location',
      after.id,
      null,
      after,
      campusId,
    );
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
    await this.audit(
      operator,
      'location.update',
      'location',
      id,
      before,
      after,
      campusId,
    );
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
    await this.audit(
      operator,
      'location.delete',
      'location',
      id,
      before,
      null,
      campusId,
    );
  }
  /** IKB5PA：status 过滤（online/paused/offline），不传 = 全部在职口径（除 deleted）。 */
  async staff(campusId: string, status?: string, role?: string) {
    const xs = await this.db.staff.findMany({
      where: {
        campusId,
        ...(status ? { status } : { status: { not: 'deleted' } }),
        // IKD6FG：角色筛选（楼长/全职/兼职）
        ...(role ? { role } : {}),
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
  /** 服务范围（IKGVOO，2026-09-18 道哥定版）：员工可选所属校区——必须是真实
   *  运营校区（type=campus，拒绝 official/hq 伪校区），缺省回落账号绑定校区。 */
  private async resolveStaffCampus(
    requested: string | undefined,
    fallback: string,
  ): Promise<{ id: string; name: string }> {
    const campus = await this.db.campus.findFirst({
      where: { id: requested || fallback, type: 'campus' },
    });
    if (!campus)
      throw new BadRequestException('所属校区不存在或不可用，请先选择服务范围');
    return { id: campus.id, name: campus.name };
  }
  async createStaff(body: CreateStaffDto, operator: string, campusId: string) {
    const target = await this.resolveStaffCampus(body.campusId, campusId);
    const duplicate = await this.db.staff.findUnique({
      where: { staffNo: body.staffNo },
    });
    if (duplicate) throw new BadRequestException('工号已存在');
    // IK9U3Y：骑手不绑楼栋；IK9U3X：楼长必须绑定且一楼一在职楼长。
    // 2026-09-14 放开实习楼长手建：同属楼长系、必须绑楼栋；
    // 一楼一在职楼长仅约束正式楼长——实习楼长可与正式楼长共存（与招募审批路径一致）
    const RIDER_ROLES = ['fulltime-rider', 'parttime-rider'];
    if (RIDER_ROLES.includes(body.role) && body.buildingId)
      throw new BadRequestException('配送员角色无需绑定楼栋');
    if (
      body.role === 'building-manager' ||
      body.role === 'intern-building-manager'
    ) {
      if (!body.buildingId) throw new BadRequestException('楼长必须绑定楼栋');
      if (body.role === 'building-manager') {
        const clash = await this.db.staff.findFirst({
          where: {
            buildingId: body.buildingId,
            role: 'building-manager',
            status: { not: 'deleted' },
          },
        });
        if (clash) throw new BadRequestException('该楼栋已有在职楼长');
      }
    }
    // IKGVOO：兜底校名按所选校区（原硬编码「湖北工业大学」已清除）
    let buildingName = target.name;
    if (body.buildingId) {
      const building = await this.db.building.findFirst({
        where: { id: body.buildingId, campusId: target.id },
      });
      if (!building) throw new BadRequestException('楼栋不存在');
      buildingName = building.name;
    }
    const roleText =
      body.role === 'building-manager'
        ? `${buildingName}楼长`
        : body.role === 'intern-building-manager'
          ? `${buildingName}实习楼长`
          : body.role === 'fulltime-rider'
            ? '全职配送员'
            : '兼职配送员';
    const staff = await this.db.staff.create({
      data: {
        campusId: target.id,
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
      target.id,
    );
    return staff;
  }
  async updateStaff(
    id: string,
    body: UpdateStaffDto,
    operator: string,
    campusId?: string,
  ) {
    // Source and destination are independent checks: campus grants may only edit current-campus staff.
    const before = await this.db.staff.findFirst({
      where: { id, ...(campusId !== undefined ? { campusId } : {}) },
    });
    if (!before || before.status === 'deleted')
      throw new NotFoundException('员工不存在');
    if (
      body.staffNo &&
      body.staffNo !== before.staffNo &&
      (await this.db.staff.findUnique({ where: { staffNo: body.staffNo } }))
    )
      throw new BadRequestException('工号已存在');
    // 服务范围改派（IKGVOO）：改派时未显式指定新楼栋 → 自动清空绑定（待分配）
    const target = await this.resolveStaffCampus(
      body.campusId,
      before.campusId,
    );
    const campusChanged = target.id !== before.campusId;
    if (campusChanged && body.buildingId === undefined) {
      body.buildingId = null;
    }
    const data: Prisma.StaffUpdateInput = {};
    if (body.name !== undefined) data.name = body.name;
    if (body.role !== undefined) data.role = body.role;
    if (body.staffNo !== undefined) data.staffNo = body.staffNo;
    if (body.status !== undefined) data.status = body.status;
    if (campusChanged) data.campus = { connect: { id: target.id } };
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
          // IKGVOO：解绑快照按目标校区名（原硬编码「湖北工业大学」已清除）
          data.building = target.name;
          buildingName = target.name;
        }
      } else {
        // IKBW0E：楼长允许显式解绑（清空绑定进「待分配」态，见下方 buildingId null
        // 分支）；绑有楼栋时才校验一楼一在职楼长，编辑改名等操作不受历史数据阻塞。
        // 一楼一在职楼长仅约束正式楼长：实习楼长可与正式楼长共存（招募审批同理）
        if (
          nextRole === 'building-manager' &&
          nextBuildingId &&
          (nextBuildingId !== before.buildingId || nextRole !== before.role)
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
          where: { id: body.buildingId, campusId: target.id },
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
          : role === 'intern-building-manager'
            ? `${buildingName}实习楼长`
            : role === 'fulltime-rider'
              ? '全职配送员'
              : '兼职配送员';
    }
    const after = await this.db.staff.update({
      where: { id, campusId: before.campusId },
      data,
    });
    await this.audit(
      operator,
      'staff.update',
      'staff',
      id,
      before,
      after,
      target.id,
    );
    return after;
  }
  async deleteStaff(id: string, operator: string, campusId?: string) {
    // Only a matching platform grant may omit the source campus filter.
    const before = await this.db.staff.findFirst({
      where: { id, ...(campusId !== undefined ? { campusId } : {}) },
    });
    if (!before || before.status === 'deleted')
      throw new NotFoundException('员工不存在');
    const after = await this.db.staff.update({
      where: { id, campusId: before.campusId },
      data: { status: 'deleted' },
    });
    await this.audit(
      operator,
      'staff.delete',
      'staff',
      id,
      before,
      after,
      before.campusId,
    );
    return { id, deleted: true };
  }
  /** IK9SO6：配送费/起送门槛按校园配置（business.cart/checkout 已按此生效）。
   *  IKG1C（IKGI1C 打烊停单）：闭店窗/手动开关同页一并读写。 */
  async deliveryConfig(campusId: string) {
    const campus = await this.db.campus.findFirstOrThrow({
      where: { id: campusId },
      select: {
        deliveryFeeInstant: true,
        deliveryFeeScheduled: true,
        deliveryThreshold: true,
        closeStart: true,
        closeEnd: true,
        manualClosed: true,
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
        // IKG1C（IKGI1C 打烊停单）：三字段可选，不传/空（null、undefined）
        // 不动原值——配错时间窗不至于把闭店开关一起带飞
        ...(body.closeStart ? { closeStart: body.closeStart } : {}),
        ...(body.closeEnd ? { closeEnd: body.closeEnd } : {}),
        ...(body.manualClosed === undefined || body.manualClosed === null
          ? {}
          : { manualClosed: body.manualClosed }),
        // IKHMKR：无楼长提示（校区自定义，可选不传不动）
        ...(body.noManagerTip != null
          ? { noManagerTip: body.noManagerTip }
          : {}),
      },
      select: {
        deliveryFeeInstant: true,
        deliveryFeeScheduled: true,
        deliveryThreshold: true,
        closeStart: true,
        closeEnd: true,
        manualClosed: true,
        noManagerTip: true,
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
  /**
   * 寝室导入模板（IKD6FH）：xlsx 两列——楼层 / 寝室号，附 2 行示例。
   * 楼栋名写进文件名，下载即知导入目标。
   */
  async roomTemplate(buildingId: string, campusId: string) {
    const building = await this.db.building.findFirst({
      where: { id: buildingId, campusId },
    });
    if (!building) throw new NotFoundException('楼栋不存在');
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('寝室导入');
    sheet.columns = [
      { header: '楼层', key: 'floor', width: 12 },
      { header: '寝室号', key: 'roomNo', width: 20 },
    ];
    sheet.addRow({ floor: 1, roomNo: '101' });
    sheet.addRow({ floor: 1, roomNo: '102' });
    const buffer = await wb.xlsx.writeBuffer();
    return {
      filename: `寝室导入模板-${building.name}.xlsx`,
      buffer: Buffer.from(buffer),
    };
  }
  /**
   * 寝室批量导入（IKD6FH）：解析模板 xlsx（楼层/寝室号两列，首行表头），
   * 楼栋内已存在的寝室自动跳过（唯一约束 buildingId+floor+roomNo），
   * createMany skipDuplicates 兜底并发。行级错误（楼层非正整数/寝室号空）
   * 收集返回，合法行照常导入。
   */
  async importRooms(
    buildingId: string,
    campusId: string,
    file: Buffer,
    operator: string,
  ) {
    const building = await this.db.building.findFirst({
      where: { id: buildingId, campusId },
    });
    if (!building) throw new NotFoundException('楼栋不存在');
    const wb = new ExcelJS.Workbook();
    try {
      // exceljs 4.4 自带类型钉在旧 @types/node 的 Buffer 上，与项目
      // Buffer<ArrayBufferLike> 不兼容（运行时无差别），此处按参数类型断言
      await wb.xlsx.load(file as unknown as Parameters<typeof wb.xlsx.load>[0]);
    } catch {
      throw new BadRequestException('文件解析失败，请使用下载的 xlsx 模板');
    }
    const sheet = wb.worksheets[0];
    if (!sheet) throw new BadRequestException('表格为空');
    const errors: string[] = [];
    const rows: Array<{ floor: number; roomNo: string }> = [];
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return; // 表头
      const floor = Number(row.getCell(1).value);
      const roomNoCell = row.getCell(2).value;
      const roomNo =
        typeof roomNoCell === 'object' && roomNoCell && 'text' in roomNoCell
          ? String((roomNoCell as { text: string }).text).trim()
          : String(roomNoCell ?? '').trim();
      if (!Number.isInteger(floor) || floor < 1 || floor > 100) {
        errors.push(`第 ${rowNumber} 行：楼层必须是 1-100 的整数`);
        return;
      }
      if (!roomNo || roomNo.length > 20) {
        errors.push(`第 ${rowNumber} 行：寝室号必填且不超过 20 字`);
        return;
      }
      rows.push({ floor, roomNo });
    });
    if (!rows.length)
      throw new BadRequestException(
        errors[0] ?? '没有可导入的数据行，请按模板填写',
      );
    const result = await this.db.room.createMany({
      data: rows.map((r) => ({
        buildingId,
        floor: r.floor,
        roomNo: r.roomNo,
        qrToken: `qr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      })),
      skipDuplicates: true,
    });
    const imported = result.count;
    const skipped = rows.length - imported;
    await this.audit(
      operator,
      'room.import',
      'building',
      buildingId,
      null,
      { total: rows.length, imported, skipped },
      campusId,
    );
    return { total: rows.length, imported, skipped, errors };
  }
  /** IKB5PA：status 过滤（pending/cancelled），不传 = 全部。 */
  async afterSales(campusId: string, status?: string) {
    return this.db.afterSale.findMany({
      where: { order: { campusId }, ...(status ? { status } : {}) },
      include: { order: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  /* ---------- IKHZKA 退款功能 v1：审核 + 微信原路退回 + 联动 ---------- */

  /** 售后/退款申请列表：校区范围 + 状态/来源筛选（新申请走 Refund 统一主表）。 */
  async refunds(campusId: string, status?: string, source?: string) {
    const items = await this.db.refund.findMany({
      where: {
        ...(campusId ? { order: { campusId } } : {}),
        ...(status ? { status } : {}),
        ...(source ? { source } : {}),
      },
      include: {
        items: true,
        order: {
          select: {
            orderNo: true,
            campusId: true,
            status: true,
            statusText: true,
            payableAmount: true,
            deliveryFee: true,
            items: true,
            address: true,
            createdAt: true,
            campus: { select: { name: true, shortName: true } },
          },
        },
        user: { select: { nickname: true, phone: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return items.map((r) => ({
      id: r.id,
      orderId: r.orderId,
      orderNo: r.order.orderNo,
      campusId: r.order.campusId,
      // IKJ9XQ 对账配套：校区筛选的列表展示列
      campusName: r.order.campus?.name,
      campusShortName: r.order.campus?.shortName,
      orderStatus: r.order.status,
      userName: r.user.nickname,
      userPhone: r.user.phone,
      source: r.source,
      type: r.type,
      description: r.description,
      images: (r.images as string[] | null) ?? [],
      reason: r.reason,
      amount: this.num(r.amount),
      payableAmount: this.num(r.order.payableAmount),
      deliveryFee: this.num(r.order.deliveryFee),
      status: r.status,
      statusText: REFUND_STATUS_TEXT[r.status] ?? r.status,
      beforeStatus: r.beforeStatus,
      auditBy: r.auditBy,
      auditAt: r.auditAt?.toISOString() ?? null,
      auditRemark: r.auditRemark,
      refundError: r.refundError,
      rejectCount: r.rejectCount,
      wxRefundId: r.wxRefundId,
      createdAt: r.createdAt.toISOString(),
      orderCreatedAt: r.order.createdAt.toISOString(),
      items: (r.items ?? []).map((i) => ({
        id: i.id,
        productId: i.productId,
        productName: i.productName,
        unitPrice: this.num(i.unitPrice),
        quantity: i.quantity,
        amount: this.num(i.amount),
      })),
    }));
  }

  /**
   * 审核退款申请（IKHZKA）：
   * - approve：抢占 → 微信原路退回（out_refund_no=Refund.id，重试幂等）→
   *   即时终态直接落账；受理中（PROCESSING）转 refunding 由 syncRefund 补齐；
   *   受理失败标 failed + 原因，可再次批准重试。
   * - reject：拒绝并回滚订单到申请前状态（beforeStatus 快照），用户可重新申请。
   * 金额口径：Refund.amount（申请时锁定 = 实付 − 配送费）。
   * scope：校区级授权传本校区（强校验），平台级传 null（跨校区可审）。
   */
  async auditRefund(
    id: string,
    action: 'approve' | 'reject',
    operator: string,
    scope: string | null,
    remark = '',
    /** v2 部分退款：审核核定的各行金额（客服可改），按 RefundItem.id 对齐 */
    amounts?: Array<{ itemId: string; amount: number }>,
  ) {
    const refund = await this.db.refund.findUnique({
      where: { id },
      include: { order: true },
    });
    if (!refund || (scope !== null && refund.order.campusId !== scope))
      throw new NotFoundException('退款申请不存在');
    const campusId = refund.order.campusId;
    if (action === 'reject') {
      // failed 也可拒绝：微信受理失败且确认不退的单要有终态出口，不能永远挂着
      if (!['pending', 'failed'].includes(refund.status))
        throw new BadRequestException('当前状态不可拒绝');
      const record = await this.db.$transaction(async (tx) => {
        const after = await tx.refund.update({
          where: { id },
          data: {
            status: 'rejected',
            auditBy: operator,
            auditAt: new Date(),
            auditRemark: remark,
            rejectCount: { increment: 1 },
          },
        });
        await this.restoreOrderFromRefund(
          tx,
          refund.orderId,
          refund.beforeStatus,
        );
        return after;
      });
      await this.audit(
        operator,
        'refund.reject',
        'refund',
        id,
        { status: refund.status },
        { status: 'rejected', remark },
        campusId,
      );
      try {
        await this.push?.refundResultPush(
          refund.userId,
          refund.order.orderNo,
          refund.amount,
          false,
        );
      } catch {
        // 推送失败不阻塞审核结果
      }
      return record;
    }
    // approve：pending 或 failed（failed = 微信受理失败后的重试）
    if (!['pending', 'failed'].includes(refund.status))
      throw new BadRequestException('当前状态不可批准');
    if (
      !['after-sales', 'delivered', 'completed'].includes(refund.order.status)
    )
      throw new BadRequestException('订单状态已变化，无法退款，请刷新');
    if (!this.payments)
      // 先验支付通道再抢占：否则抢占成 approved 后失败会卡死申请
      throw new ServiceUnavailableException('支付服务未就绪，无法发起退款');
    // v2 部分退款：审核可改金额（Q3 定稿）——按提交的 amounts 核定各行金额
    if (amounts?.length) {
      const owned = await this.db.refundItem.findMany({
        where: { refundId: id },
      });
      const byId = new Map(owned.map((i) => [i.id, i]));
      for (const a of amounts) {
        const item = byId.get(a.itemId);
        if (!item) throw new BadRequestException('退款商品行不存在');
        if (a.amount < 0 || a.amount > item.unitPrice * item.quantity)
          throw new BadRequestException(`${item.productName} 金额超出该行上限`);
      }
      await this.db.$transaction(
        amounts.map((a) =>
          this.db.refundItem.update({
            where: { id: a.itemId },
            data: { amount: Math.round(a.amount) },
          }),
        ),
      );
    }
    // 金额核定后重算合计，并做全局硬上限校验：累计已退 + 本次 ≤ 实付 − 配送费
    const finalItems = await this.db.refundItem.findMany({
      where: { refundId: id },
    });
    const finalAmount = finalItems.reduce(
      (s, i) => s + Math.round(i.amount),
      0,
    );
    const refundedBefore = await this.db.refund.aggregate({
      where: { orderId: refund.orderId, status: 'refunded', id: { not: id } },
      _sum: { amount: true },
    });
    const goodsPaid =
      Number(refund.order.payableAmount) - Number(refund.order.deliveryFee);
    if (finalAmount + Number(refundedBefore._sum.amount ?? 0) > goodsPaid)
      throw new BadRequestException(
        `超出可退上限：本单最多还可退 ¥${((goodsPaid - Number(refundedBefore._sum.amount ?? 0)) / 100).toFixed(2)}`,
      );
    await this.db.refund.update({
      where: { id },
      data: { amount: finalAmount },
    });
    // 条件更新抢占审核权：并发双批只有一笔进入退款
    const claimed = await this.db.refund.updateMany({
      where: { id, status: refund.status },
      data: {
        status: 'approved',
        auditBy: operator,
        auditAt: new Date(),
        auditRemark: remark,
      },
    });
    if (!claimed.count) throw new BadRequestException('申请状态已变化，请刷新');
    try {
      const applied = await this.payments.applyWechatRefund(
        refund.order.orderNo,
        Number(refund.order.payableAmount),
        refund.amount,
        refund.id,
        remark || refund.description || refund.reason || '订单退款',
      );
      if (applied.status === 'SUCCESS')
        return await this.finishRefund(
          refund,
          applied.refundId,
          operator,
          campusId,
        );
      const record = await this.db.refund.update({
        where: { id },
        data: { status: 'refunding', wxRefundId: applied.refundId },
      });
      await this.audit(
        operator,
        'refund.approve',
        'refund',
        id,
        { status: refund.status },
        { status: 'refunding', wxRefundId: applied.refundId },
        campusId,
      );
      return record;
    } catch (error) {
      const message =
        error instanceof HttpException ? error.message : '退款请求失败';
      await this.db.refund.update({
        where: { id },
        data: { status: 'failed', refundError: message },
      });
      // 微信未受理：订单解锁回原状态（客服单可能未转售后态，尽力回滚）
      await this.restoreOrderFromRefund(
        this.db as unknown as Prisma.TransactionClient,
        refund.orderId,
        refund.beforeStatus || 'delivered',
      );
      await this.audit(
        operator,
        'refund.approve.fail',
        'refund',
        id,
        null,
        { error: message },
        campusId,
      );
      throw new BadRequestException(
        `退款发起失败：${message}（申请已标记失败，处理后可再次批准重试）`,
      );
    }
  }

  /**
   * 退款终态落账（微信确认退款后，IKHZKA v2）：
   * - 累计已退 ≥ 实付−配送费 → 订单 refunded（整单终态：券返还+秒杀限购派生释放）
   * - 部分退 → 订单回滚 beforeStatus（状态不变+金额标记，Q4 定稿 A）
   * - 未发货退款（pre-delivery，整单）回补库存与销量（stockRestored 防双补）
   * - 售后（after-sale）佣金按「累计退款 ÷ 商品实付」比例负向冲回（目标差值法防超冲）
   */
  private async finishRefund(
    refund: {
      id: string;
      orderId: string;
      userId: string;
      amount: number;
      source: string;
      status: string;
      beforeStatus: string;
    },
    wxRefundId: string,
    operator: string,
    campusId: string,
  ) {
    const order = await this.db.order.findUniqueOrThrow({
      where: { id: refund.orderId },
    });
    const goodsPaid = Number(order.payableAmount) - Number(order.deliveryFee);
    const refundedAgg = await this.db.refund.aggregate({
      where: { orderId: order.id, status: 'refunded' },
      _sum: { amount: true },
    });
    const totalRefunded = Number(refundedAgg._sum.amount ?? 0) + refund.amount;
    const isFull = totalRefunded >= goodsPaid;
    // 幂等早退：本条已落过账（syncRefund 重复调用）直接返回
    if (refund.status === 'refunded')
      return this.db.refund.findUniqueOrThrow({ where: { id: refund.id } });
    const record = await this.db.$transaction(async (tx) => {
      // 部分退：订单回原状态（快照在 Refund.beforeStatus）；整单退：refunded。
      // 客服单批准时订单在 delivered/completed（未转售后态）也在合法范围。
      const patchData = isFull
        ? { status: 'refunded', statusText: '已退款' }
        : (() => {
            const target = ['paid', 'delivered', 'completed'].includes(
              refund.beforeStatus,
            )
              ? refund.beforeStatus
              : 'delivered';
            return {
              status: target,
              statusText:
                target === 'paid'
                  ? '仓库正在接单'
                  : target === 'completed'
                    ? '已确认收货'
                    : '已送达寝室',
            };
          })();
      const won = await tx.order.updateMany({
        where: { id: order.id, status: { in: ['after-sales', order.status] } },
        data: patchData,
      });
      if (!won.count) throw new BadRequestException('订单状态已变化，请刷新');
      const after = await tx.refund.update({
        where: { id: refund.id },
        data: { status: 'refunded', wxRefundId, refundError: '' },
      });
      if (refund.source === 'pre-delivery' && isFull) {
        // 货未出仓：回补库存与销量（商品可能已被清理，存在才回补）
        if (!order.stockRestored) {
          const lines =
            (order.items as Array<{
              product?: { id?: string; costSource?: 'HQ' | 'LOCAL' | 'LEGACY' };
              quantity: number;
            }>) ?? [];
          const productIds = [
            ...new Set(
              lines
                .map((l) => l.product?.id)
                .filter((pid): pid is string => Boolean(pid)),
            ),
          ];
          const existing = productIds.length
            ? await tx.product.findMany({
                where: { id: { in: productIds } },
                select: { id: true, procurementMode: true },
              })
            : [];
          const currentMode = new Map(
            existing.map((p) => [p.id, p.procurementMode]),
          );
          for (const line of lines) {
            const productId = line.product?.id;
            const soldAs = line.product?.costSource;
            // 商品清零后可能已切换采购来源；旧来源退款不能自动混回新库存。
            // LEGACY/无来源快照保持历史兼容，已明确来源则必须与当前一致。
            if (
              productId &&
              currentMode.has(productId) &&
              (!soldAs ||
                soldAs === 'LEGACY' ||
                soldAs === currentMode.get(productId))
            )
              await tx.product.update({
                where: { id: productId },
                data: {
                  stock: { increment: line.quantity },
                  sales: { decrement: line.quantity },
                },
              });
          }
          await tx.order.update({
            where: { id: order.id },
            data: { stockRestored: true },
          });
        }
        // 整单终态：优惠券返还（locked/used → released，可再次使用）
        if (order.couponId)
          await tx.userCoupon.updateMany({
            where: { id: order.couponId, status: { in: ['locked', 'used'] } },
            data: { status: 'released' },
          });
      }
      return after;
    });
    if (refund.source !== 'pre-delivery') {
      if (isFull) {
        // 整单终态的售后退款：佣金全额冲回
        await this.db.$transaction(async (tx) => {
          await this.commissions.refundAdjust(
            tx,
            order.id,
            `售后退款冲回 ${order.orderNo}`,
          );
        });
      } else {
        // 部分退：按累计退款比例冲回（目标差值法）
        await this.refundCommissionPartial(
          order.id,
          goodsPaid,
          totalRefunded,
          order.orderNo,
        );
      }
    }
    await this.audit(
      operator,
      'refund.finish',
      'refund',
      refund.id,
      null,
      {
        status: 'refunded',
        wxRefundId,
        source: refund.source,
        amount: refund.amount,
        partial: !isFull,
        totalRefunded,
      },
      campusId,
    );
    try {
      await this.push?.refundResultPush(
        refund.userId,
        order.orderNo,
        refund.amount,
        true,
      );
    } catch {
      // 推送失败不阻塞落账
    }
    return record;
  }

  /**
   * 售后部分退款佣金冲回（IKHZKA v2，比例目标差值法）：
   * 目标冲回额 = 原佣金总额 × (累计已退 ÷ 商品实付)，本次补足「目标 − 已冲回」，
   * 多次部分退累加不会超过佣金全额。在 finishRefund 落账事务外单独执行
   * （Commission 读写独立，失败仅记日志）。
   */
  private async refundCommissionPartial(
    orderId: string,
    goodsPaid: number,
    totalRefunded: number,
    orderNo: string,
  ) {
    try {
      const ratio = goodsPaid > 0 ? Math.min(1, totalRefunded / goodsPaid) : 1;
      await this.db.$transaction(async (tx) => {
        const originals = await tx.commission.findMany({
          where: { orderId, kind: 'commission' },
        });
        const adjusted = await tx.commission.aggregate({
          where: { orderId, kind: 'adjustment' },
          _sum: { amount: true },
        });
        const totalCommission = originals.reduce(
          (s, x) => s + Math.abs(x.amount),
          0,
        );
        if (totalCommission <= 0) return;
        const target = Math.round(totalCommission * ratio);
        const done = Math.abs(adjusted._sum.amount ?? 0);
        const delta = target - done;
        if (delta <= 0) return;
        const riders = [...new Set(originals.map((x) => x.staffId))];
        // 多骑手单按各自佣金占比分摊（单骑手单即全额差值）
        for (const staffId of riders) {
          const share = originals
            .filter((x) => x.staffId === staffId)
            .reduce((s, x) => s + Math.abs(x.amount), 0);
          const part = Math.round((delta * share) / totalCommission);
          if (part <= 0) continue;
          await tx.commission.create({
            data: {
              staffId,
              orderId,
              campusId: originals[0].campusId,
              amount: -part,
              kind: 'adjustment',
              status: 'adjusted',
              period: new Date().toISOString().slice(0, 7),
              remark: `售后部分退款冲回 ${orderNo}`,
            },
          });
        }
      });
    } catch (error) {
      console.warn(
        `[refund] 部分退款佣金冲回失败（不影响退款）: ${orderNo}`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  /**
   * 退款状态同步（IKHZKA）：refunding/approved/failed 的单向微信查终态并落账；
   * CLOSED=微信侧关闭（可重新批准重试）、ABNORMAL=微信异常（需商户平台人工处理）。
   * scope：校区级授权传本校区（强校验），平台级传 null（跨校区可查）。
   */
  async syncRefund(id: string, operator: string, scope: string | null) {
    const refund = await this.db.refund.findUnique({
      where: { id },
      include: { order: true },
    });
    if (!refund || (scope !== null && refund.order.campusId !== scope))
      throw new NotFoundException('退款申请不存在');
    const campusId = refund.order.campusId;
    if (!['refunding', 'approved', 'failed'].includes(refund.status))
      throw new BadRequestException('当前状态无需同步');
    if (!this.payments) throw new ServiceUnavailableException('支付服务未就绪');
    // 微信按 out_refund_no（= Refund.id）查询
    const result = await this.payments.queryWechatRefund(refund.id);
    await this.audit(
      operator,
      'refund.sync',
      'refund',
      id,
      { status: refund.status },
      { wxStatus: result.status },
      campusId,
    );
    if (result.status === 'SUCCESS')
      return this.finishRefund(
        refund,
        result.refundId ?? refund.wxRefundId ?? '',
        operator,
        campusId,
      );
    if (result.status === 'CLOSED')
      return this.db.refund.update({
        where: { id },
        data: {
          status: 'failed',
          refundError: '微信侧退款已关闭，可重新批准发起',
        },
      });
    if (result.status === 'ABNORMAL')
      return this.db.refund.update({
        where: { id },
        data:
          refund.status === 'approved'
            ? {
                status: 'failed',
                refundError: '退款未被微信受理，可重新批准发起',
              }
            : { refundError: '微信侧退款异常，需登录商户平台处理' },
      });
    return refund; // PROCESSING：继续等
  }

  /**
   * 客服按商品发起部分退款并即时批准（IKHZKA v2）：客服操作即审核，一次提交。
   * 金额=行原价小计（可传 amounts 核定），硬上限：累计已退 + 本次 ≤ 实付 − 配送费。
   */
  async createAndApproveRefund(
    orderId: string,
    input: {
      productIds: string[];
      amounts?: Array<{ productId: string; amount: number }>;
      remark?: string;
    },
    operator: string,
    scope: string | null,
  ) {
    const order = await this.db.order.findUnique({ where: { id: orderId } });
    if (!order || (scope !== null && order.campusId !== scope))
      throw new NotFoundException('订单不存在');
    if (!['delivered', 'completed', 'after-sales'].includes(order.status))
      throw new BadRequestException('仅送达后的订单支持按商品退款');
    if (!input.productIds?.length)
      throw new BadRequestException('请勾选退款商品');
    const pending = await this.db.refund.findFirst({
      where: { orderId, status: 'pending' },
      select: { id: true },
    });
    if (pending) throw new BadRequestException('该订单已有退款申请在审核中');
    const items = this.business.parseRefundItems(order, input.productIds);
    const amtMap = new Map(
      (input.amounts ?? []).map((a) => [a.productId, a.amount]),
    );
    for (const item of items) {
      const cap = item.unitPrice * item.quantity;
      const amt = amtMap.get(item.productId);
      if (amt != null) {
        if (amt < 0 || amt > cap)
          throw new BadRequestException(
            `${item.productName} 金额超出该行上限 ¥${(cap / 100).toFixed(2)}`,
          );
        item.amount = Math.round(amt);
      }
    }
    const total = items.reduce((s, i) => s + i.amount, 0);
    const refundedBefore = await this.db.refund.aggregate({
      where: { orderId, status: 'refunded' },
      _sum: { amount: true },
    });
    const goodsPaid = Number(order.payableAmount) - Number(order.deliveryFee);
    const already = Number(refundedBefore._sum.amount ?? 0);
    if (total + already > goodsPaid)
      throw new BadRequestException(
        `超出可退上限：本单最多还可退 ¥${((goodsPaid - already) / 100).toFixed(2)}`,
      );
    if (!this.payments)
      // 校验全过再验支付通道（便于测试上限逻辑）
      throw new ServiceUnavailableException('支付服务未就绪，无法发起退款');
    const refund = await this.db.refund.create({
      data: {
        userId: order.userId,
        orderId,
        source: 'after-sale',
        type: null,
        description: '',
        images: [],
        reason: input.remark?.slice(0, 120) ?? '',
        amount: total,
        beforeStatus: order.status === 'after-sales' ? '' : order.status,
        status: 'pending',
        auditBy: operator,
        auditAt: new Date(),
        auditRemark: input.remark?.slice(0, 200) ?? '',
        items: { create: items },
      },
    });
    // 订单转售后态锁定（与 C 端申请一致；部分退落账时回滚 beforeStatus）
    await this.db.order.update({
      where: { id: orderId },
      data: { status: 'after-sales', statusText: '部分退款中' },
    });
    // 创建即批准：复用 auditRefund 的微信退款+落账链路
    return this.auditRefund(
      refund.id,
      'approve',
      operator,
      scope,
      input.remark?.slice(0, 200) ?? '',
    );
  }

  /** 退款申请撤销/拒绝后订单回滚  /** 退款申请撤销/拒绝后订单回滚（与 C 端撤销共用口径，仅当订单仍在售后态）。 */
  private async restoreOrderFromRefund(
    tx: Prisma.TransactionClient,
    orderId: string,
    beforeStatus: string,
  ) {
    const target = ['paid', 'delivered', 'completed'].includes(beforeStatus)
      ? beforeStatus
      : 'delivered';
    const statusText =
      target === 'paid'
        ? '仓库正在接单'
        : target === 'completed'
          ? '已确认收货'
          : '已送达寝室';
    await tx.order.updateMany({
      where: { id: orderId, status: 'after-sales' },
      data: { status: target, statusText },
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
    // IKDHLN（道哥拍板A）：历史月只物化有业务的员工——原「查询即物化」
    // 给切到的任何月份生成全员占位账单（底薪/0），换月观感"没变化"。
    // 历史月无提成且无既有账单 → 跳过（空列表）；当月照旧全员（结算工作流）
    const isCurrentPeriod = period === new Date().toISOString().slice(0, 7);
    const staffList = await this.db.staff.findMany({
      where: { campusId, status: { not: 'deleted' } },
    });
    // IKDOIU：楼长底薪改为校区维度后台配置（分，0=无底薪），取代硬编码 50000
    const campus = await this.db.campus.findUnique({
      where: { id: campusId },
      select: { buildingManagerBaseSalary: true },
    });
    const managerBaseSalary = campus?.buildingManagerBaseSalary ?? 0;
    for (const s of staffList) {
      const { commissionTotal, adjustment } = await this.commissions.monthly(
        s.id,
        period,
      );
      const baseSalary = s.role === 'building-manager' ? managerBaseSalary : 0;
      const payable = baseSalary + commissionTotal + adjustment;
      const existing = await this.db.bmBill.findUnique({
        where: { staffId_period: { staffId: s.id, period } },
      });
      if (
        !isCurrentPeriod &&
        !existing &&
        commissionTotal === 0 &&
        adjustment === 0
      )
        continue;
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
  async campuses(campusId?: string) {
    // status=official 是官方商品库伪校区（IKAJSM），不出现在校区列表
    const xs = await this.db.campus.findMany({
      where: {
        status: { not: 'official' },
        ...(campusId !== undefined ? { id: campusId } : {}),
      },
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

  /* ---------- 多租户组织基线（IKKRMM，ADR-0001）：平台视角最小只读端点 ---------- */
  // 本阶段组织 A 单租户运行：端点仅供平台核对归属与聚合，组织维护（建组/
  // 微信配置/开通组织 B）属 IKKRMS；权限为平台级（access-policy 拦校区授予）。

  /** 组织列表：每组织聚合校区数（不含平台伪校区）与用户数（经校区归属汇总）。 */
  async organizations() {
    const orgs = await this.db.organization.findMany({
      orderBy: { createdAt: 'asc' },
    });
    // 校区归属快照（organizationId 可空=平台层，不进聚合）
    const campusRows = await this.db.campus.findMany({
      where: { organizationId: { not: null }, status: { not: 'official' } },
      select: { id: true, organizationId: true },
    });
    const userAgg = await this.db.user.groupBy({
      by: ['campusId'],
      _count: { _all: true },
    });
    const usersByCampus = new Map(
      userAgg.map((u) => [u.campusId, u._count._all]),
    );
    return orgs.map((o) => {
      const own = campusRows.filter((c) => c.organizationId === o.id);
      return {
        id: o.id,
        name: o.name,
        shortName: o.shortName,
        status: o.status,
        createdAt: o.createdAt,
        campusCount: own.length,
        userCount: own.reduce(
          (n, c) => n + (usersByCampus.get(c.id) ?? 0),
          0,
        ),
        // IKKRMS：列表补微信配置位（编辑抽屉直接用，不必逐行拉详情）
        wxAppId: o.wxAppId,
        mchId: o.mchId,
        serialNo: o.serialNo,
        notifyDomain: o.notifyDomain,
        hasWxSecret: o.wxSecret != null,
        hasMchApiV3Key: o.mchApiV3Key != null,
        hasPrivateKey: o.privateKey != null,
      };
    });
  }

  /** 组织详情：校区清单 + 聚合；微信敏感凭据只回「已配置」位，不回明文。 */
  async organizationDetail(id: string) {
    const org = await this.db.organization.findUnique({ where: { id } });
    if (!org) throw new BadRequestException(`组织不存在: ${id}`);
    const campuses = await this.db.campus.findMany({
      where: { organizationId: id, status: { not: 'official' } },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        name: true,
        shortName: true,
        type: true,
        status: true,
        createdAt: true,
      },
    });
    const userAgg = await this.db.user.groupBy({
      by: ['campusId'],
      _count: { _all: true },
      where: { campusId: { in: campuses.map((c) => c.id) } },
    });
    const userCount = userAgg.reduce((n, u) => n + u._count._all, 0);
    return {
      id: org.id,
      name: org.name,
      shortName: org.shortName,
      status: org.status,
      createdAt: org.createdAt,
      // 微信配置（ADR-0001 决策 2 预留）：非敏感位透出，敏感凭据只回布尔
      wxAppId: org.wxAppId,
      mchId: org.mchId,
      serialNo: org.serialNo,
      notifyDomain: org.notifyDomain,
      hasWxSecret: org.wxSecret != null,
      hasMchApiV3Key: org.mchApiV3Key != null,
      hasPrivateKey: org.privateKey != null,
      campuses,
      campusCount: campuses.length,
      userCount,
    };
  }

  /* ---------- 组织 CRUD + 开通（IKKRMS，ADR-0001）：平台端开通组织 B ---------- */
  // 全部写端点超管专属（access-policy isSuperOnlyOperation 拦截）；registry
  // organizations.write 按钮节点仅供权限目录展示与角色编辑，判权不消费。

  /** 组织行 → API 返回（敏感凭据只回布尔，与 organizationDetail 同口径）。 */
  private organizationView(org: {
    id: string; name: string; shortName: string; status: string;
    createdAt: Date; wxAppId: string | null; mchId: string | null;
    serialNo: string | null; notifyDomain: string | null;
    wxSecret: string | null; mchApiV3Key: string | null; privateKey: string | null;
  }) {
    return {
      id: org.id,
      name: org.name,
      shortName: org.shortName,
      status: org.status,
      createdAt: org.createdAt,
      wxAppId: org.wxAppId,
      mchId: org.mchId,
      serialNo: org.serialNo,
      notifyDomain: org.notifyDomain,
      hasWxSecret: org.wxSecret != null,
      hasMchApiV3Key: org.mchApiV3Key != null,
      hasPrivateKey: org.privateKey != null,
    };
  }

  /**
   * 组织唯一性查重（name/shortName/wxAppId）。ADR 决策（IKKRMS 钉死）：
   * wxAppId 一经登记，AppID→组织映射即生效（IKKRMO resolveOrganizationByAppId
   * 命中即把该小程序的登录/注册/切校区限定进本组织校区集合）——登记与换绑
   * 两个入口都必须查重，否则两个组织挂同一 AppID 时映射不确定（findFirst
   * 谁先命中算谁）。组织 A 现状 wxAppId=NULL 不参与比较（NULL≠NULL）。
   */
  private async assertOrganizationUnique(
    checks: Array<{
      field: 'name' | 'shortName' | 'wxAppId';
      label: string;
      value?: string | null;
    }>,
    excludeId?: string,
  ) {
    for (const c of checks) {
      const v = c.value?.trim();
      if (!v) continue;
      const hit = await this.db.organization.findFirst({
        where: { [c.field]: v, ...(excludeId ? { id: { not: excludeId } } : {}) },
        select: { id: true },
      });
      if (hit) throw new BadRequestException(`${c.label} 已被其他组织登记: ${v}`);
    }
  }

  /** 组织新增（超管）：name/shortName/wxAppId 必填唯一；微信凭据可随后补。 */
  async createOrganization(body: CreateOrganizationDto, operator: string) {
    await this.assertOrganizationUnique([
      { field: 'name', label: '组织名称', value: body.name },
      { field: 'shortName', label: '组织简称', value: body.shortName },
      { field: 'wxAppId', label: '小程序 AppID', value: body.wxAppId },
    ]);
    const org = await this.db.organization.create({
      data: {
        name: body.name.trim(),
        shortName: body.shortName.trim(),
        wxAppId: body.wxAppId.trim(),
        ...(body.wxSecret ? { wxSecret: body.wxSecret } : {}),
        ...(body.mchId ? { mchId: body.mchId } : {}),
        ...(body.mchApiV3Key ? { mchApiV3Key: body.mchApiV3Key } : {}),
        ...(body.serialNo ? { serialNo: body.serialNo } : {}),
        ...(body.privateKey ? { privateKey: body.privateKey } : {}),
        ...(body.notifyDomain ? { notifyDomain: body.notifyDomain.trim() } : {}),
      },
    });
    await this.audit(
      operator,
      'organization.create',
      'organization',
      org.id,
      null,
      // 审计同样只留敏感字段布尔位（同改密 passwordReset 口径）
      {
        name: org.name,
        shortName: org.shortName,
        wxAppId: org.wxAppId,
        wxSecretConfigured: org.wxSecret != null,
        mchId: org.mchId,
      },
      '',
    );
    return this.organizationView(org);
  }

  /**
   * 组织编辑（超管；含微信配置更新）。合并语义：未传不动；wxSecret/
   * mchApiV3Key/privateKey 等只写不回读字段显式 null=清除、空串视同清除；
   * wxAppId 换绑唯一性强校验（见 assertOrganizationUnique ADR 注释）。
   */
  async updateOrganization(
    id: string,
    body: UpdateOrganizationDto,
    operator: string,
  ) {
    const before = await this.db.organization.findUnique({ where: { id } });
    if (!before) throw new BadRequestException(`组织不存在: ${id}`);
    await this.assertOrganizationUnique(
      [
        { field: 'name', label: '组织名称', value: body.name },
        { field: 'shortName', label: '组织简称', value: body.shortName },
        { field: 'wxAppId', label: '小程序 AppID', value: body.wxAppId },
      ],
      id,
    );
    const after = await this.db.organization.update({
      where: { id },
      data: {
        ...(body.name !== undefined ? { name: body.name.trim() } : {}),
        ...(body.shortName !== undefined
          ? { shortName: body.shortName.trim() }
          : {}),
        ...(body.wxAppId !== undefined
          ? { wxAppId: body.wxAppId?.trim() || null }
          : {}),
        ...(body.wxSecret !== undefined ? { wxSecret: body.wxSecret || null } : {}),
        ...(body.mchId !== undefined ? { mchId: body.mchId || null } : {}),
        ...(body.mchApiV3Key !== undefined
          ? { mchApiV3Key: body.mchApiV3Key || null }
          : {}),
        ...(body.serialNo !== undefined ? { serialNo: body.serialNo || null } : {}),
        ...(body.privateKey !== undefined
          ? { privateKey: body.privateKey || null }
          : {}),
        ...(body.notifyDomain !== undefined
          ? { notifyDomain: body.notifyDomain?.trim() || null }
          : {}),
      },
    });
    await this.audit(
      operator,
      'organization.update',
      'organization',
      id,
      this.organizationAuditView(before),
      this.organizationAuditView(after),
      '',
    );
    return this.organizationView(after);
  }

  /** 审计快照（非敏感字段透出，敏感凭据只留布尔位）。 */
  private organizationAuditView(org: {
    name: string; shortName: string; wxAppId: string | null; mchId: string | null;
    serialNo: string | null; notifyDomain: string | null;
    wxSecret: string | null; mchApiV3Key: string | null; privateKey: string | null;
  }) {
    return {
      name: org.name,
      shortName: org.shortName,
      wxAppId: org.wxAppId,
      mchId: org.mchId,
      serialNo: org.serialNo,
      notifyDomain: org.notifyDomain,
      hasWxSecret: org.wxSecret != null,
      hasMchApiV3Key: org.mchApiV3Key != null,
      hasPrivateKey: org.privateKey != null,
    };
  }

  /** 组织启停（超管）。停用后组织校区/账号的联动处置属 IKKRMP，本阶段不消费。 */
  async setOrganizationStatus(
    id: string,
    status: 'active' | 'disabled',
    operator: string,
  ) {
    const before = await this.db.organization.findUnique({ where: { id } });
    if (!before) throw new BadRequestException(`组织不存在: ${id}`);
    const after = await this.db.organization.update({
      where: { id },
      data: { status },
    });
    await this.audit(
      operator,
      'organization.status',
      'organization',
      id,
      { status: before.status },
      { status },
      '',
    );
    return this.organizationView(after);
  }

  /**
   * 开通组织一条龙（IKKRMS，超管）：组织管理员账号 + 首个校区一次提交。
   * - 管理员：orgLevel='org' + organizationId 绑定（IKKRMP 数据边界源头），
   *   默认绑 org-admin 预设角色（IKKRMQ：平台级授权+org 级收口），运营
   *   落点 campusId=本组织首个校区；
   * - 校区：organizationId 归属 + 官方库模板类别集初始化（同 IKAJSL 建校区）；
   * - 幂等：已有管理员或校区时返回现状不重复建（部分开通可续开——两段各自
   *   判存在，重复提交零副作用）。
   */
  async bootstrapOrganization(
    id: string,
    body: OrganizationBootstrapDto,
    operator: string,
  ) {
    const org = await this.db.organization.findUnique({ where: { id } });
    if (!org) throw new BadRequestException(`组织不存在: ${id}`);
    if (org.status !== 'active')
      throw new BadRequestException('组织已停用，请先启用再开通');
    // 幂等现状：管理员=orgLevel='org' 且固定本组织的最早账号（停用也算已建，
    // 不静默另建二号管理员）；校区=本组织最早非官方库校区
    let admin = await this.db.adminAccount.findFirst({
      where: { orgLevel: 'org', organizationId: id },
      orderBy: { createdAt: 'asc' },
    });
    let campus = await this.db.campus.findFirst({
      where: { organizationId: id, status: { not: 'official' } },
      orderBy: { createdAt: 'asc' },
    });
    let adminCreated = false;
    let campusCreated = false;
    if (!campus) {
      campus = await this.createCampusWithTemplates(
        {
          name: body.campusName,
          shortName: body.campusShortName,
          warehouseName: body.campusWarehouseName,
        },
        operator,
        id,
      );
      campusCreated = true;
    }
    if (!admin) {
      // org-admin 预设角色（启动同步登记）：缺失/停用时明确报错而非静默裸建
      const role = await this.db.adminRole.findUnique({
        where: { code: 'org-admin' },
      });
      if (!role || role.status !== 'active')
        throw new BadRequestException(
          '预设角色 org-admin 缺失或已停用，无法开通组织管理员（重启服务触发启动同步可恢复）',
        );
      if (
        await this.db.adminAccount.findUnique({
          where: { username: body.adminUsername },
          select: { id: true },
        })
      )
        throw new BadRequestException('用户名已存在');
      const passwordHash = await hash(body.adminPassword, 10);
      admin = await this.db.$transaction(async (tx) => {
        const acc = await tx.adminAccount.create({
          data: {
            username: body.adminUsername,
            passwordHash,
            nickname: body.adminNickname?.trim() ?? '',
            role: 'rbac',
            campusId: campus!.id,
            rbacMigrated: true,
            orgLevel: 'org',
            organizationId: id,
          },
        });
        // IKKRMQ 口径：org-admin 按平台级授权（组织域读+经营面），数据边界
        // 由账号 orgLevel='org' 收口（层级优先于角色视角）
        await tx.adminAccountRole.create({
          data: {
            accountId: acc.id,
            roleId: role.id,
            scope: 'platform',
            campusId: null,
            grantedBy: operator,
          },
        });
        return acc;
      });
      adminCreated = true;
    }
    if (adminCreated || campusCreated)
      await this.audit(
        operator,
        'organization.bootstrap',
        'organization',
        id,
        null,
        {
          adminCreated,
          campusCreated,
          admin: { username: admin.username, nickname: admin.nickname },
          campus: { name: campus.name, shortName: campus.shortName },
        },
        campus.id,
      );
    return {
      organization: this.organizationView(org),
      created: { admin: adminCreated, campus: campusCreated },
      admin: {
        id: admin.id,
        username: admin.username,
        nickname: admin.nickname,
        status: admin.status,
      },
      campus: {
        id: campus.id,
        name: campus.name,
        shortName: campus.shortName,
        status: campus.status,
      },
    };
  }

  /** 校区本体新增（IKAJSL）：新校区接入入口，仅总部长（controller 守卫）。 */
  async createCampus(body: CreateCampusDto, operator: string) {
    return this.createCampusWithTemplates(
      {
        name: body.name,
        shortName: body.shortName,
        warehouseName: body.warehouseName,
        address: body.address,
        buildingManagerBaseSalary: body.buildingManagerBaseSalary,
        deliveryFeeInstant: body.deliveryFeeInstant,
        deliveryFeeScheduled: body.deliveryFeeScheduled,
        deliveryThreshold: body.deliveryThreshold,
      },
      operator,
    );
  }

  /**
   * 建校区 + 官方库模板类别初始化（IKAJSL 建校区与 IKKRMS 开通首校区共用）。
   * organizationId 缺省=平台层（现状语义零变化）。
   */
  private async createCampusWithTemplates(
    body: {
      name: string;
      shortName: string;
      warehouseName: string;
      address?: string;
      buildingManagerBaseSalary?: number;
      deliveryFeeInstant?: number;
      deliveryFeeScheduled?: number;
      deliveryThreshold?: number;
    },
    operator: string,
    organizationId?: string,
  ) {
    const campus = await this.db.campus.create({
      data: {
        name: body.name,
        shortName: body.shortName,
        warehouseName: body.warehouseName,
        address: body.address ?? '',
        ...(organizationId ? { organizationId } : {}),
        // IKDOIU：楼长月度底薪（分，0=无底薪），settlements 物化时读取
        ...(body.buildingManagerBaseSalary != null
          ? { buildingManagerBaseSalary: body.buildingManagerBaseSalary }
          : {}),
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
    // IKKA1S：新校区初始化——复制官方库模板类别集（一套初始分类）
    const templates = await this.db.category.findMany({
      where: { campusId: OFFICIAL_CAMPUS_ID },
    });
    if (templates.length)
      await this.db.category.createMany({
        data: templates.map((t) => ({
          campusId: campus.id,
          name: t.name,
          sort: t.sort,
          image: t.image,
          hidden: t.hidden,
        })),
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
  async updateCampus(id: string, body: UpdateCampusDto, operator: string) {
    const before = await this.db.campus.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('校区不存在');
    if (before.status === 'official')
      throw new BadRequestException('官方商品库校区不可修改');
    // IKFOPY：总部仓是系统预置中转仓——名称可改，但不可停用（停用即从
    // 授权切换/库存视角消失，中转链路断）；type 永不改（DTO 亦无此字段）
    if (before.type === 'hq' && body.status && body.status !== 'active')
      throw new BadRequestException('总部仓不可停用');
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
        // IKDOIU：楼长月度底薪（分，0=无底薪）
        ...(body.buildingManagerBaseSalary != null
          ? { buildingManagerBaseSalary: body.buildingManagerBaseSalary }
          : {}),
        // IKHMF1：客服电话（校区自定义，小程序拨号展示）
        ...(body.servicePhone != null
          ? { servicePhone: body.servicePhone }
          : {}),
        // IKHMKR：无楼长提示（校区自定义，空串=回落默认文案）
        ...(body.noManagerTip != null
          ? { noManagerTip: body.noManagerTip }
          : {}),
        // 打烊窗/手动闭店（可选不传不动）：平台账号管理任意校区配送营业配置
        ...(body.closeStart ? { closeStart: body.closeStart } : {}),
        ...(body.closeEnd ? { closeEnd: body.closeEnd } : {}),
        ...(body.manualClosed === undefined || body.manualClosed === null
          ? {}
          : { manualClosed: body.manualClosed }),
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
      // IKDEN2：不限量券 remain=null（后台显示「不限量」）
      remain: x.total === null ? null : Math.max(0, x.total - x.claimed),
    }));
  }
  async createCoupon(
    body: CreateCouponDto,
    operator: string,
    campusId: string,
  ) {
    // IKDCVO：长期券不传 expiresAt（null=长期有效）；传了则须合法且晚于当前。
    let expiresAt: Date | null = null;
    if (body.expiresAt) {
      expiresAt = new Date(body.expiresAt);
      if (Number.isNaN(expiresAt.getTime()))
        throw new BadRequestException('过期时间格式不正确');
      if (expiresAt.getTime() <= Date.now())
        throw new BadRequestException('过期时间必须晚于当前时间');
    }
    const kind = body.kind === 'partner' ? 'partner' : 'platform';
    const trigger = ['manual', 'lottery', 'signup'].includes(body.trigger ?? '')
      ? body.trigger!
      : 'manual';
    if (kind === 'partner' && (body.amount !== 0 || body.threshold !== 0))
      throw new BadRequestException('异业券不参与下单抵扣，金额/门槛请填 0');
    if (kind === 'platform' && !(body.amount > 0))
      throw new BadRequestException('金额券面额必须大于 0');
    const coupon = await this.db.coupon.create({
      data: {
        campusId,
        name: body.name,
        kind,
        trigger,
        remark: body.remark?.trim() ?? '',
        amount: kind === 'partner' ? 0 : body.amount,
        threshold: kind === 'partner' ? 0 : body.threshold,
        // IKDEN2：不传 total = 不限量（null）
        total: body.total ?? null,
        status: 'active',
        // 支付后推荐（道哥 2026-09-08）：支付成功页领券卡
        featuredAfterPay: body.featuredAfterPay ?? false,
        // IKKEWS：每人限领（0=不限，缺省 1）与定向券标记
        perUserLimit: body.perUserLimit ?? 1,
        targetedOnly: body.targetedOnly ?? false,
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
  /**
   * 优惠券删除（IKDES1）：仅限从未发放（issued=0 且 claimed=0）——无
   * UserCoupon 引用，物理删除无资产影响；有发放记录拒绝（用户资产与
   * 流水依赖，请用暂停发放）。转盘奖位 JSON 引用无外键，抽中自动降级。
   */
  async deleteCoupon(id: string, operator: string, campusId: string) {
    const coupon = await this.db.coupon.findFirst({ where: { id, campusId } });
    if (!coupon) throw new NotFoundException('优惠券不存在');
    if (coupon.issued > 0 || coupon.claimed > 0)
      throw new BadRequestException(
        `该券已有发放记录（发放 ${coupon.issued} 张），删除会影响用户资产，请使用「暂停发放」下线`,
      );
    await this.db.coupon.delete({ where: { id } });
    await this.audit(
      operator,
      'coupon.delete',
      'coupon',
      id,
      coupon,
      null,
      campusId,
    );
    return { id, deleted: true };
  }
  /**
   * 优惠券编辑（IKDERC）：全字段可选 PATCH。
   * 管控：已发放（claimed>0）锁面额/门槛（资金口径）；partner 券面额/门槛
   * 恒 0 不可改；total 不得小于已发数（null=转不限量）；expiresAt null=转长期。
   */
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
    // 编辑语义：amount/threshold 不存在「清空」，null 一律视为未传
    const amount = body.amount ?? undefined;
    const threshold = body.threshold ?? undefined;
    const locked = before.claimed > 0;
    if ((amount !== undefined || threshold !== undefined) && locked)
      throw new BadRequestException(
        `该券已发放 ${before.claimed} 张，面额与使用门槛锁定不可修改（可调名称/总量/有效期或暂停）`,
      );
    if (
      before.kind === 'partner' &&
      (amount !== undefined || threshold !== undefined)
    )
      throw new BadRequestException('异业券不参与下单，面额/门槛固定为 0');
    if (
      body.total !== undefined &&
      body.total !== null &&
      body.total < before.claimed
    )
      throw new BadRequestException(
        `发放总量不能小于已发放数（已发 ${before.claimed} 张）`,
      );
    if (amount !== undefined && before.kind === 'platform' && amount <= 0)
      throw new BadRequestException('金额券面额必须大于 0');
    const data: Prisma.CouponUpdateInput = {};
    if (body.status !== undefined) data.status = body.status;
    if (body.name !== undefined) data.name = body.name;
    if (body.remark !== undefined) data.remark = body.remark;
    // 支付后推荐（道哥 2026-09-08）：undefined 不动
    if (body.featuredAfterPay !== undefined)
      data.featuredAfterPay = body.featuredAfterPay;
    // IKKEWS：每人限领与定向券标记
    if (body.perUserLimit !== undefined) data.perUserLimit = body.perUserLimit;
    if (body.targetedOnly !== undefined) data.targetedOnly = body.targetedOnly;
    if (amount !== undefined) data.amount = amount;
    if (threshold !== undefined) data.threshold = threshold;
    // total/expiresAt：undefined 不动；null 显式转不限量/长期
    if (body.total !== undefined) data.total = body.total;
    if (body.expiresAt !== undefined)
      data.expiresAt = body.expiresAt ? new Date(body.expiresAt) : null;
    if (!Object.keys(data).length)
      throw new BadRequestException('没有要修改的字段');
    const after = await this.db.coupon.update({
      where: { id },
      data,
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
    if (coupon.expiresAt && coupon.expiresAt.getTime() <= Date.now())
      throw new BadRequestException('已过期的优惠券不能发放');
    // IKD6FI 定向发券：显式 userIds 与定向条件（手机号/楼栋/楼层/寝室）并集去重
    const targeted = await this.resolveCouponTargets(body, campusId);
    const explicit = body.userIds ?? [];
    if (explicit.length) {
      // 券跨校园：显式指定的用户只能给本校用户发放（定向解析结果天然本校）。
      const users = await this.db.user.findMany({
        where: { id: { in: explicit }, campusId },
        select: { id: true },
      });
      if (users.length !== explicit.length)
        throw new BadRequestException('部分用户不存在或不在当前校园');
    }
    const userIds = [...new Set([...explicit, ...targeted])];
    if (!userIds.length)
      throw new BadRequestException(
        body.phones?.length || body.buildingId
          ? '定向条件未匹配到任何用户，请检查手机号/寝室范围'
          : '请选择发放对象',
      );
    // IKKEWS 多张发放：每人可补发张数 = perUserLimit − 未使用持有数
    // （0=不限——只受券总量约束）；已达限领的用户跳过。
    const limit = coupon.perUserLimit ?? 1; // 0=不限
    const wantCount =
      limit === 0 ? (body.count ?? 1) : Math.min(body.count ?? 1, limit);
    const holdings = await this.db.userCoupon.findMany({
      where: { couponId: id, userId: { in: userIds }, status: { not: 'used' } },
      select: { userId: true },
    });
    const heldCount = new Map<string, number>();
    for (const h of holdings)
      heldCount.set(h.userId, (heldCount.get(h.userId) ?? 0) + 1);
    const grants = userIds
      .map((userId) => ({
        userId,
        count:
          limit === 0
            ? wantCount // 不限领：按 wantCount 直发
            : Math.min(
                wantCount,
                Math.max(0, limit - (heldCount.get(userId) ?? 0)),
              ),
      }))
      .filter((g) => g.count > 0);
    if (!grants.length)
      throw new BadRequestException(
        body.phones?.length || body.buildingId
          ? '定向条件未匹配到可发放的用户（命中用户均已达到每人限领张数）'
          : '所选用户均已达到每人限领张数',
      );
    const totalGrant = grants.reduce((sum, g) => sum + g.count, 0);
    const result = await this.db.$transaction(async (tx) => {
      // 条件更新兜底并发：已领取数加上本次发放总数不能超过总量。
      // IKDEN2：不限量券（total=null）跳过额度条件。
      const won = await tx.coupon.updateMany({
        where: {
          id,
          ...(coupon.total === null
            ? {}
            : { claimed: { lte: coupon.total - totalGrant } }),
        },
        data: {
          claimed: { increment: totalGrant },
          issued: { increment: totalGrant },
        },
      });
      if (!won.count)
        throw new BadRequestException('发放数量超过优惠券剩余额度');
      return tx.userCoupon.createMany({
        data: grants.flatMap((g) =>
          Array.from({ length: g.count }, () => ({
            userId: g.userId,
            couponId: id,
            status: 'claimed',
          })),
        ),
      });
    });
    await this.audit(
      operator,
      'coupon.issue',
      'coupon',
      id,
      coupon,
      {
        grants,
        skipped: userIds.filter(
          (userId) => !grants.some((g) => g.userId === userId),
        ),
      },
      campusId,
    );
    return {
      issued: result.count,
      targets: grants.map((g) => g.userId),
      couponId: id,
    };
  }
  /**
   * 定向发券目标解析（IKD6FI）：手机号（绑定手机号口径，非微信昵称）→
   * 本校区 User；寝室条件 → 本校区 Address（楼栋必填，楼层/寝室号可选收窄）
   * 反查用户。用户没填过地址则只能按手机号触达。
   */
  private async resolveCouponTargets(body: IssueCouponDto, campusId: string) {
    const ids: string[] = [];
    if (body.phones?.length) {
      const users = await this.db.user.findMany({
        where: { campusId, phone: { in: body.phones } },
        select: { id: true },
      });
      ids.push(...users.map((u) => u.id));
    }
    if (body.buildingId) {
      const users = await this.db.user.findMany({
        where: {
          campusId,
          addresses: {
            some: {
              buildingId: body.buildingId,
              ...(body.floor ? { floor: body.floor } : {}),
              ...(body.roomNos?.length ? { room: { in: body.roomNos } } : {}),
            },
          },
        },
        select: { id: true },
      });
      ids.push(...users.map((u) => u.id));
    }
    return ids;
  }
  /**
   * 营销地图（IKD6FI）：楼栋 × 楼层 × 寝室的下单聚合（近 N 天已支付订单，
   * 地址取订单 Json 快照）。格子以 Room 表寝室为底（未下单寝室补零），
   * 快照寝室（legacy 手填）额外并入。
   */
  async marketingMap(buildingId: string, campusId: string, days = 30) {
    const building = await this.db.building.findFirst({
      where: { id: buildingId, campusId },
    });
    if (!building) throw new NotFoundException('楼栋不存在');
    const since = new Date(Date.now() - Math.max(1, days) * 86_400_000);
    const [orders, rooms] = await Promise.all([
      this.db.order.findMany({
        where: { campusId, paidAt: { not: null }, createdAt: { gte: since } },
        select: { address: true, payableAmount: true, userId: true },
      }),
      this.db.room.findMany({
        where: { buildingId },
        select: { floor: true, roomNo: true },
        orderBy: [{ floor: 'asc' }, { roomNo: 'asc' }],
      }),
    ]);
    type Cell = {
      floor: number;
      room: string;
      orders: number;
      amount: number;
      users: Set<string>;
    };
    const cells = new Map<string, Cell>();
    const ensure = (floor: number, room: string) => {
      const key = `${floor}-${room}`;
      let cell = cells.get(key);
      if (!cell) {
        cell = { floor, room, orders: 0, amount: 0, users: new Set() };
        cells.set(key, cell);
      }
      return cell;
    };
    for (const r of rooms) ensure(r.floor, r.roomNo);
    for (const o of orders) {
      const a = o.address as {
        buildingId?: string;
        buildingName?: string;
        floor?: number;
        room?: string;
      };
      if (!a?.floor || !a.room) continue;
      // 快照匹配：buildingId 优先，legacy 手填地址按楼栋名兜底
      if (a.buildingId !== buildingId && a.buildingName !== building.name)
        continue;
      const cell = ensure(a.floor, a.room);
      cell.orders += 1;
      cell.amount += o.payableAmount;
      cell.users.add(o.userId);
    }
    const floorMap = new Map<number, Cell[]>();
    for (const cell of cells.values()) {
      const list = floorMap.get(cell.floor) ?? [];
      list.push(cell);
      floorMap.set(cell.floor, list);
    }
    const floors = [...floorMap.entries()]
      .sort((x, y) => x[0] - y[0])
      .map(([floor, list]) => {
        const sorted = list.sort((a, b) =>
          a.room.localeCompare(b.room, 'zh-Hans-CN', { numeric: true }),
        );
        return {
          floor,
          orders: sorted.reduce((s, x) => s + x.orders, 0),
          amount: sorted.reduce((s, x) => s + x.amount, 0),
          rooms: sorted.map((x) => ({
            room: x.room,
            orders: x.orders,
            amount: x.amount,
            users: x.users.size,
          })),
        };
      });
    return {
      building: { id: building.id, name: building.name },
      days: Math.max(1, days),
      totals: {
        orders: floors.reduce((s, f) => s + f.orders, 0),
        amount: floors.reduce((s, f) => s + f.amount, 0),
      },
      floors,
    };
  }
  /** 审计日志：IKAJSL campusId 空 = 总部跨校区视角。 */
  /** IKB5P8：审计列表同样人话化——附操作人昵称/中文动作/中文对象，原始代码只留 entityId 备查。 */
  async auditLogs(campusId: string) {
    const rows = await this.db.auditLog.findMany({
      // Permission snapshots may contain grants in other campuses. They belong only
      // to the separately authorized, platform-only RBAC audit endpoint.
      where: {
        ...(campusId ? { campusId } : {}),
        NOT: { action: { startsWith: 'rbac.' } },
      },
      orderBy: { createdAt: 'desc' },
    });
    const names = await this.operatorNames(rows.map((x) => x.operator));
    const safeRecruitSnapshot = (value: Prisma.JsonValue | null) => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        return value;
      const { staffRemark, idCardImages, idCardNo, ...rest } = value;
      return {
        ...rest,
        ...(staffRemark !== undefined
          ? { hasStaffRemark: Boolean(staffRemark) }
          : {}),
        ...(typeof idCardNo === 'string'
          ? { idCardNo: maskIdCard(idCardNo) }
          : {}),
      };
    };
    return rows.map((x) => ({
      ...x,
      ...(x.entityType === 'recruitingApplication'
        ? {
            before: safeRecruitSnapshot(x.before),
            after: safeRecruitSnapshot(x.after),
          }
        : {}),
      operatorName: names.get(x.operator) ?? '系统',
      actionText: AdminService.AUDIT_ACTION_TEXTS[x.action] ?? '后台操作',
      entityText: AdminService.AUDIT_ENTITY_TEXTS[x.entityType] ?? '后台数据',
    }));
  }

  /* ---------- 后台账号管理（IK9KWO → RBAC V1 2026-09-19）：仅超管（rbac.accounts.*） ---------- */
  /** 账号查询（rbac/me 等控制器路径用）。 */
  findAccount(id: string) {
    return this.db.adminAccount.findUnique({ where: { id } });
  }
  /** 列表不回 passwordHash；附 RBAC 角色授权明细与状态（V1 全量视角）。 */
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
        status: true,
        createdAt: true,
        // IKKRMP：账号固定数据边界（NULL=历史推导；组织 UI 属 IKKRMS）
        orgLevel: true,
        organizationId: true,
        rbacRoles: {
          include: {
            role: { select: { code: true, name: true, status: true } },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    const grantsByAccount = new Map<
      string,
      {
        roleCode: string;
        roleName: string;
        roleStatus: string;
        scope: string;
        campusId: string | null;
      }[]
    >();
    for (const x of xs) {
      grantsByAccount.set(
        x.id,
        x.rbacRoles.map((g) => ({
          roleCode: g.role.code,
          roleName: g.role.name,
          roleStatus: g.role.status,
          scope: g.scope,
          campusId: g.campusId,
        })),
      );
    }
    const campuses = await this.db.campus.findMany({
      select: { id: true, name: true, shortName: true },
    });
    const nameById = new Map(
      campuses.map((c) => [c.id, c.shortName || c.name]),
    );
    return xs.map(({ rbacRoles, ...x }) => ({
      ...x,
      grants: grantsByAccount.get(x.id) ?? [],
      campusName: x.campusId ? (nameById.get(x.campusId) ?? '') : '平台',
      campusNames: [
        ...new Set(
          (grantsByAccount.get(x.id) ?? [])
            .filter((g) => g.scope === 'campus' && g.campusId)
            .map((g) => nameById.get(g.campusId!) ?? '')
            .filter(Boolean),
        ),
      ],
    }));
  }
  /** Account profile and permissions share an atomic RBAC transaction.
   * IKKRMQ：账号写端点现状超管独占（守卫拦截非超管），此处仅剩 spec 夹具
   * 调用——操作者按超管声明（对齐控制器 grantActor 透传 ctx.super）。 */
  createAccount(body: CreateAccountDto, operator: string) {
    return this.rbac.createAccount(
      { id: operator, username: operator, super: true },
      body,
    );
  }
  updateAccount(id: string, body: { nickname?: string }, operator: string) {
    return this.rbac.updateAccount(
      { id: operator, username: operator, super: true },
      id,
      body,
    );
  }
  deleteAccount(id: string, operator: string) {
    return this.rbac.deleteAccount(
      { id: operator, username: operator, super: true },
      id,
    );
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
      buildingName: g.buildingId
        ? (nameById.get(g.buildingId) ?? '未知楼栋')
        : '校级大群',
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

  /* ---------- 抽奖大转盘（IKD6FC）：单校区单配置 ---------- */

  /** 奖位读视图：coupon 附带券名/余量（前端下拉回显与发完预警）。 */
  async wheel(campusId: string) {
    const row = await this.db.lotteryWheel.findUnique({
      where: { campusId },
    });
    const prizes = row ? (JSON.parse(row.prizes) as any[]) : [];
    // IKDCVO：partner 行配异业券后同样带券名/余量（编辑抽屉与奖池行展示）
    const couponIds = prizes
      .filter((p) => p.couponId)
      .map((p) => p.couponId as string);
    const coupons = couponIds.length
      ? await this.db.coupon.findMany({
          where: { id: { in: couponIds } },
          select: { id: true, name: true, total: true, claimed: true },
        })
      : [];
    const couponById = new Map(coupons.map((c) => [c.id, c]));
    const weightTotal = prizes.reduce((s, p) => s + (p.weight || 0), 0);
    return {
      active: row?.active ?? false,
      prizes: prizes.map((p) => {
        const c = p.couponId ? couponById.get(p.couponId) : null;
        return {
          ...p,
          couponName: c?.name ?? '',
          // IKDEN2：不限量券余量显示 null（后台转盘抽屉显示「不限量」）
          couponLeft: c
            ? c.total === null
              ? null
              : c.total - c.claimed
            : null,
          weightPct:
            weightTotal > 0
              ? Math.round(((p.weight || 0) / weightTotal) * 1000) / 10
              : 0,
        };
      }),
    };
  }

  /** 保存配置：8 位逐项校验（券归属本校区/类型字段齐备），upsert 单行。 */
  async upsertWheel(
    body: { active: boolean; prizes: any[] },
    operator: string,
    campusId: string,
  ) {
    const prizes = body.prizes ?? [];
    if (prizes.length !== 8) throw new BadRequestException('奖位必须为 8 个');
    if (body.active && prizes.every((p) => !(p.weight > 0)))
      throw new BadRequestException('至少一个奖位的权重大于 0');
    for (const [i, p] of prizes.entries()) {
      if (!['coupon', 'partner', 'none'].includes(p.type))
        throw new BadRequestException(`奖位 ${i + 1}：类型不合法`);
      if (!p.label || !String(p.label).trim())
        throw new BadRequestException(`奖位 ${i + 1}：请填写扇区文案`);
      if (p.type === 'coupon') {
        if (!p.couponId)
          throw new BadRequestException(`奖位 ${i + 1}：请选择优惠券`);
        const coupon = await this.db.coupon.findFirst({
          where: { id: p.couponId, campusId, kind: 'platform' },
        });
        if (!coupon)
          throw new BadRequestException(
            `奖位 ${i + 1}：优惠券不存在或不属于本校区`,
          );
      }
      if (p.type === 'partner') {
        // IKDCVO：partner 行配异业券 → 抽中发券入账（发不出回落图文）；
        // bizImage 随之可选——存量纯图文（无 couponId）仍要求图片。
        if (p.couponId) {
          const coupon = await this.db.coupon.findFirst({
            where: { id: p.couponId, campusId, kind: 'partner' },
          });
          if (!coupon)
            throw new BadRequestException(
              `奖位 ${i + 1}：异业券不存在或不属于本校区（请选异业类型的券）`,
            );
        } else if (!p.bizImage) {
          throw new BadRequestException(
            `奖位 ${i + 1}：请上传异业图文图片或选择异业券`,
          );
        }
      }
    }
    const data = JSON.stringify(
      prizes.map((p) => ({
        type: p.type,
        label: String(p.label).trim(),
        ...(p.type === 'coupon' ? { couponId: p.couponId } : {}),
        ...(p.type === 'partner'
          ? {
              ...(p.couponId ? { couponId: p.couponId } : {}),
              bizTitle: p.bizTitle ?? '',
              bizImage: p.bizImage ?? '',
              bizNote: p.bizNote ?? '',
            }
          : {}),
        weight: p.weight,
      })),
    );
    const row = await this.db.lotteryWheel.upsert({
      where: { campusId },
      create: { campusId, active: body.active, prizes: data },
      update: { active: body.active, prizes: data },
    });
    await this.audit(
      operator,
      'wheel.upsert',
      'wheel',
      row.id,
      null,
      { active: body.active },
      campusId,
    );
    return row;
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
      /** IKKKC2：定向发券场景回明文手机号（默认脱敏口径不变） */
      plainPhone?: boolean;
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
              ...(opts.dateTo
                ? { lte: new Date(`${opts.dateTo}T23:59:59`) }
                : {}),
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
      value && value.length > 6
        ? `${value.slice(0, 3)}****${value.slice(-3)}`
        : value;
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
          // IKKKC2：明文手机号（仅定向发券抽屉请求时下发）
          ...(opts.plainPhone ? { phone: u.phone } : {}),
          buildingName: addr?.buildingName ?? '',
          room: addr?.room ?? '',
          createdAt: u.createdAt.toISOString(),
          ...(aggById.get(u.id) ?? { orderCount: 0, totalSpend: 0 }),
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
        where: {
          ...scope,
          createdAt: { gte: startOfMonth },
          paidAt: { not: null },
        },
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
      avgOrders: total ? Number((paidAgg._count._all / total).toFixed(1)) : 0,
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
  /** 查看用户明文手机号（IKDG8V）：列表恒脱敏（maskPhone），明文按需
   *  单查返回 + 审计留痕（敏感数据查看留痕，同后台操作惯例）。 */
  async revealUserPhone(id: string, operator: string, campusId: string) {
    const user = await this.db.user.findFirst({
      where: { id, ...(campusId ? { campusId } : {}) },
      select: { id: true, phone: true, campusId: true },
    });
    if (!user) throw new NotFoundException('用户不存在');
    await this.audit(
      operator,
      'users.phone-reveal',
      'user',
      user.id,
      null,
      { revealed: true },
      user.campusId,
      true,
    );
    return { id: user.id, phone: user.phone };
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
        role === 'admin'
          ? '至少需要保留一个超管账号'
          : '至少需要保留一个总部账号',
      );
  }
  /** 审计留痕（全局 ~49 处调用）：写入失败只 warn 不抛——业务更新在审计前
   *  已提交，审计故障不应把成功的操作变成 500（IKC1AA「更新报错但实际
   *  已生效」的假报错即此形状）。 */
  /* ---------- 楼长招募（IKEAGE，2026-09-09）：C 端报名 → 面试审批 → 实习楼长 ---------- */
  /** 报名列表：campusId 空串=不限（hq/admin 跨校区视角）；附校区名与通过后的工号。 */
  async recruitApplications(
    campusId: string,
    status?: string,
    keyword?: string,
  ) {
    const xs = await this.db.recruitingApplication.findMany({
      where: {
        ...(campusId ? { campusId } : {}),
        ...(status ? { status } : {}),
        ...(keyword
          ? {
              OR: [
                { name: { contains: keyword } },
                { phone: { contains: keyword } },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    const campuses = await this.db.campus.findMany({
      where: { status: { not: 'official' } },
      select: { id: true, name: true, shortName: true },
    });
    const nameById = new Map(
      campuses.map((c) => [c.id, c.shortName || c.name]),
    );
    // approved 行附带工号（列表直接展示，不必逐行开详情）
    const staffIds = xs.filter((x) => x.staffId).map((x) => x.staffId!);
    const staffByid = staffIds.length
      ? new Map(
          (
            await this.db.staff.findMany({
              where: { id: { in: staffIds } },
              select: { id: true, staffNo: true },
            })
          ).map((s) => [s.id, s.staffNo]),
        )
      : new Map<string, string>();
    return xs.map((x) => ({
      ...x,
      // RBAC V1（goal 硬要求）：候选人列表不回后台证件与运营备注——
      // 身份证号/照片/备注仅经 /recruit-applications/:id/idcard 专用端点（权限+审计）读取
      idCardNo: undefined,
      idCardImages: undefined,
      staffRemark: undefined,
      hasIdCard: Boolean(x.idCardNo || x.idCardImages),
      campusName: nameById.get(x.campusId) ?? '',
      staffNo: x.staffId ? (staffByid.get(x.staffId) ?? '') : '',
    }));
  }

  /** 身份证/运营备注专用读取（RBAC V1）：recruit.idcard.read 或 recruit.note
   *  持有者可用；身份证照片回 COS 临时签名 URL（5 分钟，私有读）。 */
  async recruitIdcard(id: string, campusId: string) {
    const found = campusId
      ? await this.db.recruitingApplication.findFirst({
          where: { id, campusId },
        })
      : await this.db.recruitingApplication.findUnique({ where: { id } });
    if (!found) throw new NotFoundException('报名不存在');
    const images = Array.isArray(found.idCardImages)
      ? (found.idCardImages as unknown as string[])
      : [];
    return {
      id: found.id,
      name: found.name,
      idCardNo: found.idCardNo,
      idCardImages: images.map((u) => presignCosUrl(u, 300)),
      staffRemark: found.staffRemark,
    };
  }

  /** 状态 Tab 计数（IKEAGE）：pending/interviewing/approved/rejected。 */
  async recruitStatusCounts(campusId: string) {
    const grouped = await this.db.recruitingApplication.groupBy({
      by: ['status'],
      where: campusId ? { campusId } : {},
      _count: true,
    });
    return Object.fromEntries(grouped.map((g) => [g.status, g._count]));
  }

  /** 资料补录（IKEAGE）：身份证号/照片/运营备注随时可补，不占状态机。 */
  async updateRecruitApplication(
    id: string,
    body: UpdateRecruitApplicationDto,
    operator: string,
    campusId: string,
  ) {
    const found = campusId
      ? await this.db.recruitingApplication.findFirst({
          where: { id, campusId },
        })
      : await this.db.recruitingApplication.findUnique({ where: { id } });
    if (!found) throw new NotFoundException('报名不存在');
    const updated = await this.db.recruitingApplication.update({
      where: { id },
      data: {
        idCardNo:
          body.idCardNo === undefined ? undefined : body.idCardNo.trim(),
        idCardImages: body.idCardImages as unknown as Prisma.InputJsonValue,
        // IKEAGE：运营备注独立字段（原误绑候选人 note，已切分）
        staffRemark:
          body.staffRemark === undefined ? undefined : body.staffRemark.trim(),
      },
    });
    await this.audit(
      operator,
      'recruit.update',
      'recruitingApplication',
      id,
      // RBAC V1：审计不留身份证明文（掩码保尾 2 位供核对）
      {
        idCardNo: maskIdCard(found.idCardNo),
        hasStaffRemark: Boolean(found.staffRemark),
      },
      {
        idCardNo: maskIdCard(updated.idCardNo),
        hasStaffRemark: Boolean(updated.staffRemark),
      },
      found.campusId,
    );
    return updated;
  }

  /** 待联系 → 面试中（运营已联系上候选人）。 */
  async recruitTransition(id: string, operator: string, campusId: string) {
    const found = campusId
      ? await this.db.recruitingApplication.findFirst({
          where: { id, campusId },
        })
      : await this.db.recruitingApplication.findUnique({ where: { id } });
    if (!found) throw new NotFoundException('报名不存在');
    if (found.status !== 'pending')
      throw new BadRequestException('仅「待联系」状态可进入面试');
    const updated = await this.db.recruitingApplication.update({
      where: { id },
      data: { status: 'interviewing' },
    });
    await this.audit(
      operator,
      'recruit.interview',
      'recruitingApplication',
      id,
      { status: found.status },
      { status: updated.status },
      found.campusId,
    );
    return updated;
  }

  /** 拒绝（IKEAGE）：原因 C 端进度页展示；被拒后候选人可重新报名。 */
  async recruitReject(
    id: string,
    reason: string,
    operator: string,
    campusId: string,
  ) {
    if (!reason.trim())
      throw new BadRequestException('请填写拒绝原因（候选人可见）');
    const found = campusId
      ? await this.db.recruitingApplication.findFirst({
          where: { id, campusId },
        })
      : await this.db.recruitingApplication.findUnique({ where: { id } });
    if (!found) throw new NotFoundException('报名不存在');
    if (found.status !== 'pending' && found.status !== 'interviewing')
      throw new BadRequestException('该报名已结束流程');
    const auditName =
      (await this.operatorNames([operator])).get(operator) ?? '';
    const updated = await this.db.recruitingApplication.update({
      where: { id },
      data: {
        status: 'rejected',
        rejectReason: reason.trim(),
        auditBy: operator,
        auditByName: auditName,
        auditedAt: new Date(),
      },
    });
    await this.audit(
      operator,
      'recruit.reject',
      'recruitingApplication',
      id,
      { status: found.status },
      { status: 'rejected', reason: reason.trim() },
      found.campusId,
    );
    return updated;
  }

  /**
   * 审批通过（IKEAGE）：事务内生成工号 IBM-{序号} + 创建实习楼长
   * （campusId=报名校区，非操作者校区；与正式楼长同权同价，仅角色标记）。
   */
  async recruitApprove(id: string, operator: string, campusId: string) {
    const result = await this.db.$transaction(async (tx) => {
      const found = campusId
        ? await tx.recruitingApplication.findFirst({
            where: { id, campusId },
          })
        : await tx.recruitingApplication.findUnique({ where: { id } });
      if (!found) throw new NotFoundException('报名不存在');
      if (found.status === 'approved')
        throw new BadRequestException('该报名已通过');
      if (found.status === 'rejected')
        throw new BadRequestException('该报名已被拒绝');
      // 工号：IBM-{3位序号}，同前缀最大 +1（跨校区唯一序号段）
      const last = await tx.staff.findFirst({
        where: { staffNo: { startsWith: 'IBM-' } },
        orderBy: { staffNo: 'desc' },
        select: { staffNo: true },
      });
      const seq = last ? Number(last.staffNo.slice(4)) + 1 : 1;
      const staffNo = `IBM-${String(seq).padStart(3, '0')}`;
      const staff = await tx.staff.create({
        data: {
          campusId: found.campusId,
          name: found.name,
          role: 'intern-building-manager',
          roleText: `${found.buildingName}实习楼长`,
          staffNo,
          buildingId: found.buildingId,
          building: found.buildingName,
          status: 'online',
          onTimeRate: 100,
          income: 0,
        },
      });
      const account = await tx.adminAccount.findUnique({
        where: { id: operator },
        select: { nickname: true, username: true },
      });
      const auditName = account?.nickname || account?.username || '';
      const application = await tx.recruitingApplication.update({
        where: { id },
        data: {
          status: 'approved',
          staffId: staff.id,
          auditBy: operator,
          auditByName: auditName,
          auditedAt: new Date(),
        },
      });
      return { application, staff };
    });
    await this.audit(
      operator,
      'recruit.approve',
      'recruitingApplication',
      id,
      { status: 'pending' },
      { status: 'approved', staffNo: result.staff.staffNo },
      result.application.campusId,
    );
    return result;
  }

  private async audit(
    operator: string,
    action: string,
    entityType: string,
    entityId: string,
    before: unknown,
    after: unknown,
    campusId: string,
    required = false,
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
      if (required)
        throw new ServiceUnavailableException('审计服务暂不可用，请稍后重试');
      console.warn(
        `[audit] 审计写入失败（不影响业务操作）: ${action} ${entityType}/${entityId}`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  /* ---------- IKHM1O 校区配置聚合页：一次拉全该校区全部配置 ---------- */

  /** 聚合读（campuses 读权限）：档案+配送营业+底薪（campus 行）+ 送达时段 + 公告。 */
  async campusConfig(campusId: string) {
    const [campus, slots, notices] = await Promise.all([
      this.db.campus.findFirstOrThrow({
        where: { id: campusId },
        select: {
          id: true,
          name: true,
          shortName: true,
          warehouseName: true,
          address: true,
          status: true,
          type: true,
          deliveryFeeInstant: true,
          deliveryFeeScheduled: true,
          deliveryThreshold: true,
          closeStart: true,
          closeEnd: true,
          manualClosed: true,
          buildingManagerBaseSalary: true,
          // IKHMF1 客服电话：校区自定义，聚合页档案 Tab 编辑
          servicePhone: true,
          // IKHMKR 无楼长提示：校区自定义，聚合页配送 Tab 编辑
          noManagerTip: true,
        },
      }),
      this.db.deliverySlot.findMany({
        where: { campusId },
        orderBy: { label: 'asc' },
      }),
      this.db.notice.findMany({
        where: { campusId },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    return { campus, slots, notices };
  }

  /* ---------- 送达时段管理（IKHM1O 补窟窿：原无后台入口） ---------- */

  async createSlot(body: CreateSlotDto, operator: string, scope: string) {
    const campusId = scope || body.campusId;
    const slot = await this.db.deliverySlot.create({
      data: {
        campusId,
        label: body.label,
        capacity: body.capacity ?? 100,
      },
    });
    await this.audit(
      operator,
      'slot.create',
      'delivery-slot',
      slot.id,
      null,
      slot,
      campusId,
    );
    return slot;
  }
  async updateSlot(
    id: string,
    body: UpdateSlotDto,
    operator: string,
    scope: string,
  ) {
    const before = await this.db.deliverySlot.findFirst({
      where: { id, ...(scope ? { campusId: scope } : {}) },
    });
    if (!before) throw new NotFoundException('记录不存在');
    const after = await this.db.deliverySlot.update({
      where: { id },
      data: {
        ...(body.label != null ? { label: body.label } : {}),
        ...(body.capacity != null ? { capacity: body.capacity } : {}),
        ...(body.available != null ? { available: body.available } : {}),
      },
    });
    await this.audit(
      operator,
      'slot.update',
      'delivery-slot',
      id,
      before,
      after,
      before.campusId,
    );
    return after;
  }
  async deleteSlot(id: string, operator: string, scope: string) {
    const before = await this.db.deliverySlot.findFirst({
      where: { id, ...(scope ? { campusId: scope } : {}) },
    });
    if (!before) throw new NotFoundException('记录不存在');
    await this.db.deliverySlot.delete({ where: { id } });
    await this.audit(
      operator,
      'slot.delete',
      'delivery-slot',
      id,
      before,
      null,
      before.campusId,
    );
    return { id, deleted: true };
  }

  /* ---------- 公告（IKHM1P）：校区多条 + 生效窗 + 启停 ---------- */

  async notices(campusId: string) {
    return this.db.notice.findMany({
      where: { campusId },
      orderBy: { createdAt: 'asc' },
    });
  }
  async createNotice(body: CreateNoticeDto, operator: string, scope: string) {
    const campusId = scope || body.campusId;
    const startsAt = new Date(body.startsAt);
    const endsAt = new Date(body.endsAt);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime()))
      throw new BadRequestException('时间格式不正确');
    if (endsAt <= startsAt)
      throw new BadRequestException('结束时间必须晚于开始时间');
    const notice = await this.db.notice.create({
      data: { campusId, content: body.content, startsAt, endsAt },
    });
    await this.audit(
      operator,
      'notice.create',
      'notice',
      notice.id,
      null,
      notice,
      campusId,
    );
    return notice;
  }
  async updateNotice(
    id: string,
    body: UpdateNoticeDto,
    operator: string,
    scope: string,
  ) {
    const before = await this.db.notice.findFirst({
      where: { id, ...(scope ? { campusId: scope } : {}) },
    });
    if (!before) throw new NotFoundException('记录不存在');
    const startsAt = body.startsAt ? new Date(body.startsAt) : undefined;
    const endsAt = body.endsAt ? new Date(body.endsAt) : undefined;
    if (startsAt && Number.isNaN(startsAt.getTime()))
      throw new BadRequestException('开始时间格式不正确');
    if (endsAt && Number.isNaN(endsAt.getTime()))
      throw new BadRequestException('结束时间格式不正确');
    const nextStart = startsAt ?? before.startsAt;
    const nextEnd = endsAt ?? before.endsAt;
    if (nextEnd <= nextStart)
      throw new BadRequestException('结束时间必须晚于开始时间');
    const after = await this.db.notice.update({
      where: { id },
      data: {
        ...(body.content != null ? { content: body.content } : {}),
        ...(startsAt ? { startsAt } : {}),
        ...(endsAt ? { endsAt } : {}),
        ...(body.status ? { status: body.status } : {}),
      },
    });
    await this.audit(
      operator,
      'notice.update',
      'notice',
      id,
      before,
      after,
      before.campusId,
    );
    return after;
  }
  async deleteNotice(id: string, operator: string, scope: string) {
    const before = await this.db.notice.findFirst({
      where: { id, ...(scope ? { campusId: scope } : {}) },
    });
    if (!before) throw new NotFoundException('记录不存在');
    await this.db.notice.delete({ where: { id } });
    await this.audit(
      operator,
      'notice.delete',
      'notice',
      id,
      before,
      null,
      before.campusId,
    );
    return { id, deleted: true };
  }
}
