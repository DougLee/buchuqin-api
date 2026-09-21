import { PrismaService } from '../src/database/prisma.service';
import { RbacService } from '../src/admin/rbac/rbac.service';
async function main() {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (url.hostname !== '127.0.0.1' || !url.pathname.startsWith('/buchuqin_rbac_checks_')) throw new Error('isolated browser database only');
  const db = new PrismaService();
  try {
    const rbac = new RbacService(db), actor = { id: 'local-qa', username: 'local-qa' };
    const menuCodes: string[] = ['products', 'products.price'];
    for (const [path, name, viewPath, keepAlive] of [
      ['/qa-frame', '验收外链', 'https://example.com', true],
      ['/qa-cache-off', '验收不缓存', 'products', false],
      ['/qa-missing', '验收缺失组件', 'products', false],
    ] as const) {
      const existing = await db.adminMenu.findFirst({ where: { path } });
      const menu = existing ?? await rbac.createMenu(actor, { name, type: 1, path, viewPath, keepAlive,
        perms: viewPath === 'products' ? ['GET /admin/products', 'GET /admin/products/status-counts'] : [] });
      menuCodes.push(menu.code);
      // Simulate a historical registered component removed by a later release;
      // normal menu API correctly refuses creating an unknown component.
      if (path === '/qa-missing') await db.adminMenu.update({ where: { id: menu.id }, data: { viewPath: 'retired-qa-component' } });
    }
    const existingRole = await db.adminRole.findUnique({ where: { code: 'qa-browser-edge' } });
    if (existingRole) await rbac.updateRole(actor, existingRole.id, { menuCodes });
    else await rbac.createRole(actor, { code: 'qa-browser-edge', name: '浏览器边界验收', menuCodes });
    const account = await db.adminAccount.findUnique({ where: { username: 'qa-edge' } });
    if (account) await rbac.setAccountRoles(actor, account.id, [{ roleCode: 'qa-browser-edge', scope: 'campus', campusId: 'qa-a' }]);
    else await rbac.createAccount(actor, { username: 'qa-edge', password: 'Local-Rbac-QA-2026!',
      grants: [{ roleCode: 'qa-browser-edge', scope: 'campus', campusId: 'qa-a' }] });
    console.log('Synthetic qa-edge browser fixtures ready');
  } finally { await db.$disconnect(); }
}
void main();
