import { Prisma } from '@prisma/client';

/** Night catalog IDs are distinct from the shared physical warehouse IDs. */
export async function nightPromotions(db: Pick<Prisma.TransactionClient, 'promotion'>, productIds: string[], type: 'clearance' | 'seckill' = 'clearance', now = new Date()) {
  const rows = productIds.length ? await db.promotion.findMany({
    where: { productId: { in: productIds }, type, status: 'active', startsAt: { lte: now }, endsAt: { gt: now } },
    orderBy: [{ endsAt: 'asc' }, { createdAt: 'asc' }],
  }) : [];
  const result = new Map<string, typeof rows[number]>();
  for (const row of rows) if (!result.has(row.productId)) result.set(row.productId, row);
  return result;
}
