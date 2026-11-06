import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { OFFICIAL_CAMPUS_ID } from '../common/campus';
import { parsePagination } from '../common/pagination';

type Tx = Prisma.TransactionClient;
export interface NightCatalogFilters {
  status?: string;
  categoryId?: string;
  stock?: string;
  source?: string;
}
export interface NightOperationFilters {
  keyword?: string;
  from?: string;
  to?: string;
  kind?: string;
}
export interface NightBuildingProductFilters extends NightCatalogFilters {
  storeId?: string;
  keyword?: string;
  saleAllowed?: string;
  onShelf?: string;
}
export interface StockLine {
  catalogProductId: string;
  warehouseProductId: string;
  nightProductId?: string;
  name: string;
  image?: string;
  price: number;
  quantity: number;
  receivedQuantity?: number;
}
export interface ReportLine {
  nightProductId: string;
  name: string;
  quantity: number;
  delta: number;
  value: number;
  unitValue: number;
  bookQuantity: number;
  countedQuantity?: number;
}
export const stockLines = (v: unknown): StockLine[] =>
  JSON.parse(JSON.stringify(v)) as StockLine[];
export const reportLines = (v: unknown): ReportLine[] =>
  JSON.parse(JSON.stringify(v)) as ReportLine[];
const json = (v: unknown) =>
  JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
const money = (n: number) => {
  if (!Number.isSafeInteger(n) || n < 0 || n > 2_147_483_647)
    throw new BadRequestException('货值超出允许范围');
  return n;
};
/** 移动平均分摊，最后一件携带尾差；不按当前售价重估历史库存。 */
export function allocateInventoryValue(
  value: number,
  stock: number,
  qty: number,
) {
  if (!Number.isInteger(qty) || qty < 0 || qty > stock)
    throw new BadRequestException('库存数量不足');
  return qty === stock ? value : Math.floor((value * qty) / stock);
}

@Injectable()
export class NightInventoryService {
  constructor(private readonly db: PrismaService) {}

