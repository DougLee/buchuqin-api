import fs from 'node:fs';
import { createRequire } from 'node:module';

// Called only by loopback Vite middleware, never an API endpoint. Fixed fixture
// ownership is checked again before invoking the real idempotent callback handler.
const line = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/).find(x => x.startsWith('DATABASE_URL='));
const url = new URL(line?.slice(13).replace(/^['"]|['"]$/g, '') || '');
if (!url.pathname.endsWith('_spec')) throw new Error('只允许独立测试库');
url.searchParams.set('schema', 'night_stock_preview_20261106');
process.env.DATABASE_URL = url.toString();
process.env.NODE_ENV = 'test';
await import('./night-preview-network-guard.mjs');
const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const { NightOrderService } = require('../dist/src/night/night-order.service.js');
const db = new PrismaClient();
try {
  const id = process.argv[2], kind = process.argv[3] || 'user';
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id || '')) throw new Error('支付单标识不合法');
  const orders = new NightOrderService(db, { registerNightPaymentHandler() {} });
  if (kind === 'user') {
    const order = await db.nightOrder.findUniqueOrThrow({ where: { id }, include: { store: true } });
    if (order.userId !== 'night-demo-customer-0' || order.store.campusId !== 'night-preview-campus' || !['pending-payment', 'pending-accept'].includes(order.status)) throw new Error('仅可确认本机用户夹具的有效订单');
    await orders.applyNightOrderPaid(order.orderNo, 'LOCAL_PREVIEW_ONLY');
  } else if (kind === 'deposit') {
    const intent = await db.nightDepositOrder.findUniqueOrThrow({ where: { id }, include: { store: true } });
    if (intent.storeId !== 'night-preview-store' || intent.store.managerStaffId !== 'night-preview-staff' || intent.store.campusId !== 'night-preview-campus') throw new Error('仅可确认本机楼长夹具押金');
    await orders.applyNightDepositPaid(intent.outTradeNo, 'LOCAL_PREVIEW_ONLY');
  } else throw new Error('不支持的本机确认类型');
  console.log(JSON.stringify({ localSimulation: true, confirmed: true }));
} finally { await db.$disconnect(); }
