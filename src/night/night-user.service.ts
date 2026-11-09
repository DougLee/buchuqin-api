import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { nightPromotions } from './night-pricing';
import { NightOrderService } from './night-order.service';
import { beijingMinutes, inNightWindow } from './night.helpers';
import { NightAfterSaleDto, NightOrderCreateDto } from './night.dto';

/**
 * 用户端夜宵服务（IKSW1F /night/*）：夜宵入口三态、楼栋店铺列表/详情、
 * 本店商品、下单/取消/确认/售后、夜宵券。购物车一期为客户端本地暂存
 * （提交时服务端全量重验），不下发服务端购物车接口（与白天 CartItem
 * 彻底隔离）。
 */
@Injectable()
export class NightUserService {
  constructor(
    private readonly db: PrismaService,
    private readonly orderSvc: NightOrderService,
  ) {}

  /** 校区夜宵配置 + 当前窗口态（白天店与夜宵店入口互斥展示的判定源）。 */
  private async campusNightConfig(campusId: string) {
    const campus = await this.db.campus.findUnique({
      where: { id: campusId },
      select: {
        id: true,
        name: true,
        nightEnabled: true,
        nightStartAt: true,
        nightEndAt: true,
        nightPayTimeout: true,
        nightAcceptTimeout: true,
        nightDeliveryFee: true,
        deliveryFeeInstant: true,
        closeStart: true,
        closeEnd: true,
        manualClosed: true,
      },
    });
    if (!campus) throw new NotFoundException('校区不存在');
    const inWindow = inNightWindow(campus.nightStartAt, campus.nightEndAt);
    // 白天闭店判定（与楼长开店互斥校验同口径）
    const s = beijingMinutes();
    const cs = this.toMin(campus.closeStart);
    const ce = this.toMin(campus.closeEnd);
    const dayClosed =
      campus.manualClosed ||
      (cs !== null && ce !== null && cs !== ce
        ? cs < ce
          ? s >= cs && s < ce
          : s >= cs || s < ce
        : false);
    return {
      campusId: campus.id,
      campusName: campus.name,
      nightEnabled: campus.nightEnabled,
      nightStartAt: campus.nightStartAt,
      nightEndAt: campus.nightEndAt,
      nightDeliveryFee: campus.nightDeliveryFee ?? campus.deliveryFeeInstant,
      // 三元组：入口展示与下单校验共用（inNight = 夜宵可购窗口）
      dayClosed,
      inWindow,
      inNightSession: campus.nightEnabled && dayClosed && inWindow,
      nowMinutes: s,
    };
  }

  private toMin(s?: string | null): number | null {
    if (!s) return null;
    const m = /^(\d{1,2}):(\d{2})$/.exec(s);
    if (!m) return null;
    return Number(m[1]) * 60 + Number(m[2]);
  }

  /** 夜宵入口数据：当前校区是否可进夜宵（楼栋由前端带 buildingId 查店铺）。 */
  async entry(campusId: string) {
    return this.campusNightConfig(campusId);
  }

  /**
   * 楼栋店铺列表（三态）：no-manager 无楼长（招募中）/ resting 有楼长未
   * 营业 / open 营业中。可按 buildingId 过滤（进本楼店详情前置校验）。
   */
  async stores(campusId: string, buildingId?: string) {
    const cfg = await this.campusNightConfig(campusId);
    const buildings = await this.db.building.findMany({
      where: {
        campusId,
        status: 'active',
        ...(buildingId ? { id: buildingId } : {}),
      },
      orderBy: { name: 'asc' },
      include: {
        nightStore: {
          include: {
            managerStaff: { select: { id: true, name: true } },
          },
        },
      },
    });
    return {
      session: {
        nightEnabled: cfg.nightEnabled,
        inWindow: cfg.inWindow,
        dayClosed: cfg.dayClosed,
        inNightSession: cfg.inNightSession,
        nightStartAt: cfg.nightStartAt,
        nightEndAt: cfg.nightEndAt,
      },
      stores: buildings.map((b) => {
        const store = b.nightStore;
        // 三态（PRD B03/U03）：无楼长招募中 → 有楼长休息中 → 营业中
        const state =
          !store || !store.managerStaffId
            ? 'no-manager'
            : store.status === 'open' && cfg.inNightSession
              ? 'open'
              : 'resting';
        return {
          buildingId: b.id,
          buildingName: b.name,
          storeId: store?.id ?? null,
          state,
          storeStatus: store?.status ?? null,
          managerName: store?.managerStaff?.name ?? null,
          // 公告位预留（一期无配置入口，恒空串）
          announcement: '',
        };
      }),
    };
  }

  /** 店铺详情（三态 + 营业时间 + 公告位预留）。 */
  async storeDetail(campusId: string, storeId: string) {
    const list = await this.stores(campusId);
    const row = list.stores.find((s) => s.storeId === storeId);
    if (!row) throw new NotFoundException('夜宵店不存在');
    return { ...row, session: list.session };
  }

