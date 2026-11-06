import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { campusOrganizationId } from '../common/organization';
import { NightOrderService } from './night-order.service';
import {
  inNightWindow,
  nextDepositTier,
  nightBusinessDate,
} from './night.helpers';
import { NightStockOrderDto, NightDeliverDto } from './night.dto';
import { NightInventoryService } from './night-inventory.service';
import { parsePagination } from '../common/pagination';
import { NightReportingService } from './night-reporting.service';

const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

/**
 * 楼长端夜宵服务（IKSW1F /night-rider/*）：押金缴纳、备货下单（押金额度
 * 校验）、营业管理（互斥校验）、商品上下架、接单配送、收入明细。
 * 全部以「本人绑定的夜宵店」为唯一数据边界（store.managerStaffId=staffId）。
 */
@Injectable()
export class NightRiderService {
  constructor(
    private readonly db: PrismaService,
    private readonly orders: NightOrderService,
    private readonly inventory: NightInventoryService = new NightInventoryService(
      db,
    ),
  ) {}

  /** 所有履约员工均可查询；时间和资格由服务端裁决。 */
  async businessContext(staffId: string) {
    const staff = await this.db.staff.findUnique({
      where: { id: staffId },
      include: { campus: true },
    });
    if (!staff) throw new NotFoundException('员工不存在');
    const campus = staff.campus;
    const dayClosed =
      campus.manualClosed || inNightWindow(campus.closeStart, campus.closeEnd);
    const store = ['building-manager', 'intern-building-manager'].includes(
      staff.role,
    )
      ? await this.db.nightStore.findFirst({
          where: { managerStaffId: staffId, campusId: staff.campusId },
        })
      : null;
    const nightWindow =
      campus.nightEnabled &&
      inNightWindow(campus.nightStartAt, campus.nightEndAt);
    return {
      staffId: staff.id,
      staffRole: staff.role,
      // 工作台手动切换仅向已绑定夜宵店的正式楼长开放。
      canSwitchWorkspace: staff.role === 'building-manager' && Boolean(store),
      mode: !dayClosed ? 'day' : nightWindow && store ? 'night' : 'rest',
      hasNightStore: Boolean(store),
      campusName: campus.name,
      nightStartAt: campus.nightStartAt,
      nightEndAt: campus.nightEndAt,
      reason: !dayClosed
        ? ''
        : !store
          ? '当前已休息，暂无夜宵经营资格'
          : !campus.nightEnabled
            ? '校区尚未开放夜宵经营'
            : '尚未进入夜宵营业时间',
    };
  }

  /** 本人夜宵店（未绑定=404；解绑/换人后旧 token 立即失效口径）。 */
  private async myStore(staffId: string) {
    const staff = await this.db.staff.findUnique({ where: { id: staffId } });
    if (
      !staff ||
      !['building-manager', 'intern-building-manager'].includes(staff.role)
    )
      throw new NotFoundException('楼长账号不存在');
    const store = await this.db.nightStore.findFirst({
      where: { managerStaffId: staffId, campusId: staff.campusId },
      include: {
        building: { select: { id: true, name: true } },
        campus: {
          select: {
            id: true,
            name: true,
            nightEnabled: true,
            nightStartAt: true,
            nightEndAt: true,
            nightAcceptTimeout: true,
            closeStart: true,
            closeEnd: true,
            manualClosed: true,
          },
        },
      },
    });
    if (!store) throw new NotFoundException('尚未绑定夜宵店，请联系运营分配');
    return store;
  }

  /* ==================== 押金 ==================== */

  /** 押金档位：当前余额 + 下一档 + 差额（初始 500，按 500 档递增补缴）。 */
  async depositTiers(staffId: string) {
    const store = await this.myStore(staffId);
    const nextTier = nextDepositTier(store.deposit);
    return {
      deposit: store.deposit,
      nextTier,
      gapToNext: nextTier - store.deposit,
      // 预览后续三档（500 档递增）
      tiers: [0, 1, 2].map((i) => {
        const tier = nextTier + i * 50000;
        return { tier, gap: tier - store.deposit };
      }),
    };
  }

  /** 押金详情：余额 + 流水（缴纳/扣除/退还全量，时间倒序）。 */
  async depositDetail(staffId: string, page?: string, pageSize?: string) {
    const store = await this.myStore(staffId);
    const records = await this.inventory.depositTransactions(store.id, page, pageSize);
    const nextTier = nextDepositTier(store.deposit);
    return {
      staffId,
      storeId: store.id,
      deposit: store.deposit,
      nextTier,
      gapToNext: nextTier - store.deposit,
      total: records.total,
      page: records.page,
      pageSize: records.pageSize,
      txns: records.items.map((t) => ({
        id: t.id,
        type: t.type,
        amount: t.amount,
        payOrderNo: t.payOrderNo,
        remark: t.remark,
        createdAt: t.createdAt,
      })),
    };
  }

