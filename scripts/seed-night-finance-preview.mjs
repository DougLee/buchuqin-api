import fs from 'node:fs';
import { createRequire } from 'node:module';

// Additive fixtures only. Never resets subsequent browser operations.
const line = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/).find(x => x.startsWith('DATABASE_URL='));
const url = new URL(line?.slice(13).replace(/^['"]|['"]$/g, '') || '');
if (!url.pathname.endsWith('_spec')) throw new Error('财务夹具只允许独立测试库');
url.searchParams.set('schema', 'night_stock_preview_20261106');
process.env.DATABASE_URL = url.toString(); process.env.NODE_ENV = 'test';
await import('./night-preview-network-guard.mjs');
const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const { NightOrderService } = require('../dist/src/night/night-order.service.js');
const { NightInventoryService } = require('../dist/src/night/night-inventory.service.js');
const { NightDepositRefundService } = require('../dist/src/night/night-deposit-refund.service.js');
const db = new PrismaClient();
try {
  const campusId = 'night-preview-campus', storeId = 'night-preview-clearance-store';
  const building = await db.building.upsert({ where: { id: 'night-preview-clearance-building' }, update: {}, create: { id: 'night-preview-clearance-building', campusId, name: '退押验收楼' } });
  const staff = await db.staff.upsert({ where: { id: 'night-preview-clearance-staff' }, update: {}, create: { id: 'night-preview-clearance-staff', campusId, buildingId: building.id, building: building.name, name: '退押验收楼长', staffNo: 'NIGHT-FINANCE', role: 'building-manager', roleText: '楼长', onTimeRate: 100, income: 0 } });
  await db.nightStore.upsert({ where: { id: storeId }, update: {}, create: { id: storeId, campusId, buildingId: building.id, managerStaffId: staff.id, commissionRate: 2000 } });
  const gateway = { registerNightPaymentHandler() {}, nightPrepay: async () => ({ appId: 'LOCAL_PREVIEW_ONLY' }), applyWechatRefund: async () => { if (process.argv.includes('--slow-channel')) await new Promise(resolve => setTimeout(resolve, 15000)); return { status: 'PROCESSING', refundId: 'LOCAL_PREVIEW_DEPOSIT_PENDING' }; }, queryWechatRefund: async () => ({ status: 'PROCESSING', refundId: 'LOCAL_PREVIEW_DEPOSIT_PENDING' }) };
  if (!await db.nightDepositOrder.count({ where: { storeId } })) {
    const orders = new NightOrderService(db, gateway);
    const intent = await orders.initiateDepositPay(storeId, campusId, 'LOCAL_PREVIEW_FINANCE', undefined, 50000);
    await orders.applyNightDepositPaid(intent.outTradeNo, 'LOCAL_PREVIEW_ONLY');
  }
  if (process.argv.includes('--pending')) {
    const index = process.argv.indexOf('--request-id');
    const requestId = index >= 0 ? process.argv[index + 1] : 'finance-pending-browser-20261107';
    if (!/^finance-browser-[a-z0-9-]{1,40}$/.test(requestId) && requestId !== 'finance-pending-browser-20261107') throw new Error('仅允许财务验收申请编号');
    await new NightDepositRefundService(db, gateway, new NightInventoryService(db)).request('night-preview-admin', storeId, { requestId, amount: 10000, reason: '本机模拟渠道处理中验收，无真实退款' });
  }
  console.log(JSON.stringify({ localSimulation: true, storeId, deposit: (await db.nightStore.findUniqueOrThrow({ where: { id: storeId } })).deposit }));
} finally { await db.$disconnect(); }