  async catalog(
    campusId: string,
    keyword?: string,
    filters: NightCatalogFilters = {},
  ) {
    this.checkChoice(filters.status, ['on-sale', 'off-sale']);
    this.checkChoice(filters.stock, ['available', 'empty', 'unlinked']);
    this.checkChoice(filters.source, ['official', 'manual']);
    const rows = await this.db.product.findMany({
      where: {
        campusId,
        nightCatalog: true,
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.categoryId ? { categoryId: filters.categoryId } : {}),
        ...(filters.source
          ? {
              sourceProductId:
                filters.source === 'official' ? { not: null } : null,
            }
          : {}),
        ...(keyword
          ? {
              OR: [
                { name: { contains: keyword, mode: 'insensitive' as const } },
                {
                  nightBarcode: {
                    contains: keyword,
                    mode: 'insensitive' as const,
                  },
                },
                {
                  warehouseProduct: {
                    barcode: {
                      contains: keyword,
                      mode: 'insensitive' as const,
                    },
                  },
                },
              ],
            }
          : {}),
      },
      include: {
        warehouseProduct: true,
        category: { select: { id: true, name: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });
    return rows
      .map((p) => ({
        id: p.id,
        name: p.name,
        subtitle: p.subtitle,
        categoryId: p.categoryId,
        categoryName: p.category.name,
        image: p.image,
        price: p.price,
        originalPrice: p.originalPrice,
        barcode: p.nightBarcode || p.warehouseProduct?.barcode || p.barcode,
        status: p.status,
        sourceProductId: p.sourceProductId,
        warehouseProductId: p.warehouseProductId,
        warehouseAvailable: p.warehouseProduct
          ? p.warehouseProduct.stock - p.warehouseProduct.lockedStock
          : 0,
        warehouseReserved: p.warehouseProduct?.nightReservedStock ?? 0,
        retailUnit: p.retailUnit,
        updatedAt: p.updatedAt.toISOString(),
      }))
      .filter(
        (p) =>
          !filters.stock ||
          (filters.stock === 'unlinked'
            ? !p.warehouseProductId
            : filters.stock === 'available'
              ? p.warehouseAvailable > 0
              : Boolean(p.warehouseProductId) && p.warehouseAvailable <= 0),
      );
  }

  private checkChoice(value: string | undefined, choices: string[]) {
    if (value && !choices.includes(value))
      throw new BadRequestException('筛选条件无效，请刷新页面');
  }

  async catalogCategories(campusId: string) {
    return this.db.category.findMany({
      where: { campusId },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  private createdRange(filters: NightOperationFilters) {
    const result: { gte?: Date; lte?: Date } = {};
    for (const [key, value] of [
      ['gte', filters.from],
      ['lte', filters.to],
    ] as const) {
      if (!value) continue;
      const date = new Date(
        `${value}T${key === 'gte' ? '00:00:00.000' : '23:59:59.999'}+08:00`,
      );
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(date.getTime()) ||
        new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(
          date,
        ) !== value
      )
        throw new BadRequestException('日期格式无效');
      result[key] = date;
    }
    if (result.gte && result.lte && result.gte > result.lte)
      throw new BadRequestException('开始日期不能晚于结束日期');
    return Object.keys(result).length ? result : undefined;
  }

  async campusProducts(
    campusId: string,
    filters: NightBuildingProductFilters = {},
  ) {
    if (!campusId) throw new BadRequestException('请先选择校区');
    this.checkChoice(filters.stock, ['available', 'empty', 'frozen']);
    this.checkChoice(filters.saleAllowed, ['true', 'false']);
    this.checkChoice(filters.onShelf, ['true', 'false']);
    const q = filters.keyword?.trim();
    const rows = await this.db.nightProduct.findMany({
      where: {
        store: { campusId },
        ...(filters.storeId ? { storeId: filters.storeId } : {}),
        ...(filters.categoryId
          ? { catalogProduct: { categoryId: filters.categoryId } }
          : {}),
        ...(filters.saleAllowed
          ? { saleAllowed: filters.saleAllowed === 'true' }
          : {}),
        ...(filters.onShelf ? { onShelf: filters.onShelf === 'true' } : {}),
        ...(filters.stock === 'available'
          ? { stock: { gt: 0 } }
          : filters.stock === 'empty'
            ? { stock: 0 }
            : filters.stock === 'frozen'
              ? { frozenStock: { gt: 0 } }
              : {}),
        ...(q
          ? {
              OR: [
                {
                  catalogProduct: {
                    name: { contains: q, mode: 'insensitive' as const },
                  },
                },
                {
                  catalogProduct: {
                    nightBarcode: { contains: q, mode: 'insensitive' as const },
                  },
                },
                {
                  store: {
                    building: {
                      name: { contains: q, mode: 'insensitive' as const },
                    },
                  },
                },
                {
                  store: {
                    managerStaff: {
                      name: { contains: q, mode: 'insensitive' as const },
                    },
                  },
                },
              ],
            }
          : {}),
      },
      include: {
        catalogProduct: { include: { category: { select: { name: true } } } },
        store: {
          include: {
            building: { select: { name: true } },
            managerStaff: { select: { name: true } },
          },
        },
      },
      orderBy: [{ storeId: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((p) => ({
      id: p.id,
      storeId: p.storeId,
      buildingName: p.store.building.name,
      managerName: p.store.managerStaff?.name ?? '',
      catalogProductId: p.catalogProductId,
      name: p.catalogProduct.name,
      barcode: p.catalogProduct.nightBarcode,
      image: p.catalogProduct.image,
      categoryName: p.catalogProduct.category.name,
      price: p.catalogProduct.price,
      catalogStatus: p.catalogProduct.status,
      stock: p.stock,
      frozenStock: p.frozenStock,
      inventoryValue: p.inventoryValue,
      onShelf: p.onShelf,
      saleAllowed: p.saleAllowed,
      purchasable:
        p.stock > 0 &&
        p.onShelf &&
        p.saleAllowed &&
        p.catalogProduct.status === 'on-sale',
    }));
  }

  async catalogCandidates(keyword?: string) {
    return this.db.product.findMany({
      where: {
        campusId: OFFICIAL_CAMPUS_ID,
        catalogScope: 'platform',
        status: 'on-sale',
        ...(keyword
          ? {
              OR: [
                { name: { contains: keyword, mode: 'insensitive' as const } },
                {
                  barcode: { contains: keyword, mode: 'insensitive' as const },
                },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        name: true,
        image: true,
        barcode: true,
        originalPrice: true,
        retailUnit: true,
        unitsPerCase: true,
      },
      orderBy: { name: 'asc' },
    });
  }

  async importCatalog(
    operator: string,
    campusId: string,
    productIds: string[],
  ) {
    if (!campusId || campusId === OFFICIAL_CAMPUS_ID)
      throw new BadRequestException('请选择真实校区');
    const campus = await this.db.campus.findUnique({ where: { id: campusId } });
    if (!campus || campus.type !== 'campus')
      throw new BadRequestException('导入目标必须是经营校区');
    const ids = [...new Set(productIds)];
    if (!ids.length || ids.length > 100)
      throw new BadRequestException('每次选择1至100种商品');
    return this.db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`night-catalog-${campusId}`}))::text`;
        const officials = await tx.product.findMany({
          where: {
            id: { in: ids },
            campusId: OFFICIAL_CAMPUS_ID,
            catalogScope: 'platform',
            status: 'on-sale',
          },
          include: { category: true },
          orderBy: { id: 'asc' },
        });
        if (officials.length !== ids.length)
          throw new BadRequestException('包含无效或已下架的官方商品，请刷新');
        const imported: string[] = [];
        for (const official of officials) {
          const exists = await tx.product.findFirst({
            where: {
              campusId,
              nightCatalog: true,
              sourceProductId: official.id,
            },
          });
          if (exists) continue;
          const category = await tx.category.upsert({
            where: {
              campusId_name: { campusId, name: official.category.name },
            },
            create: { campusId, name: official.category.name },
            update: {},
          });
          let warehouse = await tx.product.findFirst({
            where: {
              campusId,
              nightCatalog: false,
              OR: [
                { sourceProductId: official.id },
                ...(official.barcode ? [{ barcode: official.barcode }] : []),
              ],
            },
          });
          const shared = {
            name: official.name,
            subtitle: official.subtitle,
            image: official.image,
            images: official.images ?? Prisma.JsonNull,
            description: official.description,
            weight: official.weight,
            retailUnit: official.retailUnit,
            wholesaleUnit: official.wholesaleUnit,
            unitsPerCase: official.unitsPerCase,
            tag: official.tag,
            sourceProductId: official.id,
            sourceSyncedAt: official.updatedAt,
            categoryId: category.id,
            campusId,
            catalogScope: 'campus',
          };
          if (!warehouse)
            warehouse = await tx.product.create({
              data: {
                ...shared,
                barcode: official.barcode,
                price: official.price,
                originalPrice: official.originalPrice,
                stock: 0,
                status: 'off-sale',
                costPrice: official.costPrice,
                wholesalePrice: official.price,
                procurementMode: 'HQ',
              },
            });
          const duplicate = await tx.product.findFirst({
            where: {
              campusId,
              nightCatalog: true,
              warehouseProductId: warehouse.id,
            },
          });
          if (duplicate) {
            await tx.product.update({
              where: { id: duplicate.id },
              data: { sourceProductId: official.id },
            });
            continue;
          }
          const product = await tx.product.create({
            data: {
              ...shared,
              nightCatalog: true,
              warehouseProductId: warehouse.id,
              nightBarcode: official.barcode,
              price:
                official.originalPrice > 0
                  ? official.originalPrice
                  : official.price,
              originalPrice: official.originalPrice,
              stock: 0,
              status: 'off-sale',
              barcode: null,
            },
          });
          imported.push(product.id);
          await tx.auditLog.create({
            data: {
              operator,
              campusId,
              action: 'night.catalog.import',
              entityType: 'product',
              entityId: product.id,
              after: json({
                sourceProductId: official.id,
                warehouseProductId: warehouse.id,
                status: 'off-sale',
              }),
            },
          });
        }
        return {
          importedCount: imported.length,
          importedProductIds: imported,
          skippedCount: ids.length - imported.length,
        };
      },
      { timeout: 30000 },
    );
  }

  async myStore(staffId: string) {
    const staff = await this.db.staff.findUnique({ where: { id: staffId } });
    if (
      !staff ||
      staff.status === 'deleted' ||
      !['building-manager', 'intern-building-manager'].includes(staff.role)
    )
      throw new ForbiddenException('仅绑定在职楼长可管理库存');
    const store = await this.db.nightStore.findFirst({
      where: { managerStaffId: staffId, campusId: staff.campusId },
    });
    if (!store) throw new NotFoundException('尚未绑定夜宵店，请联系校区');
    return store;
  }

  async lockStore(tx: Tx, storeId: string, staffId?: string) {
    await tx.$queryRaw`SELECT id FROM "NightStore" WHERE id = ${storeId} FOR UPDATE`;
    const store = await tx.nightStore.findUnique({ where: { id: storeId } });
    if (!store) throw new NotFoundException('夜宵店不存在');
    if (staffId && store.managerStaffId !== staffId)
      throw new ForbiddenException('经营资格已变化，请刷新');
    return store;
  }

  /** 所有占用均保存历史货值。暂停/下架/调价不会释放或重估。 */
  async summary(storeId: string, tx: Tx = this.db) {
    const [store, available, orders, requests, reports, refunds, depositRefunds] = await Promise.all([
      tx.nightStore.findUniqueOrThrow({ where: { id: storeId } }),
      tx.nightProduct.aggregate({
        where: { storeId },
        _sum: { inventoryValue: true },
      }),
      tx.nightOrder.aggregate({
        where: { storeId },
        _sum: { quotaHeld: true },
      }),
      tx.nightStockOrder.aggregate({
        where: { storeId },
        _sum: { heldValue: true },
      }),
      tx.nightInventoryReport.findMany({
        where: { storeId, heldValue: { gt: 0 } },
        select: { kind: true, heldValue: true },
      }),
      tx.nightRefund.aggregate({ where: { storeId }, _sum: { heldValue: true } }),
      tx.nightDepositRefund.aggregate({ where: { storeId, status: { in: ['requested', 'submitting', 'processing', 'unknown'] } }, _sum: { amount: true } }),
    ]);
    const frozenValue = reports
      .filter((r) => r.kind !== 'receipt-shortage')
      .reduce((s, r) => s + r.heldValue, 0);
    const shortageValue = reports
      .filter((r) => r.kind === 'receipt-shortage')
      .reduce((s, r) => s + r.heldValue, 0);
    const stockValue =
      (available._sum.inventoryValue ?? 0) +
      (orders._sum.quotaHeld ?? 0) +
      frozenValue;
    const refundReservedValue = refunds._sum.heldValue ?? 0;
    const depositRefundReservedValue = depositRefunds._sum.amount ?? 0;
    const reservedValue = (requests._sum.heldValue ?? 0) + shortageValue + refundReservedValue + depositRefundReservedValue;
    return {
      deposit: store.deposit,
      stockValue,
      reservedValue,
      refundReservedValue,
      depositRefundReservedValue,
      frozenValue,
      shortageValue,
      usedQuota: stockValue + reservedValue,
      usableQuota: Math.max(0, store.deposit - stockValue - reservedValue),
    };
  }

  async depositTransactions(storeId: string, page?: string, pageSize?: string, kind?: string) {
    this.checkChoice(kind, ['deposit', 'deduct', 'refund']);
    const paging = parsePagination(page, pageSize);
    const where = { storeId, ...(kind ? { type: kind } : {}) };
    const [items, total] = await Promise.all([
      this.db.nightDepositTxn.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (paging.page - 1) * paging.pageSize, take: paging.pageSize }),
      this.db.nightDepositTxn.count({ where }),
    ]);
    return { items: items.map(row => ({ ...row, createdAt: row.createdAt.toISOString() })), total, ...paging };
  }

  async stockPool(staffId: string) {
    const store = await this.myStore(staffId);
    const [catalog, products] = await Promise.all([
      this.db.product.findMany({
        where: {
          campusId: store.campusId,
          nightCatalog: true,
          status: 'on-sale',
        },
        include: {
          warehouseProduct: true,
          category: { select: { name: true } },
        },
        orderBy: { name: 'asc' },
      }),
      this.db.nightProduct.findMany({ where: { storeId: store.id } }),
    ]);
    return catalog.map((p) => {
      const row = products.find((x) => x.catalogProductId === p.id);
      const validWarehouse =
        p.warehouseProduct?.campusId === store.campusId &&
        !p.warehouseProduct?.nightCatalog;
      return {
        catalogProductId: p.id,
        barcode: p.nightBarcode || p.warehouseProduct?.barcode || p.barcode,
        categoryName: p.category.name,
        name: p.name,
        image: p.image,
        price: p.price,
        status: p.status,
        retailUnit: p.retailUnit,
        attached: Boolean(row),
        nightProductId: row?.id ?? null,
        stock: row?.stock ?? 0,
        stockValue: row?.inventoryValue ?? 0,
        onShelf: row?.onShelf ?? false,
        saleAllowed: row?.saleAllowed ?? true,
        warehouseAvailable: validWarehouse
          ? Math.max(
              0,
              p.warehouseProduct!.stock - p.warehouseProduct!.lockedStock,
            )
          : 0,
        canStock: Boolean(validWarehouse && (row?.saleAllowed ?? true)),
        unavailableReason: !validWarehouse
          ? '待校区关联仓库商品'
          : row?.saleAllowed === false
            ? '校区已停售'
            : '',
      };
    });
  }

  async products(staffId: string) {
    const store = await this.myStore(staffId);
    const rows = await this.db.nightProduct.findMany({
      where: { storeId: store.id },
      include: { catalogProduct: true },
      orderBy: { createdAt: 'asc' },
    });
    const orders = await this.db.nightOrder.findMany({
      where: {
        storeId: store.id,
        status: { in: ['pending-payment', 'pending-accept', 'delivering'] },
      },
      select: { items: true },
    });
    const pending = new Map<string, number>();
    for (const order of orders)
      for (const line of stockLines(order.items))
        if (line.nightProductId)
          pending.set(
            line.nightProductId,
            (pending.get(line.nightProductId) ?? 0) + line.quantity,
          );
    return rows.map((p) => ({
      id: p.id,
      catalogProductId: p.catalogProductId,
      name: p.catalogProduct.name,
      image: p.catalogProduct.image,
      price: p.catalogProduct.price,
      retailUnit: p.catalogProduct.retailUnit,
      stock: p.stock,
      frozenStock: p.frozenStock,
      inventoryValue: p.inventoryValue,
      inventoryVersion: p.inventoryVersion,
      pendingQuantity: pending.get(p.id) ?? 0,
      onShelf: p.onShelf,
      saleAllowed: p.saleAllowed,
      catalogStatus: p.catalogProduct.status,
      purchasable:
        p.stock > 0 &&
        p.onShelf &&
        p.saleAllowed &&
        p.catalogProduct.status === 'on-sale',
    }));
  }

  async createStockOrder(
    staffId: string,
    dto: {
      requestId?: string;
      items: Array<{ catalogProductId: string; quantity: number }>;
    },
  ) {
    const store = await this.myStore(staffId);
    const merged = new Map<string, number>();
    for (const item of dto.items) {
      if (
        !Number.isInteger(item.quantity) ||
        item.quantity < 1 ||
        item.quantity > 9999
      )
        throw new BadRequestException('备货数量须为1至9999的整数');
      merged.set(
        item.catalogProductId,
        (merged.get(item.catalogProductId) ?? 0) + item.quantity,
      );
    }
    if (!merged.size || merged.size > 100)
      throw new BadRequestException('请选择1至100种商品');
    const requestId = dto.requestId || randomUUID();
    return this.db.$transaction(
      async (tx) => {
        const fresh = await this.lockStore(tx, store.id, staffId);
        const previous = await tx.nightStockOrder.findUnique({
          where: { storeId_requestId: { storeId: store.id, requestId } },
        });
        if (previous) {
          if (previous.managerStaffId !== staffId)
            throw new ForbiddenException('备货单不属于当前经营者');
          const old = stockLines(previous.items);
          if (
            old.length !== merged.size ||
            old.some((l) => merged.get(l.catalogProductId) !== l.quantity)
          )
            throw new BadRequestException('重复请求的商品数量与原单不一致');
          return this.stockView(previous);
        }
        if (fresh.status === 'suspended')
          throw new BadRequestException('店铺已停业，暂不能申请备货');
        const catalog = await tx.product.findMany({
          where: {
            id: { in: [...merged.keys()] },
            campusId: store.campusId,
            nightCatalog: true,
            status: 'on-sale',
          },
          include: { warehouseProduct: true },
          orderBy: { id: 'asc' },
        });
        if (catalog.length !== merged.size)
          throw new BadRequestException('商品已下架或不属于本校区，请刷新');
        const mine = await tx.nightProduct.findMany({
          where: {
            storeId: store.id,
            catalogProductId: { in: [...merged.keys()] },
          },
        });
        const items: StockLine[] = catalog.map((p) => {
          if (
            !p.warehouseProduct ||
            p.warehouseProduct.campusId !== store.campusId ||
            p.warehouseProduct.nightCatalog
          )
            throw new BadRequestException(`${p.name}尚未关联校区仓库商品`);
          if (mine.some((x) => x.catalogProductId === p.id && !x.saleAllowed))
            throw new BadRequestException(`${p.name}已被校区停售`);
          return {
            catalogProductId: p.id,
            warehouseProductId: p.warehouseProduct.id,
            name: p.name,
            image: p.image,
            price: p.price,
            quantity: merged.get(p.id)!,
          };
        });
        const totalValue = money(
          items.reduce((s, i) => s + i.price * i.quantity, 0),
        );
        const quota = await this.summary(store.id, tx);
        if (totalValue > quota.usableQuota)
          throw new BadRequestException(
            `押金额度不足：超出押金 ${((totalValue - quota.usableQuota) / 100).toFixed(2)} 元，请先补缴押金`,
          );
        for (const item of items) {
          const row = await tx.nightProduct.upsert({
            where: {
              storeId_catalogProductId: {
                storeId: store.id,
                catalogProductId: item.catalogProductId,
              },
            },
            create: {
              storeId: store.id,
              catalogProductId: item.catalogProductId,
              stock: 0,
              inventoryValue: 0,
              onShelf: true,
            },
            update: {},
          });
          item.nightProductId = row.id;
        }
        const order = await tx.nightStockOrder.create({
          data: {
            storeId: store.id,
            managerStaffId: staffId,
            requestId,
            items: json(items),
            totalValue,
            heldValue: totalValue,
            status: 'requested',
          },
        });
        return this.stockView(order);
      },
      { timeout: 20000 },
    );
  }

  stockView(order: {
    id: string;
    status: string;
    items: Prisma.JsonValue;
    totalValue: number;
    heldValue: number;
    reason: string;
    createdAt: Date;
    reviewedAt: Date | null;
    shippedAt: Date | null;
    receivedAt: Date | null;
    storeId: string;
    managerStaffId: string;
  }) {
    return {
      ...order,
      items: stockLines(order.items),
      createdAt: order.createdAt.toISOString(),
      reviewedAt: order.reviewedAt?.toISOString() ?? null,
      shippedAt: order.shippedAt?.toISOString() ?? null,
      receivedAt: order.receivedAt?.toISOString() ?? null,
    };
  }

  async stockOrders(storeId: string, staffId?: string) {
    const orders = await this.db.nightStockOrder.findMany({
      where: { storeId, ...(staffId ? { managerStaffId: staffId } : {}) },
      orderBy: { createdAt: 'desc' },
    });
    return orders.map((o) => this.stockView(o));
  }

  async stockOrdersPage(storeId: string, staffId: string, status?: string, page?: string, pageSize?: string) {
    this.checkChoice(status, ['all', 'requested', 'approved', 'shipped', 'received', 'rejected', 'cancelled', 'completed']);
    const paging = parsePagination(page, pageSize);
    const where = { storeId, managerStaffId: staffId, ...(status && status !== 'all' ? { status } : {}) };
    const [rows, total] = await Promise.all([
      this.db.nightStockOrder.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (paging.page - 1) * paging.pageSize, take: paging.pageSize }),
      this.db.nightStockOrder.count({ where }),
    ]);
    return { items: rows.map(row => this.stockView(row)), total, ...paging };
  }

  async stockOrderStore(id: string) {
    const row = await this.db.nightStockOrder.findUnique({
      where: { id },
      select: { storeId: true },
    });
    if (!row) throw new NotFoundException('备货单不存在');
    return row.storeId;
  }
  async reportStore(id: string) {
    const row = await this.db.nightInventoryReport.findUnique({
      where: { id },
      select: { storeId: true },
    });
    if (!row) throw new NotFoundException('报告不存在');
    return row.storeId;
  }
  async campusStockOrders(
    campusId: string,
    status?: string,
    storeId?: string,
    filters: NightOperationFilters = {},
  ) {
    if (!campusId && !storeId) throw new BadRequestException('请先选择校区');
    this.checkChoice(status, [
      'all',
      'requested',
      'approved',
      'shipped',
      'received',
      'rejected',
      'cancelled',
      'completed',
    ]);
    const rows = await this.db.nightStockOrder.findMany({
      where: {
        store: { ...(campusId ? { campusId } : {}) },
        ...(storeId ? { storeId } : {}),
        ...(status && status !== 'all' ? { status } : {}),
        createdAt: this.createdRange(filters),
      },
      include: {
        store: {
          include: {
            building: { select: { name: true } },
            managerStaff: { select: { name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows
      .map((o) => ({
        ...this.stockView(o),
        buildingName: o.store.building.name,
        managerName: o.store.managerStaff?.name ?? '',
      }))
      .filter((row) => this.matchesOperation(row, filters.keyword));
  }
  async campusReports(
    campusId: string,
    status?: string,
    storeId?: string,
    filters: NightOperationFilters = {},
  ) {
    if (!campusId && !storeId) throw new BadRequestException('请先选择校区');
    this.checkChoice(status, ['all', 'pending', 'approved', 'rejected']);
    this.checkChoice(filters.kind, [
      'loss',
      'stocktake',
      'receipt-shortage',
      'order-loss',
    ]);
    const rows = await this.db.nightInventoryReport.findMany({
      where: {
        store: { ...(campusId ? { campusId } : {}) },
        ...(storeId ? { storeId } : {}),
        ...(status && status !== 'all' ? { status } : {}),
        ...(filters.kind ? { kind: filters.kind } : {}),
        createdAt: this.createdRange(filters),
      },
      include: {
        store: {
          include: {
            building: { select: { name: true } },
            managerStaff: { select: { name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows
      .map((r) => ({
        ...r,
        buildingName: r.store.building.name,
        managerName: r.store.managerStaff?.name ?? '',
      }))
      .filter((row) => this.matchesOperation(row, filters.keyword));
  }

  private matchesOperation(
    row: {
      id: string;
      buildingName: string;
      managerName: string;
      reason: string;
      items: unknown;
      reviewReason?: string;
    },
    keyword?: string,
  ) {
    const q = keyword?.trim().toLowerCase();
    return (
      !q ||
      `${row.id} ${row.buildingName} ${row.managerName} ${row.reason} ${row.reviewReason ?? ''} ${JSON.stringify(row.items)}`
        .toLowerCase()
        .includes(q)
    );
  }
  async transactions(storeId: string, productId?: string) {
    return this.db.nightStockTxn.findMany({
      where: { storeId, ...(productId ? { nightProductId: productId } : {}) },
      include: {
        product: { select: { catalogProduct: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async transactionsPage(storeId: string, productId?: string, page?: string, pageSize?: string) {
    const paging = parsePagination(page, pageSize);
    const where = { storeId, ...(productId ? { nightProductId: productId } : {}) };
    const [items, total] = await Promise.all([
      this.db.nightStockTxn.findMany({ where, include: { product: { select: { catalogProduct: { select: { name: true } } } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (paging.page - 1) * paging.pageSize, take: paging.pageSize }),
      this.db.nightStockTxn.count({ where }),
    ]);
    return { items, total, ...paging };
  }

  private warehouseQuantities(items: StockLine[]) {
    const map = new Map<string, number>();
    for (const line of items) {
      if (!line.warehouseProductId)
        throw new BadRequestException('历史一步制备货单不支持审核/出库');
      map.set(
        line.warehouseProductId,
        (map.get(line.warehouseProductId) ?? 0) + line.quantity,
      );
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }

  async reviewStockOrder(
    operator: string,
    id: string,
    approved: boolean,
    reason: string,
  ) {
    if (!approved && !reason.trim())
      throw new BadRequestException('请填写驳回原因');
    const raw = await this.db.nightStockOrder.findUniqueOrThrow({
      where: { id },
    });
    return this.db.$transaction(
      async (tx) => {
        await this.lockStore(tx, raw.storeId);
        const order = await tx.nightStockOrder.findUniqueOrThrow({
          where: { id },
        });
        const status = approved ? 'approved' : 'rejected';
        if (order.status === status) return this.stockView(order);
        if (order.status !== 'requested')
          throw new BadRequestException('仅待审核备货单可以审核');
        if (approved)
          for (const [productId, qty] of this.warehouseQuantities(
            stockLines(order.items),
          )) {
            const updated =
              await tx.$executeRaw`UPDATE "Product" SET stock = stock - ${qty}, "nightReservedStock" = "nightReservedStock" + ${qty}
          WHERE id = ${productId} AND "campusId" = (SELECT "campusId" FROM "NightStore" WHERE id = ${order.storeId})
          AND "nightCatalog" = false AND stock - "lockedStock" >= ${qty}`;
            if (!updated)
              throw new BadRequestException(
                '仓库可用库存不足，整单不能通过审核',
              );
          }
        const after = await tx.nightStockOrder.update({
          where: { id },
          data: {
            status,
            reviewedBy: operator,
            reviewedAt: new Date(),
            reason: reason.trim(),
            ...(!approved ? { heldValue: 0 } : {}),
          },
        });
        await this.audit(
          tx,
          operator,
          'night.stock.review',
          order.storeId,
          id,
          { status, reason },
        );
        return this.stockView(after);
      },
      { timeout: 20000 },
    );
  }

  async cancelStockOrder(
    id: string,
    actor: { staffId?: string; operatorId?: string },
    reason = '',
  ) {
    const raw = await this.db.nightStockOrder.findUniqueOrThrow({
      where: { id },
    });
    if (actor.staffId) {
      const store = await this.myStore(actor.staffId);
      if (store.id !== raw.storeId || raw.managerStaffId !== actor.staffId)
        throw new ForbiddenException('无权撤回该备货单');
    }
    return this.db.$transaction(
      async (tx) => {
        await this.lockStore(tx, raw.storeId, actor.staffId);
        const order = await tx.nightStockOrder.findUniqueOrThrow({
          where: { id },
        });
        if (order.status === 'cancelled') return this.stockView(order);
        if (actor.staffId && order.status !== 'requested')
          throw new BadRequestException('已审核备货单请联系校区取消');
        if (!['requested', 'approved'].includes(order.status))
          throw new BadRequestException('已出库的备货单不能取消');
        if (order.status === 'approved')
          for (const [productId, qty] of this.warehouseQuantities(
            stockLines(order.items),
          )) {
            const updated = await tx.product.updateMany({
              where: { id: productId, nightReservedStock: { gte: qty } },
              data: {
                stock: { increment: qty },
                nightReservedStock: { decrement: qty },
              },
            });
            if (!updated.count)
              throw new BadRequestException('仓库预留库存异常，请先核对');
          }
        const after = await tx.nightStockOrder.update({
          where: { id },
          data: { status: 'cancelled', heldValue: 0, reason: reason.trim() },
        });
        await this.audit(
          tx,
          actor.operatorId || actor.staffId!,
          'night.stock.cancel',
          order.storeId,
          id,
          { reason },
        );
        return this.stockView(after);
      },
      { timeout: 20000 },
    );
  }

  async shipStockOrder(operator: string, id: string) {
    const raw = await this.db.nightStockOrder.findUniqueOrThrow({
      where: { id },
    });
    return this.db.$transaction(
      async (tx) => {
        await this.lockStore(tx, raw.storeId);
        const order = await tx.nightStockOrder.findUniqueOrThrow({
          where: { id },
        });
        if (['shipped', 'received'].includes(order.status))
          return this.stockView(order);
        if (order.status !== 'approved')
          throw new BadRequestException('仅已审核备货单可出库');
        for (const [productId, qty] of this.warehouseQuantities(
          stockLines(order.items),
        )) {
          const updated = await tx.product.updateMany({
            where: { id: productId, nightReservedStock: { gte: qty } },
            data: { nightReservedStock: { decrement: qty } },
          });
          if (!updated.count)
            throw new BadRequestException('仓库预留库存异常，请先核对');
          await tx.inventoryTxn.create({
            data: {
              productId,
              type: 'night-stock-out',
              delta: -qty,
              operator,
              reason: `夜宵备货出库 ${id}`,
            },
          });
        }
        const after = await tx.nightStockOrder.update({
          where: { id },
          data: {
            status: 'shipped',
            shippedBy: operator,
            shippedAt: new Date(),
          },
        });
        await this.audit(tx, operator, 'night.stock.ship', order.storeId, id, {
          status: 'shipped',
        });
        return this.stockView(after);
      },
      { timeout: 20000 },
    );
  }

  async receiveStockOrder(
    staffId: string,
    id: string,
    received: Array<{ catalogProductId: string; quantity: number }>,
  ) {
    const store = await this.myStore(staffId);
    return this.db.$transaction(
      async (tx) => {
        await this.lockStore(tx, store.id, staffId);
        const order = await tx.nightStockOrder.findFirst({
          where: { id, storeId: store.id, managerStaffId: staffId },
        });
        if (!order) throw new NotFoundException('备货单不存在');
        const items = stockLines(order.items);
        const quantities = new Map(
          received.map((x) => [x.catalogProductId, x.quantity]),
        );
        if (
          quantities.size !== received.length ||
          quantities.size !== items.length ||
          items.some((i) => !quantities.has(i.catalogProductId))
        )
          throw new BadRequestException('请逐项填写本单实收数量');
        if (order.status === 'received') {
          if (
            items.some(
              (i) => i.receivedQuantity !== quantities.get(i.catalogProductId),
            )
          )
            throw new BadRequestException('已确认收货，不能修改实收数量');
          return this.stockView(order);
        }
        if (order.status !== 'shipped')
          throw new BadRequestException('校区出库后才能确认收货');
        const shortage: ReportLine[] = [];
        for (const item of items) {
          const quantity = quantities.get(item.catalogProductId)!;
          if (
            !Number.isInteger(quantity) ||
            quantity < 0 ||
            quantity > item.quantity
          )
            throw new BadRequestException(
              `${item.name}实收数量须介于0和出库数量之间`,
            );
          const row = await tx.nightProduct.upsert({
            where: {
              storeId_catalogProductId: {
                storeId: store.id,
                catalogProductId: item.catalogProductId,
              },
            },
            create: {
              storeId: store.id,
              catalogProductId: item.catalogProductId,
              stock: quantity,
              inventoryValue: money(quantity * item.price),
              onShelf: true,
              inventoryVersion: 1,
            },
            update: {
              stock: { increment: quantity },
              inventoryValue: { increment: money(quantity * item.price) },
              inventoryVersion: { increment: 1 },
            },
          });
          item.nightProductId = row.id;
          item.receivedQuantity = quantity;
          if (quantity)
            await this.stockTxn(
              tx,
              row,
              'stockIn',
              quantity,
              'night-stock-order',
              id,
              staffId,
              '实收确认入库',
            );
          if (quantity < item.quantity)
            shortage.push({
              nightProductId: row.id,
              name: item.name,
              quantity: item.quantity - quantity,
              delta: 0,
              value: (item.quantity - quantity) * item.price,
              unitValue: item.price,
              bookQuantity: item.quantity,
              countedQuantity: quantity,
            });
        }
        if (shortage.length)
          await tx.nightInventoryReport.create({
            data: {
              storeId: store.id,
              managerStaffId: staffId,
              kind: 'receipt-shortage',
              requestId: `receipt-${id}`,
              stockOrderId: id,
              items: json(shortage),
              heldValue: shortage.reduce((s, i) => s + i.value, 0),
              reason: '收货数量少于出库数量，待校区核对',
            },
          });
        const after = await tx.nightStockOrder.update({
          where: { id },
          data: {
            items: json(items),
            status: 'received',
            heldValue: 0,
            receivedAt: new Date(),
          },
        });
        await this.audit(tx, staffId, 'night.stock.receive', store.id, id, {
          received,
        });
        return this.stockView(after);
      },
      { timeout: 20000 },
    );
  }

  async reports(storeId: string, staffId?: string) {
    return this.db.nightInventoryReport.findMany({
      where: { storeId, ...(staffId ? { managerStaffId: staffId } : {}) },
      orderBy: { createdAt: 'desc' },
    });
  }

  async reportsPage(storeId: string, staffId: string, page?: string, pageSize?: string) {
    const paging = parsePagination(page, pageSize);
    const where = { storeId, managerStaffId: staffId };
    const [items, total] = await Promise.all([
      this.db.nightInventoryReport.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (paging.page - 1) * paging.pageSize, take: paging.pageSize }),
      this.db.nightInventoryReport.count({ where }),
    ]);
    return { items, total, ...paging };
  }

  async createReport(
    staffId: string,
    dto: {
      requestId: string;
      kind: 'loss' | 'stocktake';
      reason: string;
      photos?: string[];
      items: Array<{
        nightProductId: string;
        quantity: number;
        inventoryVersion: number;
      }>;
    },
  ) {
    if (
      !dto.reason.trim() ||
      !dto.items.length ||
      dto.items.length > 100 ||
      new Set(dto.items.map((i) => i.nightProductId)).size !== dto.items.length
    )
      throw new BadRequestException('请填写原因并选择不重复的商品');
    const store = await this.myStore(staffId);
    return this.db.$transaction(
      async (tx) => {
        await this.lockStore(tx, store.id, staffId);
        const previous = await tx.nightInventoryReport.findUnique({
          where: {
            storeId_requestId: { storeId: store.id, requestId: dto.requestId },
          },
        });
        if (previous) {
          if (previous.managerStaffId !== staffId)
            throw new ForbiddenException('无权访问原报告');
          const old = reportLines(previous.items);
          if (
            previous.kind !== dto.kind ||
            old.length !== dto.items.length ||
            dto.items.some(
              (i) =>
                !old.some(
                  (o) =>
                    o.nightProductId === i.nightProductId &&
                    (dto.kind === 'loss' ? o.quantity : o.countedQuantity) ===
                      i.quantity,
                ),
            )
          )
            throw new BadRequestException('重复请求内容与原报告不一致');
          return previous;
        }
        const pending = await tx.nightInventoryReport.findMany({
          where: {
            storeId: store.id,
            status: 'pending',
            kind: { not: 'receipt-shortage' },
          },
        });
        const busy = new Set(
          pending.flatMap((r) =>
            reportLines(r.items).map((i) => i.nightProductId),
          ),
        );
        const id = randomUUID();
        const items: ReportLine[] = [];
        for (const selected of dto.items) {
          if (
            !Number.isInteger(selected.quantity) ||
            selected.quantity < 0 ||
            selected.quantity > 99999
          )
            throw new BadRequestException('数量必须是有效非负整数');
          if (busy.has(selected.nightProductId))
            throw new BadRequestException(
              '该商品已有待审核盘点或报损，请先处理',
            );
          const row = await tx.nightProduct.findFirst({
            where: { id: selected.nightProductId, storeId: store.id },
            include: { catalogProduct: true },
          });
          if (!row) throw new NotFoundException('商品不存在或不属于本店');
          if (row.inventoryVersion !== selected.inventoryVersion)
            throw new BadRequestException(
              `${row.catalogProduct.name}库存已变化，请刷新后重新盘点`,
            );
          const delta =
            dto.kind === 'loss'
              ? -selected.quantity
              : selected.quantity - row.stock;
          if (dto.kind === 'loss' && delta === 0)
            throw new BadRequestException('报损数量须大于零');
          const quantity = Math.abs(delta);
          const value = money(
            delta < 0
              ? allocateInventoryValue(row.inventoryValue, row.stock, quantity)
              : Math.round(
                  quantity *
                    (row.stock
                      ? row.inventoryValue / row.stock
                      : row.catalogProduct.price),
                ),
          );
          items.push({
            nightProductId: row.id,
            name: row.catalogProduct.name,
            quantity,
            delta,
            value,
            unitValue: quantity ? value / quantity : 0,
            bookQuantity: row.stock,
            ...(dto.kind === 'stocktake'
              ? { countedQuantity: selected.quantity }
              : {}),
          });
          if (delta < 0) {
            const frozen = await tx.nightProduct.update({
              where: { id: row.id },
              data: {
                stock: { decrement: quantity },
                inventoryValue: { decrement: value },
                frozenStock: { increment: quantity },
                inventoryVersion: { increment: 1 },
              },
            });
            await this.stockTxn(
              tx,
              frozen,
              'reportFreeze',
              -quantity,
              'night-inventory-report',
              id,
              staffId,
              '盘亏/损耗申报冻结，待校区审核',
            );
          }
        }
        if (!items.some((item) => item.delta !== 0))
          throw new BadRequestException('账实一致，无需提交差异报告');
        const report = await tx.nightInventoryReport.create({
          data: {
            id,
            storeId: store.id,
            managerStaffId: staffId,
            requestId: dto.requestId,
            kind: dto.kind,
            reason: dto.reason.trim(),
            photos: json(dto.photos ?? []),
            items: json(items),
            heldValue: items
              .filter((i) => i.delta < 0)
              .reduce((s, i) => s + i.value, 0),
          },
        });
        await this.audit(tx, staffId, 'night.inventory.submit', store.id, id, {
          kind: dto.kind,
          items,
        });
        return report;
      },
      { timeout: 20000 },
    );
  }

  async resubmitShortage(
    staffId: string,
    id: string,
    reason: string,
    photos: string[] = [],
  ) {
    if (!reason.trim()) throw new BadRequestException('请填写补充说明');
    const store = await this.myStore(staffId);
    return this.db.$transaction(async (tx) => {
      await this.lockStore(tx, store.id, staffId);
      const report = await tx.nightInventoryReport.findFirst({
        where: {
          id,
          storeId: store.id,
          managerStaffId: staffId,
          kind: { in: ['receipt-shortage', 'order-loss'] },
        },
      });
      if (!report || report.status !== 'rejected')
        throw new BadRequestException('仅已驳回收货报损可补充重提');
      const after = await tx.nightInventoryReport.update({
        where: { id },
        data: {
          status: 'pending',
          reason: reason.trim(),
          photos: json(photos),
          reviewedAt: null,
          reviewedBy: null,
          reviewReason: '',
        },
      });
      await this.audit(tx, staffId, 'night.inventory.resubmit', store.id, id, {
        reason,
      });
      return after;
    });
  }

  async reviewReport(
    operator: string,
    id: string,
    approved: boolean,
    reason: string,
  ) {
    if (!reason.trim()) throw new BadRequestException('请填写审核说明');
    const raw = await this.db.nightInventoryReport.findUniqueOrThrow({
      where: { id },
    });
    return this.db.$transaction(
      async (tx) => {
        await this.lockStore(tx, raw.storeId);
        const report = await tx.nightInventoryReport.findUniqueOrThrow({
          where: { id },
        });
        const status = approved ? 'approved' : 'rejected';
        if (report.status === status) return report;
        if (report.status !== 'pending')
          throw new BadRequestException('仅待审核报告可处理');
        const externalLoss = ['receipt-shortage', 'order-loss'].includes(
          report.kind,
        );
        if (!externalLoss) {
          if (approved) {
            const gains = reportLines(report.items)
              .filter((item) => item.delta > 0)
              .reduce((sum, item) => sum + item.value, 0);
            const quota = await this.summary(report.storeId, tx);
            if (gains > quota.usableQuota + report.heldValue)
              throw new BadRequestException(
                '盘盈入库超出押金额度，请楼长先补缴押金',
              );
          }
          for (const item of reportLines(report.items)) {
            if (item.delta < 0) {
              const row = await tx.nightProduct.update({
                where: { id: item.nightProductId },
                data: {
                  frozenStock: { decrement: item.quantity },
                  ...(!approved
                    ? {
                        stock: { increment: item.quantity },
                        inventoryValue: { increment: item.value },
                      }
                    : {}),
                  inventoryVersion: { increment: 1 },
                },
              });
              await this.stockTxn(
                tx,
                row,
                approved ? 'loss' : 'reportRelease',
                approved ? 0 : item.quantity,
                'night-inventory-report',
                id,
                operator,
                approved
                  ? '审核通过，冻结数量确认损耗'
                  : '审核驳回，恢复冻结库存',
              );
            } else if (approved && item.delta > 0) {
              const row = await tx.nightProduct.update({
                where: { id: item.nightProductId },
                data: {
                  stock: { increment: item.quantity },
                  inventoryValue: { increment: item.value },
                  inventoryVersion: { increment: 1 },
                },
              });
              await this.stockTxn(
                tx,
                row,
                'stocktake',
                item.quantity,
                'night-inventory-report',
                id,
                operator,
                '盘盈审核入库',
              );
            }
          }
        }
        const after = await tx.nightInventoryReport.update({
          where: { id },
          data: {
            status,
            reviewedBy: operator,
            reviewedAt: new Date(),
            reviewReason: reason.trim(),
            heldValue: externalLoss && !approved ? report.heldValue : 0,
          },
        });
        await this.audit(
          tx,
          operator,
          'night.inventory.review',
          report.storeId,
          id,
          { status, reason },
        );
        return after;
      },
      { timeout: 20000 },
    );
  }

  async stockTxn(
    tx: Tx,
    row: { id: string; storeId: string; stock: number },
    type: string,
    delta: number,
    refType: string,
    refId: string,
    operatorId: string,
    remark: string,
  ) {
    return tx.nightStockTxn.create({
      data: {
        storeId: row.storeId,
        nightProductId: row.id,
        type,
        delta,
        afterStock: row.stock,
        refType,
        refId,
        operatorId,
        remark,
      },
    });
  }

  async audit(
    tx: Tx,
    operator: string,
    action: string,
    storeId: string,
    targetId: string,
    after: unknown,
  ) {
    const store = await tx.nightStore.findUniqueOrThrow({
      where: { id: storeId },
    });
    await tx.auditLog.create({
      data: {
        operator,
        action,
        entityType: 'night-stock',
        entityId: targetId,
        after: json(after),
        campusId: store.campusId,
      },
    });
  }
}
