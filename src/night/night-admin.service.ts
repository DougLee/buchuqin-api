import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { NightDepositRefundService } from './night-deposit-refund.service';
import { NightReportingService } from './night-reporting.service';
import { PrismaService } from '../database/prisma.service';
import { PaymentsService } from '../payments/payments.service';
import { NightOrderService } from './night-order.service';
import {
  allocateInventoryValue,
  NightInventoryService,
} from './night-inventory.service';
import { hhmmToMinutes, nextDepositTier } from './night.helpers';
import {
  NightCatalogCreateDto,
  NightCatalogUpdateDto,
  NightConfigDto,
  NightDepositDeductDto,
  NightDepositRefundDto,
  NightRefundDto,
  NightStockAdjustDto,
  NightStoreCreateDto,
  NightStoreProductAttachDto,
  NightStoreUpdateDto,
} from './night.dto';

/** 夜宵主档默认分类名（隐藏，双保险隔离白天目录）。 */
const NIGHT_CATEGORY_NAME = '夜宵专供';

/**
 * 后台夜宵服务（IKSW1F /admin/night/*）：店铺/夜主档/楼栋商品/库存调整/
 * 校区配置/押金账务（判责扣除、退出退还）/清算清单。
 * 订单查询/退款/结算佣金在 NightOrderService（本服务委托）。
 */
