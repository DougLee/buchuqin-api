import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const line = fs.readFileSync('.env', 'utf8').split(/\r?\n/).find(x => x.startsWith('DATABASE_URL='));
const url = new URL(line?.slice(13).replace(/^['"]|['"]$/g, '') || '');
if (!url.pathname.endsWith('_spec')) throw new Error('只允许独立预览测试库');
url.searchParams.set('schema', 'night_stock_preview_20261106');
process.env.DATABASE_URL = url.toString();
const { PrismaClient } = require('@prisma/client'), { JwtService } = require('@nestjs/jwt');
const db = new PrismaClient();
const jwt = new JwtService({ secret: fs.readFileSync('/tmp/night-stock-preview-secret', 'utf8') });
const preview = JSON.parse(fs.readFileSync('/tmp/night-stock-preview.json', 'utf8'));
async function context(token) {
  const r = await fetch('http://localhost:3150/api/v1/fulfillment/business-context', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200);
  return (await r.json()).data;
}
try {
  const formal = await context(preview.staffToken);
  assert.equal(formal.canSwitchWorkspace, true); assert.equal(formal.staffRole, 'building-manager'); assert.equal(formal.staffId, preview.staffId);
  const campusId = 'night-workspace-roles-campus';
  await db.campus.upsert({ where: { id: campusId }, update: {}, create: { id: campusId, name: '切换权限验收校区', shortName: '权限验收', warehouseName: '验收仓', manualClosed: false, closeStart: '00:00', closeEnd: '00:00', nightEnabled: true, nightStartAt: '00:00', nightEndAt: '23:59' } });
  const cases = [];
  for (const [key, role, bound] of [['intern', 'intern-building-manager', true], ['fulltime', 'fulltime-rider', false], ['parttime', 'parttime-rider', false], ['unbound', 'building-manager', false]]) {
    const staffId = `workspace-role-${key}`, buildingId = `workspace-building-${key}`;
    await db.building.upsert({ where: { id: buildingId }, update: {}, create: { id: buildingId, campusId, name: `权限验收${key}栋` } });
    await db.staff.upsert({ where: { id: staffId }, update: {}, create: { id: staffId, campusId, buildingId, building: `权限验收${key}栋`, name: `切换验收·${key}`, role, roleText: role === 'building-manager' ? '楼长' : role === 'intern-building-manager' ? '实习楼长' : '配送员', staffNo: `NS-SWITCH-${key}`, onTimeRate: 100, income: 0 } });
    if (bound) await db.nightStore.upsert({ where: { id: `workspace-store-${key}` }, update: {}, create: { id: `workspace-store-${key}`, campusId, buildingId, managerStaffId: staffId } });
    const token = jwt.sign({ id: staffId, campusId, role, appKind: 'delivery' }, { expiresIn: '1d' });
    const ctx = await context(token);
    assert.equal(ctx.staffRole, role); assert.equal(ctx.canSwitchWorkspace, false); assert.equal(ctx.hasNightStore, bound);
    cases.push({ staffId, role, token });
  }
  fs.writeFileSync('/tmp/workspace-switch-roles.json', JSON.stringify(cases), { mode: 0o600 });
  console.log('真实HTTP权限验证通过：正式楼长+绑定允许；已绑定实习楼长、全职骑手、兼职骑手、未绑定正式楼长均不允许。角色浏览器验收材料仅保存在本机/tmp。');
} finally { await db.$disconnect(); }
