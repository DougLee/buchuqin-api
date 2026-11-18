import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { parsePagination } from '../common/pagination';
import { nightBusinessDate, nightDayBoundary, nightDayStart } from './night.helpers';

type Window = { nightStartAt: string | null; nightEndAt: string | null };
export class NightReportingService {
  constructor(private readonly db: PrismaService) {}
  async campusSales(campusId: string, campus: Window) {
    const today = nightBusinessDate(new Date(), campus.nightStartAt, campus.nightEndAt);
    const rows = await this.db.$queryRaw<Array<{ storeId: string; todayOrders: bigint; todaySales: bigint }>>`
      SELECT o."storeId", COUNT(*) FILTER (WHERE o.status NOT IN ('cancelled', 'refunded')) AS "todayOrders",
        COALESCE(SUM(GREATEST(o."productAmount" - o."couponDiscount" - CASE WHEN r.status = 'succeeded' THEN r."productAmount" WHEN r.id IS NULL AND o.status IN ('refunded','cancelled') THEN o."productAmount" - o."couponDiscount" ELSE 0 END, 0)), 0) AS "todaySales"
      FROM "NightOrder" o JOIN "NightStore" s ON s.id = o."storeId" LEFT JOIN "NightRefund" r ON r."orderId" = o.id
      WHERE s."campusId" = ${campusId} AND o."businessDate" = ${today} AND o."paidAt" IS NOT NULL GROUP BY o."storeId"`;
    return new Map(rows.map(row => [row.storeId, { todayOrders: Number(row.todayOrders), todaySales: Number(row.todaySales) }]));
  }
  async sales(storeId: string, campus: Window) {
    const today = nightBusinessDate(new Date(), campus.nightStartAt, campus.nightEndAt), month = today.slice(0, 7);
    const rows = await this.db.$queryRaw<Array<{ todayOrders: bigint; todaySales: bigint; monthSales: bigint; legacyRefunds: bigint }>>`
      SELECT COUNT(*) FILTER (WHERE o."businessDate" = ${today} AND o.status NOT IN ('cancelled', 'refunded')) AS "todayOrders",
        COALESCE(SUM(CASE WHEN o."businessDate" = ${today} THEN GREATEST(o."productAmount" - o."couponDiscount" - CASE WHEN r.status = 'succeeded' THEN r."productAmount" WHEN r.id IS NULL AND o.status IN ('refunded','cancelled') THEN o."productAmount" - o."couponDiscount" ELSE 0 END, 0) ELSE 0 END), 0) AS "todaySales",
        COALESCE(SUM(GREATEST(o."productAmount" - o."couponDiscount" - CASE WHEN r.status = 'succeeded' THEN r."productAmount" WHEN r.id IS NULL AND o.status IN ('refunded','cancelled') THEN o."productAmount" - o."couponDiscount" ELSE 0 END, 0)), 0) AS "monthSales",
        COUNT(*) FILTER (WHERE r.id IS NULL AND (o.status IN ('refunded','cancelled') OR o.timeline @> '[{"key":"refund"}]'::jsonb)) AS "legacyRefunds"
      FROM "NightOrder" o LEFT JOIN "NightRefund" r ON r."orderId" = o.id
      WHERE o."storeId" = ${storeId} AND o."paidAt" IS NOT NULL AND o."businessDate" >= ${month + '-01'} AND o."businessDate" <= ${today}`;
    const r = rows[0];
    return { businessDate: today, month, todayOrders: Number(r.todayOrders), todaySales: Number(r.todaySales), monthSales: Number(r.monthSales), legacyRefunds: Number(r.legacyRefunds) };
  }

  async income(staffId: string, campus: Window, filters: { month?: string; status?: string; page?: string; pageSize?: string } = {}) {
    const month = filters.month || nightBusinessDate(new Date(), campus.nightStartAt, campus.nightEndAt).slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || Number(month.slice(0, 4)) < 2000 || Number(month.slice(0, 4)) > 2100) throw new BadRequestException('收入月份须为2000至2100年的YYYY-MM');
    if (filters.status && !['estimated', 'pending', 'settled', 'all'].includes(filters.status)) throw new BadRequestException('收入状态无效');
    const start = nightDayStart(month + '-01', campus.nightStartAt, campus.nightEndAt);
    const next = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString().slice(0, 10);
    const end = nightDayStart(next, campus.nightStartAt, campus.nightEndAt);
    const scope = { managerStaffId: staffId, createdAt: { gte: start, lt: end } };
    const where = { ...scope, ...(filters.status && filters.status !== 'all' ? { status: filters.status } : {}) };
    const paging = parsePagination(filters.page, filters.pageSize);
    const boundary = nightDayBoundary(campus.nightStartAt, campus.nightEndAt);
    const [groups, rows, total, negatives, daily] = await Promise.all([
      this.db.nightCommissionTxn.groupBy({ by: ['type', 'status'], where: scope, _sum: { amount: true } }),
      this.db.nightCommissionTxn.findMany({ where, include: { order: { select: { orderNo: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (paging.page - 1) * paging.pageSize, take: paging.pageSize }),
      this.db.nightCommissionTxn.count({ where }),
      this.db.nightCommissionTxn.aggregate({ where: { ...scope, amount: { lt: 0 } }, _sum: { amount: true } }),
      this.db.$queryRaw<Array<{ day: string; orderCount: number; commission: bigint; deliveryFee: bigint }>>`
        SELECT to_char("createdAt" + INTERVAL '8 hours' - ${boundary} * INTERVAL '1 minute', 'YYYY-MM-DD') AS day,
          COUNT(DISTINCT "orderId")::int AS "orderCount",
          COALESCE(SUM(CASE WHEN type = 'commission' THEN amount ELSE 0 END), 0) AS commission,
          COALESCE(SUM(CASE WHEN type = 'deliveryFee' THEN amount ELSE 0 END), 0) AS "deliveryFee"
        FROM "NightCommissionTxn" WHERE "managerStaffId" = ${staffId} AND "createdAt" >= ${start} AND "createdAt" < ${end} AND status IN ('pending','settled') GROUP BY day ORDER BY day`,
    ]);
    const commission = { estimated: 0, pending: 0, settled: 0 }, deliveryFee = { ...commission };
    for (const row of groups) {
      const bucket = row.type === 'commission' ? commission : deliveryFee;
      if (row.status in bucket) bucket[row.status as keyof typeof bucket] += row._sum.amount ?? 0;
    }
    return { month, businessDate: nightBusinessDate(new Date(), campus.nightStartAt, campus.nightEndAt), summary: { commission, deliveryFee }, refundTotal: negatives._sum.amount ?? 0, total, ...paging,
      days: daily.map(d => ({ day: d.day, orderCount: d.orderCount, commission: Number(d.commission), deliveryFee: Number(d.deliveryFee) })),
      items: rows.map(r => ({ id: r.id, orderNo: r.order.orderNo, type: r.type, base: r.base, rate: r.rate, amount: r.amount, status: r.status, settleBatch: r.settleBatch, remark: r.remark, createdAt: r.createdAt.toISOString() })),
    };
  }
}
