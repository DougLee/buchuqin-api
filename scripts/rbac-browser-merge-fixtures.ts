import { PrismaService } from '../src/database/prisma.service';
import { RbacService } from '../src/admin/rbac/rbac.service';
async function main() {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (url.hostname !== '127.0.0.1' || !url.pathname.startsWith('/buchuqin_rbac_checks_'))
    throw new Error('Only isolated local browser checks databases are supported');
  const db = new PrismaService();
  try {
    const rbac = new RbacService(db);
    const actor = { id: 'merge-qa', username: 'merge-qa' };
    for (const [code, menus] of [
      ['qa-merge-read', ['campus-config']],
      ['qa-merge-write', ['campus-config.slots', 'campus-config.notices', 'campuses.config.write']],
    ] as const) {
      if (!await db.adminRole.findUnique({ where: { code } }))
        await rbac.createRole(actor, { code, name: code, menuCodes: [...menus] });
    }
    for (const [username, grants] of [
      ['qa-merge-readonly', [{ roleCode: 'qa-merge-read', scope: 'campus', campusId: 'qa-a' }]],
      ['qa-merge-mixed', [
        { roleCode: 'qa-merge-read', scope: 'platform' },
        { roleCode: 'qa-merge-write', scope: 'campus', campusId: 'qa-a' },
      ]],
    ] as const) {
      if (await db.adminAccount.findUnique({ where: { username } })) continue;
      const account = await rbac.createAccount(actor, { username, nickname: username,
        password: 'Local-Rbac-QA-2026!', grants: [...grants] });
      await db.adminAccount.update({ where: { id: account.id }, data: { campusId: 'qa-a' } });
    }
    console.log('Merge QA accounts ready; existing accounts/grants untouched');
  } finally { await db.$disconnect(); }
}
void main();
