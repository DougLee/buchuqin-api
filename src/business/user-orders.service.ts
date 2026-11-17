import { BadRequestException, Injectable } from '@nestjs/common';
import { BusinessService } from './business.service';
import { NightOrderService } from '../night/night-order.service';
import { DELIVERING_STATUSES } from '../common/order-state';
import { parsePagination } from '../common/pagination';

export interface UserOrderRow {
  key: string;
  businessType: 'day' | 'night';
  id: string;
  orderNo: string;
  status: string;
  statusText: string;
  createdAt: string;
  timeoutAt: string | null;
  paidAt: string | null;
  storeId?: string;
  payableAmount: number;
  deliveryText: string;
  items: Array<{ id: string; name: string; image: string; quantity: number }>;
  afterSaleStatus?: string;
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function userOrderRow(
  value: unknown,
  type: UserOrderRow['businessType'],
): UserOrderRow {
  const row = record(value),
    store = record(row.store);
  const createdAt = String(row.createdAt || '');
  return {
    key: `${type}:${row.id}`,
    businessType: type,
    id: String(row.id),
    orderNo: String(row.orderNo),
    status: String(row.status),
    statusText: String(row.statusText),
    createdAt,
    timeoutAt:
      type === 'night'
        ? row.timeoutAt
          ? String(row.timeoutAt)
          : null
        : new Date(
            new Date(createdAt).getTime() + BusinessService.PAYMENT_TIMEOUT_MS,
          ).toISOString(),
    ...(store.id ? { storeId: String(store.id) } : {}),
    paidAt: row.paidAt ? String(row.paidAt) : null,
    payableAmount: Number(row.payableAmount),
    deliveryText:
      type === 'night'
        ? `${store.buildingName || '本楼'} · 夜宵配送`
        : String(row.estimatedArrival || ''),
    afterSaleStatus: row.afterSaleStatus
      ? String(row.afterSaleStatus)
      : undefined,
    items: (Array.isArray(row.items) ? row.items : []).map((value) => {
      const line = record(value),
        product = type === 'day' ? record(line.product) : line;
      return {
        id: String(type === 'day' ? product.id : line.nightProductId),
        name: String(product.name || ''),
        image: String(product.image || ''),
        quantity: Number(line.quantity),
      };
    }),
  };
}
export function userOrderPage(
  rows: UserOrderRow[],
  channel = 'all',
  status = 'all',
  page?: string,
  pageSize?: string,
) {
  if (
    !['all', 'day', 'night'].includes(channel) ||
    ![
      'all',
      'pending-payment',
      'delivering',
      'completed',
      'cancelled',
      'refunded',
      'exception',
    ].includes(status)
  )
    throw new BadRequestException('订单筛选条件不正确');
  const progress = new Set([
    ...DELIVERING_STATUSES,
    'pending-accept',
    'delivering',
  ]);
  const terminal = (row: UserOrderRow) =>
    ['completed', 'cancelled', 'refunded'].includes(row.status);
  const filtered = rows
    .filter(
      (row) =>
        (channel === 'all' || row.businessType === channel) &&
        (status === 'all' ||
          (status === 'delivering'
            ? progress.has(row.status)
            : status === 'refunded'
              ? ['refunded', 'cancelling'].includes(row.status) ||
                row.afterSaleStatus === 'refund-processing'
              : row.status === status)),
    )
    .sort(
      (a, b) =>
        Number(terminal(a)) - Number(terminal(b)) ||
        b.createdAt.localeCompare(a.createdAt) ||
        a.key.localeCompare(b.key),
    );
  const paging = parsePagination(page, pageSize);
  return {
    items: filtered.slice(
      (paging.page - 1) * paging.pageSize,
      paging.page * paging.pageSize,
    ),
    total: filtered.length,
    ...paging,
  };
}
@Injectable()
export class UserOrdersService {
  constructor(
    private readonly day: BusinessService,
    private readonly night: NightOrderService,
  ) {}
  async list(
    userId: string,
    channel = 'all',
    status = 'all',
    page?: string,
    pageSize?: string,
  ) {
    userOrderPage([], channel, status, page, pageSize);
    const sources = (['day', 'night'] as const).filter(
      (type) => channel === 'all' || type === channel,
    );
    const results = await Promise.allSettled(
      sources.map(async (type) => {
        const rows =
          type === 'day'
            ? await this.day.orders(userId)
            : await this.night.myOrders(userId);
        return rows.map((row) => userOrderRow(row, type));
      }),
    );
    const errors: string[] = [];
    const rows = results.flatMap((result, i) => {
      if (result.status === 'fulfilled') return result.value;
      errors.push(sources[i]);
      return [];
    });
    return { ...userOrderPage(rows, channel, status, page, pageSize), errors };
  }
}
