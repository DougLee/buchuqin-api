// Only additive local fixtures: give the existing isolated security campus an
// organization so the real admin campus picker can exercise cross-campus UI.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const line = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/).find(x => x.startsWith('DATABASE_URL='));
const url = new URL(line?.slice(13).replace(/^['"]|['"]$/g, '') || '');
assert.ok(url.pathname.endsWith('_spec'), '仅允许隔离测试库');
url.searchParams.set('schema', 'night_stock_preview_20261106');
process.env.DATABASE_URL = url.toString(); process.env.NODE_ENV = 'test';
await import('./night-preview-network-guard.mjs');
const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
try {
  const main = await db.campus.findUniqueOrThrow({ where: { id: 'night-preview-campus' } });
  assert.ok(main.organizationId);
  const foreign = await db.campus.findUniqueOrThrow({ where: { id: 'night-security-campus' } });
  assert.equal(foreign.name, '独立跨校区权限夹具');
  await db.campus.update({ where: { id: foreign.id }, data: { organizationId: main.organizationId } });
  console.log(JSON.stringify({ schema: 'night_stock_preview_20261106', campusId: foreign.id, organizationLinked: true, nightEnabled: foreign.nightEnabled, fee: foreign.nightDeliveryFee, mainConfigUnchanged: true }));
} finally { await db.$disconnect(); }
