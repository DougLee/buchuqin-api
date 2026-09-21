import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { PrismaService } from '../src/database/prisma.service';
import { RbacService } from '../src/admin/rbac/rbac.service';

async function main() {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (url.hostname !== '127.0.0.1' || !url.pathname.startsWith('/buchuqin_rbac_upgrade_'))
    throw new Error('Only the local synthetic upgrade rehearsal database is allowed');
  const db = new PrismaService();
  try {
    const service = new RbacService(db);
    const preSync = await db.adminAccount.findMany({ where: { id: { startsWith: 'upgrade-' } } });
    assert.equal(preSync.find(a => a.id === 'upgrade-revoked')?.rbacMigrated, true);
    assert.equal(preSync.find(a => a.id === 'upgrade-legacy')?.rbacMigrated, false);
    assert.equal((await db.adminRole.findUniqueOrThrow({ where: { id: 'upgrade-empty-role' } })).menusMigrated, true);
    await service.syncRegistry();
    const capture = async () => {
      const rows = [];
      for (const account of await db.adminAccount.findMany({ where: { id: { startsWith: 'upgrade-' } }, orderBy: { id: 'asc' } })) {
        const scopes = [];
        for (const campusId of ['upgrade-a', 'upgrade-b']) {
          const me = await service.buildMeResponse({ ...account, campusId });
          scopes.push({ campusId, perms: me.perms, menuCodes: me.menus.map(m => m.code).sort() });
        }
        rows.push({ accountId: account.id, status: account.status, migrated: account.rbacMigrated, scopes });
      }
      return rows;
    };
    const once = await capture();
    const beforeVersion = (await db.rbacState.findUniqueOrThrow({ where: { id: 'global' } })).version;
    await service.syncRegistry();
    assert.deepEqual(await capture(), once, 'Repeated startup must not change effective permissions');
    assert.equal((await db.rbacState.findUniqueOrThrow({ where: { id: 'global' } })).version, beforeVersion);
    assert.equal(await db.adminAccountRole.count({ where: { accountId: 'upgrade-legacy' } }), 2);
    assert.equal(await db.adminAccountRole.count({ where: { accountId: 'upgrade-revoked' } }), 0);
    assert.equal(await db.adminRoleMenu.count({ where: { roleId: 'upgrade-empty-role' } }), 0);
    assert.equal((await db.adminRole.findUniqueOrThrow({ where: { id: 'upgrade-empty-role' } })).name, '明确清空的模板角色');
    for (const id of ['upgrade-revoked', 'upgrade-empty'])
      assert(once.find(row => row.accountId === id)!.scopes.every(scope => scope.perms.length === 0));
    const current = once.find(row => row.accountId === 'upgrade-current')!;
    assert.deepEqual(current.scopes[0].perms, ['GET /admin/products']);
    assert.deepEqual(current.scopes[1].perms, []);
    assert.equal((await db.adminMenu.findUniqueOrThrow({ where: { id: 'upgrade-menu' } })).path, '/upgrade-products');
    const legacy = once.find(row => row.accountId === 'upgrade-legacy')!;
    assert(legacy.scopes.every(scope => scope.perms.includes('PATCH /admin/products/:id')));
    assert(legacy.scopes.every(scope => !scope.perms.includes('POST /admin/campuses')));
    const disabled = await db.adminAccount.findUniqueOrThrow({ where: { id: 'upgrade-disabled' } });
    assert.throws(() => service.assertSession(disabled, disabled.sessionVersion));
    const report = {
      fixture: 'scripts/fixtures/rbac-upgrade.sql',
      comparisons: [
        'Legacy operations with A/B access -> same role separately bound to A/B; no platform campus management',
        'Audited revoked legacy account -> zero grants, including after repeated startup',
        'Existing custom role/menu/grant -> exact GET products in A only, custom route retained',
        'Audited empty template with seeded=false -> remains empty; does not refill template',
        'Disabled legacy account -> remains disabled and session assertion rejects',
      ],
      repeatedStartupUnchanged: true, accounts: once,
    };
    await writeFile('docs/rbac/upgrade-rehearsal.json', JSON.stringify(report, null, 2) + '\n');
    console.log('Upgrade rehearsal passed: 5 synthetic accounts × 2 campuses; repeated startup unchanged.');
  } finally { await db.$disconnect(); }
}
void main();
