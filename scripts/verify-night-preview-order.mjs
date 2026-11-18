import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const line = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/).find(x => x.startsWith('DATABASE_URL='));
const url = new URL(line?.slice(13).replace(/^['"]|['"]$/g, '') || '');
if (!url.pathname.endsWith('_spec')) throw new Error('仅允许隔离测试库');
url.searchParams.set('schema', 'night_stock_preview_20261106');
process.env.DATABASE_URL = url.toString(); process.env.NODE_ENV = 'test';
await import('./night-preview-network-guard.mjs');
const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
try {
  const id = process.argv[2];
  assert.match(id || '', /^c[a-z0-9]{20,40}$/);
  const order = await db.nightOrder.findFirstOrThrow({ where: { id, userId: 'night-demo-customer-0', storeId: 'night-preview-store' } });
  const txns = await db.nightStockTxn.findMany({ where: { refId: id, refType: 'order' } });
  // Historical rows may use another reference label; ID is globally unique.
  const rows = txns.length ? txns : await db.nightStockTxn.findMany({ where: { refId: id } });
  for (const item of order.items) {
    const out = rows.filter(row => row.nightProductId === item.nightProductId && row.type === 'saleOut');
    assert.equal(out.length, 1); assert.equal(out[0].delta, -item.quantity);
    const back = rows.filter(row => row.nightProductId === item.nightProductId && row.type === 'refundBack');
    assert.equal(back.length, order.inventoryRestocked ? 1 : 0);
    if (back.length) assert.equal(back[0].delta, item.quantity);
  }
  const commissions = await db.nightCommissionTxn.findMany({ where: { orderId: id } });
  if (!order.paidAt) assert.equal(commissions.length, 0);
  if (order.status === 'cancelled') { assert.equal(order.quotaHeld, 0); assert.equal(order.inventoryRestocked, true); }
  const refund = await db.nightRefund.findUnique({ where: { orderId: id } });
  if (refund?.status === 'succeeded' && refund.fullProductRefund) assert.equal(commissions.reduce((sum, row) => sum + row.amount, 0), order.deliveryFee - refund.deliveryFeeAmount);
  console.log(JSON.stringify({ verified: true, orderId: id, status: order.status, paid: !!order.paidAt, productAmount: order.productAmount, couponDiscount: order.couponDiscount, deliveryFee: order.deliveryFee, payableAmount: order.payableAmount, quotaHeld: order.quotaHeld, inventoryRestocked: order.inventoryRestocked, stockTxnCount: rows.length, commissionTotal: commissions.reduce((sum, row) => sum + row.amount, 0), refundStatus: refund?.status ?? null }, null, 2));
} finally { await db.$disconnect(); }