  /** 发起押金缴纳（微信支付；复用 payments JSAPI 通道，ND 业务标记）。 */
  async initiateDepositPay(staffId: string, targetTier?: number) {
    const store = await this.myStore(staffId);
    const staff = await this.db.staff.findUniqueOrThrow({
      where: { id: staffId },
      select: { openid: true },
    });
    // 押金走履约端 openid？楼长在履约端操作——支付拉起在履约端小程序，
    // openid 必须是履约端签发的 openid。Staff.openid 即履约端绑定 openid。
    if (!staff.openid)
      throw new BadRequestException('当前账号未绑定微信，无法发起支付');
    // payer openid 属履约端 AppID（楼长在履约端小程序支付）——预下单 appid
    // 必须同源：组织登记了履约端 AppID 用之，否则 env 兜底（上线配置项：
    // 商户号须绑定履约端 AppID，否则微信报 appid/openid 不匹配）
    const payerAppId = await this.deliveryAppId(store.campusId);
    return this.orders.initiateDepositPay(
      store.id,
      store.campusId,
      staff.openid,
      payerAppId,
      targetTier,
    );
  }

  /** 履约端 AppID：组织行 deliveryWxAppId 优先，env WX_APPID_DELIVERY 兜底。 */
  private async deliveryAppId(campusId: string): Promise<string | undefined> {
    const organizationId = await campusOrganizationId(this.db, campusId);
    if (organizationId) {
      const org = await this.db.organization.findUnique({
        where: { id: organizationId },
        select: { deliveryWxAppId: true },
      });
      if (org?.deliveryWxAppId) return org.deliveryWxAppId;
    }
    if (organizationId && organizationId !== 'org-a') return undefined;
    return process.env.WX_APPID_DELIVERY?.trim() || undefined;
  }

  /** 押金支付结果查询兜底（回调故障时主动查微信单）。 */
  async depositPayStatus(staffId: string, outTradeNo?: string) {
    const store = await this.myStore(staffId);
    return this.orders.depositPayStatus(store.id, store.campusId, outTradeNo);
  }

  /* ==================== 备货 ==================== */

  /**
   * 商品池：本校区夜主档（Product.nightCatalog，on-sale）+ 本店楼栋行
   * （当前库存/上架状态）。楼栋行未配置的显示为「未配置」。
   */
  async stockPool(staffId: string) {
    return this.inventory.stockPool(staffId);
  }

  /**
   * 免费备货申请：按历史货值及在途、冻结占用校验押金额度，只创建备货单
   * 并预占额度。校区审核预留共享仓库存，整单出库后由楼长确认实收，
   * 实收才增加楼长库存；少收差异转报损，审核通过后释放对应额度。
   */
  async createStockOrder(staffId: string, dto: NightStockOrderDto) {
    return this.inventory.createStockOrder(staffId, dto);
  }

  /** 备货记录列表。 */
  async stockOrders(staffId: string) {
    const store = await this.inventory.myStore(staffId);
    return this.inventory.stockOrders(store.id, staffId);
  }
  async stockOrdersPage(staffId: string, status?: string, page?: string, pageSize?: string) {
    const store = await this.inventory.myStore(staffId);
    return this.inventory.stockOrdersPage(store.id, staffId, status, page, pageSize);
  }

  /* ==================== 营业管理 ==================== */

  openStore(staffId: string) { return this.changeStoreStatus(staffId, 'open'); }
  pauseStore(staffId: string) { return this.changeStoreStatus(staffId, 'pause'); }
  resumeStore(staffId: string) { return this.changeStoreStatus(staffId, 'resume'); }
  closeStore(staffId: string) { return this.changeStoreStatus(staffId, 'close'); }

