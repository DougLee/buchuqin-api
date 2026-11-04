import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { campusOrganizationId } from '../common/organization';
import { NightOrderService } from './night-order.service';
import { commissionOf, inNightWindow, nextDepositTier } from './night.helpers';
import { NightStockOrderDto } from './night.dto';

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
  ) {}

  /** 本人夜宵店（未绑定=404；解绑/换人后旧 token 立即失效口径）。 */
  private async myStore(staffId: string) {
    const store = await this.db.nightStore.findFirst({
      where: { managerStaffId: staffId },
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
  async depositDetail(staffId: string) {
    const store = await this.myStore(staffId);
    const txns = await this.db.nightDepositTxn.findMany({
      where: { storeId: store.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const nextTier = nextDepositTier(store.deposit);
    return {
      deposit: store.deposit,
      nextTier,
      gapToNext: nextTier - store.deposit,
      txns: txns.map((t) => ({
        id: t.id,
        type: t.type,
        amount: t.amount,
        payOrderNo: t.payOrderNo,
        remark: t.remark,
        createdAt: t.createdAt.toISOString(),
      })),
    };
  }

  /** 发起押金缴纳（微信支付；复用 payments JSAPI 通道，ND 业务标记）。 */
  async initiateDepositPay(staffId: string) {
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
    const store = await this.myStore(staffId);
    const [catalog, mine] = await Promise.all([
      this.db.product.findMany({
        where: {
          campusId: store.campusId,
          nightCatalog: true,
          status: 'on-sale',
        },
        select: {
          id: true,
          name: true,
          image: true,
          price: true,
          status: true,
        },
        orderBy: { updatedAt: 'desc' },
      }),
      this.db.nightProduct.findMany({ where: { storeId: store.id } }),
    ]);
    const mineMap = new Map(mine.map((m) => [m.catalogProductId, m]));
    return catalog.map((c) => {
      const row = mineMap.get(c.id);
      return {
        catalogProductId: c.id,
        name: c.name,
        image: c.image,
        price: c.price, // 夜宵统一售价（主档）
        status: c.status,
        attached: Boolean(row),
        nightProductId: row?.id ?? null,
        stock: row?.stock ?? 0,
        onShelf: row?.onShelf ?? false,
        saleAllowed: row?.saleAllowed ?? true,
        stockValue: (row?.stock ?? 0) * c.price,
      };
    });
  }

  /**
   * 备货下单（免费；押金额度校验）：事务内校验
   * Σ(现有库存 + 本次数量) × 夜宵售价 ≤ 押金余额，通过则
   * NightStockOrder 落单 + NightProduct.stock 原子增加 + NightStockTxn(stockIn)。
   * 超额 400 提示押金差额。线下取货（平台铺货交接），无支付环节。
   */
  async createStockOrder(staffId: string, dto: NightStockOrderDto) {
    const store = await this.myStore(staffId);
    // 同商品多行合并数量
    const merged = new Map<string, number>();
    for (const item of dto.items)
      merged.set(
        item.catalogProductId,
        (merged.get(item.catalogProductId) ?? 0) + item.quantity,
      );
    const result = await this.db.$transaction(async (tx) => {
      const fresh = await tx.nightStore.findUnique({ where: { id: store.id } });
      if (!fresh) throw new NotFoundException('夜宵店不存在');
      const rows = await tx.nightProduct.findMany({
        where: {
          storeId: store.id,
          catalogProductId: { in: [...merged.keys()] },
        },
        include: {
          catalogProduct: {
            select: { id: true, name: true, price: true, status: true },
          },
        },
      });
      if (rows.length !== merged.size)
        throw new BadRequestException(
          '存在未配置商品，请联系后台先给本店配置商品',
        );
      // 押金额度校验（现有库存×售价 + 本次×售价 ≤ 押金）
      let currentValue = 0;
      let orderValue = 0;
      for (const row of rows) {
        const qty = merged.get(row.catalogProductId)!;
        if (row.catalogProduct.status !== 'on-sale')
          throw new BadRequestException(
            `${row.catalogProduct.name}夜主档已停售`,
          );
        if (qty <= 0) throw new BadRequestException('备货数量不合法');
        currentValue += row.stock * row.catalogProduct.price;
        orderValue += qty * row.catalogProduct.price;
      }
      const gap = currentValue + orderValue - fresh.deposit;
      if (gap > 0)
        throw new BadRequestException(
          `押金额度不足：库存货值 + 本次备货货值超出押金 ${(gap / 100).toFixed(2)} 元，请先补缴押金（500 元档递增）`,
        );
      const items = rows.map((row) => ({
        nightProductId: row.id,
        catalogProductId: row.catalogProductId,
        name: row.catalogProduct.name,
        price: row.catalogProduct.price,
        quantity: merged.get(row.catalogProductId)!,
      }));
      const totalValue = items.reduce((s, i) => s + i.price * i.quantity, 0);
      const stockOrder = await tx.nightStockOrder.create({
        data: {
          storeId: store.id,
          managerStaffId: staffId,
          items: json(items),
          totalValue,
        },
      });
      // 库存入账（一步制）：NightProduct.stock 增加 + stockIn 流水
      for (const item of items) {
        const updated = await tx.nightProduct.update({
          where: { id: item.nightProductId },
          data: { stock: { increment: item.quantity } },
        });
        await tx.nightStockTxn.create({
          data: {
            storeId: store.id,
            nightProductId: item.nightProductId,
            type: 'stockIn',
            delta: item.quantity,
            afterStock: updated.stock,
            refType: 'night-stock-order',
            refId: stockOrder.id,
            operatorId: staffId,
            remark: '备货入库（押金额度校验通过）',
          },
        });
      }
      return { stockOrder, totalValue };
    });
    return {
      id: result.stockOrder.id,
      totalValue: result.totalValue,
      createdAt: result.stockOrder.createdAt.toISOString(),
    };
  }

  /** 备货记录列表。 */
  async stockOrders(staffId: string) {
    const store = await this.myStore(staffId);
    const rows = await this.db.nightStockOrder.findMany({
      where: { storeId: store.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((r) => ({
      id: r.id,
      items: r.items,
      totalValue: r.totalValue,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /* ==================== 营业管理 ==================== */

  /**
   * 开店（V1.5 修订项 1 互斥）：校区白天已闭店 + 夜宵窗口内 + 押金>0 +
   * 有上架可售商品。不满足返回具体原因（T71）。全店售罄后仍可保持营业
   * （PRD「今夜已售罄」是展示态，不强制打烊）。
   */
  async openStore(staffId: string) {
    const store = await this.myStore(staffId);
    if (store.status === 'suspended')
      throw new BadRequestException('店铺已被平台停业，请联系运营');
    // 互斥校验（V1.5 T71）：校区白天未闭店 / 未到夜宵窗口 → 具体原因拒绝
    this.orders.assertNightWindow(store.campus);
    if (store.deposit <= 0)
      throw new BadRequestException('请先缴纳经营押金（首次 500 元）');
    const sellable = await this.db.nightProduct.count({
      where: {
        storeId: store.id,
        onShelf: true,
        saleAllowed: true,
        stock: { gt: 0 },
        catalogProduct: { status: 'on-sale' },
      },
    });
    if (sellable === 0)
      throw new BadRequestException('暂无可售商品，请先备货并上架');
    await this.db.nightStore.update({
      where: { id: store.id },
      data: { status: 'open', openedAt: new Date() },
    });
    return { id: store.id, status: 'open' };
  }

  /** 暂停营业（本场次内可恢复；已付订单继续履约）。 */
  async pauseStore(staffId: string) {
    const store = await this.myStore(staffId);
    if (store.status !== 'open')
      throw new BadRequestException('当前不是营业中状态');
    await this.db.nightStore.update({
      where: { id: store.id },
      data: { status: 'paused' },
    });
    return { id: store.id, status: 'paused' };
  }

  /** 恢复营业（重验场次窗口与校区闭店互斥）。 */
  async resumeStore(staffId: string) {
    const store = await this.myStore(staffId);
    if (store.status !== 'paused')
      throw new BadRequestException('当前不是暂停状态');
    this.orders.assertNightWindow(store.campus);
    await this.db.nightStore.update({
      where: { id: store.id },
      data: { status: 'open' },
    });
    return { id: store.id, status: 'open' };
  }

  /** 打烊（停止新单；已支付订单继续履约，库存跨场留存）。 */
  async closeStore(staffId: string) {
    const store = await this.myStore(staffId);
    if (store.status === 'suspended')
      throw new BadRequestException('店铺已被平台停业');
    if (store.status === 'closed') return { id: store.id, status: 'closed' };
    await this.db.nightStore.update({
      where: { id: store.id },
      data: { status: 'closed', closedAt: new Date() },
    });
    return { id: store.id, status: 'closed' };
  }

  /** 工作台：场次/营业态/押金/待接单/今日销售额/库存货值/佣金汇总。 */
  async dashboard(staffId: string) {
    const store = await this.myStore(staffId);
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
    }).format(new Date());
    const [pendingOrders, todayAgg, products, commissionAgg] =
      await Promise.all([
        this.db.nightOrder.count({
          where: { storeId: store.id, status: 'pending-accept' },
        }),
        this.db.nightOrder.aggregate({
          where: {
            storeId: store.id,
            businessDate: today,
            status: { notIn: ['cancelled', 'pending-payment', 'exception'] },
          },
          _count: true,
          _sum: { payableAmount: true },
        }),
        this.db.nightProduct.findMany({
          where: { storeId: store.id },
          include: { catalogProduct: { select: { price: true } } },
        }),
        this.db.nightCommissionTxn.groupBy({
          by: ['type', 'status'],
          where: { managerStaffId: staffId },
          _sum: { amount: true },
        }),
      ]);
    const stockValue = products.reduce(
      (s, p) => s + p.stock * p.catalogProduct.price,
      0,
    );
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
      deposit: store.deposit,
      gapToNextTier: nextDepositTier(store.deposit) - store.deposit,
      pendingOrders,
      todayOrders: todayAgg._count,
      todaySales: todayAgg._sum.payableAmount ?? 0,
      stockValue,
      // 楼长侧透明化（V1.5 修订项 2）：佣金/配送费两列分账
      commission,
      deliveryFee,
    };
  }

  /* ==================== 商品 ==================== */

  /** 本店商品列表（含库存/上下架/停售状态）。 */
  async myProducts(staffId: string) {
    const store = await this.myStore(staffId);
    const rows = await this.db.nightProduct.findMany({
      where: { storeId: store.id },
      include: {
        catalogProduct: {
          select: {
            id: true,
            name: true,
            image: true,
            price: true,
            status: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      catalogProductId: r.catalogProductId,
      name: r.catalogProduct.name,
      image: r.catalogProduct.image,
      price: r.catalogProduct.price,
      catalogStatus: r.catalogProduct.status,
      stock: r.stock,
      onShelf: r.onShelf,
      saleAllowed: r.saleAllowed,
      purchasable:
        r.onShelf &&
        r.saleAllowed &&
        r.stock > 0 &&
        r.catalogProduct.status === 'on-sale',
    }));
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
    const store = await this.myStore(staffId);
    const rows = await this.db.nightOrder.findMany({
      where: {
        storeId: store.id,
        ...(status && status !== 'all'
          ? status === 'todo'
            ? { status: { in: ['pending-accept', 'delivering'] } }
            : { status }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((o) => this.orders.orderView(o));
  }

  /** 接单（校验本人店铺；pending-accept → delivering）。 */
  async accept(staffId: string, orderId: string) {
    const store = await this.myStore(staffId);
    return this.orders.acceptOrder(staffId, store.id, orderId);
  }

  /** 送达（delivering → delivered）。 */
  async deliver(staffId: string, orderId: string) {
    const store = await this.myStore(staffId);
    return this.orders.deliverOrder(staffId, store.id, orderId);
  }

  /** 本店订单详情（楼长视角：含地址联系方式，仅本店单）。 */
  async storeOrderDetail(staffId: string, orderId: string) {
    const store = await this.myStore(staffId);
    const order = await this.db.nightOrder.findFirst({
      where: { id: orderId, storeId: store.id },
    });
    if (!order) throw new NotFoundException('订单不存在');
    return this.orders.orderView(order);
  }

  /* ==================== 收入 ==================== */

  /** 收入页：佣金流水（商品佣金/配送费两列）+ 期间汇总。 */
  async income(staffId: string) {
    const store = await this.myStore(staffId);
    const rows = await this.db.nightCommissionTxn.findMany({
      where: { managerStaffId: staffId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const orderIds = [...new Set(rows.map((r) => r.orderId))];
    const orderNos = new Map(
      (
        await this.db.nightOrder.findMany({
          where: { id: { in: orderIds } },
          select: { id: true, orderNo: true },
        })
      ).map((o) => [o.id, o.orderNo]),
    );
    return {
      summary: {
        commission: {
          estimated: sumBy(rows, 'commission', 'estimated'),
          pending: sumBy(rows, 'commission', 'pending'),
          settled: sumBy(rows, 'commission', 'settled'),
        },
        deliveryFee: {
          estimated: sumBy(rows, 'deliveryFee', 'estimated'),
          pending: sumBy(rows, 'deliveryFee', 'pending'),
          settled: sumBy(rows, 'deliveryFee', 'settled'),
        },
      },
      deposit: store.deposit,
      items: rows.map((r) => ({
        id: r.id,
        orderNo: orderNos.get(r.orderId) ?? '',
        type: r.type,
        base: r.base,
        rate: r.rate,
        amount: r.amount,
        status: r.status,
        settleBatch: r.settleBatch,
        remark: r.remark,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }

  /** 佣金单条试算（楼长查看某单应得 = 商品佣金 + 配送费，V1.5 L14）。 */
  async orderEarning(staffId: string, orderId: string) {
    const store = await this.myStore(staffId);
    const order = await this.db.nightOrder.findFirst({
      where: { id: orderId, storeId: store.id },
    });
    if (!order) throw new NotFoundException('订单不存在');
    const base = order.productAmount - order.couponDiscount;
    return {
      orderNo: order.orderNo,
      productAmount: order.productAmount,
      couponDiscount: order.couponDiscount,
      // 透明化（V1.5 B22）：券优惠进入佣金基数，必须可见
      commissionBase: base,
      commissionRate: order.commissionRate,
      commission: commissionOf(base, order.commissionRate),
      deliveryFee: order.deliveryFee,
      total: commissionOf(base, order.commissionRate) + order.deliveryFee,
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
