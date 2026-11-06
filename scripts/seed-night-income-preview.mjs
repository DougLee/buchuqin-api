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
const { NightOrderService } = require('../dist/src/night/night-order.service.js');
const db = new PrismaClient();
try {
  const store = await db.nightStore.findUniqueOrThrow({ where: { id: 'night-preview-store' } });
  assert.equal(store.campusId, 'night-preview-campus'); assert.equal(store.managerStaffId, 'night-preview-staff');
  const original = await db.nightOrder.findFirstOrThrow({ where: { storeId: store.id, userId: 'night-demo-customer-0', status: 'completed' }, orderBy: { createdAt: 'desc' } });
  const images = original.timeline.find(step => step.proof?.images?.length)?.proof.images;
  assert.ok(images?.length, '请先在本机H5上传并完成一次送达');
  assert.equal(new URL(images[0]).origin, 'http://localhost:3150');
  const product = await db.nightProduct.findFirstOrThrow({ where: { storeId: store.id, catalogProduct: { sourceProductId: 'night-preview-official-0' } } });
  const orders = new NightOrderService(db, { registerNightPaymentHandler() {} });
  const evidence = [];
  for (let i = 0; i < 3; i++) {
    const requestId = `preview-income-pagination-${i}`;
    let order = await db.nightOrder.findUnique({ where: { userId_requestId: { userId: original.userId, requestId } } });
    if (!order) order = await orders.submitOrder(original.userId, { requestId, storeId: store.id, addressId: 'night-demo-address-0', items: [{ productId: product.id, quantity: 1 }], remark: '本机隔离模拟付款，用于收入分页验收' });
    if (order.status === 'pending-payment') await orders.applyNightOrderPaid(order.orderNo, `LOCAL_INCOME_PAGINATION_${i}`);
    order = await db.nightOrder.findUniqueOrThrow({ where: { id: order.id } });
    if (order.status === 'pending-accept') await orders.acceptOrder(store.managerStaffId, store.id, order.id);
    order = await db.nightOrder.findUniqueOrThrow({ where: { id: order.id } });
    if (order.status === 'delivering') await orders.deliverOrder(store.managerStaffId, store.id, order.id, { images });
    order = await db.nightOrder.findUniqueOrThrow({ where: { id: order.id } });
    assert.equal(order.status, 'completed');
    evidence.push({ orderId: order.id, status: order.status, payableAmount: order.payableAmount, quotaHeld: order.quotaHeld });
  }
  console.log(JSON.stringify({ simulatedExternalPaymentOnly: true, schema: 'night_stock_preview_20261106', orders: evidence, commissionTxnCount: await db.nightCommissionTxn.count({ where: { storeId: store.id } }) }, null, 2));
} finally { await db.$disconnect(); }