  /** 与后台停业、解绑、库存和下单共用店锁，不能用锁外旧快照覆盖新的经营限制。 */
  private async changeStoreStatus(staffId: string, action: 'open' | 'pause' | 'resume' | 'close') {
    const initial = await this.myStore(staffId);
    return this.db.$transaction(async tx => {
      const store = await this.inventory.lockStore(tx, initial.id, staffId);
      const staff = await tx.staff.findUnique({ where: { id: staffId }, select: { role: true, campusId: true } });
      if (!staff || !['building-manager', 'intern-building-manager'].includes(staff.role) || staff.campusId !== store.campusId) throw new NotFoundException('经营资格已变化，请刷新');
      if (store.status === 'suspended') throw new BadRequestException('店铺已被平台停业，请联系运营');
      if (action === 'pause' && store.status !== 'open') throw new BadRequestException('当前不是营业中状态');
      if (action === 'resume' && store.status !== 'paused') throw new BadRequestException('当前不是暂停状态');
      if (action === 'close' && store.status === 'closed') return { id: store.id, status: 'closed' };
      if (action === 'open' || action === 'resume') {
        const campus = await tx.campus.findUniqueOrThrow({ where: { id: store.campusId } });
        this.orders.assertNightWindow(campus);
      }
      if (action === 'open') {
        if (store.deposit <= 0) throw new BadRequestException('请先缴纳经营押金（首次 500 元）');
        const count = await tx.nightProduct.count({ where: { storeId: store.id, onShelf: true, saleAllowed: true, stock: { gt: 0 }, catalogProduct: { status: 'on-sale' } } });
        if (!count) throw new BadRequestException('暂无可售商品，请先备货并上架');
      }
      const status = action === 'close' ? 'closed' : action === 'pause' ? 'paused' : 'open';
      await tx.nightStore.update({ where: { id: store.id }, data: { status, ...(action === 'open' ? { openedAt: new Date() } : {}), ...(action === 'close' ? { closedAt: new Date() } : {}) } });
      await tx.auditLog.create({ data: { campusId: store.campusId, operator: staffId, action: `night.store.${action}`, entityType: 'nightStore', entityId: store.id, before: { status: store.status }, after: { status } } });
      return { id: store.id, status };
    }, { timeout: 20000 });
  }

  /** 工作台：场次/营业态/押金/待接单/今日销售额/库存货值/佣金汇总。 */
  async dashboard(staffId: string) {
    const store = await this.myStore(staffId);
    const reporting = new NightReportingService(this.db);
    const [pendingOrders, sales, quota, commissionAgg, monthly] = await Promise.all([
      this.db.nightOrder.count({ where: { storeId: store.id, managerStaffId: staffId, status: 'pending-accept', OR: [{ afterSaleStatus: null }, { afterSaleStatus: { not: 'refund-processing' } }] } }),
      reporting.sales(store.id, store.campus),
      this.inventory.summary(store.id),
      this.db.nightCommissionTxn.groupBy({ by: ['type', 'status'], where: { managerStaffId: staffId }, _sum: { amount: true } }),
      reporting.income(staffId, store.campus),
    ]);
    const commission = { estimated: 0, pending: 0, settled: 0 };
    const deliveryFee = { estimated: 0, pending: 0, settled: 0 };
    for (const row of commissionAgg) {
      const bucket = row.type === 'commission' ? commission : deliveryFee;
      if (row.status === 'estimated') bucket.estimated += row._sum.amount ?? 0;
      if (row.status === 'pending') bucket.pending += row._sum.amount ?? 0;
      if (row.status === 'settled') bucket.settled += row._sum.amount ?? 0;
    }
    const c = store.campus;
    return {
      store: {
        id: store.id,
        status: store.status,
        buildingName: store.building.name,
        commissionRate: store.commissionRate,
      },
      campus: {
        nightEnabled: c.nightEnabled,
        nightStartAt: c.nightStartAt,
        nightEndAt: c.nightEndAt,
      },
      inWindow: inNightWindow(c.nightStartAt, c.nightEndAt),
      gapToNextTier: nextDepositTier(store.deposit) - store.deposit,
      pendingOrders,
      ...sales,
      todayIncome: monthly.days.filter(d => d.day === sales.businessDate).reduce((sum, d) => sum + d.commission + d.deliveryFee, 0),
      monthIncome: monthly.summary.commission.pending + monthly.summary.commission.settled + monthly.summary.deliveryFee.pending + monthly.summary.deliveryFee.settled,
      ...quota,
      // 楼长侧透明化（V1.5 修订项 2）：佣金/配送费两列分账
      commission,
      deliveryFee,
    };
  }

  /* ==================== 商品 ==================== */

  /** 本店商品列表（含库存/上下架/停售状态）。 */
  async myProducts(staffId: string) {
    return this.inventory.products(staffId);
  }

