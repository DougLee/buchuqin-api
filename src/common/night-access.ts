import { ForbiddenException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../database/prisma.service';

type NightDb = PrismaService | Prisma.TransactionClient;

/** Organization permission and campus enrollment are independent switches.
 * Missing organization/configuration never grants night-store access. */
export async function nightAccess(db: NightDb, campusId?: string | null) {
  const campus = campusId ? await db.campus.findUnique({
    where: { id: campusId }, select: { organizationId: true, nightEnabled: true },
  }) : null;
  const org = campus?.organizationId ? await db.organization.findUnique({
    where: { id: campus.organizationId }, select: { nightEnabled: true, status: true },
  }) : null;
  const authorized = org?.nightEnabled === true && org.status === 'active';
  return { authorized, enrolled: campus?.nightEnabled === true, enabled: authorized && campus?.nightEnabled === true };
}

export async function assertNightEnabled(db: NightDb, campusId?: string | null) {
  if (!(await nightAccess(db, campusId)).enabled)
    throw new ForbiddenException('本校区未开通夜宵服务');
}

/** Existing obligations remain accessible after either switch is disabled. */
export async function hasCampusNightHistory(db: NightDb, campusId?: string | null, managerStaffId?: string) {
  if (!campusId) return false;
  return !!await db.nightStore.findFirst({ where: { campusId, ...(managerStaffId ? { managerStaffId } : {}), OR: [
    { deposit: { gt: 0 } }, { orders: { some: {} } },
    { products: { some: { OR: [{ stock: { gt: 0 } }, { frozenStock: { gt: 0 } }, { inventoryValue: { gt: 0 } }] } } },
    { stockOrders: { some: {} } }, { depositOrders: { some: {} } }, { depositTxns: { some: {} } },
  ] }, select: { id: true } });
}

export async function closeNightStores(db: NightDb, campusIds: string[]) {
  if (campusIds.length) await db.nightStore.updateMany({
    where: { campusId: { in: campusIds }, status: { in: ['open', 'paused'] } },
    data: { status: 'closed', closedAt: new Date() },
  });
}

/** Closing access must not strand fulfillment, refunds or existing financial records. */
export function isNightHistoryOperation(method: string, path: string) {
  const route = path.replace(/^\/api\/v1/, '').replace(/\/+$/, '');
  if (method === 'GET') return /^\/admin\/night\/(stores(?:\/[^/]+(?:\/(?:stock-txns|deposit-txns|deposit-refunds|liquidation))?)?|orders(?:\/[^/]+)?|stock-orders|inventory-reports|settlements)$/.test(route);
  return method === 'POST' && /^\/admin\/night\/(stock-orders\/[^/]+\/(review|ship|cancel)|inventory-reports\/[^/]+\/review|orders\/[^/]+\/(refund(?:\/sync)?|after-sale\/reject)|stores\/[^/]+\/deposit\/(deduct|refund|refunds\/[^/]+\/sync)|settlements\/(settle|[^/]+\/pay))$/.test(route);
}
