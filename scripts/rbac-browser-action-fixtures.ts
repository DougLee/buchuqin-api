import { PrismaService } from '../src/database/prisma.service';
import { RbacService } from '../src/admin/rbac/rbac.service';
async function main() {
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (url.hostname !== '127.0.0.1' || !url.pathname.startsWith('/buchuqin_rbac_checks_')) throw new Error('isolated browser database only');
  const db = new PrismaService();
  try {
    const rbac = new RbacService(db), actor = { id: 'local-qa', username: 'local-qa' };
    for (const [username, codes, scope] of [
      ['qa-confirm', ['finance', 'finance.confirm'], 'campus'],
      ['qa-pay', ['finance', 'finance.pay'], 'campus'],
      ['qa-inbound', ['inventory', 'inventory.inbound'], 'platform'],
    ] as const) {
      const role = await db.adminRole.findUnique({ where: { code: username } });
      if (role) await rbac.updateRole(actor, role.id, { menuCodes: [...codes] });
      else await rbac.createRole(actor, { code: username, name: username, menuCodes: [...codes] });
      const grants = [{ roleCode: username, scope, ...(scope === 'campus' ? { campusId: 'qa-a' } : {}) }];
      const account = await db.adminAccount.findUnique({ where: { username } });
      if (account) await rbac.setAccountRoles(actor, account.id, grants);
      else await rbac.createAccount(actor, { username, password: 'Local-Rbac-QA-2026!', grants });
      await db.adminAccount.update({ where: { username }, data: { campusId: 'qa-a' } });
    }
    const staff = await db.staff.upsert({ where: { id: 'qa-action-staff' }, update: {}, create: {
      id: 'qa-action-staff', campusId: 'qa-a', name: '按钮验收员工', staffNo: 'qa-action-staff', role: 'fulltime-rider',
      roleText: '骑手', building: '', onTimeRate: 100, income: 0,
    } });
    const period = new Date().toISOString().slice(0, 7);
    await db.bmBill.upsert({ where: { staffId_period: { staffId: staff.id, period } }, update: { status: 'pending-review', confirmedAt: null, paidAt: null },
      create: { campusId: 'qa-a', staffId: staff.id, period, baseSalary: 0, commissionTotal: 0, adjustment: 0, payable: 0, status: 'pending-review' } });
    console.log('Synthetic qa-confirm / qa-pay / qa-inbound fixtures ready');
  } finally { await db.$disconnect(); }
}
void main();