  /**
   * 上下架切换（楼长选择）：恢复上架实时校验——主档在售 + 后台未停售
   * （PRD B19：楼长不能绕过后台停售）；下架不影响库存与既有订单。
   */
  async toggleShelf(staffId: string, nightProductId: string, onShelf: boolean) {
    const store = await this.myStore(staffId);
    const product = await this.db.nightProduct.findFirst({
      where: { id: nightProductId, storeId: store.id },
      include: { catalogProduct: { select: { status: true, name: true } } },
    });
    if (!product) throw new NotFoundException('商品不存在');
    if (onShelf) {
      if (!product.saleAllowed)
        throw new BadRequestException('商品已被后台停售，暂不能上架');
      if (product.stock <= 0)
        throw new BadRequestException('暂无库存，请先进货');
      if (product.catalogProduct.status !== 'on-sale')
        throw new BadRequestException(
          `${product.catalogProduct.name}已被后台停售，暂不能上架`,
        );
    }
    await this.db.nightProduct.update({
      where: { id: product.id },
      data: { onShelf },
    });
    return { id: product.id, onShelf };
  }

  /* ==================== 订单 ==================== */

  /** 本店订单列表（按状态筛选）。 */
  async storeOrders(staffId: string, status?: string) {
    return (await this.storeOrdersPage(staffId, status, '1', '100')).items;
  }

  async storeOrdersPage(
    staffId: string,
    status?: string,
    page?: string,
    pageSize?: string,
  ) {
    const store = await this.myStore(staffId);
    const paging = parsePagination(page, pageSize);
    const where: Prisma.NightOrderWhereInput = {
      storeId: store.id,
      managerStaffId: staffId,
      ...(status && status !== 'all'
        ? status === 'todo'
          ? { status: { in: ['pending-accept', 'delivering'] } }
          : { status }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.db.nightOrder.findMany({
        where,
        include: { refund: true, store: { include: { building: { select: { name: true } } } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (paging.page - 1) * paging.pageSize,
        take: paging.pageSize,
      }),
      this.db.nightOrder.count({ where }),
    ]);
    return {
      items: rows.map((o) => this.orders.orderView(o)),
      total,
      ...paging,
    };
  }

  /** 接单（校验本人店铺；pending-accept → delivering）。 */
  async accept(staffId: string, orderId: string) {
    const store = await this.myStore(staffId);
    return this.orders.acceptOrder(staffId, store.id, orderId);
  }

  /** 送达（delivering → delivered）。 */
  async deliver(staffId: string, orderId: string, proof: NightDeliverDto) {
    const store = await this.myStore(staffId);
    return this.orders.deliverOrder(staffId, store.id, orderId, proof);
  }

  /** 本店订单详情（楼长视角：含地址联系方式，仅本店单）。 */
  async storeOrderDetail(staffId: string, orderId: string) {
    const store = await this.myStore(staffId);
    const order = await this.db.nightOrder.findFirst({
      where: { id: orderId, storeId: store.id, managerStaffId: staffId },
      include: { refund: true, store: { include: { building: { select: { name: true } } } } },
    });
    if (!order) throw new NotFoundException('订单不存在');
    return this.orders.orderView(order);
  }

  /* ==================== 收入 ==================== */

  /** 收入页：佣金流水（商品佣金/配送费两列）+ 期间汇总。 */
  async income(staffId: string, filters: { month?: string; status?: string; page?: string; pageSize?: string } = {}) {
    const store = await this.myStore(staffId);
    return { ...await new NightReportingService(this.db).income(staffId, store.campus, filters), deposit: store.deposit };
  }

  /** 佣金单条试算（楼长查看某单应得 = 商品佣金 + 配送费，V1.5 L14）。 */
  async orderEarning(staffId: string, orderId: string) {
    const store = await this.myStore(staffId);
    const order = await this.db.nightOrder.findFirst({
      where: { id: orderId, storeId: store.id, managerStaffId: staffId },
      include: { refund: true },
    });
    if (!order) throw new NotFoundException('订单不存在');
    const refund = order.refund?.status === 'succeeded' ? order.refund : null;
    const base = order.productAmount - order.couponDiscount - (refund?.productAmount ?? 0);
    const rows = await this.db.nightCommissionTxn.groupBy({ by: ['type'], where: { orderId, managerStaffId: staffId }, _sum: { amount: true } });
    const commission = rows.find(r => r.type === 'commission')?._sum.amount ?? 0;
    const deliveryFee = rows.find(r => r.type === 'deliveryFee')?._sum.amount ?? 0;
    return {
      orderNo: order.orderNo,
      productAmount: order.productAmount,
      couponDiscount: order.couponDiscount,
      // 透明化（V1.5 B22）：券优惠进入佣金基数，必须可见
      commissionBase: base,
      commissionRate: order.commissionRate,
      commission,
      deliveryFee,
      total: commission + deliveryFee,
    };
  }
}

function sumBy(
  rows: Array<{ type: string; status: string; amount: number }>,
  type: string,
  status: string,
): number {
  return rows
    .filter((r) => r.type === type && r.status === status)
    .reduce((s, r) => s + r.amount, 0);
}
