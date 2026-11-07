import { purchaseWindowStart } from '../common/purchase-window';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { NightRefund, Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { nightPromotions } from './night-pricing';
import { NightRefundService } from './night-refund.service';
import { NightDepositRefundService } from './night-deposit-refund.service';
import { PrismaService } from '../database/prisma.service';
import { PaymentsService } from '../payments/payments.service';
import { NightPaymentHandler } from '../payments/payments.service';
import { NotificationsService } from '../notifications/notifications.service';
import { marketingEnabled } from '../common/capability';
import {
  beijingDate,
  beijingMinutes,
  commissionOf,
  hhmmToMinutes,
  inNightWindow,
  nightBusinessDate,
  nightDepositTradeNo,
  nightOrderNo,
} from './night.helpers';
import { NightOrderCreateDto, NightRefundDto } from './night.dto';
import { parsePagination } from '../common/pagination';
import {
  allocateInventoryValue,
  NightInventoryService,
} from './night-inventory.service';

/** JSON → 时间线（json() 自写自读，形状恒定；round-trip 避开 any 断言规则）。 */
const asTimeline = (v: unknown): NightTimelineStep[] =>
  JSON.parse(JSON.stringify(Array.isArray(v) ? v : [])) as NightTimelineStep[];
const USER_ORDER_INCLUDE = {
  refund: true,
  store: { include: {
    building: { select: { name: true } },
    campus: { select: { servicePhone: true, serviceQrcode: true, serviceKfUrl: true, serviceKfCorpId: true, showDeliveryContacts: true, afterSalesGroupQrcode: true, groupQrcodeTip: true } },
    managerStaff: { select: { id: true, name: true, phone: true } },
  } },
} satisfies Prisma.NightOrderInclude;

/** 夜宵订单行快照（items JSON）。 */
export interface NightOrderLine {
  nightProductId: string;
  catalogProductId: string;
  name: string;
  image: string;
  price: number; // 夜宵售价（分）
  quantity: number;
  inventoryValue?: number;
  basePrice?: number;
  promotionId?: string;
  asSeckill?: boolean;
}

/** 夜宵订单时间线节点（轻量自持，不复用白天 12 态）。 */
export interface NightTimelineStep {
  key: string;
  title: string;
  time?: string;
  description?: string;
  images?: string[];
  proof?: { images: string[]; remark?: string };
}

const STATUS_TEXT: Record<string, string> = {
  'pending-payment': '等待支付',
  'pending-accept': '待接单',
  delivering: '配送中',
  delivered: '已送达',
  completed: '已完成',
  cancelled: '已取消',
  cancelling: '退款处理中',
  refunded: '已退款',
  exception: '支付异常',
};

/** 待支付超时缺省（分钟）：校区 nightPayTimeout 未配置时的兜底。 */
const DEFAULT_PAY_TIMEOUT_MIN = 15;
/** 送达后自动完成（小时）：用户未确认时的兜底（夜间场次次日已过，24h 足够）。 */
const AUTO_COMPLETE_HOURS = 24;

type Tx = Prisma.TransactionClient;

const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

/**
 * 楼栋夜宵店订单域服务（IKSW1F）：下单/取消/完成/退款/佣金/结算/支付落账。
 * 与白天业务完全隔离——不读写 Order/CartItem/Product.stock，库存只走
 * NightProduct + NightStockTxn，佣金只走 NightCommissionTxn。
 */
@Injectable()
export class NightOrderService implements NightPaymentHandler {
  private readonly logger = new Logger(NightOrderService.name);
  private readonly refunds: NightRefundService;

  constructor(
    private readonly db: PrismaService,
    private readonly payments: PaymentsService,
    // 渠道推送：可选注入（单测直接 new 时不传，跳过推送）
    @Optional() private readonly push?: NotificationsService,
    private readonly inventory: NightInventoryService = new NightInventoryService(
      db,
    ),
  ) {
    this.refunds = new NightRefundService(db, payments, inventory, (tx, request) => this.finalizeRefund(tx, request));
    // 注册微信回调分发（YX/ND 前缀）；setter 注入避免模块循环依赖
    this.payments.registerNightPaymentHandler(this);
  }

  /* ==================== 视图 ==================== */

  orderView(order: {
    id: string;
    orderNo: string;
    status: string;
    statusText: string;
    items: Prisma.JsonValue;
    productAmount: number;
    couponDiscount: number;
    deliveryFee: number;
    payableAmount: number;
    commissionRate: number;
    address: Prisma.JsonValue;
    remark: string;
    timeline: Prisma.JsonValue;
    couponSnapshot: Prisma.JsonValue;
    businessDate: string;
    timeoutAt: Date | null;
    createdAt: Date;
    paidAt: Date | null;
    completedAt: Date | null;
    cancelReason: string | null;
    afterSaleStatus: string | null;
    managerStaffId?: string | null;
    refund?: NightRefund | null;
    store?: {
      id: string;
      building: { name: string };
      campus?: { servicePhone: string; serviceQrcode: string; serviceKfUrl: string; serviceKfCorpId: string; showDeliveryContacts: boolean; afterSalesGroupQrcode?: string; groupQrcodeTip?: string };
      managerStaff?: { id: string; name: string; phone?: string } | null;
    } | null;
  }) {
    return {
      id: order.id,
      orderNo: order.orderNo,
      status: order.status,
      statusText: order.statusText,
      items: order.items,
      productAmount: order.productAmount,
      couponDiscount: order.couponDiscount,
      deliveryFee: order.deliveryFee,
      payableAmount: order.payableAmount,
      commissionRate: order.commissionRate,
      address: order.address,
      remark: order.remark,
      timeline: order.timeline,
      couponSnapshot: order.couponSnapshot,
      businessDate: order.businessDate,
      timeoutAt: order.timeoutAt?.toISOString() ?? null,
      createdAt: order.createdAt.toISOString(),
      paidAt: order.paidAt?.toISOString() ?? null,
      completedAt: order.completedAt?.toISOString() ?? null,
      cancelReason: order.cancelReason,
      afterSaleStatus: order.afterSaleStatus,
      support: order.store?.campus ? { phone: order.store.campus.servicePhone, qrcode: order.store.campus.serviceQrcode, kfUrl: order.store.campus.serviceKfUrl, corpId: order.store.campus.serviceKfCorpId, groupQrcode: order.store.campus.afterSalesGroupQrcode || '', groupTip: order.store.campus.groupQrcodeTip || '' } : null,
      deliveryContact: order.paidAt && ['pending-accept', 'delivering', 'delivered'].includes(order.status) && order.store?.campus?.showDeliveryContacts && order.store.managerStaff?.id === order.managerStaffId && order.store.managerStaff?.phone ? { name: order.store.managerStaff.name, phone: order.store.managerStaff.phone } : null,
      refund: order.refund ? { id: order.refund.id, kind: order.refund.kind, fullProductRefund: order.refund.fullProductRefund, restock: order.refund.restock, reason: order.refund.reason, status: order.refund.status, amount: order.refund.totalAmount, productAmount: order.refund.productAmount, deliveryFeeAmount: order.refund.deliveryFeeAmount, message: order.refund.errorMessage, createdAt: order.refund.createdAt.toISOString(), completedAt: order.refund.completedAt?.toISOString() ?? null } : null,
      store: order.store
        ? { id: order.store.id, buildingName: order.store.building.name }
        : null,
    };
  }

  /* ==================== 用户端：下单 ==================== */

  /**
   * 提交夜宵订单（服务端全量重验）：营业状态/场次窗口/上架售卖许可/库存
   * 足量/本楼地址/夜宵券资格。事务内原子生效：券锁定 + 库存扣减（条件
   * UPDATE 防超卖）+ 订单落库（YX 单号，timeoutAt=now+校区配置）。
   * 库存在下单即扣（预占口径），支付成功只是状态推进；超时关单回补。
   */
  async submitOrder(userId: string, dto: NightOrderCreateDto) {
    if (!Array.isArray(dto.items) || !dto.items.length || dto.items.length > 100 || dto.items.some(line => !Number.isSafeInteger(line.quantity) || line.quantity < 1 || line.quantity > 999)) throw new BadRequestException('商品数量不合法');
    const quantities = new Map<string, number>();
    for (const line of dto.items) quantities.set(line.productId, (quantities.get(line.productId) ?? 0) + line.quantity);
    if ([...quantities.values()].some(qty => qty > 999)) throw new BadRequestException('单品数量最多999件');
    const seckillIds = [...new Set(dto.items.filter(line => line.asSeckill === true).map(line => line.productId))].sort();
    if (dto.items.some(line => line.asSeckill !== undefined && typeof line.asSeckill !== 'boolean')) throw new BadRequestException('商品购买渠道不正确');
    if (dto.items.some(line => line.asSeckill && (!line.promotionId || typeof line.promotionId !== 'string'))) throw new BadRequestException('请选择有效的秒杀活动');
    if (seckillIds.length > 1) throw new BadRequestException('一个订单限一个秒杀商品');
    for (const id of seckillIds) {
      if (dto.items.some(line => line.productId === id && !line.asSeckill)) throw new BadRequestException('同一商品不可混用秒杀和原价渠道');
      if (quantities.get(id)! > 1) throw new BadRequestException('秒杀商品每单限购1件');
    }
    const requestHash = createHash('sha256').update(JSON.stringify({ storeId: dto.storeId, addressId: dto.addressId, couponId: dto.couponId ?? null, remark: dto.remark?.trim() ?? '', expectedProductAmount: dto.expectedProductAmount ?? null, expectedDeliveryFee: dto.expectedDeliveryFee ?? null, items: [...quantities].sort(([a], [b]) => a.localeCompare(b)), ...(seckillIds.length ? { seckillIds: seckillIds.map(id => [id, dto.items.find(line => line.productId === id)!.promotionId || null]) } : {}) })).digest('hex');
    const priorOrder = async () => {
      if (!dto.requestId) return null;
      const old = await this.db.nightOrder.findUnique({ where: { userId_requestId: { userId, requestId: dto.requestId } } });
      if (old && old.requestHash !== requestHash) throw new BadRequestException('下单请求标识已用于其他内容，请重新确认订单');
      return old;
    };
    const prior = await priorOrder();
    if (prior) return this.myOrder(userId, prior.id);
    try { return await this.createOrder(userId, dto, requestHash); }
    catch (error) {
      const won = await priorOrder();
      if (won) return this.myOrder(userId, won.id);
      throw error;
    }
  }

  private async createOrder(userId: string, dto: NightOrderCreateDto, requestHash: string) {
    const store = await this.db.nightStore.findUnique({
      where: { id: dto.storeId },
      include: {
        campus: {
          select: {
            id: true,
            nightEnabled: true,
            nightStartAt: true,
            nightEndAt: true,
            nightPayTimeout: true,
            nightDeliveryFee: true,
            deliveryFeeInstant: true,
            closeStart: true,
            closeEnd: true,
            manualClosed: true,
          },
        },
      },
    });
    if (!store) throw new NotFoundException('夜宵店不存在');
    const buyer = await this.db.user.findUnique({ where: { id: userId }, select: { campusId: true, phone: true, role: true } });
    if (!buyer || buyer.role !== 'user') throw new ForbiddenException('当前账号无用户下单资格');
    if (buyer.campusId !== store.campusId) throw new BadRequestException('请选择当前校区的夜宵店');
    if (!buyer.phone) throw new BadRequestException('请先绑定手机号后再下单');
    if (!store.managerStaffId)
      throw new BadRequestException('本楼夜宵店暂无楼长经营');
    if (store.status !== 'open')
      throw new BadRequestException('夜宵店当前未营业');
    this.assertNightWindow(store.campus);
    const address = await this.db.address.findFirst({
      where: { id: dto.addressId, userId },
    });
    if (!address) throw new BadRequestException('地址不存在或无权使用');
    if (address.campusId !== store.campusId)
      throw new BadRequestException('请选择当前校区的收货地址');
    if (address.buildingId !== store.buildingId)
      throw new BadRequestException('夜宵订单仅支持本楼配送，请重新选店');

    // 行合并（同商品多行合并数量）后逐行验货验价
    const merged = new Map<string, number>();
    for (const line of dto.items) {
      merged.set(
        line.productId,
        (merged.get(line.productId) ?? 0) + line.quantity,
      );
    }
    const productRows = await this.db.nightProduct.findMany({
      where: { id: { in: [...merged.keys()] }, storeId: store.id },
      include: {
        catalogProduct: {
          select: { name: true, image: true, price: true, status: true },
        },
      },
    });
    if (productRows.length !== merged.size)
      throw new BadRequestException('存在无效商品，请重新选购');
    const [normalPromotions, seckillPromotions] = await Promise.all([nightPromotions(this.db, productRows.map(row => row.catalogProductId)), nightPromotions(this.db, productRows.map(row => row.catalogProductId), 'seckill')]);
    const seckillProducts = new Set(dto.items.filter(line => line.asSeckill).map(line => line.productId));
    const promotions = new Map(productRows.map(row => {
      const promotion = (seckillProducts.has(row.id) ? seckillPromotions : normalPromotions).get(row.catalogProductId);
      if (seckillProducts.has(row.id) && !promotion) throw new BadRequestException('秒杀活动未开始或已结束，请重新选购');
      if (seckillProducts.has(row.id) && promotion!.id !== dto.items.find(line => line.productId === row.id)!.promotionId) throw new BadRequestException('秒杀活动已变化，请移除后重新选购');
      return [row.catalogProductId, promotion];
    }));
    const lines: NightOrderLine[] = productRows.map((p) => ({
      nightProductId: p.id,
      catalogProductId: p.catalogProductId,
      name: p.catalogProduct.name,
      image: p.catalogProduct.image,
      price: promotions.get(p.catalogProductId)?.price ?? p.catalogProduct.price,
      basePrice: p.catalogProduct.price,
      ...(seckillProducts.has(p.id) ? { asSeckill: true } : {}),
      ...(promotions.get(p.catalogProductId) ? { promotionId: promotions.get(p.catalogProductId)!.id } : {}),
      quantity: merged.get(p.id)!,
    }));
    for (const p of productRows) {
      if (!p.onShelf || !p.saleAllowed)
        throw new BadRequestException(`${p.catalogProduct.name}已下架`);
      if (p.catalogProduct.status !== 'on-sale')
        throw new BadRequestException(`${p.catalogProduct.name}已停售`);
      if (p.stock < merged.get(p.id)!)
        throw new BadRequestException(`${p.catalogProduct.name}库存不足`);
    }
    const productAmount = lines.reduce((s, l) => s + l.price * l.quantity, 0);
    const deliveryFee =
      store.campus.nightDeliveryFee ?? store.campus.deliveryFeeInstant;
    if ((dto.expectedProductAmount !== undefined && dto.expectedProductAmount !== productAmount) || (dto.expectedDeliveryFee !== undefined && dto.expectedDeliveryFee !== deliveryFee)) throw new BadRequestException('商品价格或配送费已变化，请刷新后确认金额');

    if (dto.couponId && lines.some(line => line.promotionId)) throw new BadRequestException('活动价与优惠券不可叠加，请重新选择');
    // 夜宵券校验（businessType=night 强隔离：白天券在夜宵结算不可用）
    const userCoupon = dto.couponId
      ? await this.validateNightCoupon(userId, dto.couponId, store.campusId)
      : null;
    const couponDiscount = userCoupon ? userCoupon.coupon.amount : 0;
    const eligibleAmount = userCoupon?.coupon.nightProductIds.length ? lines.filter(line => userCoupon.coupon.nightProductIds.includes(line.catalogProductId)).reduce((sum, line) => sum + line.price * line.quantity, 0) : productAmount;
    if (userCoupon && (eligibleAmount === 0 || eligibleAmount < userCoupon.coupon.threshold))
      throw new BadRequestException('商品金额未达到夜宵券使用门槛');
    // 无门槛大额券防负数单：抵扣超过商品金额的差额不生效（券不抵配送费，
    // PRD 6.9「券优惠不超过适用商品金额，不找零」）
    const effectiveDiscount = Math.min(couponDiscount, eligibleAmount);
    const payableAmount = productAmount - effectiveDiscount + deliveryFee;

    const order = await this.db.$transaction(async (tx) => {
      const freshStore = await this.inventory.lockStore(tx, store.id);
      // User row serializes quota checks even when the same buyer orders in different stores.
      await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;

      if (dto.requestId) {
        const old = await tx.nightOrder.findUnique({ where: { userId_requestId: { userId, requestId: dto.requestId } } });
        if (old) {
          if (old.requestHash !== requestHash) throw new BadRequestException('下单请求标识已用于其他内容');
          return old;
        }
      }
      if (
        freshStore.status !== 'open' ||
        freshStore.managerStaffId !== store.managerStaffId
      )
        throw new BadRequestException('店铺经营状态已变化，请刷新');
      const currentCampus = await tx.campus.findUniqueOrThrow({ where: { id: store.campusId } });
      this.assertNightWindow(currentCampus);
      if ((currentCampus.nightDeliveryFee ?? currentCampus.deliveryFeeInstant) !== deliveryFee) throw new BadRequestException('配送费已变化，请重新确认金额');
      if (userCoupon) {
        const freshCoupon = await tx.coupon.findUniqueOrThrow({ where: { id: userCoupon.couponId } });
        if ((freshCoupon.expiresAt && freshCoupon.expiresAt <= new Date()) || freshCoupon.amount !== userCoupon.coupon.amount || freshCoupon.threshold !== userCoupon.coupon.threshold || JSON.stringify(freshCoupon.nightProductIds) !== JSON.stringify(userCoupon.coupon.nightProductIds)) throw new BadRequestException('优惠券状态已变化，请重新选择');
        // 下单锁定优惠券：claimed/released -> locked（与白天同构，防并发双占）
        const locked = await tx.userCoupon.updateMany({
          where: {
            id: userCoupon.id,
            userId,
            status: { in: ['claimed', 'released'] },
          },
          data: { status: 'locked' },
        });
        if (!locked.count)
          throw new BadRequestException('优惠券不可用或已被锁定');
      }
      const limited = await tx.product.findMany({ where: { id: { in: lines.map(line => line.catalogProductId) }, purchaseLimit: { not: 'none' } } });
      if (limited.length) {
        const now = new Date();
        const prior = await tx.nightOrder.findMany({ where: { userId, OR: [
          { paidAt: { not: null }, status: { notIn: ['cancelled', 'refunded'] } },
          { status: 'pending-payment' },
        ] }, select: { items: true, paidAt: true, createdAt: true } });
        for (const product of limited) {
          const start = purchaseWindowStart(product.purchaseLimit, now);
          let quantity = lines.filter(line => line.catalogProductId === product.id).reduce((sum, line) => sum + line.quantity, 0);
          for (const old of prior) {
            if ((old.paidAt && old.paidAt < start) || !Array.isArray(old.items)) continue;
            for (const line of old.items as unknown as NightOrderLine[]) if (line.catalogProductId === product.id) quantity += line.quantity;
          }
          if (quantity > product.purchaseLimitQty) throw new BadRequestException(`「${product.name}」已超出本周期限购数量，请调整购物车或先关闭待支付订单`);
        }
      }
      // 条件扣库存：影响行数=0 即超卖竞争失败，整个事务回滚（券锁定一并回滚）
      const stockTxnLines: Array<{
        nightProductId: string;
        delta: number;
        afterStock: number;
      }> = [];
      const [freshNormalPromotions, freshSeckillPromotions] = await Promise.all([nightPromotions(tx, lines.map(line => line.catalogProductId)), nightPromotions(tx, lines.map(line => line.catalogProductId), 'seckill')]);
      for (const line of lines) {
        const current = await tx.nightProduct.findUniqueOrThrow({
          where: { id: line.nightProductId },
          include: { catalogProduct: true },
        });
        const currentPromotion = (line.asSeckill ? freshSeckillPromotions : freshNormalPromotions).get(current.catalogProductId);
        if ((currentPromotion?.id || null) !== (line.promotionId || null) || (currentPromotion?.price ?? current.catalogProduct.price) !== line.price) throw new BadRequestException('商品活动或价格已变化，请刷新');
        if (
          !current.onShelf ||
          !current.saleAllowed ||
          current.catalogProduct.status !== 'on-sale' ||
          current.catalogProduct.price !== (line.basePrice ?? line.price)
        )
          throw new BadRequestException('商品状态或价格已变化，请刷新');
        line.inventoryValue = allocateInventoryValue(
          current.inventoryValue,
          current.stock,
          line.quantity,
        );
        const updated = (await tx.$queryRaw`
          UPDATE "NightProduct" SET stock = stock - ${line.quantity}, "inventoryValue" = "inventoryValue" - ${line.inventoryValue}, "inventoryVersion" = "inventoryVersion" + 1
          WHERE id = ${line.nightProductId} AND stock >= ${line.quantity}
          AND "onShelf" = true AND "saleAllowed" = true
          AND "catalogProductId" IN (SELECT id FROM "Product" WHERE status = 'on-sale' AND price = ${line.basePrice ?? line.price})
          RETURNING stock`) as Array<{ stock: number }>;
        if (!updated.length)
          throw new BadRequestException(`${line.name}库存不足`);
        stockTxnLines.push({
          nightProductId: line.nightProductId,
          delta: -line.quantity,
          afterStock: Number(updated[0].stock),
        });
      }
      const now = new Date();
      const created = await tx.nightOrder.create({
        data: {
          orderNo: nightOrderNo(),
          requestId: dto.requestId ?? null,
          requestHash,
          storeId: store.id,
          managerStaffId: store.managerStaffId,
          userId,
          businessDate: nightBusinessDate(now, store.campus.nightStartAt, store.campus.nightEndAt),
          status: 'pending-payment',
          statusText: STATUS_TEXT['pending-payment'],
          items: json(lines),
          quotaHeld: lines.reduce(
            (sum, line) => sum + (line.inventoryValue ?? 0),
            0,
          ),
          productAmount,
          couponDiscount: effectiveDiscount,
          deliveryFee,
          payableAmount,
          couponId: userCoupon?.id ?? null,
          couponSnapshot: userCoupon
            ? json({
                name: userCoupon.coupon.name,
                amount: userCoupon.coupon.amount,
                threshold: userCoupon.coupon.threshold,
                nightProductIds: userCoupon.coupon.nightProductIds,
              })
            : Prisma.JsonNull,
          commissionRate: store.commissionRate,
          address: json({
            buildingId: address.buildingId,
            buildingName: address.buildingName,
            floor: address.floor,
            room: address.room,
            contactName: address.contactName,
            phone: address.phone,
          }),
          remark: dto.remark ?? '',
          timeline: json([{ key: 'submit', title: '订单已提交' }]),
          timeoutAt: new Date(
            now.getTime() +
              (store.campus.nightPayTimeout ?? DEFAULT_PAY_TIMEOUT_MIN) *
                60 *
                1000,
          ),
        },
      });
      // 下单锁库存流水（saleOut，与关单回补 refundBack 配对——库存恒等式）
      for (const s of stockTxnLines) {
        await tx.nightStockTxn.create({
          data: {
            storeId: store.id,
            nightProductId: s.nightProductId,
            type: 'saleOut',
            delta: s.delta,
            afterStock: s.afterStock,
            refType: 'night-order',
            refId: created.id,
          },
        });
      }
      return created;
    });
    if (order.payableAmount === 0) {
      await this.applyNightOrderPaid(order.orderNo, 'NO_CHARGE');
      return this.myOrder(userId, order.id);
    }
    return this.orderView(order);
  }

  /** 夜宵券校验（下单用）：businessType/校区/有效期/状态强校验。 */
  private async validateNightCoupon(
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
    if (record.coupon.campusId !== campusId)
      throw new BadRequestException('该优惠券不属于当前校区');
    // 券双向隔离（T52）：夜宵订单只能用夜宵券
    if (record.coupon.businessType !== 'night')
      throw new BadRequestException('白天券不可用于夜宵订单');
    if (!['claimed', 'released'].includes(record.status))
      throw new BadRequestException('优惠券当前状态不可使用');
    if (record.coupon.kind === 'partner')
      throw new BadRequestException('异业券不参与下单抵扣');
    if (
      record.coupon.expiresAt &&
      record.coupon.expiresAt.getTime() <= Date.now()
    )
      throw new BadRequestException('优惠券已过期');
    return record;
  }

  /* ==================== 用户端：查询/取消/确认/售后 ==================== */

  /** 懒执行：本人待支付超时单先关单（与支付回调/取消并发互斥靠条件更新）。 */
  private async expireMyPendingOrders(userId: string) {
    const stale = await this.db.nightOrder.findMany({
      where: {
        userId,
        status: 'pending-payment',
        timeoutAt: { lt: new Date() },
      },
      select: { id: true },
      take: 20,
    });
    for (const row of stale)
      await this.closePendingPayment(row.id, '支付超时已关闭');
  }

  async myOrders(userId: string, status?: string) {
    await this.expireMyPendingOrders(userId);
    const rows = await this.db.nightOrder.findMany({
      where: {
        userId,
        ...(status && status !== 'all' ? { status } : {}),
      },
      include: USER_ORDER_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((o) => this.orderView(o));
  }

  async myOrdersPage(userId: string, status?: string, page?: string, pageSize?: string) {
    if (status && status !== 'all' && !(status in STATUS_TEXT)) throw new BadRequestException('订单状态无效');
    await this.expireMyPendingOrders(userId);
    const paging = parsePagination(page, pageSize);
    const where = { userId, ...(status && status !== 'all' ? { status } : {}) };
    const [rows, total] = await Promise.all([
      this.db.nightOrder.findMany({ where, include: USER_ORDER_INCLUDE, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (paging.page - 1) * paging.pageSize, take: paging.pageSize }),
      this.db.nightOrder.count({ where }),
    ]);
    return { items: rows.map(row => this.orderView(row)), total, ...paging };
  }

  async myOrder(userId: string, id: string) {
    await this.expireMyPendingOrders(userId);
    const order = await this.db.nightOrder.findFirst({
      where: { id, userId },
      include: USER_ORDER_INCLUDE,
    });
    if (!order) throw new NotFoundException('订单不存在');
    return this.orderView(order);
  }

  /**
   * 用户取消：未支付直接关单（释放券+回补库存）；已支付未接单走全额原路
   * 退款（券恢复/库存回补/佣金冲销）。接单后不可取消，走售后。
   */
  async cancelByUser(userId: string, id: string, reason?: string) {
    const order = await this.db.nightOrder.findFirst({ where: { id, userId } });
    if (!order) throw new NotFoundException('订单不存在');
    if (order.status === 'pending-payment') {
      await this.closePendingPayment(id, '用户取消');
      return this.myOrder(userId, id);
    }
    if (order.status === 'cancelled') return this.myOrder(userId, id);
    if (!['pending-accept', 'cancelling'].includes(order.status)) throw new BadRequestException('楼长已接单，请联系客服处理售后');
    await this.refunds.request(id, { kind: 'cancel', operatorId: userId, reason: reason || '用户取消' });
    return this.myOrder(userId, id);
  }

  /** 送达确认（用户）：completed + 佣金 estimated → pending。 */
  async confirmOrder(userId: string, id: string) {
    const order = await this.db.nightOrder.findFirst({ where: { id, userId } });
    if (!order) throw new NotFoundException('订单不存在');
    if (order.status !== 'delivered')
      throw new BadRequestException('订单当前状态不可确认收货');
    const won = await this.db.nightOrder.updateMany({
      where: { id, status: 'delivered' },
      data: {
        status: 'completed',
        statusText: STATUS_TEXT.completed,
        completedAt: new Date(),
        quotaHeld: 0,
        timeline: json([
          ...asTimeline(order.timeline),
          { key: 'completed', title: '已完成', time: new Date().toISOString() },
        ]),
      },
    });
    if (!won.count) throw new BadRequestException('订单状态已变化');
    await this.promoteCommissionToPending(id);
    return this.myOrder(userId, id);
  }

  /**
   * 售后申请（一期轻量承载）：写 timeline + afterSaleStatus=requested。
   * requested 期间该单佣金不得转 pending（「无进行中售后」判定）；
   * 实际退款由后台 /admin/night/orders/:id/refund 完成（回写 resolved）。
   */
  async applyAfterSale(
    userId: string,
    id: string,
    body: {
      type: string;
      description: string;
      images?: string[];
      productIds?: string[];
    },
  ) {
    if (body.description.trim().length < 5 || body.description.length > 300 || (body.images?.length ?? 0) > 6 || body.images?.some(url => !/^https?:\/\//.test(url))) throw new BadRequestException('请填写5至300字售后说明，并上传最多6张有效图片');
    const order = await this.db.nightOrder.findFirst({ where: { id, userId } });
    if (!order) throw new NotFoundException('订单不存在');
    if (!['delivered', 'completed'].includes(order.status))
      throw new BadRequestException('当前状态不可申请售后');
    const deliveredAt = order.completedAt || [...asTimeline(order.timeline)].reverse().find(step => step.key === 'completed' || step.key === 'delivered')?.time || order.paidAt;
    if (!deliveredAt || Date.now() - new Date(deliveredAt).getTime() > 24 * 60 * 60 * 1000) throw new BadRequestException('已超过送达后24小时售后期限');
    const selected = body.productIds ?? [];
    if (new Set(selected).size !== selected.length) throw new BadRequestException('退款商品不可重复');
    const lines = order.items as unknown as NightOrderLine[];
    const selectedLines = selected.map(productId => {
      const line = lines.find(item => item.nightProductId === productId);
      if (!line) throw new BadRequestException('退款商品不属于本订单');
      return line;
    });
    const requestedAmount = selectedLines.length ? selectedLines.reduce((amount, line) => amount + line.price * line.quantity, 0) : order.payableAmount - order.deliveryFee;
    if (requestedAmount < 0 || requestedAmount > order.payableAmount - order.deliveryFee) throw new BadRequestException('退款金额超过实付商品金额');
    const updated = await this.db.nightOrder.updateMany({
      where: { id, status: order.status, afterSaleStatus: null },
      data: {
        afterSaleStatus: 'requested',
        timeline: json([
          ...asTimeline(order.timeline),
          {
            key: 'after-sale',
            title: '用户申请售后',
            description: `${body.type}：${body.description.trim()}`,
            images: body.images ?? [],
            productIds: selected,
            requestedAmount,
            requestedItems: selectedLines.map(line => ({ productId: line.nightProductId, name: line.name, quantity: line.quantity })),
            time: new Date().toISOString(),
          },
        ]),
      },
    });
    if (!updated.count)
      throw new BadRequestException('售后申请已存在，请等待处理');
    return { id, afterSaleStatus: 'requested' };
  }

  async myAfterSales(userId: string, page?: string, pageSize?: string) {
    const paging = parsePagination(page, pageSize);
    const where: Prisma.NightOrderWhereInput = { userId, OR: [{ afterSaleStatus: { not: null } }, { refund: { isNot: null } }] };
    const [rows, total, refunded] = await Promise.all([
      this.db.nightOrder.findMany({ where, include: USER_ORDER_INCLUDE, orderBy: { createdAt: 'desc' }, skip: (paging.page - 1) * paging.pageSize, take: paging.pageSize }),
      this.db.nightOrder.count({ where }),
      this.db.nightRefund.aggregate({ where: { order: { userId }, status: 'succeeded' }, _sum: { totalAmount: true } }),
    ]);
    return { items: rows.map(order => this.orderView(order)), total, refundedAmount: refunded._sum.totalAmount || 0, ...paging };
  }

  async withdrawAfterSale(userId: string, id: string) {
    const raw = await this.db.nightOrder.findFirst({ where: { id, userId } });
    if (!raw) throw new NotFoundException('订单不存在');
    return this.db.$transaction(async tx => {
      await this.inventory.lockStore(tx, raw.storeId);
      const order = await tx.nightOrder.findUniqueOrThrow({ where: { id } });
      if (order.afterSaleStatus !== 'requested') throw new BadRequestException('当前售后状态不可撤销');
      const result = await tx.nightOrder.updateMany({ where: { id, userId, afterSaleStatus: 'requested' }, data: {
        afterSaleStatus: 'withdrawn',
        timeline: json([...asTimeline(order.timeline), { key: 'after-sale-withdrawn', title: '用户撤销售后申请', time: new Date().toISOString() }]),
      } });
      if (!result.count) throw new BadRequestException('售后状态已变化，请刷新');
      if (order.status === 'completed') await tx.nightCommissionTxn.updateMany({ where: { orderId: id, status: 'estimated' }, data: { status: 'pending' } });
      return { id, afterSaleStatus: 'withdrawn' };
    });
  }

  async rejectAfterSale(operatorId: string, id: string, reason: string) {
    if (!reason.trim()) throw new BadRequestException('请填写售后审核说明');
    const raw = await this.db.nightOrder.findUniqueOrThrow({ where: { id } });
    await this.db.$transaction(async tx => {
      const store = await this.inventory.lockStore(tx, raw.storeId);
      const order = await tx.nightOrder.findUniqueOrThrow({ where: { id } });
      if (order.afterSaleStatus !== 'requested') throw new BadRequestException('售后状态已变化，请刷新');
      await tx.nightOrder.update({ where: { id }, data: { afterSaleStatus: 'rejected', timeline: json([...asTimeline(order.timeline), { key: 'after-sale-review', title: '售后审核未通过', description: reason.trim(), time: new Date().toISOString() }]) } });
      if (order.status === 'completed') await tx.nightCommissionTxn.updateMany({ where: { orderId: id, status: 'estimated' }, data: { status: 'pending' } });
      await tx.auditLog.create({ data: { campusId: store.campusId, operator: operatorId, action: 'night.after-sale.reject', entityType: 'night-order', entityId: id, after: { reason } } });
      await tx.notification.create({ data: { userId: order.userId, businessType: 'night', orderId: order.id, type: 'order', title: '夜宵售后审核结果', content: reason.trim() } });
    });
    return this.adminOrderDetail(id);
  }

  /* ==================== 楼长端：接单/送达 ==================== */

  async acceptOrder(staffId: string, storeId: string, id: string) {
    const order = await this.db.nightOrder.findUnique({ where: { id } });
    if (!order) throw new NotFoundException('订单不存在');
    if (order.storeId !== storeId) throw new ForbiddenException('非本店订单');
    if (order.managerStaffId !== staffId) throw new ForbiddenException('非本人经营订单');
    if (order.afterSaleStatus === 'refund-processing') throw new BadRequestException('退款正在核对，暂不可接单');
    if (order.status !== 'pending-accept')
      throw new BadRequestException('当前状态不可接单');
    const won = await this.db.nightOrder.updateMany({
      where: { id, status: 'pending-accept', OR: [{ afterSaleStatus: null }, { afterSaleStatus: { not: 'refund-processing' } }] },
      data: {
        status: 'delivering',
        statusText: STATUS_TEXT.delivering,
        timeline: json([
          ...asTimeline(order.timeline),
          {
            key: 'accepted',
            title: '楼长已接单',
            time: new Date().toISOString(),
          },
        ]),
      },
    });
    if (!won.count) throw new BadRequestException('订单状态已变化');
    await this.db.notification.create({
      data: {
        userId: order.userId, businessType: 'night', orderId: order.id,
        type: 'order',
        title: '夜宵订单已接单',
        content: `订单 ${order.orderNo} 楼长已接单，正在为你配送。`,
      },
    });
    return { id, status: 'delivering' };
  }

  async deliverOrder(
    staffId: string,
    storeId: string,
    id: string,
    proof: { images: string[]; remark?: string },
  ) {
    if (
      !proof?.images?.length ||
      proof.images.some((url) => !/^https?:\/\//.test(url))
    )
      throw new BadRequestException('请上传有效的送达照片');
    await this.db.$transaction(async (tx) => {
      await this.inventory.lockStore(tx, storeId, staffId);
      const order = await tx.nightOrder.findUnique({ where: { id } });
      if (!order) throw new NotFoundException('订单不存在');
      if (order.storeId !== storeId) throw new ForbiddenException('非本店订单');
      if (order.managerStaffId !== staffId)
        throw new ForbiddenException('非本人经营订单');
      if (order.afterSaleStatus === 'refund-processing') throw new BadRequestException('退款正在核对，暂不可送达');
      if (order.status === 'completed') return;
      if (order.status !== 'delivering')
        throw new BadRequestException('当前状态不可标记送达');
      const won = await tx.nightOrder.updateMany({
        where: { id, status: 'delivering' },
        data: {
          status: 'completed',
          statusText: STATUS_TEXT.completed,
          completedAt: new Date(),
          quotaHeld: 0,
          timeline: json([
            ...asTimeline(order.timeline),
            {
              key: 'completed',
              title: '已送达并完成',
              time: new Date().toISOString(),
              proof,
              operatorId: staffId,
            },
          ]),
        },
      });
      if (!won.count) throw new BadRequestException('订单状态已变化');
      if (order.afterSaleStatus !== 'requested')
        await tx.nightCommissionTxn.updateMany({
          where: { orderId: id, status: 'estimated' },
          data: { status: 'pending' },
        });
      await tx.notification.create({
        data: {
          userId: order.userId, businessType: 'night', orderId: order.id,
          type: 'delivery',
          title: '夜宵订单已送达',
          content: `订单 ${order.orderNo} 已送达并完成，可在订单详情查看。`,
        },
      });
    });
    return { id, status: 'completed' };
  }

  /* ==================== 支付 ==================== */

  /** 夜宵订单微信支付下单（复用 payments JSAPI 通道，业务标记 YX 单号）。 */
  async prepayOrder(userId: string, orderId: string) {
    const order = await this.db.nightOrder.findFirst({
      where: { id: orderId, userId },
      include: { store: { select: { campusId: true } } },
    });
    if (!order) throw new NotFoundException('订单不存在');
    if (order.status !== 'pending-payment')
      throw new BadRequestException('当前状态不可支付');
    const user = await this.db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { openid: true },
    });
    if (!user.openid)
      throw new BadRequestException('当前用户无微信 openid，无法发起支付');
    const payParams = await this.payments.nightPrepay({
      campusId: order.store.campusId,
      outTradeNo: order.orderNo,
      amount: order.payableAmount,
      openid: user.openid,
      description: `夜宵订单 ${order.orderNo}`,
      expectedMerchantId: order.payMerchantId ?? undefined,
      expectedAppId: order.payAppId ?? undefined,
    });
    if (payParams.merchantId) await this.db.nightOrder.update({ where: { id: order.id }, data: { payMerchantId: payParams.merchantId, payAppId: payParams.appId } });
    const { merchantId: _merchant, ...clientParams } = payParams;
    return {
      orderId: order.id,
      orderNo: order.orderNo,
      amount: order.payableAmount,
      payParams: clientParams,
    };
  }

  /** 支付结果轮询兜底：超 30 秒未收到回调时主动向微信查单落账。 */
  async orderPayStatus(userId: string, orderId: string) {
    let order = await this.db.nightOrder.findFirst({
      where: { id: orderId, userId },
    });
    if (!order) throw new NotFoundException('订单不存在');
    if (
      order.status === 'pending-payment' &&
      Date.now() - order.createdAt.getTime() > 30_000
    ) {
      try {
        const store = await this.db.nightStore.findUnique({
          where: { id: order.storeId },
          select: { campusId: true },
        });
        const trade = await this.payments.nightTradeState(
          order.orderNo,
          store?.campusId ?? '',
        );
        if (trade.tradeState === 'SUCCESS')
          await this.applyNightOrderPaid(order.orderNo, trade.transactionId);
        order =
          (await this.db.nightOrder.findUnique({ where: { id: order.id } })) ??
          order;
      } catch {
        // 查单/落账失败不阻塞状态返回
      }
    }
    return {
      orderId: order.id,
      orderNo: order.orderNo,
      status: order.status,
      statusText: order.statusText,
      paid: order.paidAt != null,
    };
  }

  /**
   * 夜宵订单支付落账（回调 + 查单兜底共用，幂等）：
   * pending-payment → pending-accept；券 locked → used；佣金流水两条
   * （commission=券后基数×比例快照 / deliveryFee=配送费全额）status=estimated；
   * 触发楼长新单推送（复用履约端订阅链，fire-and-forget）。
   * 库存已于下单扣减，此处只确认不再重复扣。
   */
  async applyNightOrderPaid(orderNo: string, transactionId?: string) {
    await this.db.$transaction(async (tx) => {
      const order = await tx.nightOrder.findUnique({ where: { orderNo } });
      if (!order) throw new NotFoundException('夜宵订单不存在');
      if (order.paidAt) return;
      // 幂等：已支付直接返回（重复回调/并发回调只生效一次）
      if (order.status !== 'pending-payment') {
        if (order.status === 'cancelled') {
          // 超时关单后微信才扣款成功：不复活店铺/订单（PRD 6.2），转异常单
          // 冻结现场待客服退款——条件更新防重复通知
          const frozen = await tx.nightOrder.updateMany({
            where: { id: order.id, status: 'cancelled' },
            data: {
              status: 'exception',
              statusText: '支付已收到但订单已关闭，请联系客服处理',
              paidAt: new Date(),
              wxTransactionId: transactionId,
            },
          });
          if (frozen.count)
            await tx.notification.create({
              data: {
                userId: order.userId, businessType: 'night', orderId: order.id,
                type: 'order',
                title: '夜宵订单异常提醒',
                content: `订单 ${order.orderNo} 支付已收到但订单已超时关闭，客服会尽快处理退款，请勿重复支付。`,
              },
            });
        }
        return;
      }
      const store = await tx.nightStore.findUnique({
        where: { id: order.storeId },
        include: {
          building: { select: { name: true } },
          campus: { select: { nightAcceptTimeout: true } },
        },
      });
      const paidAt = new Date();
      const won = await tx.nightOrder.updateMany({
        where: { id: order.id, status: 'pending-payment' },
        data: {
          status: 'pending-accept',
          statusText: STATUS_TEXT['pending-accept'],
          paidAt,
          timeoutAt: new Date(paidAt.getTime() + (store?.campus.nightAcceptTimeout ?? 30) * 60_000),
          wxTransactionId: transactionId,
          timeline: json([
            ...asTimeline(order.timeline),
            { key: 'paid', title: '支付成功', time: new Date().toISOString() },
          ]),
        },
      });
      if (!won.count) return; // 并发竞争败者直接退出（幂等）
      if (order.couponId) {
        const used = await tx.userCoupon.updateMany({
          where: { id: order.couponId, status: 'locked' },
          data: { status: 'used' },
        });
        if (used.count) {
          const holding = await tx.userCoupon.findUniqueOrThrow({
            where: { id: order.couponId },
            select: { couponId: true },
          });
          await tx.coupon.update({
            where: { id: holding.couponId },
            data: { used: { increment: 1 } },
          });
        }
      }
      // 佣金流水两条（estimated）：商品佣金（券后基数×比例快照）+ 配送费全额
      const managerId = order.managerStaffId ?? '';
      const base = order.productAmount - order.couponDiscount;
      await tx.nightCommissionTxn.createMany({
        data: [
          {
            orderId: order.id,
            storeId: order.storeId,
            managerStaffId: managerId,
            type: 'commission',
            base,
            rate: order.commissionRate,
            amount: commissionOf(base, order.commissionRate),
            status: 'estimated',
            remark: '商品佣金（券后净实收×比例快照）',
          },
          {
            orderId: order.id,
            storeId: order.storeId,
            managerStaffId: managerId,
            type: 'deliveryFee',
            base: null,
            rate: null,
            amount: order.deliveryFee,
            status: 'estimated',
            remark: '夜间配送费收入（全额）',
          },
        ],
      });
      await tx.notification.create({
        data: {
          userId: order.userId, businessType: 'night', orderId: order.id,
          type: 'order',
          title: '夜宵订单支付成功',
          content: `订单 ${order.orderNo} 支付成功，楼长即将接单配送。`,
        },
      });
      // 楼长新单推送：fire-and-forget（复用履约端订阅消息链），不进事务
      if (store?.managerStaffId && this.push) {
        void this.push.notifyNightManagerNewOrder({
          staffId: store.managerStaffId,
          campusId: store.campusId,
          orderNo: order.orderNo,
          amountFen: order.payableAmount,
          buildingName: store.building.name,
        });
      }
    });
  }

  /**
   * 楼长押金缴纳落账（回调 + 查单兜底共用，幂等）：
   * NightDepositOrder pending/closed → paid；写 NightDepositTxn(deposit)
   * + NightStore.deposit 原子增加。重复回调只落账一次。
   */
  async applyNightDepositPaid(outTradeNo: string, transactionId?: string) {
    await this.db.$transaction(async (tx) => {
      const intent = await tx.nightDepositOrder.findUnique({
        where: { outTradeNo },
      });
      if (!intent) throw new NotFoundException('押金支付单不存在');
      // 幂等：条件抢占 paid 位，败者直接返回
      const won = await tx.nightDepositOrder.updateMany({
        where: { id: intent.id, status: { not: 'paid' } },
        data: { status: 'paid', paidAt: new Date(), wxTransactionId: transactionId },
      });
      if (!won.count) return;
      await tx.nightDepositTxn.create({
        data: {
          storeId: intent.storeId,
          type: 'deposit',
          amount: intent.amount,
          payOrderNo: intent.outTradeNo,
          remark: `押金缴纳至 ${intent.targetTier / 100} 元档`,
        },
      });
      await tx.nightStore.update({
        where: { id: intent.storeId },
        data: { deposit: { increment: intent.amount } },
      });
    });
  }

  /* ==================== 退款（后台 + 用户取消共用通道） ==================== */

  /** 网关结果持久化，成功后才结算库存/券/佣金；处理中可重复调用核对原申请。 */
  async adminRefund(operatorId: string, orderId: string, body: NightRefundDto) {
    const request = await this.refunds.request(orderId, { kind: 'admin', operatorId, productAmount: body.productRefund, refundDeliveryFee: body.refundDeliveryFee, restock: body.restock, reason: body.reason });
    const order = await this.db.nightOrder.findUniqueOrThrow({ where: { id: orderId } });
    return { id: orderId, refundId: request.id, refundStatus: request.status, refundAmount: request.totalAmount, fullRefund: request.totalAmount === order.payableAmount, message: request.errorMessage };
  }

  async reconcilePendingRefunds(limit = 50) { return this.refunds.reconcileDue(limit); }
  async reconcilePendingDepositRefunds(limit = 50) { return new NightDepositRefundService(this.db, this.payments, this.inventory).reconcileDue(limit); }

  async syncRefund(orderId: string) {
    const request = await this.db.nightRefund.findUnique({ where: { orderId } });
    if (!request) throw new BadRequestException('该订单尚未申请退款');
    await this.refunds.reconcile(request.id);
    return this.adminOrderDetail(orderId);
  }

  async settlementCampusIds(batch: string) {
    const rows = await this.db.nightCommissionTxn.findMany({ where: { settleBatch: batch }, select: { store: { select: { campusId: true } } }, distinct: ['storeId'] });
    if (!rows.length) throw new NotFoundException('批次不存在');
    return [...new Set(rows.map(row => row.store.campusId))];
  }

  private async finalizeRefund(tx: Tx, request: NightRefund) {
    const order = await tx.nightOrder.findUniqueOrThrow({ where: { id: request.orderId } });
    const productPaid = order.productAmount - order.couponDiscount;
    const productsReturned = request.fullProductRefund;
    const fullRefund = request.totalAmount === order.payableAmount;
    const timeline = asTimeline(order.timeline);
    if (timeline.some(step => step.key === 'refund' && (step as NightTimelineStep & {refundId?: string}).refundId === request.id)) return;
    const status = request.kind === 'cancel' ? 'cancelled' : productsReturned ? 'refunded' : request.originalStatus;
    await tx.nightOrder.update({ where: { id: order.id }, data: {
      status,
      statusText: request.kind === 'cancel' ? '已取消并退款' : productsReturned && !fullRefund ? '商品已退款，配送费保留' : STATUS_TEXT[status] || order.statusText,
      afterSaleStatus: 'resolved',
      timeline: json([...timeline, { key: 'refund', title: '退款已到账 ¥' + (request.totalAmount / 100).toFixed(2), time: new Date().toISOString(), refundId: request.id, productRefund: request.productAmount, feeRefund: request.deliveryFeeAmount }]),
    } });
    if (request.restock && productsReturned) {
      await this.releaseOrderResources(tx, order);
    } else if (productsReturned && order.quotaHeld > 0) {
      if (!order.managerStaffId) throw new BadRequestException('订单缺少原经营者，请核对');
      const items = (order.items as unknown as NightOrderLine[]).map(line => ({
        nightProductId: line.nightProductId, name: line.name, quantity: line.quantity, delta: 0,
        value: line.inventoryValue ?? line.price * line.quantity,
        unitValue: (line.inventoryValue ?? line.price * line.quantity) / line.quantity, bookQuantity: line.quantity,
      }));
      await tx.nightInventoryReport.create({ data: {
        storeId: order.storeId, managerStaffId: order.managerStaffId, kind: 'order-loss', requestId: 'refund-' + order.id, items: json(items), heldValue: order.quotaHeld, reason: '订单退款未回库：' + request.reason,
      } });
      await tx.nightOrder.update({ where: { id: order.id }, data: { quotaHeld: 0 } });
    }
    if (request.kind === 'cancel') await this.reverseCommission(tx, order.id, '订单取消退款成功冲销');
    else await this.adjustCommissionOnRefund(tx, order, request.productAmount, request.deliveryFeeAmount);
    if (productsReturned && order.couponId) await tx.userCoupon.updateMany({ where: { id: order.couponId, status: 'used' }, data: { status: 'released' } });
    // 商品全退但保留配送费时，保留部分应进入待结算，不遗留在预计收入中。
    if (request.kind !== 'cancel' && productsReturned) await tx.nightCommissionTxn.updateMany({ where: { orderId: order.id, status: 'estimated' }, data: { status: 'pending' } });
    await tx.notification.create({ data: { userId: order.userId, businessType: 'night', orderId: order.id, type: 'refund', title: request.kind === 'cancel' ? '夜宵订单已取消并退款' : '夜宵退款已完成', content: '订单 ' + order.orderNo + ' 已退款 ¥' + (request.totalAmount / 100).toFixed(2) + '。' } });
  }

  /** 佣金退款联动（PRD 6.6/T19/T20）：重算 adjust + 配送费 clawback。 */
  private async adjustCommissionOnRefund(
    tx: Tx,
    order: {
      id: string;
      productAmount: number;
      couponDiscount: number;
      deliveryFee: number;
      commissionRate: number;
      storeId: string;
      managerStaffId: string | null;
    },
    productRefund: number,
    feeRefund: number,
  ) {
    const managerId = order.managerStaffId ?? '';
    const originals = await tx.nightCommissionTxn.findMany({
      where: {
        orderId: order.id,
        type: { in: ['commission', 'deliveryFee'] },
        // 冲销行（负向）不作为重算基准
        amount: { gte: 0 },
      },
    });
    const commissionRow = originals.find((r) => r.type === 'commission');
    if (commissionRow && productRefund > 0) {
      const newBase =
        order.productAmount - order.couponDiscount - productRefund;
      const newAmount = commissionOf(newBase, order.commissionRate);
      const delta = newAmount - commissionRow.amount;
      if (delta !== 0) {
        await tx.nightCommissionTxn.create({
          data: {
            orderId: order.id,
            storeId: order.storeId,
            managerStaffId: managerId,
            type: 'commission',
            base: newBase,
            rate: order.commissionRate,
            amount: delta, // 负向调整（跨期冲回）
            status: commissionRow.status === 'settled' ? 'pending' : commissionRow.status,
            settleBatch: null,
            remark: `退款重算：基数 ${newBase}，应得 ${newAmount}，调整 ${delta}`,
          },
        });
      }
    }
    const feeRow = originals.find(row => row.type === 'deliveryFee');
    if (feeRefund > 0 && feeRow) {
      await tx.nightCommissionTxn.create({
        data: {
          orderId: order.id,
          storeId: order.storeId,
          managerStaffId: managerId,
          type: 'deliveryFee',
          base: null,
          rate: null,
          amount: -feeRefund, // clawback：配送费退款同步冲回（V1.5 修订项 3）
          status: feeRow?.status === 'estimated' ? 'estimated' : 'pending',
          remark: '配送费退款冲回（clawback）',
        },
      });
    }
  }

  /** 订单取消冲销预计佣金（取消不形成佣金，PRD 6.2）。 */
  private async reverseCommission(tx: Tx, orderId: string, remark: string) {
    const originals = await tx.nightCommissionTxn.findMany({
      where: { orderId, amount: { gt: 0 } },
    });
    if (!originals.length) return;
    await tx.nightCommissionTxn.createMany({
      data: originals.map((r) => ({
        orderId,
        storeId: r.storeId,
        managerStaffId: r.managerStaffId,
        type: r.type,
        base: r.base,
        rate: r.rate,
        amount: -r.amount,
        status: r.status,
        settleBatch: r.settleBatch,
        remark: `${remark}（冲销 ${r.remark}）`,
      })),
    });
  }

  /**
   * 订单完成且无进行中售后 → 佣金 estimated → pending（PRD B13）。
   * 用户确认收货与自动完成 Cron 共用。
   */
  async promoteCommissionToPending(orderId: string) {
    const order = await this.db.nightOrder.findUnique({
      where: { id: orderId },
      select: { afterSaleStatus: true, status: true },
    });
    if (!order) return;
    if (['requested', 'refund-processing'].includes(order.afterSaleStatus || '')) return;
    await this.db.nightCommissionTxn.updateMany({
      where: { orderId, status: 'estimated' },
      data: { status: 'pending' },
    });
  }

  /* ==================== 超时关单 / 自动完成（Cron 与懒执行共用） ==================== */

  /** 待支付超时关单：释放券 + 回补库存（条件更新与支付/取消互斥）。 */
  async closePendingPayment(orderId: string, reason: string) {
    const target = await this.db.nightOrder.findUnique({
      where: { id: orderId },
    });
    if (!target) return;
    await this.db.$transaction(async (tx) => {
      await this.inventory.lockStore(tx, target.storeId);
      const order = await tx.nightOrder.findUnique({ where: { id: orderId } });
      if (!order || order.status !== 'pending-payment') return;
      const closed = await tx.nightOrder.updateMany({
        where: { id: orderId, status: 'pending-payment' },
        data: {
          status: 'cancelled',
          statusText: reason,
          cancelReason: reason,
          timeline: json([
            ...asTimeline(order.timeline),
            { key: 'cancel', title: reason, time: new Date().toISOString() },
          ]),
        },
      });
      if (!closed.count) return;
      await this.releaseOrderResources(tx, order);
    });
  }

  /** 关单资源释放：券 locked → released；库存逐行回补（refundBack 流水）。 */
  private async releaseOrderResources(
    tx: Tx,
    order: {
      id: string;
      storeId: string;
      couponId: string | null;
      items: Prisma.JsonValue;
    },
  ) {
    if (order.couponId) {
      await tx.userCoupon.updateMany({
        where: { id: order.couponId, status: 'locked' },
        data: { status: 'released' },
      });
    }
    const lines = order.items as unknown as NightOrderLine[];
    const restored = await tx.nightOrder.updateMany({
      where: { id: order.id, inventoryRestocked: false },
      data: { inventoryRestocked: true, quotaHeld: 0 },
    });
    if (!restored.count) return;
    for (const line of lines) {
      const updated = await tx.nightProduct.updateMany({
        where: { id: line.nightProductId },
        data: {
          stock: { increment: line.quantity },
          inventoryValue: {
            increment: line.inventoryValue ?? line.price * line.quantity,
          },
          inventoryVersion: { increment: 1 },
        },
      });
      if (updated.count) {
        const fresh = await tx.nightProduct.findUniqueOrThrow({
          where: { id: line.nightProductId },
          select: { stock: true },
        });
        await tx.nightStockTxn.create({
          data: {
            storeId: order.storeId,
            nightProductId: line.nightProductId,
            type: 'refundBack',
            delta: line.quantity,
            afterStock: fresh.stock,
            refType: 'night-order',
            refId: order.id,
            remark: '订单关闭回补库存',
          },
        });
      }
    }
  }

  /** 送达超时自动完成（Cron 调用）：24h 未确认 → completed + 佣金转 pending。 */
  async autoCompleteDelivered(limit = 50): Promise<number> {
    const due = Date.now() - AUTO_COMPLETE_HOURS * 3600 * 1000;
    const orders = await this.db.nightOrder.findMany({
      where: { status: 'delivered' },
      select: { id: true, timeline: true },
      take: limit,
      orderBy: { createdAt: 'asc' },
    });
    let total = 0;
    for (const order of orders) {
      const steps = asTimeline(order.timeline);
      const deliveredAt = steps.find((s) => s.key === 'delivered')?.time;
      if (!deliveredAt || new Date(deliveredAt).getTime() > due) continue;
      const won = await this.db.nightOrder.updateMany({
        where: { id: order.id, status: 'delivered' },
        data: {
          status: 'completed',
          statusText: '超时自动确认',
          completedAt: new Date(),
          timeline: json([
            ...steps,
            {
              key: 'completed',
              title: '超时自动确认',
              time: new Date().toISOString(),
            },
          ]),
        },
      });
      if (won.count) {
        total++;
        await this.promoteCommissionToPending(order.id);
      }
    }
    return total;
  }

  /* ==================== 后台：订单查询 / 结算 ==================== */

  async adminOrders(campusId: string, filters: { storeId?: string; status?: string; date?: string }) {
    return (await this.adminOrdersPage(campusId, filters, '1', '100')).items;
  }

  async adminOrdersPage(campusId: string, filters: { storeId?: string; status?: string; date?: string; keyword?: string; afterSaleStatus?: string }, page?: string, pageSize?: string) {
    if (filters.status && !Object.keys(STATUS_TEXT).includes(filters.status)) throw new BadRequestException('订单状态无效');
    if (filters.date && !/^\\d{4}-\\d{2}-\\d{2}$/.test(filters.date)) throw new BadRequestException('营业日格式无效');
    if (filters.afterSaleStatus && !['requested', 'refund-processing', 'resolved', 'rejected', 'withdrawn'].includes(filters.afterSaleStatus)) throw new BadRequestException('售后状态无效');
    const keyword = filters.keyword?.trim().slice(0, 80);
    const where: Prisma.NightOrderWhereInput = {
      store: { ...(campusId ? { campusId } : {}) },
      ...(filters.storeId ? { storeId: filters.storeId } : {}),
      ...(filters.status ? { status: filters.status } : {}),
      ...(filters.date ? { businessDate: filters.date } : {}),
      ...(filters.afterSaleStatus ? { afterSaleStatus: filters.afterSaleStatus } : {}),
      ...(keyword ? { OR: [
        { orderNo: { contains: keyword } }, { user: { nickname: { contains: keyword } } }, { user: { phone: { contains: keyword } } },
        { address: { path: ['buildingName'], string_contains: keyword } }, { address: { path: ['room'], string_contains: keyword } },
      ] } : {}),
    };
    const paging = parsePagination(page, pageSize);
    const [rows, total] = await Promise.all([
      this.db.nightOrder.findMany({ where, include: { refund: true, store: { include: { building: { select: { name: true } } } }, user: { select: { id: true, nickname: true, phone: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (paging.page - 1) * paging.pageSize, take: paging.pageSize }),
      this.db.nightOrder.count({ where }),
    ]);
    return { items: rows.map(o => ({ ...this.orderView(o), user: o.user })), total, ...paging };
  }

  async adminOrderDetail(id: string) {
    const order = await this.db.nightOrder.findUnique({
      where: { id },
      include: {
        refund: true,
        store: {
          include: {
            building: { select: { name: true } },
            managerStaff: { select: { id: true, name: true, staffNo: true } },
          },
        },
        commissionTxns: true,
        user: { select: { id: true, nickname: true, phone: true } },
      },
    });
    if (!order) throw new NotFoundException('订单不存在');
    return {
      ...this.orderView(order),
      user: order.user,
      manager: order.store.managerStaff,
      commissionTxns: order.commissionTxns,
    };
  }

  /**
   * 周账单出账：范围内 pending（待结算）佣金流水 → settled + settleBatch。
   * estimated（未完成订单）不进批次（PRD B13：完成且无进行中售后才可结算）。
   */
  async settleBatch(campusId: string, storeIds?: string[]) {
    if (storeIds?.length) {
      const allowed = await this.db.nightStore.count({ where: { id: { in: [...new Set(storeIds)] }, ...(campusId ? { campusId } : {}) } });
      if (allowed !== new Set(storeIds).size) throw new ForbiddenException('结算店铺不属于当前校区或不存在');
    }
    const scope = storeIds?.length
      ? storeIds
      : (
          await this.db.nightStore.findMany({
            where: { campusId },
            select: { id: true },
          })
        ).map((s) => s.id);
    if (!scope.length) throw new BadRequestException('范围内没有夜宵店');
    const batch = `NW${beijingDate().replace(/-/g, '')}${Math.random()
      .toString(36)
      .slice(2, 6)
      .toUpperCase()}`;
    const result = await this.db.nightCommissionTxn.updateMany({
      where: {
        storeId: { in: scope },
        status: 'pending',
        settleBatch: null,
        order: { OR: [{ afterSaleStatus: null }, { afterSaleStatus: { notIn: ['requested', 'refund-processing'] } }] },
      },
      data: { status: 'settled', settleBatch: batch },
    });
    const rows = await this.db.nightCommissionTxn.findMany({
      where: { settleBatch: batch },
    });
    return {
      batch,
      txnCount: result.count,
      commissionTotal: rows
        .filter((r) => r.type === 'commission')
        .reduce((s, r) => s + r.amount, 0),
      deliveryFeeTotal: rows
        .filter((r) => r.type === 'deliveryFee')
        .reduce((s, r) => s + r.amount, 0),
    };
  }

  /** 数据库按批次聚合全部流水，不按最近1000笔截断财务汇总。 */
  async settlements(campusId: string) {
    const rows = await this.db.$queryRaw<Array<{ batch: string; txnCount: number; commissionTotal: bigint; deliveryFeeTotal: bigint; latestAt: Date; markedPaid: boolean }>>`
      SELECT t."settleBatch" AS batch, COUNT(*)::int AS "txnCount",
        COALESCE(SUM(CASE WHEN t.type = 'commission' THEN t.amount ELSE 0 END), 0) AS "commissionTotal",
        COALESCE(SUM(CASE WHEN t.type = 'deliveryFee' THEN t.amount ELSE 0 END), 0) AS "deliveryFeeTotal",
        MAX(t."createdAt") AS "latestAt",
        BOOL_AND(position(' | 已打款 ' in t.remark) > 0) AS "markedPaid"
      FROM "NightCommissionTxn" t JOIN "NightStore" s ON s.id = t."storeId"
      WHERE s."campusId" = ${campusId} AND t.status = 'settled' AND t."settleBatch" IS NOT NULL
      GROUP BY t."settleBatch" ORDER BY MAX(t."createdAt") DESC, t."settleBatch" DESC`;
    return rows.map(row => ({ ...row, commissionTotal: Number(row.commissionTotal), deliveryFeeTotal: Number(row.deliveryFeeTotal), latestAt: row.latestAt.toISOString() }));
  }

  /** 仅登记财务已在线下完成打款；沿用既有备注，批次串行且重复登记不再追加。 */
  async markBatchPaid(batch: string, operatorId: string, remark: string) {
    return this.db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'night-settlement:' + batch}))`;
      const list = await tx.nightCommissionTxn.findMany({ where: { settleBatch: batch, status: 'settled' }, select: { id: true, remark: true, store: { select: { campusId: true } } } });
      if (!list.length) throw new NotFoundException('批次不存在或无已结算流水');
      const outstanding = list.filter(row => !row.remark.includes(' | 已打款 '));
      if (!outstanding.length) return { batch, txnCount: list.length, alreadyPaid: true };
      const stamp = ` | 已打款 ${new Date().toISOString()} by ${operatorId}${remark.trim() ? ' ' + remark.trim().slice(0, 100) : ''}`;
      await tx.$executeRaw`UPDATE "NightCommissionTxn" SET remark = LEFT(remark, ${Math.max(0, 500 - stamp.length)}::int) || ${stamp} WHERE "settleBatch" = ${batch} AND status = 'settled' AND position(' | 已打款 ' in remark) = 0`;
      for (const campusId of new Set(list.map(row => row.store.campusId))) await tx.auditLog.create({ data: { campusId, operator: operatorId, action: 'night.settlement.markPaid', entityType: 'night-settlement', entityId: batch, after: { txnCount: outstanding.length, remark: remark.trim().slice(0, 100) } } });
      return { batch, txnCount: list.length, alreadyPaid: false };
    }, { timeout: 60000 });
  }

  /* ==================== 押金支付单（楼长端发起） ==================== */

  /**
   * 发起押金缴纳：按 500 元档递增补缴（下一档 − 当前余额 = 本次缴纳额）。
   * 生成 ND 前缀微信支付单（幂等：旧 pending 单直接复用其单号重新预下单）。
   */
  async initiateDepositPay(
    storeId: string,
    campusId: string,
    openid: string,
    payerAppId?: string,
    requestedTier?: number,
  ) {
    const intent = await this.db.$transaction(async tx => {
    const store = await this.inventory.lockStore(tx, storeId);
    if (store.campusId !== campusId) throw new BadRequestException('店铺归属已变化，请刷新');
    if (await tx.nightDepositRefund.count({ where: { storeId, status: { in: ['requested', 'submitting', 'processing', 'unknown'] } } })) throw new BadRequestException('押金退还处理中，请先完成核对再缴纳');
    const minimumTier = Math.max(
      50000,
      (Math.floor(store.deposit / 50000) + 1) * 50000,
    );
    const targetTier = requestedTier ?? minimumTier;
    if (
      !Number.isSafeInteger(targetTier) ||
      targetTier % 50000 !== 0 ||
      targetTier < minimumTier ||
      targetTier > 5000000
    )
      throw new BadRequestException('请选择有效的 500 元押金档位');
    const amount = targetTier - store.deposit;
    if (amount <= 0) throw new BadRequestException('押金已足额，无需缴纳');
    // 复用未支付旧单（幂等；避免堆积死单）
    let intent = await tx.nightDepositOrder.findFirst({
      where: { storeId, status: 'pending', amount },
      orderBy: { createdAt: 'desc' },
    });
    if (!intent) {
      // 关闭过期旧单（不同金额的 pending 单）
      await tx.nightDepositOrder.updateMany({
        where: { storeId, status: 'pending' },
        data: { status: 'closed' },
      });
      intent = await tx.nightDepositOrder.create({
        data: {
          storeId,
          outTradeNo: nightDepositTradeNo(),
          amount,
          targetTier,
        },
      });
    }
    return intent;
    }, { timeout: 20000 });
    const payParams = await this.payments.nightPrepay({
      campusId,
      outTradeNo: intent.outTradeNo,
      amount: intent.amount,
      openid,
      description: '夜宵店经营押金缴纳',
      payerAppId,
      expectedMerchantId: intent.payMerchantId ?? undefined,
      expectedAppId: intent.payAppId ?? undefined,
    });
    if (payParams.merchantId) await this.db.nightDepositOrder.update({ where: { id: intent.id }, data: { payMerchantId: payParams.merchantId, payAppId: payParams.appId } });
    const { merchantId: _merchant, ...clientParams } = payParams;
    return {
      depositOrderId: intent.id,
      outTradeNo: intent.outTradeNo,
      amount: intent.amount,
      targetTier: intent.targetTier,
      payParams: clientParams,
    };
  }

  /** 押金支付结果轮询兜底（回调故障时查单落账）。 */
  async depositPayStatus(
    storeId: string,
    campusId: string,
    outTradeNo?: string,
  ) {
    const intent = await this.db.nightDepositOrder.findFirst({
      where: { storeId, ...(outTradeNo ? { outTradeNo } : {}) },
      orderBy: { createdAt: 'desc' },
    });
    if (!intent) throw new NotFoundException('押金支付单不存在');
    if (intent.status === 'pending') {
      try {
        const trade = await this.payments.nightTradeState(
          intent.outTradeNo,
          campusId,
        );
        if (trade.tradeState === 'SUCCESS')
          await this.applyNightDepositPaid(
            intent.outTradeNo,
            trade.transactionId,
          );
      } catch {
        // 查单失败不阻塞状态返回
      }
    }
    const fresh = await this.db.nightDepositOrder.findUniqueOrThrow({
      where: { id: intent.id },
    });
    return {
      outTradeNo: fresh.outTradeNo,
      amount: fresh.amount,
      status: fresh.status,
      paidAt: fresh.paidAt?.toISOString() ?? null,
    };
  }

  /* ==================== 微信回调分发（NightPaymentHandler） ==================== */

  async onPaid(outTradeNo: string, transactionId?: string): Promise<void> {
    if (outTradeNo.startsWith('ND'))
      return this.applyNightDepositPaid(outTradeNo, transactionId);
    return this.applyNightOrderPaid(outTradeNo, transactionId);
  }

  /* ==================== 内部：场次窗口 ==================== */

  /**
   * 夜晚场次校验（V1.5 修订项 1 互斥判定）：校区开夜宵 + 处于夜宵窗口 +
   * 校区白天业务已闭店（手动闭店或打烊窗内）。不满足抛具体原因（T71）。
   */
  assertNightWindow(campus: {
    nightEnabled: boolean;
    nightStartAt: string | null;
    nightEndAt: string | null;
    closeStart: string;
    closeEnd: string;
    manualClosed: boolean;
  }) {
    if (!campus.nightEnabled)
      throw new BadRequestException('本校区未开通夜宵服务');
    if (!inNightWindow(campus.nightStartAt, campus.nightEndAt))
      throw new BadRequestException(
        `未到夜宵营业时间（${campus.nightStartAt ?? '--:--'}~${campus.nightEndAt ?? '--:--'}）`,
      );
    // 白天闭店判定与白天业务 isClosedNow 同构：手动闭店优先，时间窗跨零点合法；
    // closeStart === closeEnd = 24 小时营业 = 白天永不闭店 = 夜宵恒不可开（互斥）
    const dayClosed =
      campus.manualClosed ||
      this.dayCloseWindowHit(campus.closeStart, campus.closeEnd);
    if (!dayClosed)
      throw new BadRequestException('校区白天业务未闭店，夜宵店暂不能营业');
  }

  /** 白天打烊窗命中判定（照抄 business.service isClosedNow 时间窗分支）。 */
  private dayCloseWindowHit(start?: string | null, end?: string | null) {
    const s = hhmmToMinutes(start);
    const e = hhmmToMinutes(end);
    if (s === null || e === null || s === e) return false;
    const nowMin = beijingMinutes();
    return s < e ? nowMin >= s && nowMin < e : nowMin >= s || nowMin < e;
  }

  /** 静态出口：营状态下发文案（三态页面用）。 */
  statusTextOf(status: string) {
    return STATUS_TEXT[status] ?? status;
  }

  /** 领券中心/我的夜宵券（businessType=night 隔离；结构对齐白天 coupons）。 */
  async nightCoupons(userId: string, campusId: string) {
    const marketing = await marketingEnabled(this.db, campusId);
    const [items, mine] = await Promise.all([
      this.db.coupon.findMany({
        where: { campusId, businessType: 'night' },
        orderBy: { expiresAt: 'asc' },
      }),
      this.db.userCoupon.findMany({
        where: { userId, coupon: { campusId, businessType: 'night' } },
        include: { coupon: true },
        orderBy: { claimedAt: 'desc' },
      }),
    ]);
    const now = new Date();
    return {
      claimable: marketing
        ? items
            .filter(
              (c) =>
                c.trigger === 'manual' &&
                !c.targetedOnly &&
                c.status === 'active' &&
                (!c.expiresAt || c.expiresAt > now) &&
                (c.total === null || c.claimed < c.total) &&
                ((c.perUserLimit ?? 1) === 0 ||
                  mine.filter((x) => x.couponId === c.id)
                    .length < (c.perUserLimit ?? 1)),
            )
            .map((c) => ({
              id: c.id,
              featuredAfterPay: c.featuredAfterPay,
              name: c.name,
              amount: c.amount,
              threshold: c.threshold,
              businessType: c.businessType,
              nightProductIds: c.nightProductIds,
              remain:
                c.total === null ? null : Math.max(0, c.total - c.claimed),
              expiresAt: c.expiresAt ? c.expiresAt.toISOString() : null,
            }))
        : [],
      mine: mine.map((x) => ({
        id: x.id,
        couponId: x.couponId,
        status: x.status,
        claimedAt: x.claimedAt.toISOString(),
        coupon: {
          id: x.coupon.id,
          name: x.coupon.name,
          amount: x.coupon.amount,
          threshold: x.coupon.threshold,
          businessType: x.coupon.businessType,
          nightProductIds: x.coupon.nightProductIds,
          expiresAt: x.coupon.expiresAt
            ? x.coupon.expiresAt.toISOString()
            : null,
        },
      })),
    };
  }

  /** 领取夜宵券（复刻白天 claimCoupon 逻辑 + businessType=night 强校验）。 */
  async claimNightCoupon(userId: string, couponId: string, campusId: string) {
    if (!(await marketingEnabled(this.db, campusId)))
      throw new ForbiddenException('营销能力未开通');
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Coupon" WHERE id = ${couponId} FOR UPDATE`;
      const coupon = await tx.coupon.findUnique({ where: { id: couponId } });
      if (!coupon) throw new NotFoundException('优惠券不存在');
      if (coupon.campusId !== campusId)
        throw new BadRequestException('该优惠券不属于当前校区');
      // 券双向隔离：夜宵领券口只收夜宵券（T52）
      if (coupon.businessType !== 'night')
        throw new BadRequestException('该券不可在夜宵渠道领取');
      if (coupon.status !== 'active')
        throw new BadRequestException('优惠券暂不可领取');
      if (coupon.trigger !== 'manual' || coupon.targetedOnly)
        throw new BadRequestException('该优惠券不支持手动领取');
      if (coupon.expiresAt && coupon.expiresAt.getTime() <= Date.now())
        throw new BadRequestException('优惠券已过期');
      const limit = coupon.perUserLimit ?? 1;
      if (limit !== 0) {
        const holdings = await tx.userCoupon.findMany({
          where: { userId, couponId },
        });
        const holding = holdings.find((x) => x.status !== 'used');
        if (holdings.length >= limit) {
          if (holding) return holding;
          throw new BadRequestException('该优惠券已使用');
        }
      }
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
}
