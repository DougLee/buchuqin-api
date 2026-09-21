import { PrismaService } from '../src/database/prisma.service';
import { RbacService } from '../src/admin/rbac/rbac.service';
async function main() {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (url.hostname !== '127.0.0.1' || !url.pathname.startsWith('/buchuqin_rbac_checks_')) throw new Error('isolated browser database only');
  const db = new PrismaService();
  try {
    const rbac = new RbacService(db), actor = { id: 'local-qa', username: 'local-qa' };
    const code = 'qa-supply-read', menuCodes = ['purchase', 'restock', 'featured'];
    const role = await db.adminRole.findUnique({ where: { code } });
    if (role) await rbac.updateRole(actor, role.id, { menuCodes });
    else await rbac.createRole(actor, { code, name: '供应链只读验收', menuCodes });
    const grants = [{ roleCode: code, scope: 'platform' as const }];
    const existing = await db.adminAccount.findUnique({ where: { username: code } });
    if (existing) await rbac.setAccountRoles(actor, existing.id, grants);
    else await rbac.createAccount(actor, { username: code, password: 'Local-Rbac-QA-2026!', grants });
    await db.adminAccount.update({ where: { username: code }, data: { campusId: 'qa-a' } });
    await db.restockBatch.upsert({ where: { id: 'qa-read-batch' }, update: {}, create: { id: 'qa-read-batch', name: '只读验收批次',
      startAt: new Date(Date.now() - 60_000), endAt: new Date(Date.now() + 86_400_000), createdBy: actor.id } });
    for (const closed of [false, true]) await db.purchaseOrder.upsert({ where: { id: closed ? 'qa-read-closed' : 'qa-read-open' }, update: {}, create: {
      id: closed ? 'qa-read-closed' : 'qa-read-open', batchId: 'qa-read-batch', supplierName: closed ? '只读已关闭采购' : '只读待到货采购',
      createdBy: actor.id, closedAt: closed ? new Date() : null,
      items: { create: { productId: 'qa-product-qa-a', requiredCases: 2, unitCost: 100, unitsPerCase: 1 } },
    } });
    await db.product.update({ where: { id: 'qa-product-qa-a' }, data: { featured: true, featuredSort: 1, status: 'on-sale' } });
    console.log('Synthetic qa-supply-read fixtures ready');
  } finally { await db.$disconnect(); }
}
void main();
