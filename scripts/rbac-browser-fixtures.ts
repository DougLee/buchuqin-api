import { PrismaService } from '../src/database/prisma.service';
import { RbacService } from '../src/admin/rbac/rbac.service';
import { hash } from 'bcryptjs';
async function main() {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (url.hostname !== '127.0.0.1' || !url.pathname.startsWith('/buchuqin_rbac_checks_'))
    throw new Error('Browser fixtures only support the isolated local RBAC checks database');
  const db = new PrismaService();
  try {
    const rbac = new RbacService(db);
    await rbac.syncRegistry();
    for (const [id, name] of [['qa-a','验收 A 校区'], ['qa-b','验收 B 校区']]) {
      await db.campus.upsert({ where: {id}, update: {}, create: { id, name, shortName: name, warehouseName: `${name}仓` } });
    }
    const actor = { id: 'local-qa', username: 'local-qa' };
    for (const [code, menuCodes] of [
      ['qa-price-only', ['products', 'products.price']],
      ['qa-status-only', ['products', 'products.status']],
    ] as const) {
      const existing = await db.adminRole.findUnique({ where: { code } });
      if (!existing) await rbac.createRole(actor, { code, name: code, menuCodes: [...menuCodes] });
    }
    await db.category.upsert({ where: { id: 'qa-category' }, update: {}, create: { id: 'qa-category', name: '验收商品分类' } });
    for (const campusId of ['qa-a', 'qa-b']) await db.product.upsert({
      where: { id: `qa-product-${campusId}` }, update: {}, create: {
        id: `qa-product-${campusId}`, campusId, categoryId: 'qa-category', name: `验收商品 ${campusId}`,
        price: 500, originalPrice: 600, stock: 10, status: 'on-sale',
        subtitle: '', tag: '', image: '', weight: 0.1,
      },
    });
    for (const [username, grants] of [
      ['qa-price', [{ roleCode: 'qa-price-only', scope: 'campus', campusId: 'qa-a' }]],
      ['qa-status', [{ roleCode: 'qa-status-only', scope: 'campus', campusId: 'qa-a' }]],
      ['qa-super', [{ roleCode: 'super-admin', scope: 'platform' }]],
      ['qa-multi', [{ roleCode: 'campus-operations', scope: 'campus', campusId: 'qa-a' }, { roleCode: 'campus-finance', scope: 'campus', campusId: 'qa-b' }]],
    ] as const) {
      const account = await db.adminAccount.upsert({
        where: { username }, update: { campusId: 'qa-a', status: 'active' },
        create: { username, nickname: username, role: 'rbac', campusId: 'qa-a', passwordHash: await hash('Local-Rbac-QA-2026!', 10) },
      });
      await rbac.setAccountRoles({ id: 'local-qa', username: 'local-qa' }, account.id, [...grants]);
    }
    console.log('Local browser accounts ready: qa-super, qa-multi');
  } finally { await db.$disconnect(); }
}
void main();