@Injectable()
export class NightAdminService {
  private readonly logger = new Logger(NightAdminService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly payments: PaymentsService,
    private readonly orders: NightOrderService,
    private readonly inventory: NightInventoryService = new NightInventoryService(
      db,
    ),
  ) {}

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
      this.logger.warn(
        `[night-audit] 审计写入失败（不影响业务操作）: ${action} ${entityId}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async campusGuard(campusId: string) {
    const campus = await this.db.campus.findUnique({ where: { id: campusId } });
    if (!campus) throw new BadRequestException('校区不存在');
    return campus;
  }

  /* ==================== 店铺管理 ==================== */

  /** 建店：校区+楼栋（唯一）+佣金比例（显式 0 合法）+绑定楼长（可空=招募中）。 */
  async createStore(operator: string, body: NightStoreCreateDto) {
    const building = await this.db.building.findUnique({
      where: { id: body.buildingId },
    });
    if (!building) throw new BadRequestException('楼栋不存在');
    const campusId = body.campusId ?? building.campusId;
    await this.campusGuard(campusId);
    if (building.campusId !== campusId)
      throw new BadRequestException('楼栋不属于该校区');
    const exists = await this.db.nightStore.findUnique({
      where: { buildingId: body.buildingId },
    });
    if (exists) throw new BadRequestException('该楼栋已存在夜宵店');
    if (body.managerStaffId)
      await this.assertManager(campusId, body.managerStaffId);
    const store = await this.db.nightStore.create({
      data: {
        campusId,
        buildingId: body.buildingId,
        managerStaffId: body.managerStaffId ?? null,
        commissionRate: body.commissionRate,
        status: 'closed',
      },
    });
    await this.audit(
      operator,
      'night.store.create',
      'nightStore',
      store.id,
      null,
      store,
      campusId,
    );
    return store;
  }

  /** 楼长必须是本校区在职楼长角色（building-manager/实习）。 */
  private async assertManager(campusId: string, staffId: string) {
    const staff = await this.db.staff.findFirst({
      where: {
        id: staffId,
        campusId,
        role: { in: ['building-manager', 'intern-building-manager'] },
        status: { not: 'deleted' },
      },
    });
    if (!staff)
      throw new BadRequestException(
        '楼长不存在或不属于该校区（须为在职楼长角色）',
      );
    return staff;
  }

  /**
   * 编辑：停业/恢复打烊态、换楼长（解绑重绑，PRD A13 交接语义——换人前
   * 应先完成清算，本接口做状态斩断）、调佣金比例。
   */
  async updateStore(operator: string, id: string, body: NightStoreUpdateDto) {
    const store = await this.db.nightStore.findUnique({ where: { id } });
    if (!store) throw new NotFoundException('夜宵店不存在');
    const data: Prisma.NightStoreUpdateInput = {};
    if (body.status !== undefined) {
      if (!['closed', 'suspended'].includes(body.status))
        throw new BadRequestException(
          '状态取值须为 closed/suspended（营业走楼长开店）',
        );
      data.status = body.status;
    }
    if (body.managerStaffId !== undefined) {
      if (body.managerStaffId === null || body.managerStaffId === '') {
        data.managerStaff = { disconnect: true };
      } else {
        await this.assertManager(store.campusId, body.managerStaffId);
        data.managerStaff = { connect: { id: body.managerStaffId } };
      }
    }
    if (body.commissionRate !== undefined)
      data.commissionRate = body.commissionRate;
    const after = await this.db.$transaction(
      async (tx) => {
        const inventory = this.inventory;
        const fresh = await inventory.lockStore(tx, id);
        if (
          body.managerStaffId !== undefined &&
          (body.managerStaffId || null) !== fresh.managerStaffId
        ) {
          const [quota, stock, requests, reports, orders] = await Promise.all([
            inventory.summary(id, tx),
            tx.nightProduct.count({
              where: {
                storeId: id,
                OR: [{ stock: { gt: 0 } }, { frozenStock: { gt: 0 } }],
              },
            }),
            tx.nightStockOrder.count({
              where: {
                storeId: id,
                status: { in: ['requested', 'approved', 'shipped'] },
              },
            }),
            tx.nightInventoryReport.count({
              where: { storeId: id, status: 'pending' },
            }),
            tx.nightOrder.count({
              where: {
                storeId: id,
                status: {
                  in: [
                    'pending-payment',
                    'pending-accept',
                    'delivering',
                    'delivered',
                  ],
                },
              },
            }),
          ]);
          if (quota.usedQuota || stock || requests || reports || orders)
            throw new BadRequestException(
              '请先清点库存、处理未完备货/订单和盘点报损，再交接楼长',
            );
        }
        return tx.nightStore.update({ where: { id }, data });
      },
      { timeout: 20000 },
    );
    await this.audit(
      operator,
      'night.store.update',
      'nightStore',
      id,
      store,
      after,
      store.campusId,
    );
    return after;
  }

  /** 店铺列表：含今日订单数/销售额、押金余额、营业状态、楼栋/楼长信息。 */
  async stores(campusId: string, status?: string) {
    const campus = await this.db.campus.findUniqueOrThrow({ where: { id: campusId }, select: { nightStartAt: true, nightEndAt: true } });
    const rows = await this.db.nightStore.findMany({
      where: { campusId, ...(status ? { status } : {}) },
      include: {
        building: { select: { name: true } },
        managerStaff: { select: { id: true, name: true, staffNo: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    const aggMap = await new NightReportingService(this.db).campusSales(campusId, campus);
    return rows.map((r) => ({
      id: r.id,
      campusId: r.campusId,
      buildingId: r.buildingId,
      buildingName: r.building.name,
      manager: r.managerStaff,
      status: r.status,
      deposit: r.deposit,
      commissionRate: r.commissionRate,
      depositGapToNextTier: nextDepositTier(r.deposit) - r.deposit,
      todayOrders: aggMap.get(r.id)?.todayOrders ?? 0,
      todaySales: aggMap.get(r.id)?.todaySales ?? 0,
      openedAt: r.openedAt?.toISOString() ?? null,
      closedAt: r.closedAt?.toISOString() ?? null,
    }));
  }

  /** 店铺详情：店铺+商品+押金流水+佣金汇总。 */
  async storeDetail(id: string) {
    const store = await this.db.nightStore.findUnique({
      where: { id },
      include: {
        building: { select: { name: true } },
        managerStaff: {
          select: { id: true, name: true, staffNo: true, phone: true },
        },
        products: {
          include: {
            catalogProduct: {
              select: { id: true, name: true, price: true, status: true },
            },
          },
        },
        depositTxns: { orderBy: { createdAt: 'desc' }, take: 50 },
      },
    });
    if (!store) throw new NotFoundException('夜宵店不存在');
    const commissionAgg = await this.db.nightCommissionTxn.groupBy({
      by: ['type', 'status'],
      where: { storeId: id },
      _sum: { amount: true },
      _count: true,
    });
    const commission = { commission: {}, deliveryFee: {} } as Record<
      string,
      Record<string, number>
    >;
    for (const row of commissionAgg) {
      commission[row.type] = commission[row.type] ?? {};
      commission[row.type][row.status] =
        (commission[row.type][row.status] ?? 0) + (row._sum.amount ?? 0);
    }
    return {
      ...store,
      buildingName: store.building.name,
      manager: store.managerStaff,
      commissionSummary: commission,
      depositGapToNextTier: nextDepositTier(store.deposit) - store.deposit,
    };
  }

  /* ==================== 夜主档管理 ==================== */

  /**
   * 夜主档行创建：Product 表 nightCatalog=true 的新行（price 字段承载夜宵
   * 统一售价）。缺省挂本校区「夜宵专供」隐藏分类（白天目录天然不可见，
   * 与显式 nightCatalog=false 过滤双保险）。
   */
  async createCatalogProduct(operator: string, body: NightCatalogCreateDto) {
    const campusId = body.campusId;
    if (!campusId) throw new BadRequestException('请指定校区');
    await this.campusGuard(campusId);
    let categoryId = body.categoryId;
    if (categoryId) {
      const category = await this.db.category.findFirst({
        where: { id: categoryId, campusId },
      });
      if (!category) throw new BadRequestException('分类不存在或不属于该校区');
    } else {
      const category = await this.db.category.upsert({
        where: { campusId_name: { campusId, name: NIGHT_CATEGORY_NAME } },
        update: {},
        create: {
          campusId,
          name: NIGHT_CATEGORY_NAME,
          sort: 9999,
          hidden: true,
        },
      });
      categoryId = category.id;
    }
    const product = await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`night-catalog-${campusId}`}))::text`;
      let warehouse = body.barcode
        ? await tx.product.findFirst({
            where: { campusId, barcode: body.barcode, nightCatalog: false },
          })
        : null;
      if (
        warehouse &&
        (await tx.product.count({
          where: {
            campusId,
            nightCatalog: true,
            warehouseProductId: warehouse.id,
          },
        }))
      )
        throw new BadRequestException('该实物商品已存在夜宵经营资料');
      if (!warehouse)
        warehouse = await tx.product.create({
          data: {
            campusId,
            categoryId,
            name: body.name,
            subtitle: body.subtitle ?? '',
            price: body.price,
            originalPrice: body.originalPrice ?? body.price,
            image: body.image ?? '',
            barcode: body.barcode ?? null,
            stock: 0,
            status: 'off-sale',
            tag: '',
            weight: 0,
          },
        });
      return tx.product.create({
        data: {
          campusId,
          catalogScope: 'campus',
          nightCatalog: true,
          categoryId,
          retailUnit: body.retailUnit?.trim() || '件',
          name: body.name,
          subtitle: body.subtitle ?? '',
          price: body.price,
          originalPrice: body.originalPrice ?? body.price,
          image: body.image ?? '',
          images: body.images ?? [],
          description: body.description ?? '',
          featured: body.featured ?? false,
          featuredSort: body.featuredSort ?? 0,
          purchaseLimit: body.purchaseLimit ?? 'none',
          purchaseLimitQty: body.purchaseLimitQty ?? 1,
          barcode: null,
          nightBarcode: body.barcode ?? null,
          warehouseProductId: warehouse.id,
          stock: 0,
          status: 'on-sale',
          tag: '',
          weight: 0,
        },
      });
    });
    await this.audit(
      operator,
      'night.catalog.create',
      'product',
      product.id,
      null,
      { name: product.name, price: product.price },
      campusId,
    );
    return product;
  }

  async updateCatalogProduct(
    operator: string,
    id: string,
    body: NightCatalogUpdateDto,
  ) {
    const product = await this.db.product.findFirst({
      where: { id, nightCatalog: true },
    });
    if (!product) throw new NotFoundException('夜主档商品不存在');
    const data: Prisma.ProductUpdateInput = {};
    if (body.categoryId !== undefined) {
      const category = await this.db.category.findFirst({ where: { id: body.categoryId, campusId: product.campusId } });
      if (!category) throw new BadRequestException('分类不存在或不属于该校区');
      data.category = { connect: { id: category.id } };
    }
    if (body.retailUnit !== undefined) {
      if (!body.retailUnit.trim()) throw new BadRequestException('请填写零售单位');
      data.retailUnit = body.retailUnit.trim();
    }
    if (body.name !== undefined) data.name = body.name;
    if (body.price !== undefined) data.price = body.price;
    if (body.originalPrice !== undefined)
      data.originalPrice = body.originalPrice;
    if (body.image !== undefined) data.image = body.image;
    if (body.images !== undefined) data.images = body.images;
    if (body.description !== undefined) data.description = body.description;
    if (body.featured !== undefined) data.featured = body.featured;
    if (body.featuredSort !== undefined) data.featuredSort = body.featuredSort;
    if (body.purchaseLimit !== undefined) data.purchaseLimit = body.purchaseLimit;
    if (body.purchaseLimitQty !== undefined) data.purchaseLimitQty = body.purchaseLimitQty;
    if (body.subtitle !== undefined) data.subtitle = body.subtitle;
    if (body.status !== undefined) data.status = body.status;
    const after = await this.db.product.update({ where: { id }, data });
    await this.audit(
      operator,
      'night.catalog.update',
      'product',
      id,
      { price: product.price, status: product.status },
      { price: after.price, status: after.status },
      product.campusId,
    );
    return after;
  }

  /** 夜主档列表。 */
  async catalogProducts(campusId: string, keyword?: string) {
    const rows = await this.db.product.findMany({
      where: {
        campusId,
        nightCatalog: true,
        ...(keyword
          ? { name: { contains: keyword, mode: 'insensitive' } }
          : {}),
      },
      orderBy: { updatedAt: 'desc' },
    });
    return rows.map((p) => ({
      id: p.id,
      name: p.name,
      subtitle: p.subtitle,
      image: p.image,
      price: p.price, // 夜宵统一售价
      originalPrice: p.originalPrice,
      barcode: p.barcode,
      status: p.status,
      updatedAt: p.updatedAt.toISOString(),
    }));
  }

  /* ==================== 楼栋商品（NightProduct） ==================== */

  /** 给店铺配商品：从夜主档勾选生成楼栋行（onShelf 默认 true，库存 0）。 */
  async attachStoreProducts(
    operator: string,
    storeId: string,
    body: NightStoreProductAttachDto,
  ) {
    const store = await this.db.nightStore.findUnique({
      where: { id: storeId },
    });
    if (!store) throw new NotFoundException('夜宵店不存在');
    const catalog = await this.db.product.findMany({
      where: { id: { in: body.catalogProductIds }, nightCatalog: true },
    });
    if (catalog.length !== new Set(body.catalogProductIds).size)
      throw new BadRequestException('存在无效夜主档商品');
    const wrongCampus = catalog.find((c) => c.campusId !== store.campusId);
    if (wrongCampus) throw new BadRequestException('夜主档不属于该校区');
    const existing = await this.db.nightProduct.findMany({
      where: { storeId, catalogProductId: { in: body.catalogProductIds } },
      select: { catalogProductId: true },
    });
    const existingSet = new Set(existing.map((e) => e.catalogProductId));
    const toCreate = catalog.filter((c) => !existingSet.has(c.id));
    const created = await this.db.$transaction(
      toCreate.map((c) =>
        this.db.nightProduct.create({
          data: { storeId, catalogProductId: c.id, onShelf: true },
        }),
      ),
    );
    await this.audit(
      operator,
      'night.storeProduct.attach',
      'nightStore',
      storeId,
      null,
      { attached: created.length, skipped: existingSet.size },
      store.campusId,
    );
    return { attached: created.length, skipped: existingSet.size };
  }

  /** 强制上下架（saleAllowed 后台售卖许可，优先于楼长 onShelf 选择）。 */
  async updateStoreProduct(
    operator: string,
    storeId: string,
    productId: string,
    body: { saleAllowed?: boolean },
  ) {
    const product = await this.db.nightProduct.findFirst({
      where: { id: productId, storeId },
    });
    if (!product) throw new NotFoundException('商品不存在');
    const after = await this.db.nightProduct.update({
      where: { id: productId },
      data: { saleAllowed: body.saleAllowed ?? product.saleAllowed },
    });
    await this.audit(
      operator,
      'night.storeProduct.update',
      'nightProduct',
      productId,
      { saleAllowed: product.saleAllowed },
      { saleAllowed: after.saleAllowed },
      (await this.db.nightStore.findUniqueOrThrow({ where: { id: storeId } }))
        .campusId,
    );
    return after;
  }

  /**
   * 库存调整（复刻白天 adjustStock 一步生效模式）：delta+type+原因 →
   * NightStockTxn 流水 + NightProduct.stock 原子生效；调整后库存不得为负。
   */
  async adjustStock(
    operator: string,
    storeId: string,
    productId: string,
    body: NightStockAdjustDto,
  ) {
    if (!body.delta) throw new BadRequestException('调整数量不能为 0');
    const product = await this.db.nightProduct.findFirst({
      where: { id: productId, storeId },
    });
    if (!product) throw new NotFoundException('商品不存在');
    const store = await this.db.nightStore.findUniqueOrThrow({
      where: { id: storeId },
    });
    const txn = await this.db.$transaction(async (tx) => {
      const inventory = this.inventory;
      await inventory.lockStore(tx, storeId);
      const current = await tx.nightProduct.findUniqueOrThrow({
        where: { id: productId },
        include: { catalogProduct: true },
      });
      if (current.stock + body.delta < 0)
        throw new BadRequestException('调整后库存不能为负数');
      const pendingReports = await tx.nightInventoryReport.count({
        where: { storeId, status: 'pending' },
      });
      if (pendingReports)
        throw new BadRequestException(
          '请先处理待审核盘点/报损，再进行人工调整',
        );
      const valueDelta =
        body.delta < 0
          ? -allocateInventoryValue(
              current.inventoryValue,
              current.stock,
              -body.delta,
            )
          : Math.round(
              body.delta *
                (current.stock
                  ? current.inventoryValue / current.stock
                  : current.catalogProduct.price),
            );
      if (valueDelta > (await inventory.summary(storeId, tx)).usableQuota)
        throw new BadRequestException('调整入库超出押金额度');
      const updated = await tx.nightProduct.update({
        where: { id: productId },
        data: {
          stock: { increment: body.delta },
          inventoryValue: { increment: valueDelta },
          inventoryVersion: { increment: 1 },
        },
      });
      const record = await tx.nightStockTxn.create({
        data: {
          storeId,
          nightProductId: productId,
          type: body.type,
          delta: body.delta,
          afterStock: updated.stock,
          operatorId: operator,
          remark: body.reason,
        },
      });
      return record;
    });
    await this.audit(
      operator,
      'night.stock.adjust',
      'nightProduct',
      productId,
      { stock: product.stock, type: body.type },
      { stock: product.stock + body.delta, reason: body.reason },
      store.campusId,
    );
    return txn;
  }

  /** 库存流水查询（对账）。 */
  stockTxns(storeId: string) {
    return this.db.nightStockTxn.findMany({
      where: { storeId },
      orderBy: { createdAt: 'desc' },
    });
  }
  stockTxnsPage(storeId: string, page?: string, pageSize?: string) { return this.inventory.transactionsPage(storeId, undefined, page, pageSize); }

  /* ==================== 校区夜宵配置 ==================== */

  /** 读配置。 */
  async getConfig(campusId: string) {
    const campus = await this.campusGuard(campusId);
    return {
      campusId: campus.id,
      nightEnabled: campus.nightEnabled,
      nightStartAt: campus.nightStartAt,
      nightEndAt: campus.nightEndAt,
      nightPayTimeout: campus.nightPayTimeout,
      nightAcceptTimeout: campus.nightAcceptTimeout,
      nightDeliveryFee: campus.nightDeliveryFee,
      closeStart: campus.closeStart,
      closeEnd: campus.closeEnd,
    };
  }

  /**
   * 写配置（V1.5 A02/T72）：时间格式与时段合法性校验；夜宵开始早于校区
   * 闭店开始时刻 → 拒绝，body.confirm=true 强警告二次确认放行并留痕。
   */
  async saveConfig(operator: string, body: NightConfigDto) {
    const campusId = body.campusId;
    if (!campusId) throw new BadRequestException('请指定校区');
    const campus = await this.campusGuard(campusId);
    if (body.nightEnabled) {
      const s = hhmmToMinutes(body.nightStartAt ?? null);
      const e = hhmmToMinutes(body.nightEndAt ?? null);
      if (s === null || e === null)
        throw new BadRequestException('开启夜宵须配置场次时间（HH:mm）');
      if (s === e) throw new BadRequestException('夜宵开始与结束时刻不能相同');
      if (
        body.nightDeliveryFee === undefined &&
        campus.nightDeliveryFee === null &&
        campus.deliveryFeeInstant === 0
      )
        this.logger.warn(
          `校区 ${campusId} 夜间配送费未配置且白天即时送为 0 元`,
        );
      // 互斥缓冲校验（强警告 + 二次确认）：夜宵开始须 ≥ 校区闭店开始时刻
      const cs = hhmmToMinutes(campus.closeStart);
      if (
        body.confirm !== true &&
        cs !== null &&
        cs !== (hhmmToMinutes(campus.closeEnd) ?? cs) &&
        s < cs
      )
        throw new BadRequestException(
          `夜宵开始时刻早于校区闭店时刻（${campus.closeStart}），请先确认打烊安排或传 confirm=true 强制保存`,
        );
    }
    const after = await this.db.campus.update({
      where: { id: campusId },
      data: {
        nightEnabled: body.nightEnabled,
        nightStartAt: body.nightStartAt ?? null,
        nightEndAt: body.nightEndAt ?? null,
        nightPayTimeout: body.nightPayTimeout ?? null,
        nightAcceptTimeout: body.nightAcceptTimeout ?? null,
        ...(body.nightDeliveryFee !== undefined
          ? { nightDeliveryFee: body.nightDeliveryFee }
          : {}),
      },
    });
    await this.audit(
      operator,
      'night.config.update',
      'campus',
      campusId,
      campus,
      {
        nightEnabled: after.nightEnabled,
        nightStartAt: after.nightStartAt,
        nightEndAt: after.nightEndAt,
        nightDeliveryFee: after.nightDeliveryFee,
      },
      campusId,
    );
    return this.getConfig(campusId);
  }

  /* ==================== 押金账务 ==================== */

  /** 押金判责扣除（后台按钮）：余额扣减 + deduct 流水（不得扣到负数）。 */
  async deductDeposit(
    operator: string,
    storeId: string,
    body: NightDepositDeductDto,
  ) {
    const result = await this.db.$transaction(async (tx) => {
      const store = await this.inventory.lockStore(tx, storeId);
      const quota = await this.inventory.summary(storeId, tx);
      if (store.deposit - quota.depositRefundReservedValue < body.amount)
        throw new BadRequestException('扣除金额超过押金余额（不得扣到负数）');
      const won = await tx.nightStore.updateMany({
        where: { id: storeId, deposit: { gte: body.amount } },
        data: { deposit: { decrement: body.amount } },
      });
      if (!won.count)
        throw new BadRequestException('押金余额已变化，请刷新重试');
      const txn = await tx.nightDepositTxn.create({
        data: {
          storeId,
          type: 'deduct',
          amount: body.amount,
          operatorId: operator,
          remark: body.reason,
        },
      });
      return { txn, balance: store.deposit - body.amount };
    });
    await this.audit(
      operator,
      'night.deposit.deduct',
      'nightStore',
      storeId,
      { deposit: result.balance + body.amount },
      { deposit: result.balance, reason: body.reason },
      (await this.db.nightStore.findUniqueOrThrow({ where: { id: storeId } }))
        .campusId,
    );
    return { txnId: result.txn.id, deposit: result.balance };
  }

  /**
   * 退出清算清单（A13 支撑）：剩余库存（含货值）/未完订单（按状态计数）/
   * 佣金余额（estimated/pending/settled）/押金余额/锁定中券。
   */
  async liquidation(storeId: string) {
    const store = await this.db.nightStore.findUnique({
      where: { id: storeId },
      include: { building: { select: { name: true } } },
    });
    if (!store) throw new NotFoundException('夜宵店不存在');
    const [products, orderCounts, commissionAgg] = await Promise.all([
      this.db.nightProduct.findMany({
        where: { storeId, stock: { gt: 0 } },
        include: { catalogProduct: { select: { name: true, price: true } } },
      }),
      this.db.nightOrder.groupBy({
        by: ['status'],
        where: {
          storeId,
          status: {
            in: [
              'pending-accept',
              'delivering',
              'delivered',
              'pending-payment',
            ],
          },
        },
        _count: true,
      }),
      this.db.nightCommissionTxn.groupBy({
        by: ['type', 'status'],
        where: { storeId },
        _sum: { amount: true },
      }),
    ]);
    const commission: Record<string, number> = {};
    for (const row of commissionAgg) {
      const key = `${row.type}:${row.status}`;
      commission[key] = (commission[key] ?? 0) + (row._sum.amount ?? 0);
    }
    return {
      store: {
        id: store.id,
        buildingName: store.building.name,
        status: store.status,
      },
      deposit: store.deposit,
      stock: {
        items: products.map((p) => ({
          id: p.id,
          name: p.catalogProduct.name,
          stock: p.stock,
          price: p.catalogProduct.price,
          value: p.inventoryValue,
        })),
        totalValue: products.reduce((s, p) => s + p.inventoryValue, 0),
      },
      openOrders: orderCounts.map((o) => ({
        status: o.status,
        count: o._count,
      })),
      commission,
      // 提示：清库存走库存调整接口（returnOut/loss），未完订单处理完才可退押
      hints: [
        '清库存：POST /admin/night/stores/:id/products/:productId/stock（type=returnOut/loss）',
        '未完订单：配送完成后或后台退款处理',
        '佣金：POST /admin/night/settlements/settle 出账后打款',
        '押金退还：POST /admin/night/stores/:id/deposit/refund（原路退回）',
      ],
    };
  }

  /** 持久化退押申请：渠道确认成功才扣押金，处理中持续占用额度。 */
  refundDeposit(operator: string, storeId: string, body: NightDepositRefundDto) {
    return new NightDepositRefundService(this.db, this.payments, this.inventory).request(operator, storeId, body);
  }

  depositRefunds(storeId: string, page?: string, pageSize?: string) {
    return new NightDepositRefundService(this.db, this.payments, this.inventory).history(storeId, page, pageSize);
  }

  depositTransactions(storeId: string, page?: string, pageSize?: string, kind?: string) { return this.inventory.depositTransactions(storeId, page, pageSize, kind); }

  syncDepositRefund(storeId: string, requestId: string) {
    return new NightDepositRefundService(this.db, this.payments, this.inventory).sync(storeId, requestId);
  }

  /* ==================== 订单/结算（委托 NightOrderService） ==================== */

  /** 资源归属校区（控制器 campusScope 落地校验用）。 */
  async storeCampus(storeId: string): Promise<string> {
    const store = await this.db.nightStore.findUnique({
      where: { id: storeId },
      select: { campusId: true },
    });
    if (!store) throw new NotFoundException('夜宵店不存在');
    return store.campusId;
  }

  async catalogCampus(productId: string): Promise<string> {
    const product = await this.db.product.findUnique({
      where: { id: productId },
      select: { campusId: true, nightCatalog: true },
    });
    if (!product || !product.nightCatalog)
      throw new NotFoundException('夜主档商品不存在');
    return product.campusId;
  }

  /** 夜宵券模板列表（businessType=night 过滤；口径同 admin.service.coupons）。 */
  async nightCoupons(campusId: string, status?: string) {
    const rows = await this.db.coupon.findMany({
      where: { campusId, businessType: 'night', ...(status ? { status } : {}) },
      // Coupon 无 createdAt 列；按面额降序近似最新（后台 Tab 展示口径）
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
    });
    return rows.map((c) => ({
      ...c,
      remain: c.total === null ? null : Math.max(0, c.total - c.claimed),
    }));
  }

  adminOrders(
    campusId: string,
    filters: { storeId?: string; status?: string; date?: string },
  ) {
    return this.orders.adminOrders(campusId, filters);
  }

  adminOrdersPage(campusId: string, filters: { storeId?: string; status?: string; date?: string; keyword?: string; afterSaleStatus?: string }, page?: string, pageSize?: string) { return this.orders.adminOrdersPage(campusId, filters, page, pageSize); }
  rejectAfterSale(operator: string, orderId: string, reason: string) { return this.orders.rejectAfterSale(operator, orderId, reason); }

  adminOrderDetail(id: string) {
    return this.orders.adminOrderDetail(id);
  }

  adminRefund(operator: string, orderId: string, body: NightRefundDto) {
    return this.orders.adminRefund(operator, orderId, body);
  }

  syncRefund(orderId: string) { return this.orders.syncRefund(orderId); }
  settlementCampusIds(batch: string) { return this.orders.settlementCampusIds(batch); }

  settleBatch(campusId: string, storeIds?: string[]) {
    return this.orders.settleBatch(campusId, storeIds);
  }

  settlements(campusId: string) {
    return this.orders.settlements(campusId);
  }

  markBatchPaid(operator: string, batch: string, remark: string) {
    return this.orders.markBatchPaid(batch, operator, remark);
  }
}