  /**
   * 本店可购商品：上架 + 后台售卖许可 + 主档在售（零库存保留售罄展示）。
   * 图/名/价引夜主档 Product（夜宵统一售价）。
   */
  async storeProducts(campusId: string, storeId: string) {
    const store = await this.db.nightStore.findFirst({
      where: { id: storeId, campusId },
    });
    if (!store) throw new NotFoundException('夜宵店不存在');
    const rows = await this.db.nightProduct.findMany({
      where: {
        storeId,
        onShelf: true,
        saleAllowed: true,
        catalogProduct: { status: 'on-sale', nightCatalog: true },
      },
      include: {
        catalogProduct: {
          select: {
            id: true,
            name: true,
            image: true,
            images: true,
            description: true,
            originalPrice: true,
            featured: true,
            featuredSort: true,
            purchaseLimit: true,
            purchaseLimitQty: true,
            subtitle: true,
            price: true,
            categoryId: true,
            category: { select: { name: true } },
            retailUnit: true,
            nightBarcode: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    const [promotions, seckill] = await Promise.all([nightPromotions(this.db, rows.map(row => row.catalogProductId)), nightPromotions(this.db, rows.map(row => row.catalogProductId), 'seckill')]);
    return rows.sort((a, b) =>
      // IKTU033：楼长推荐（楼栋行）优先——本店首页/货架排序自管；主档运营
      // 推荐位（admin 设的 catalogProduct.featured）作次级兜底，再按创建序
      Number(b.featured) - Number(a.featured) ||
      a.featuredSort - b.featuredSort ||
      Number(b.catalogProduct.featured) - Number(a.catalogProduct.featured) ||
      a.catalogProduct.featuredSort - b.catalogProduct.featuredSort,
    ).map((r) => ({
        id: r.id,
        catalogProductId: r.catalogProductId,
        purchaseLimitMeta: r.catalogProduct.purchaseLimit && r.catalogProduct.purchaseLimit !== 'none' ? { kind: r.catalogProduct.purchaseLimit, qty: r.catalogProduct.purchaseLimitQty } : undefined,
        name: r.catalogProduct.name,
        image: r.catalogProduct.image,
        images: r.catalogProduct.images,
        description: r.catalogProduct.description,
        originalPrice: promotions.has(r.catalogProductId) ? r.catalogProduct.price : r.catalogProduct.originalPrice,
        // IKTU033：featured 语义=楼长推荐（楼栋行级）；货架「精选推荐」chip 由它驱动
        featured: r.featured,
        featuredSort: r.featuredSort,
        subtitle: r.catalogProduct.subtitle,
        price: promotions.get(r.catalogProductId)?.price ?? r.catalogProduct.price,
        seckill: seckill.has(r.catalogProductId) ? { id: seckill.get(r.catalogProductId)!.id, price: seckill.get(r.catalogProductId)!.price, endsAt: seckill.get(r.catalogProductId)!.endsAt.toISOString() } : null,
        promotion: promotions.has(r.catalogProductId) ? { id: promotions.get(r.catalogProductId)!.id, type: promotions.get(r.catalogProductId)!.type, endsAt: promotions.get(r.catalogProductId)!.endsAt.toISOString() } : null,
        categoryId: r.catalogProduct.categoryId,
        categoryName: r.catalogProduct.category.name,
        retailUnit: r.catalogProduct.retailUnit,
        barcode: r.catalogProduct.nightBarcode,
        stock: r.stock,
        soldOut: r.stock <= 0,
      }));
  }

  /* ==================== 订单（薄封装，校验在 NightOrderService） ==================== */

  submitOrder(userId: string, dto: NightOrderCreateDto) {
    return this.orderSvc.submitOrder(userId, dto);
  }

  orders(userId: string, status?: string, page?: string, pageSize?: string) {
    return this.orderSvc.myOrdersPage(userId, status, page, pageSize);
  }

  order(userId: string, id: string) {
    return this.orderSvc.myOrder(userId, id);
  }

  cancelOrder(userId: string, id: string, reason?: string) {
    return this.orderSvc.cancelByUser(userId, id, reason);
  }

  confirmOrder(userId: string, id: string) {
    return this.orderSvc.confirmOrder(userId, id);
  }

  applyAfterSale(userId: string, id: string, dto: NightAfterSaleDto) {
    return this.orderSvc.applyAfterSale(userId, id, dto);
  }

  afterSales(userId: string, page?: string, pageSize?: string) {
    return this.orderSvc.myAfterSales(userId, page, pageSize);
  }

  withdrawAfterSale(userId: string, id: string) {
    return this.orderSvc.withdrawAfterSale(userId, id);
  }

  prepayOrder(userId: string, orderId: string) {
    return this.orderSvc.prepayOrder(userId, orderId);
  }

  orderPayStatus(userId: string, orderId: string) {
    return this.orderSvc.orderPayStatus(userId, orderId);
  }

  coupons(userId: string, campusId: string) {
    return this.orderSvc.nightCoupons(userId, campusId);
  }

  claimCoupon(userId: string, couponId: string, campusId: string) {
    return this.orderSvc.claimNightCoupon(userId, couponId, campusId);
  }
}
