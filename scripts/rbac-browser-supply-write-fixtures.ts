import { PrismaService } from '../src/database/prisma.service';
import { RbacService } from '../src/admin/rbac/rbac.service';
async function main() {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (url.hostname !== '127.0.0.1' || !url.pathname.startsWith('/buchuqin_rbac_checks_')) throw new Error('isolated browser database only');
  const db = new PrismaService();
  try {
    const rbac = new RbacService(db), actor = { id: 'local-qa', username: 'local-qa' };
    let menu = await db.adminMenu.findFirst({ where: { name: '验收单项供应链动作' } });
    if (!menu) menu = await rbac.createMenu(actor, { name: '验收单项供应链动作', type: 2,
      perms: ['POST /admin/purchase/orders/:id/close', 'PATCH /admin/restock/batches/:id', 'PUT /admin/featured'] });
    const code = 'qa-supply-actions', menuCodes = ['purchase', 'restock', 'featured', menu.code];
    const role = await db.adminRole.findUnique({ where: { code } });
    if (role) await rbac.updateRole(actor, role.id, { menuCodes });
    else await rbac.createRole(actor, { code, name: code, menuCodes });
    const grants = [{ roleCode: code, scope: 'platform' as const }];
    const existing = await db.adminAccount.findUnique({ where: { username: code } });
    if (existing) await rbac.setAccountRoles(actor, existing.id, grants);
    else await rbac.createAccount(actor, { username: code, password: 'Local-Rbac-QA-2026!', grants });
    await db.adminAccount.update({ where: { username: code }, data: { campusId: 'qa-a' } });
    console.log('Synthetic qa-supply-actions ready');
  } finally { await db.$disconnect(); }
}
void main();
