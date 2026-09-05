import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  PrinterService,
  ReceiptOrderContext,
} from '../printer/printer.service';
import {
  buildOrderTimeline,
  DELIVERING_STATUSES,
  markTimelineStep,
  statusPhase,
} from '../common/order-state';

/** @deprecated Seed/test compatibility only; production services use Prisma. */
import {
  CreateAddressDto,
  CreateAfterSalesDto,
  CreateOrderDto,
  UpdateAddressDto,
  UpdateCartDto,
} from './dto';

/* ---------- 抽奖大转盘（IKD6FA/FB/FC） ---------- */

/** 8 奖位单项（LotteryWheel.prizes JSON 数组元素）。 */
export interface WheelPrize {
  /** coupon=平台券（自动入账）；partner=异业券（弹图文）；none=谢谢参与。 */
  type: 'coupon' | 'partner' | 'none';
  /** 转盘扇区主文案（如「5元券」「谢谢参与」）。 */
  label: string;
  /** type=coupon：Coupon.id，抽中自动入账；发完/过期自动降级谢谢参与。 */
  couponId?: string;
  /** type=partner：图文配置（图片必填，可带商家二维码供长按识别）。 */
  bizTitle?: string;
  bizImage?: string;
  bizNote?: string;
  /** 权重正整数（0=该位永不命中），不必凑 100。 */
  weight: number;
}

