import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const url = new URL(process.env.DATABASE_URL || '');
if (!url.pathname.endsWith('_spec') || !/^night_stock_parity_full[a-z0-9_]*$/.test(url.searchParams.get('schema') || '')) throw Error('仅允许完整回归的独立schema');
const db = new PrismaClient();
try {
  const campuses = await db.campus.findMany({ select: { id: true } });
  if (campuses.some(row => !['campus-hbut', 'campus-hq', 'campus-official'].includes(row.id))) throw Error('必须在运行套件前的新隔离schema准备，不得覆盖已有业务夹具');
  await db.organization.upsert({ where: { id: 'org-a' }, update: {}, create: { id: 'org-a', name: '不出寝食社' } });
  await db.campus.upsert({ where: { id: 'campus-hq' }, update: { organizationId: 'org-a' }, create: { id: 'campus-hq', type: 'hq', name: '总部仓', shortName: '总部', warehouseName: '总部仓', organizationId: 'org-a' } });
  await db.campus.upsert({ where: { id: 'campus-official' }, update: {}, create: { id: 'campus-official', name: '官方商品库', shortName: '官方库', warehouseName: '总部官方库', status: 'official', deliveryFeeInstant: 0, deliveryFeeScheduled: 0, deliveryThreshold: 0 } });
  await db.campus.update({ where: { id: 'campus-hbut' }, data: { organizationId: 'org-a' } });
  await db.user.upsert({ where: { id: 'user-parity-second' }, update: {}, create: { id: 'user-parity-second', campusId: 'campus-hbut', nickname: '回归用户乙', phone: '13800009902' } });
  console.log('仅补齐历史迁移基线：org-a、总部/官方伪校区、第二测试用户；未配置真实外部凭证。');
} finally { await db.$disconnect(); }