const WHEEL_SLOTS = 8;
/** 北京时间自然日（IKD6FB）：每日限抽的唯一键口径。 */
const beijingDate = (now = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(now);

function parsePrizes(raw: string): WheelPrize[] {
  try {
    const xs = JSON.parse(raw) as WheelPrize[];
    return Array.isArray(xs) ? xs : [];
  } catch {
    return [];
  }
}

export interface ProductSnapshot {
  id: string;
  name: string;
  subtitle: string;
  price: number;
  originalPrice: number;
  image: string;
  stock: number;
  sales: number;
  tag: string;
  weight: number;
  categoryId: string;
}
export interface OrderLine {
  product: ProductSnapshot;
  quantity: number;
}
export interface TimelineStep {
  key: string;
  title: string;
  description: string;
  time?: string;
  done: boolean;
}
const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const number = (value: Prisma.Decimal | number) => Number(value);
/** 金额展示：分 → 元字符串（仅错误文案/通知文本用，接口一律返回分）。 */
const yuan = (cents: number) => (cents / 100).toFixed(2);

@Injectable()
export class BusinessService {
  /** IKA0BI：赠券额度/模板异常只记日志，不阻断支付主流程 */
  private static readonly logger = new Logger(BusinessService.name);
  constructor(
    private readonly db: PrismaService,
    // 渠道推送（IK8W5M）：可选注入——测试直接 new BusinessService(db) 时不传，跳过推送。
    @Optional() private readonly push?: NotificationsService,
    // 小票打印（IKBT6N）：可选注入——出库自动出票，未注入/未配置时静默跳过。
    @Optional() private readonly printer?: PrinterService,
  ) {}
  /** 金额单位:分（IK8W5K）。IK9SO6：生效值存 Campus 表（后台可配置），
   *  以下常量仅在 Campus 行缺失/字段为空时的兜底默认。 */
  static readonly DELIVERY_THRESHOLD_CENTS = 1000;
  static readonly DELIVERY_FEE_CENTS = {
    instant: 400,
    scheduled: 200,
  } as const;
  /**
   * 限时特价解析（ADR-0006）：窗口内 active 活动按 productId 取生效促销。
   * 同商品多活动兜底取 endsAt 最近者（确定性，清仓优先）；建/改时的重叠
   * 拒绝在 admin 侧把关。读时判窗，无 cron 回落。
   */
  private async promotionMap(productIds: string[], now = new Date()) {
    if (!productIds.length) return new Map<string, any>();
    const rows = await this.db.promotion.findMany({
      where: {
        productId: { in: productIds },
        status: 'active',
        startsAt: { lte: now },
        endsAt: { gt: now },
      },
      orderBy: [{ endsAt: 'asc' }, { createdAt: 'asc' }],
    });
    const map = new Map<string, any>();
    for (const r of rows) if (!map.has(r.productId)) map.set(r.productId, r);
    return map;
  }
  /**
   * 商品视图（ADR-0006）：活动期 price=促销价（生效价单一事实，所有金额出口
   * 读 .price 即正确），划线位 originalPrice 让给 product.price；promotion 块
   * 供 C 端角标/倒计时与订单快照审计（含 promotionId，下单锁价）。
   */
  private productView(product: any, withDescription = false, promotion?: any) {
    // IKC1AC：进货价/批发价是内部价格，绝不进 C 端响应
    const { description, costPrice, wholesalePrice, ...rest } = product;
    return {
      ...rest,
      // 列表不回介绍（IKAHAU）：≤2000 字 × 全量商品会把首页/列表 payload 撑爆；
      // 详情页 withDescription 才带。
      ...(withDescription ? { description: description ?? '' } : {}),
      price: number(promotion ? promotion.price : product.price),
      originalPrice: number(promotion ? product.price : product.originalPrice),
      ...(promotion
        ? {
            promotion: {
              id: promotion.id,
              type: promotion.type,
              price: number(promotion.price),
              endsAt: promotion.endsAt.toISOString(),
            },
          }
        : {}),
      weight: number(product.weight),
    };
  }
  private orderView(order: any) {
    return {
      ...order,
      // 用户端异常单统一话术（履约侧细分原因由后台/履约端展示）。
      statusText:
        order.status === 'exception'
          ? '履约异常，客服处理中'
          : order.statusText,
      statusPhase: statusPhase(order.status),
      productAmount: number(order.productAmount),
      deliveryThreshold: number(order.deliveryThreshold),
      deliveryFee: number(order.deliveryFee),
      discount: number(order.discount),
      payableAmount: number(order.payableAmount),
      createdAt: order.createdAt.toISOString(),
      paidAt: order.paidAt?.toISOString(),
      items: order.items as OrderLine[],
      timeline: order.timeline as TimelineStep[],
    };
  }
  private async notify(
    userId: string,
    type: string,
    title: string,
    content: string,
  ) {
    return this.db.notification.create({
      data: { userId, type, title, content },
    });
  }
  async campus(campusId: string) {
    const item = await this.db.campus.findFirst({ where: { id: campusId } });
    if (!item) throw new NotFoundException('校园不存在');
    return item;
  }
  async categories() {
    // 分类为全局字典（无 campusId 维度），商品侧按校园过滤。
    // IKC9M4：hidden 分类不下发 C 端（后台类目开关，类目审核场景）。
    return this.db.category.findMany({
      where: { hidden: false },
      orderBy: { sort: 'asc' },
    });
  }
  private couponView(coupon: {
    id: string;
    name: string;
    // IKDCVO：kind/trigger/remark 见 schema 注释；expiresAt 可空=长期有效。
    kind: string;
    trigger: string;
    remark: string;
    amount: number;
    threshold: number;
    /** IKDEN2：null = 不限量 */
    total: number | null;
    claimed: number;
    status: string;
    expiresAt: Date | null;
  }) {
    return {
      id: coupon.id,
      name: coupon.name,
      kind: coupon.kind,
      trigger: coupon.trigger,
      remark: coupon.remark,
      amount: coupon.amount,
      threshold: coupon.threshold,
      total: coupon.total,
      // IKDEN2：不限量券 remain=null（C 端/后台据此显示「不限量/充足」）
      remain: coupon.total === null ? null : Math.max(0, coupon.total - coupon.claimed),
      status: coupon.status,
      expiresAt: coupon.expiresAt ? coupon.expiresAt.toISOString() : null,
    };
  }
  async coupons(userId: string, campusId: string) {
    const [items, mine] = await Promise.all([
      this.db.coupon.findMany({
        where: { campusId },
        orderBy: { expiresAt: 'asc' },
      }),
      this.db.userCoupon.findMany({
        where: { userId },
        include: { coupon: true },
        orderBy: { claimedAt: 'desc' },
      }),
    ]);
    const now = new Date();
    const holding = new Set(
      mine.filter((x) => x.status !== 'used').map((x) => x.couponId),
    );
    return {
      // IKDCVO：公开可领列表只出 manual 券（lottery/signup 券靠发放入账）。
      claimable: items
        .filter(
          (c) =>
            c.trigger === 'manual' &&
            c.status === 'active' &&
            (!c.expiresAt || c.expiresAt > now) &&
            // IKDEN2：不限量券恒可领
            (c.total === null || c.claimed < c.total) &&
            !holding.has(c.id),
        )
        .map((c) => this.couponView(c)),
      mine: mine.map((x) => ({
        id: x.id,
        couponId: x.couponId,
        status: x.status,
        claimedAt: x.claimedAt.toISOString(),
        coupon: this.couponView(x.coupon),
      })),
    };
  }
  async claimCoupon(userId: string, couponId: string, campusId: string) {
    return this.db.$transaction(async (tx) => {
      const existing = await tx.userCoupon.findFirst({
        where: { userId, couponId },
      });
      if (existing) {
        // 幂等：重复领取直接返回已有记录。
        if (existing.status === 'used')
          throw new BadRequestException('该优惠券已使用');
        return existing;
      }
      const coupon = await tx.coupon.findUnique({ where: { id: couponId } });
      if (!coupon) throw new NotFoundException('优惠券不存在');
      // 券跨校园隔离：只能领取本校发放的券。
      if (coupon.campusId !== campusId)
        throw new BadRequestException('该优惠券不属于当前校园');
      if (coupon.status !== 'active')
        throw new BadRequestException('优惠券暂不可领取');
      // IKDCVO：lottery/signup 券只走发放通道，不开放手动领取。
      if (coupon.trigger !== 'manual')
        throw new BadRequestException('该优惠券不支持手动领取');
      if (coupon.expiresAt && coupon.expiresAt.getTime() <= Date.now())
        throw new BadRequestException('优惠券已过期');
      // 并发不超发：条件更新占用名额，抢不到名额即已领完。
      // IKDEN2：不限量券（total=null）不设 claimed 上限条件。
      const won = await tx.coupon.updateMany({
        where: {
          id: couponId,
          ...(coupon.total === null ? {} : { claimed: { lt: coupon.total } }),
        },
        data: { claimed: { increment: 1 }, issued: { increment: 1 } },
      });
      if (!won.count) throw new BadRequestException('优惠券已被领完');
      return tx.userCoupon.create({
        data: { userId, couponId, status: 'claimed' },
      });
    });
  }
  /** 校验用于下单的 UserCoupon（couponId 语义为 UserCoupon id）。 */
  private async validateUserCoupon(
    userId: string,
    userCouponId: string,
    campusId: string,
  ) {
    const record = await this.db.userCoupon.findUnique({
      where: { id: userCouponId },
      include: { coupon: true },
    });
    if (!record || record.userId !== userId)
      throw new BadRequestException('优惠券不存在或无权使用');
    // 券跨校园隔离：只能使用本校发放的券。
    if (record.coupon.campusId !== campusId)
      throw new BadRequestException('该优惠券不属于当前校园');
    if (!['claimed', 'released'].includes(record.status))
      throw new BadRequestException('优惠券当前状态不可使用');
    // IKA0BI：bonus 为 2 小时送达专属赠券模板状态——不进公开可领列表、
    // 领取接口拒收，但已发放到账的券正常可用（active=常规券）
    if (!['active', 'bonus'].includes(record.coupon.status))
      throw new BadRequestException('优惠券已下架');
    // IKDCVO：异业券只做到店展示，不参与下单抵扣。
    if (record.coupon.kind === 'partner')
      throw new BadRequestException('异业券请在到店时出示，不参与下单抵扣');
    if (
      record.coupon.expiresAt &&
      record.coupon.expiresAt.getTime() <= Date.now()
    )
      throw new BadRequestException('优惠券已过期');
    return record;
  }
  /** 校区选项（IKAJT2 选校区流程）：仅开放中校区，官方库伪校区天然排除。 */
  async campusOptions() {
    return this.db.campus.findMany({
      where: { status: 'active' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, shortName: true },
    });
  }
  /**
   * 切换用户校区（IKAJT2）：价格/库存/门槛按校区生效，切换即换数据口径——
   * 旧校区购物车跨校区不可结算（清掉）；旧校区地址保留但取消默认，
   * 切回原校区可重新设默认。幂等：切到当前校区直接返回。
   */
  async switchUserCampus(userId: string, campusId: string) {
    const campus = await this.db.campus.findFirst({
      where: { id: campusId, status: 'active' },
    });
    if (!campus) throw new BadRequestException('校区不存在或暂未开放');
    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('用户不存在');
    if (user.campusId === campusId) return user;
    const [updated] = await this.db.$transaction([
      this.db.user.update({ where: { id: userId }, data: { campusId } }),
      this.db.cartItem.deleteMany({
        where: { userId, product: { campusId: { not: campusId } } },
      }),
      this.db.address.updateMany({
        where: { userId, campusId: { not: campusId }, isDefault: true },
        data: { isDefault: false },
      }),
    ]);
    return updated;
  }
  async buildings(campusId: string) {
    const xs = await this.db.building.findMany({
      where: { campusId, status: 'active' },
      orderBy: { createdAt: 'asc' },
    });
    return xs.map((x) => ({
      id: x.id,
      name: x.name,
      minFloor: 1,
      maxFloor: x.floors,
      hasElevator: x.hasElevator,
      gender: x.gender,
      available: true,
    }));
  }
  /**
   * 楼栋寝室列表（IKD6FH 地址四级选择）：某楼全部/某层寝室。
   * 用户端选完楼栋+楼层后拉寝室号列表做 picker；楼栋须为本校区在营。
   */
  async buildingRooms(
    campusId: string,
    buildingId: string,
    floor?: number,
  ) {
    const building = await this.db.building.findFirst({
      where: { id: buildingId, campusId, status: 'active' },
    });
    if (!building) throw new NotFoundException('楼栋不存在');
    return this.db.room.findMany({
      where: { buildingId, ...(floor ? { floor } : {}) },
      select: { id: true, floor: true, roomNo: true },
      orderBy: [{ floor: 'asc' }, { roomNo: 'asc' }],
    });
  }
  async slots(campusId: string) {
    return this.db.deliverySlot.findMany({
      where: { campusId },
      orderBy: { label: 'asc' },
    });
  }
  async home(campusId: string) {
    const [campus, banners, categories, products] = await Promise.all([
      this.campus(campusId),
      this.db.banner.findMany({
        // IKA57F：placement 区分首页轮播 / 支付成功页广告位；
        // IKAJSL：campusId 空串 = 总部全校区投放，与本校区 Banner 一起命中
        where: {
          campusId: { in: [campusId, ''] },
          status: 'active',
          placement: 'home',
        },
        orderBy: { sort: 'asc' },
      }),
      this.categories(),
      this.db.product.findMany({
        where: { campusId, status: 'on-sale', category: { hidden: false } },
        orderBy: { sales: 'desc' },
        take: 18,
      }),
    ]);
    const now = new Date();
    const promoRows = await this.db.promotion.findMany({
      // 首页促销模块（ADR-0006）：进行中活动带商品视图，type 分组由前端渲染
      where: {
        status: 'active',
        startsAt: { lte: now },
        endsAt: { gt: now },
        product: { campusId, status: 'on-sale' },
      },
      orderBy: { endsAt: 'asc' },
      take: 20,
      include: { product: true },
    });
    const promoMap = await this.promotionMap(
      products.map((p) => p.id),
      now,
    );
    return {
      campus,
      banners,
      categories,
      hotProducts: products.map((p) =>
        this.productView(p, false, promoMap.get(p.id)),
      ),
      promotions: promoRows.map((x) => ({
        id: x.id,
        type: x.type,
        price: number(x.price),
        endsAt: x.endsAt.toISOString(),
        product: this.productView(x.product, false, x),
      })),
    };
  }
  /**
   * 按展示位取一条 Banner（IKA57F）：支付成功页广告位。取 sort 最小的一条，
   * 未配置返回 null（用户端该区域不渲染、不占位）。
   */
  async bannerByPlacement(campusId: string, placement: string) {
    return this.db.banner.findMany({
      // IKAJSL：campusId 空串 = 总部全校区投放
      where: { campusId: { in: [campusId, ''] }, status: 'active', placement },
      orderBy: [{ sort: 'asc' }, { id: 'asc' }],
      // IKB87P：支付成功页广告大卡最多 2 条（sort 升序取前 2）
      take: 2,
    });
  }
  async listProducts(campusId: string, categoryId?: string, keyword?: string) {
    const products = await this.db.product.findMany({
      where: {
        campusId,
        status: 'on-sale',
        // IKC9M4：hidden 分类的商品全链路不露出（全部/分类/搜索）
        category: { hidden: false },
        ...(categoryId && categoryId !== 'all' ? { categoryId } : {}),
        ...(keyword
          ? { name: { contains: keyword, mode: 'insensitive' } }
          : {}),
      },
      orderBy: { sales: 'desc' },
    });
    const promoMap = await this.promotionMap(products.map((p) => p.id));
    return products.map((p) => this.productView(p, false, promoMap.get(p.id)));
  }
  /**
   * 限时秒杀商品列表（IKBW0K）：进行中的 seckill 活动带促销价，供分类页
   * 「限时秒杀」特殊分类。结构同 listProducts（productView 出品，带 promotion
   * 块），不受 home 版块 take 20/混入临期 的限制。
   */
  async listSeckill(campusId: string) {
    const now = new Date();
    const rows = await this.db.promotion.findMany({
      where: {
        type: 'seckill',
        status: 'active',
        startsAt: { lte: now },
        endsAt: { gt: now },
        product: { campusId, status: 'on-sale', category: { hidden: false } },
      },
      orderBy: [{ endsAt: 'asc' }, { createdAt: 'asc' }],
      include: { product: true },
    });
    return rows.map((x) => this.productView(x.product, false, x));
  }
  async product(id: string, campusId: string) {
    const item = await this.db.product.findFirst({
      where: { id, campusId, status: 'on-sale' },
    });
    if (!item) throw new NotFoundException('商品不存在');
    const promo = (await this.promotionMap([item.id])).get(item.id);
    return this.productView(item, true, promo);
  }
  async cart(userId: string) {
    const [rows, user] = await Promise.all([
      this.db.cartItem.findMany({
        where: { userId, quantity: { gt: 0 } },
        include: { product: true },
      }),
      this.db.user.findUnique({
        where: { id: userId },
        select: { campusId: true },
      }),
    ]);
    // IK9SO6：起送门槛读校园配置（后台可改），缺省回退常量
    const campus = user
      ? await this.db.campus.findUnique({
          where: { id: user.campusId },
          select: { deliveryThreshold: true },
        })
      : null;
    // 生效价（ADR-0006）：活动期视图 price 即促销价，productAmount/券门槛/
    // 下单快照全部随 cart 单一来源走，下游零特判
    const promoMap = await this.promotionMap(rows.map((r) => r.productId));
    const items = rows.map((row) => ({
      product: this.productView(
        row.product,
        false,
        promoMap.get(row.productId),
      ),
      quantity: row.quantity,
    }));
    // 金额单位:分——全整数运算，无浮点误差（IK8W5K）。
    const productAmount = items.reduce(
      (sum, i) => sum + i.product.price * i.quantity,
      0,
    );
    return {
      items,
      productAmount,
      totalQuantity: items.reduce((sum, i) => sum + i.quantity, 0),
      deliveryThreshold:
        campus?.deliveryThreshold ?? BusinessService.DELIVERY_THRESHOLD_CENTS,
    };
  }
  async updateCart(userId: string, dto: UpdateCartDto) {
    await this.db.$transaction(async (tx) => {
      // IKDFZK：下架/不存在行直接剔除（全量替换语义下 = 自动移出购物车），
      // 不再整批抛错——旧行为会把售罄/下架商品变成"钉子户"（删不掉且
      // 连累其他商品保存失败）；在售行仅当数量上升时校验库存（同 setCartItem
      // 口径），减少/清零方向放行
      const existing = await tx.cartItem.findMany({
        where: { userId },
        select: { productId: true, quantity: true },
      });
      const oldQty = new Map(existing.map((e) => [e.productId, e.quantity]));
      const rows: { userId: string; productId: string; quantity: number }[] =
        [];
      for (const line of dto.items) {
        if (line.quantity <= 0) continue;
        const p = await tx.product.findUnique({
          where: { id: line.productId },
        });
        if (!p || p.status !== 'on-sale') continue;
        if (
          line.quantity > (oldQty.get(line.productId) ?? 0) &&
          line.quantity > p.stock - p.lockedStock
        )
          throw new BadRequestException(`${p.name}库存不足`);
        rows.push({
          userId,
          productId: line.productId,
          quantity: line.quantity,
        });
      }
      await tx.cartItem.deleteMany({ where: { userId } });
      if (rows.length) await tx.cartItem.createMany({ data: rows });
    });
    return this.cart(userId);
  }
  async setCartItem(userId: string, productId: string, quantity: number) {
    const p = await this.db.product.findUnique({ where: { id: productId } });
    if (!p) throw new NotFoundException('商品不存在');
    // IKDFZK：库存校验只拦「增加」方向（新数量 > 购物车已有数量才比库存），
    // 减少/清零放行——否则售罄商品的存量行永远删不掉
    const existing = await this.db.cartItem.findUnique({
      where: { userId_productId: { userId, productId } },
      select: { quantity: true },
    });
    if (
      quantity > (existing?.quantity ?? 0) &&
      quantity > p.stock - p.lockedStock
    )
      throw new BadRequestException(`${p.name}库存不足`);
    if (quantity === 0)
      await this.db.cartItem.deleteMany({ where: { userId, productId } });
    else
      await this.db.cartItem.upsert({
        where: { userId_productId: { userId, productId } },
        create: { userId, productId, quantity },
        update: { quantity },
      });
    return this.cart(userId);
  }
  async clearCart(userId: string) {
    await this.db.cartItem.deleteMany({ where: { userId } });
    return this.cart(userId);
  }
  private async validateQuote(
    userId: string,
    campusId: string,
    dto: CreateOrderDto,
  ) {
    const [cart, address] = await Promise.all([
      this.cart(userId),
      this.db.address.findFirst({ where: { id: dto.addressId, userId } }),
    ]);
    if (!cart.items.length) throw new BadRequestException('购物车为空');
    if (cart.productAmount < cart.deliveryThreshold)
      throw new BadRequestException(
        `商品金额满${yuan(cart.deliveryThreshold)}元起送`,
      );
    if (!address) throw new BadRequestException('地址不存在或无权使用');
    // IKAJT2：地址必须属当前校区（切换校区后旧默认地址不再可结算）
    if (address.campusId !== campusId)
      throw new BadRequestException('请选择当前校区的收货地址');
    for (const line of cart.items) {
      const p = await this.db.product.findUnique({
        where: { id: line.product.id },
      });
      if (!p || line.quantity > p.stock - p.lockedStock)
        throw new BadRequestException(`${line.product.name}库存不足`);
    }
    if (dto.deliveryMode === 'scheduled') {
      if (!dto.deliverySlot) throw new BadRequestException('请选择送达时段');
      const slot = await this.db.deliverySlot.findFirst({
        where: {
          campusId: address.campusId,
          label: dto.deliverySlot,
          available: true,
          capacity: { gt: 0 },
        },
      });
      if (!slot) throw new BadRequestException('请选择可用的送达时段');
    }
    return { cart, address };
  }
  /** 运费（单位:分，IK9SO6）：读校园配置（后台可改），缺省回退常量。
   *  IKB3K1 抽出共用：checkout 与 availableCoupons 口径必须一致。 */
  private async deliveryFeeFor(campusId: string, mode: string) {
    const campus = await this.db.campus.findUnique({
      where: { id: campusId },
      select: { deliveryFeeInstant: true, deliveryFeeScheduled: true },
    });
    return mode === 'instant'
      ? (campus?.deliveryFeeInstant ??
          BusinessService.DELIVERY_FEE_CENTS.instant)
      : (campus?.deliveryFeeScheduled ??
          BusinessService.DELIVERY_FEE_CENTS.scheduled);
  }
  async checkout(userId: string, campusId: string, dto: CreateOrderDto) {
    const { cart } = await this.validateQuote(userId, campusId, dto);
    const deliveryFee = await this.deliveryFeeFor(campusId, dto.deliveryMode);
    const userCoupon = dto.couponId
      ? await this.validateUserCoupon(userId, dto.couponId, campusId)
      : null;
    const discount = userCoupon ? userCoupon.coupon.amount : 0;
    if (userCoupon && cart.productAmount < userCoupon.coupon.threshold)
      throw new BadRequestException('商品金额未达到优惠券使用门槛');
    // IKB3K1：抵扣超过订单金额（商品+运费）的券直接拒绝——无门槛大额券会算出负数单
    if (userCoupon && discount > cart.productAmount + deliveryFee)
      throw new BadRequestException('该单无法使用此优惠券');
    return {
      ...cart,
      deliveryFee,
      discount,
      // IKB3K1：应付金额下限 0 元，双保险（上游已拦截超抵扣券）
      payableAmount: Math.max(0, cart.productAmount + deliveryFee - discount),
      estimatedArrival:
        dto.deliveryMode === 'instant'
          ? '预计 30-60 分钟送达'
          : `${dto.deliverySlot} 送达`,
    };
  }
  async createOrder(userId: string, campusId: string, dto: CreateOrderDto) {
    const { address } = await this.validateQuote(userId, campusId, dto);
    const settlement = await this.checkout(userId, campusId, dto);
    const now = new Date();
    // 12 态状态机标准 timeline（IK93GQ）：含"楼下待交接"节点。
    const timeline: TimelineStep[] = buildOrderTimeline(
      `${address.buildingName} ${address.room}`,
    );
    const order = await this.db.$transaction(async (tx) => {
      if (dto.couponId) {
        // 下单锁定优惠券：claimed/released -> locked，条件更新防并发重复占用。
        const locked = await tx.userCoupon.updateMany({
          where: {
            id: dto.couponId,
            userId,
            status: { in: ['claimed', 'released'] },
          },
          data: { status: 'locked' },
        });
        if (!locked.count)
          throw new BadRequestException('优惠券不可用或已被锁定');
      }
      return tx.order.create({
        data: {
          // orderNo 唯一约束：时间戳 + 随机后缀防同毫秒并发冲突
          orderNo: `BCQ${Date.now()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
          userId,
          campusId: address.campusId,
          status: 'pending-payment',
          statusText: '等待支付',
          address: json(address),
          deliveryMode: dto.deliveryMode,
          deliverySlot: dto.deliverySlot,
          couponId: dto.couponId,
          remark: dto.remark ?? '',
          items: json(settlement.items),
          productAmount: settlement.productAmount,
          totalQuantity: settlement.totalQuantity,
          deliveryThreshold: settlement.deliveryThreshold,
          deliveryFee: settlement.deliveryFee,
          discount: settlement.discount,
          payableAmount: settlement.payableAmount,
          estimatedArrival: settlement.estimatedArrival,
          timeline: json(timeline),
          createdAt: now,
        },
      });
    });
    return this.orderView(order);
  }
  /** 待支付超时阈值：15 分钟。 */
  static readonly PAYMENT_TIMEOUT_MS = 15 * 60 * 1000;
  /**
   * 条件关单一批超时待支付单（与并发 pay/cancel 互斥）。
   * 用户侧懒执行（expirePendingOrders）与支付超时 Cron（IK8W5I）共用。
   */
  private async closeStalePendingOrders(
    stale: Array<{ id: string; couponId: string | null }>,
  ) {
    if (!stale.length) return;
    await this.db.$transaction(async (tx) => {
      for (const order of stale) {
        // 逐单条件关单：仅当仍处于待支付时生效，避免与并发 pay/cancel 双写。
        // 待支付单未扣库存，关单只需释放券，无需回补库存。
        const closed = await tx.order.updateMany({
          where: { id: order.id, status: 'pending-payment' },
          data: { status: 'cancelled', statusText: '支付超时已关闭' },
        });
        if (closed.count && order.couponId)
          await tx.userCoupon.updateMany({
            where: { id: order.couponId, status: 'locked' },
            data: { status: 'released' },
          });
      }
    });
  }
  private async expirePendingOrders(userId: string) {
    const deadline = new Date(Date.now() - BusinessService.PAYMENT_TIMEOUT_MS);
    const stale = await this.db.order.findMany({
      where: {
        userId,
        status: 'pending-payment',
        createdAt: { lt: deadline },
      },
      select: { id: true, couponId: true },
    });
    await this.closeStalePendingOrders(stale);
  }
  /** 全量超时待支付关单（支付超时 Cron 调用，见 IK8W5I）。 */
  async expireAllPendingOrders() {
    const deadline = new Date(Date.now() - BusinessService.PAYMENT_TIMEOUT_MS);
    const stale = await this.db.order.findMany({
      where: { status: 'pending-payment', createdAt: { lt: deadline } },
      select: { id: true, couponId: true },
    });
    await this.closeStalePendingOrders(stale);
    return stale.length;
  }
  async orders(userId: string, status?: string) {
    await this.expirePendingOrders(userId);
    const delivering = DELIVERING_STATUSES;
    const rows = await this.db.order.findMany({
      where: {
        userId,
        ...(!status || status === 'all'
          ? {}
          : status === 'delivering'
            ? { status: { in: delivering } }
            : { status }),
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((o) => this.orderView(o));
  }
  async order(userId: string, id: string) {
    await this.expirePendingOrders(userId);
    const item = await this.db.order.findFirst({ where: { id, userId } });
    if (!item) throw new NotFoundException('订单不存在');
    return this.orderView(item);
  }
  async pay(userId: string, id: string) {
    return this.db.$transaction(async (tx) => {
      const raw = await tx.order.findFirst({ where: { id, userId } });
      if (!raw) throw new NotFoundException('订单不存在');
      // 顺序重复点击：已支付直接幂等返回。
      if (raw.status === 'paid') return this.orderView(raw);
      if (
        Date.now() - raw.createdAt.getTime() >=
        BusinessService.PAYMENT_TIMEOUT_MS
      ) {
        // 条件关单：仅当仍待支付才关闭并释放券（与并发 pay/cancel 互斥）。
        await tx.order.updateMany({
          where: { id, status: 'pending-payment' },
          data: { status: 'cancelled', statusText: '支付超时已关闭' },
        });
        if (raw.couponId)
          await tx.userCoupon.updateMany({
            where: { id: raw.couponId, status: 'locked' },
            data: { status: 'released' },
          });
        throw new BadRequestException('订单支付已超时');
      }
      if (raw.status !== 'pending-payment')
        throw new BadRequestException('当前状态不可支付');
      const items = raw.items as unknown as OrderLine[];
      for (const line of items) {
        const p = await tx.product.findUnique({
          where: { id: line.product.id },
        });
        if (!p || p.stock - p.lockedStock < line.quantity)
          throw new BadRequestException(`${line.product.name}库存不足`);
      }
      const timeline = raw.timeline as unknown as TimelineStep[],
        paidAt = new Date();
      timeline[0] = { ...timeline[0], done: true, time: paidAt.toISOString() };
      // 条件更新抢占支付权：并发的第二笔支付 count=0 直接失败，
      // 库存扣减与后续副作用都移到抢占成功之后，防止双扣。
      const won = await tx.order.updateMany({
        where: { id, status: 'pending-payment' },
        data: {
          status: 'paid',
          statusText: '仓库正在接单',
          paidAt,
          timeline: json(timeline),
          // 包裹码随支付生成（骑手取货扫码时须回传校验）
          package: json({
            id: `PKG-${randomUUID().slice(0, 8).toUpperCase()}`,
            status: 'waiting-pick',
          }),
        },
      });
      if (!won.count) throw new BadRequestException('订单状态已变化');
      for (const line of items)
        await tx.product.update({
          where: { id: line.product.id },
          data: { stock: { decrement: line.quantity } },
        });
      const updated = await tx.order.findUniqueOrThrow({ where: { id } });
      if (raw.couponId) {
        // 支付成功：locked -> used，并累计券维度的已使用计数。
        const used = await tx.userCoupon.updateMany({
          where: { id: raw.couponId, status: 'locked' },
          data: { status: 'used' },
        });
        if (used.count) {
          const holding = await tx.userCoupon.findUniqueOrThrow({
            where: { id: raw.couponId },
            select: { couponId: true },
          });
          await tx.coupon.update({
            where: { id: holding.couponId },
            data: { used: { increment: 1 } },
          });
        }
      }
      await tx.cartItem.deleteMany({ where: { userId } });
      // IKA0BI：2 小时送达赠券（结算页对用户的承诺）——预约单支付成功随
      // 事务发放。券模板由运营在后台创建后切 status=paused（隐藏于公开
      // 可领列表，领取接口也拒非 active），再配 SCHEDULED_BONUS_COUPON_ID
      // 启用；额度不足/未配置只记日志，绝不影响支付主流程。
      // pay() 幂等（已支付早退）保证不重发。
      const bonusCouponId = process.env.SCHEDULED_BONUS_COUPON_ID;
      if (bonusCouponId && raw.deliveryMode === 'scheduled') {
        const bonus = await tx.coupon.findUnique({
          where: { id: bonusCouponId },
        });
        if (
          bonus &&
          (!bonus.expiresAt || bonus.expiresAt.getTime() > Date.now())
        ) {
          const wonBonus = await tx.coupon.updateMany({
            // IKDEN2：不限量券不设上限条件
            where: {
              id: bonus.id,
              ...(bonus.total === null
                ? {}
                : { claimed: { lt: bonus.total } }),
            },
            data: { claimed: { increment: 1 }, issued: { increment: 1 } },
          });
          if (wonBonus.count) {
            await tx.userCoupon.create({
              data: { userId, couponId: bonus.id },
            });
            await tx.notification.create({
              data: {
                userId,
                type: 'coupon',
                title: '赠券到账',
                content: `感谢选择 2 小时送达，${bonus.name} 已放入你的账户，下次下单可用。`,
              },
            });
          } else {
            BusinessService.logger.warn(
              `赠券额度不足：order=${raw.orderNo} coupon=${bonusCouponId}`,
            );
          }
        } else {
          BusinessService.logger.warn(
            `赠券模板未配置/停用/已过期：order=${raw.orderNo} coupon=${bonusCouponId ?? '未配置'}`,
          );
        }
      }
      await tx.notification.create({
        data: {
          userId,
          type: 'order',
          title: '支付成功',
          content: '订单已进入湖工大校园仓，仓储人员即将开始拣货。',
        },
      });
      // 渠道推送（IK8W5M）：支付成功订阅消息。fire-and-forget，不进事务、不阻断。
      void this.push?.orderStatusPush({
        id: updated.id,
        userId,
        orderNo: updated.orderNo,
        status: 'paid',
        statusText: '支付成功',
        payableAmount: updated.payableAmount,
      });
      // 小票打印（IKBT6N，2026-08-28 道哥定版）：支付成功即出票，当仓库备货单。
      // 幂等早退（已支付直接 return）保证重复回调不会重复打；出库不再重复打。
      void this.printReceiptFor(updated);
      return this.orderView(updated);
    });
  }
  /**
   * 管理端推进履约（orderAction advance）：沿 12 态状态机单步前进。
   * 迁移表见 src/common/order-state.ts 注释（IK93GQ）。
   */
  private static readonly ADVANCE_MAP: Record<string, [string, string]> = {
    paid: ['picking', '仓库正在拣货'],
    picking: ['waiting-first-mile', '已出库，待配送员接单'],
    'waiting-first-mile': ['first-mile', '配送中，骑手送往楼下'],
    'first-mile': ['waiting-handover', '已到楼下，等待楼长交接'],
    'waiting-handover': ['last-mile', '楼长送往寝室'],
    'last-mile': ['delivered', '已送达寝室'],
    delivered: ['completed', '已确认收货'],
  };
  async advance(userId: string, id: string) {
    const raw = await this.db.order.findFirst({ where: { id, userId } });
    if (!raw) throw new NotFoundException('订单不存在');
    const next = BusinessService.ADVANCE_MAP[raw.status];
    if (!next) throw new BadRequestException('当前状态不可推进履约');
    const [status, statusText] = next;
    // 条件更新：并发推进（双人操作/与履约端同时改单）时仅一笔生效。
    const won = await this.db.order.updateMany({
      where: { id, status: raw.status },
      data: {
        status,
        statusText,
        timeline: markTimelineStep(raw.timeline, status),
      },
    });
    if (!won.count) throw new BadRequestException('订单状态已变化');
    const updated = await this.db.order.findUniqueOrThrow({ where: { id } });
    await this.notify(
      userId,
      'delivery',
      updated.statusText,
      `${updated.orderNo} 的履约状态已更新。`,
    );
    // 渠道推送（IK8W5M）：出库/一级配送中/即将到楼/已送达 订阅消息（已送达带短信兜底）。
    void this.push?.orderStatusPush({
      id: updated.id,
      userId,
      orderNo: updated.orderNo,
      status: updated.status,
      statusText: updated.statusText,
      payableAmount: updated.payableAmount,
    });
    return this.orderView(updated);
  }
  /**
   * 仓库出库（IKA0UQ）：paid/picking 一步转 waiting-first-mile（已出库，待配送），
   * 跳过拣货中间态——v1 履约简化（IKA0UM 同批）后 picking 不在主链路上。
   * 库存不在此扣减：支付时已扣（pay 事务），此处仅记出库流水供「出入库流水」
   * 页对账，delta 记商品出库数量、reason 注明支付已扣，避免被当二次扣减。
   */
  async outbound(id: string, operator: string) {
    const raw = await this.db.order.findUnique({ where: { id } });
    if (!raw) throw new NotFoundException('订单不存在');
    if (!['paid', 'picking'].includes(raw.status))
      throw new BadRequestException(
        raw.status === 'waiting-first-mile'
          ? '该订单已出库，无需重复操作'
          : '当前状态不可出库',
      );
    const lines =
      (raw.items as Array<{
        product?: { id?: string };
        quantity: number;
      }>) ?? [];
    const updated = await this.db.$transaction(async (tx) => {
      // 条件更新：与后台改状态/另一管理员同时出库并发时仅一笔生效。
      const won = await tx.order.updateMany({
        where: { id, status: raw.status },
        data: {
          status: 'waiting-first-mile',
          statusText: '已出库，待配送员接单',
          timeline: markTimelineStep(raw.timeline, 'waiting-first-mile'),
        },
      });
      if (!won.count) throw new BadRequestException('订单状态已变化');
      // 出库流水（IKA0UQ 验收：库存正确扣减——支付时已扣，此处记账不重复扣）。
      // IKCLAC：items 是 JSON 快照，商品档案可能已被清理/删除——先过滤出
      // 仍存在的商品再记账，不存在的跳过（外键 P2003 会把整个出库事务卡死）。
      const productIds = [
        ...new Set(
          lines
            .map((line) => line.product?.id)
            .filter((pid): pid is string => Boolean(pid)),
        ),
      ];
      const existing = productIds.length
        ? await tx.product.findMany({
            where: { id: { in: productIds } },
            select: { id: true },
          })
        : [];
      const existingIds = new Set(existing.map((p) => p.id));
      for (const line of lines) {
        const productId = line.product?.id;
        if (productId && existingIds.has(productId))
          await tx.inventoryTxn.create({
            data: {
              productId,
              type: 'out',
              delta: -line.quantity,
              reason: `订单出库 ${raw.orderNo}（库存已于支付时扣减）`,
              operator,
            },
          });
      }
      return tx.order.findUniqueOrThrow({ where: { id } });
    });
    await this.notify(
      updated.userId,
      'delivery',
      updated.statusText,
      `${updated.orderNo} 已从仓库发出，等待配送员接单。`,
    );
    void this.push?.orderStatusPush({
      id: updated.id,
      userId: updated.userId,
      orderNo: updated.orderNo,
      status: updated.status,
      statusText: updated.statusText,
      payableAmount: updated.payableAmount,
    });
    return this.orderView(updated);
  }

  /** 支付成功自动出票（IKBT6N）：组装打印上下文并推送芯烨云，失败仅 warn。 */
  private async printReceiptFor(order: {
    id: string;
    orderNo: string;
    campusId: string;
    deliveryMode: string;
    deliverySlot?: string | null;
    estimatedArrival?: string | null;
    remark?: string | null;
    createdAt: Date;
    address?: unknown;
    items?: unknown;
    productAmount: unknown;
    deliveryFee: unknown;
    discount: unknown;
    payableAmount: unknown;
  }): Promise<void> {
    if (!this.printer) return;
    try {
      const campus = await this.db.campus.findUnique({
        where: { id: order.campusId },
        select: { warehouseName: true },
      });
      // IKBW0Q：校区绑定打印机优先，未绑定回落 env 试点单机；
      // IKCZOX：联数随绑定带出（默认 1=旧票面）
      const bound = await this.db.printer.findUnique({
        where: { campusId: order.campusId },
        select: { sn: true, status: true, copies: true },
      });
      const activeBound = bound && bound.status === 'active' ? bound : null;
      const snOverride = activeBound?.sn;
      const copies = activeBound?.copies ?? 1;
      const context: ReceiptOrderContext = {
        id: order.id,
        orderNo: order.orderNo,
        campusId: order.campusId,
        warehouseName: campus?.warehouseName ?? '',
        deliveryMode: order.deliveryMode,
        deliverySlot: order.deliverySlot,
        estimatedArrival: order.estimatedArrival,
        remark: order.remark,
        createdAt: order.createdAt,
        address: order.address as ReceiptOrderContext['address'],
        items: order.items as ReceiptOrderContext['items'],
        productAmount: Number(order.productAmount),
        deliveryFee: Number(order.deliveryFee),
        discount: Number(order.discount),
        payableAmount: Number(order.payableAmount),
      };
      // IKD6H4：库位实时注入（分拣备货单要「现在放哪」）
      context.items = await this.printer.attachLocations(context.items);
      await this.printer.printOrderReceipt(context, snOverride, copies);
    } catch (error) {
      BusinessService.logger.warn(
        `订单 ${order.orderNo} 支付小票打印失败（不影响支付流程）: ${
          error instanceof Error ? error.message : error
        }`,
      );
    }
  }
  async confirmReceipt(userId: string, id: string) {
    const raw = await this.db.order.findFirst({ where: { id, userId } });
    if (!raw) throw new NotFoundException('订单不存在');
    // delivered（楼长已送达）与 completed 分离：确认收货才进入终态 completed。
    if (!['delivered', 'completed'].includes(raw.status))
      throw new BadRequestException('当前状态不可确认收货');
    if (raw.status === 'completed') return this.orderView(raw);
    // 条件更新：与售后退款/异常标记并发时仅一笔生效。
    const won = await this.db.order.updateMany({
      where: { id, status: 'delivered' },
      data: {
        status: 'completed',
        statusText: '已确认收货',
        timeline: markTimelineStep(raw.timeline, 'completed'),
      },
    });
    if (!won.count) throw new BadRequestException('订单状态已变化');
    return this.orderView(
      await this.db.order.findUniqueOrThrow({ where: { id } }),
    );
  }
  async cancel(userId: string, id: string) {
    return this.db.$transaction(async (tx) => {
      const raw = await tx.order.findFirst({ where: { id, userId } });
      if (!raw) throw new NotFoundException('订单不存在');
      // ADR-0004：试点期不退款，已支付订单不可自助取消（客服人工处理），
      // 系统任何路径都不再创建 Refund 记录。
      if (raw.status === 'paid')
        throw new BadRequestException('订单已支付，如需取消请联系客服处理');
      if (raw.status !== 'pending-payment')
        throw new BadRequestException('当前状态不可取消');
      // 条件更新抢占取消权：并发双取消只有一单成功，
      // 释放券等补偿动作全部移到抢占成功之后，防止双补。
      const won = await tx.order.updateMany({
        where: { id, status: raw.status },
        data: { status: 'cancelled', statusText: '订单已取消' },
      });
      if (!won.count) throw new BadRequestException('订单状态已变化');
      if (raw.couponId)
        // 取消订单：locked/used -> released，released 状态可再次选用。
        await tx.userCoupon.updateMany({
          where: { id: raw.couponId, status: { in: ['locked', 'used'] } },
          data: { status: 'released' },
        });
      const updated = await tx.order.findUniqueOrThrow({ where: { id } });
      return this.orderView(updated);
    });
  }
  async addresses(userId: string, campusId: string) {
    return this.db.address.findMany({
      where: { userId, campusId },
      orderBy: { isDefault: 'desc' },
    });
  }
  async addAddress(userId: string, campusId: string, dto: CreateAddressDto) {
    if (dto.isDefault)
      await this.db.address.updateMany({
        where: { userId, campusId },
        data: { isDefault: false },
      });
    const campus = await this.campus(campusId);
    const building = await this.db.building.findFirst({
      where: { campusId, name: dto.buildingName },
    });
    return this.db.address.create({
      data: {
        userId,
        campusId,
        campusName: campus.name,
        buildingId: building?.id ?? dto.buildingName,
        ...dto,
        isDefault: dto.isDefault ?? false,
      },
    });
  }
  async updateAddress(
    userId: string,
    campusId: string,
    id: string,
    dto: UpdateAddressDto,
  ) {
    const found = await this.db.address.findFirst({
      where: { id, userId, campusId },
    });
    if (!found) throw new NotFoundException('地址不存在');
    return this.db.address.update({ where: { id }, data: dto });
  }
  async deleteAddress(userId: string, campusId: string, id: string) {
    const found = await this.db.address.findFirst({
      where: { id, userId, campusId },
    });
    if (!found) throw new NotFoundException('地址不存在');
    await this.db.$transaction(async (tx) => {
      await tx.address.delete({ where: { id } });
      if (found.isDefault) {
        const next = await tx.address.findFirst({
          where: { userId, campusId },
          orderBy: { id: 'asc' },
        });
        if (next)
          await tx.address.update({
            where: { id: next.id },
            data: { isDefault: true },
          });
      }
    });
    return { id, deleted: true };
  }
  async setDefaultAddress(userId: string, campusId: string, id: string) {
    const found = await this.db.address.findFirst({
      where: { id, userId, campusId },
    });
    if (!found) throw new NotFoundException('地址不存在');
    await this.db.$transaction([
      this.db.address.updateMany({
        where: { userId, campusId },
        data: { isDefault: false },
      }),
      this.db.address.update({ where: { id }, data: { isDefault: true } }),
    ]);
    return { ...found, isDefault: true };
  }
  async availableCoupons(
    userId: string,
    campusId: string,
    dto: CreateOrderDto,
  ) {
    const { cart } = await this.validateQuote(userId, campusId, {
      ...dto,
      couponId: undefined,
    });
    // IKB3K1：券列表就标出「抵扣超过订单金额」的不可用券（口径同 checkout）
    const fee = await this.deliveryFeeFor(campusId, dto.deliveryMode);
    const rows = await this.db.userCoupon.findMany({
      // 只看本校发放的金额券（跨校园券/异业券不参与下单，IKDCVO）。
      where: {
        userId,
        status: { in: ['claimed', 'released'] },
        coupon: { campusId, kind: 'platform' },
      },
      include: { coupon: true },
      orderBy: { claimedAt: 'desc' },
    });
    const now = new Date();
    return rows.map((row) => {
      const amount = row.coupon.amount,
        threshold = row.coupon.threshold;
      let reason: string | undefined;
      if (row.coupon.status !== 'active') reason = '优惠券已下架';
      else if (row.coupon.expiresAt && row.coupon.expiresAt <= now)
        reason = '优惠券已过期';
      else if (cart.productAmount < threshold)
        reason = `还差${yuan(threshold - cart.productAmount)}元可用`;
      else if (amount > cart.productAmount + fee)
        reason = '该单无法使用此优惠券';
      return {
        id: row.id,
        couponId: row.couponId,
        name: row.coupon.name,
        remark: row.coupon.remark,
        amount,
        threshold,
        status: row.status,
        expiresAt: row.coupon.expiresAt
          ? row.coupon.expiresAt.toISOString()
          : null,
        available: !reason,
        unavailableReason: reason,
      };
    });
  }
  async createAfterSales(
    userId: string,
    orderId: string,
    dto: CreateAfterSalesDto,
  ) {
    const order = await this.db.order.findFirst({
      where: { id: orderId, userId },
    });
    if (!order) throw new NotFoundException('订单不存在');
    // delivered（已送达待确认）即可申请售后，不必等用户确认收货。
    if (!['delivered', 'completed'].includes(order.status))
      throw new BadRequestException('订单送达后才能申请售后');
    // 送达时间优先取送达凭证时间（delivered 动作写入），历史单回退 timeline 末节点。
    const proof = (order.package as unknown as Record<string, any> | null)
      ?.proof;
    const timeline = order.timeline as unknown as TimelineStep[];
    const deliveredAt = proof?.time ?? timeline.at(-1)?.time;
    if (
      !deliveredAt ||
      Date.now() - new Date(deliveredAt).getTime() > 24 * 60 * 60 * 1000
    )
      throw new BadRequestException('已超过送达后 24 小时售后期限');
    if (await this.db.afterSale.findFirst({ where: { orderId } }))
      throw new BadRequestException('该订单已提交售后');
    return this.db.$transaction(async (tx) => {
      const record = await tx.afterSale.create({
        data: {
          userId,
          orderId,
          type: dto.type,
          description: dto.description,
          images: json(dto.images),
          status: 'pending',
        },
      });
      await tx.order.update({
        where: { id: orderId },
        data: { status: 'after-sales', statusText: '售后审核中' },
      });
      return {
        ...record,
        createdAt: record.createdAt.toISOString(),
        images: dto.images,
      };
    });
  }
  async afterSales(userId: string) {
    const items = await this.db.afterSale.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return items.map((i) => ({
      ...i,
      images: i.images as string[],
      createdAt: i.createdAt.toISOString(),
    }));
  }
  async afterSale(userId: string, id: string) {
    const item = await this.db.afterSale.findFirst({ where: { id, userId } });
    if (!item) throw new NotFoundException('售后单不存在');
    return {
      ...item,
      images: item.images as string[],
      createdAt: item.createdAt.toISOString(),
    };
  }
  async cancelAfterSale(userId: string, id: string) {
    const item = await this.db.afterSale.findFirst({ where: { id, userId } });
    if (!item) throw new NotFoundException('售后单不存在');
    if (item.status !== 'pending')
      throw new BadRequestException('当前售后状态不可撤销');
    return this.db.afterSale.update({
      where: { id },
      data: { status: 'cancelled' },
    });
  }
  async refunds(userId: string) {
    const items = await this.db.refund.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return items.map((i) => ({
      ...i,
      amount: number(i.amount),
      createdAt: i.createdAt.toISOString(),
    }));
  }
  async refund(userId: string, id: string) {
    const item = await this.db.refund.findFirst({ where: { id, userId } });
    if (!item) throw new NotFoundException('退款记录不存在');
    return {
      ...item,
      amount: number(item.amount),
      createdAt: item.createdAt.toISOString(),
    };
  }
  async notifications(userId: string) {
    const items = await this.db.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return items.map((i) => ({ ...i, createdAt: i.createdAt.toISOString() }));
  }
  async readNotification(userId: string, id: string) {
    const item = await this.db.notification.findFirst({
      where: { id, userId },
    });
    if (!item) throw new NotFoundException('消息不存在');
    return this.db.notification.update({ where: { id }, data: { read: true } });
  }
  async readAllNotifications(userId: string, type?: string) {
    await this.db.notification.updateMany({
      where: { userId, ...(type ? { type } : {}) },
      data: { read: true },
    });
    return this.unreadNotificationCount(userId);
  }
  async unreadNotificationCount(userId: string) {
    const rows = await this.db.notification.groupBy({
      by: ['type'],
      where: { userId, read: false },
      _count: { _all: true },
    });
    return {
      total: rows.reduce((n, r) => n + r._count._all, 0),
      byType: Object.fromEntries(rows.map((r) => [r.type, r._count._all])),
    };
  }
  /**
   * 进群二维码（IKAJSZ）：三级回落——默认地址的楼栋群 → 校级大群 → null。
   * Address 无 createdAt，默认地址按 isDefault 优先取。
   */
  async wechatGroup(userId: string) {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { campusId: true },
    });
    if (!user) return null;
    const address = await this.db.address.findFirst({
      where: { userId },
      orderBy: { isDefault: 'desc' },
    });
    const group = address
      ? await this.db.wechatGroup.findUnique({
          where: {
            campusId_buildingId: {
              campusId: user.campusId,
              buildingId: address.buildingId,
            },
          },
        })
      : null;
    const resolved =
      group ??
      (await this.db.wechatGroup.findUnique({
        where: {
          campusId_buildingId: { campusId: user.campusId, buildingId: '' },
        },
      }));
    if (!resolved) return null;
    return {
      image: resolved.image,
      // scope 供前端展示「楼栋群/校园群」标签
      scope: resolved.buildingId ? 'building' : 'campus',
    };
  }

  /**
   * 转盘信息（IKD6FB）：首页入口与转盘页共用。
   * 未配置/未开启 → active=false（前端隐藏入口）；奖位不下发权重，
   * 概率只存在于服务端。drawnToday 供转盘页置灰中心钮。
   */
  async wheel(userId: string, campusId: string) {
    const row = await this.db.lotteryWheel.findUnique({
      where: { campusId },
    });
    const prizes = row?.active ? parsePrizes(row.prizes) : [];
    const today = beijingDate();
    const drawn = await this.db.lotteryDraw.findUnique({
      where: { userId_drawDate: { userId, drawDate: today } },
    });
    return {
      active: prizes.length === WHEEL_SLOTS,
      prizes: prizes.map((p) => ({
        type: p.type,
        label: p.label,
        bizTitle: p.bizTitle ?? '',
        bizImage: p.bizImage ?? '',
        bizNote: p.bizNote ?? '',
      })),
      drawnToday: Boolean(drawn),
    };
  }

  /**
   * 抽奖（IKD6FB）：权重随机（与历史无关），事务内「占限抽数 + 发券」。
   * 平台券发完/过期/停用 → 该次自动降级谢谢参与（grilling 拍板：绝不超发）。
   * 并发双击靠 LotteryDraw(userId, drawDate) 唯一键兜底。
   */
  async drawWheel(userId: string, campusId: string) {
    const wheel = await this.db.lotteryWheel.findUnique({
      where: { campusId },
    });
    if (!wheel || !wheel.active)
      throw new BadRequestException('抽奖活动未开启');
    const prizes = parsePrizes(wheel.prizes);
    if (prizes.length !== WHEEL_SLOTS)
      throw new BadRequestException('转盘配置不完整');

    const today = beijingDate();
    const hit = this.pickPrize(prizes);
    if (!hit) throw new BadRequestException('转盘配置不完整');
    try {
      return await this.db.$transaction(async (tx) => {
        // 先占限抽数：并发第二笔在此撞唯一键 → 视为今日已抽。
        const draw = await tx.lotteryDraw.create({
          data: {
            userId,
            wheelId: wheel.id,
            drawDate: today,
            prizeIndex: hit.index,
            prizeType: hit.prize.type,
          },
        });
        let userCouponId: string | null = null;
        let prizeType = hit.prize.type;
        let couponLabel = '';
        let couponRemark = '';
        if (hit.prize.type === 'coupon') {
          const issued = await this.issueWheelCoupon(
            tx,
            userId,
            campusId,
            hit.prize.couponId,
          );
          if (issued) {
            userCouponId = issued.id;
            couponRemark = issued.remark;
          } else {
            // 券发完/过期/停用：降级谢谢参与并落库真实结果。
            prizeType = 'none';
            await tx.lotteryDraw.update({
              where: { id: draw.id },
              data: { prizeType },
            });
          }
        } else if (hit.prize.type === 'partner' && hit.prize.couponId) {
          // IKDCVO：partner 行配了异业券 → 抽中发券入账（我的优惠券可见，
          // 暂不核销）；发不出去回落旧图文展示——异业券无资金成本不降谢谢参与。
          const issued = await this.issueWheelCoupon(
            tx,
            userId,
            campusId,
            hit.prize.couponId,
          );
          if (issued) {
            userCouponId = issued.id;
            couponLabel = issued.name;
            couponRemark = issued.remark;
          }
        }
        return {
          index: hit.index,
          type: prizeType,
          userCouponId,
          prize: {
            type: prizeType,
            label: prizeType === 'none' ? '谢谢参与' : hit.prize.label,
            // 发成异业券时优先展示券信息；存量无 couponId 保留旧图文。
            bizTitle:
              prizeType === 'partner'
                ? couponLabel || (hit.prize.bizTitle ?? '')
                : '',
            bizImage:
              prizeType === 'partner' && !userCouponId
                ? (hit.prize.bizImage ?? '')
                : '',
            bizNote:
              prizeType === 'partner'
                ? couponRemark || (hit.prize.bizNote ?? '')
                : '',
          },
        };
      });
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      )
        throw new BadRequestException('今日已抽过，明天再来');
      throw e;
    }
  }

  /** 权重随机：weight=0 的奖位不参与；全 0 兜底返回 null → 外层报配置错误。 */
  private pickPrize(
    prizes: WheelPrize[],
  ): { index: number; prize: WheelPrize } | null {
    const pool = prizes
      .map((prize, index) => ({ prize, index }))
      .filter((x) => x.prize.weight > 0);
    const total = pool.reduce((s, x) => s + x.prize.weight, 0);
    if (!total) return null;
    let roll = Math.random() * total;
    for (const x of pool) {
      roll -= x.prize.weight;
      if (roll < 0) return x;
    }
    return pool[pool.length - 1];
  }

  /**
   * IKDCVO 统一发券内核（事务内调用）：占名额条件更新防超发 +
   * 幂等查重（status≠used 持有中不重发不占名额；opts.repeat=true 跳过——
   * 转盘每日可重复中同款）。券不存在/停用/过期/已领完返回 null 不抛错，
   * 调用方自行降级。campusId 校验留给调用方（报错文案各不相同）。
   */
  private async grantCouponInner(
    tx: Prisma.TransactionClient,
    userId: string,
    couponId: string,
    opts?: { repeat?: boolean },
  ): Promise<{
    id: string;
    name: string;
    remark: string;
    existing?: boolean;
  } | null> {
    const coupon = await tx.coupon.findUnique({ where: { id: couponId } });
    if (!coupon || coupon.status !== 'active') return null;
    if (coupon.expiresAt && coupon.expiresAt.getTime() <= Date.now())
      return null;
    if (!opts?.repeat) {
      const holding = await tx.userCoupon.findFirst({
        where: { userId, couponId, status: { not: 'used' } },
      });
      // 幂等命中：返回已有持有记录并带 existing 标记（不计新增发放）。
      if (holding)
        return {
          id: holding.id,
          name: coupon.name,
          remark: coupon.remark,
          existing: true,
        };
    }
    const won = await tx.coupon.updateMany({
      // IKDEN2：不限量券（total=null）不设 claimed 上限条件
      where: {
        id: couponId,
        ...(coupon.total === null ? {} : { claimed: { lt: coupon.total } }),
      },
      data: { claimed: { increment: 1 }, issued: { increment: 1 } },
    });
    if (!won.count) return null;
    const uc = await tx.userCoupon.create({
      data: { userId, couponId, status: 'claimed' },
    });
    return { id: uc.id, name: coupon.name, remark: coupon.remark };
  }

  /** 发券外壳版（注册 hook 等非事务场景用）。 */
  private grantCoupon(userId: string, couponId: string) {
    return this.db.$transaction((tx) =>
      this.grantCouponInner(tx, userId, couponId),
    );
  }

  /**
   * IKDCVO 注册发券：发本校区 trigger=signup 且在架/未过期的券（通常一张
   * 新人红包券）。幂等——已持有不重发；整批逐张尽力发，单张失败不影响其余。
   */
  async grantSignupCoupons(userId: string, campusId: string) {
    const candidates = await this.db.coupon.findMany({
      where: {
        campusId,
        trigger: 'signup',
        status: 'active',
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
    });
    let granted = 0;
    for (const c of candidates) {
      const issued = await this.grantCoupon(userId, c.id);
      if (issued && !issued.existing) granted += 1;
    }
    return { granted };
  }

  /**
   * 抽奖发券：走 grantCouponInner 的 repeat 模式（每日可重复中同款），
   * 外加跨校园校验；发不出一律返回 null → 调用方降级。
   */
  private async issueWheelCoupon(
    tx: Prisma.TransactionClient,
    userId: string,
    campusId: string,
    couponId?: string,
  ): Promise<{ id: string; name: string; remark: string } | null> {
    if (!couponId) return null;
    const coupon = await tx.coupon.findUnique({
      where: { id: couponId },
      select: { campusId: true },
    });
    if (!coupon || coupon.campusId !== campusId) return null;
    return this.grantCouponInner(tx, userId, couponId, { repeat: true });
  }
}
