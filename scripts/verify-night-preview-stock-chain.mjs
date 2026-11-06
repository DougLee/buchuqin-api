import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const line = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/).find(x => x.startsWith('DATABASE_URL='));
const url = new URL(line?.slice(13).replace(/^['"]|['"]$/g, '') || '');
if (!url.pathname.endsWith('_spec')) throw new Error('只允许独立测试库');
url.searchParams.set('schema', 'night_stock_preview_20261106');
process.env.DATABASE_URL = url.toString(); process.env.NODE_ENV = 'test';
await import('./night-preview-network-guard.mjs');
const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const { NightInventoryService } = require('../dist/src/night/night-inventory.service.js');
const db = new PrismaClient();
try {
  const orderId = process.argv.slice(2).find(value => /^c[a-z0-9]{20,40}$/.test(value));
  const order = await db.nightStockOrder.findFirstOrThrow({ where: { storeId: 'night-preview-store', ...(orderId ? { id: orderId } : { reason: { contains: '本机H5联调' }, status: 'received' }) }, orderBy: { createdAt: 'desc' } });
  assert.equal(order.storeId, 'night-preview-store'); assert.equal(order.status, 'received');
  assert.equal(order.items.length, 1); assert.equal(order.items[0].quantity, 3); assert.equal(order.items[0].receivedQuantity, 2); assert.equal(order.items[0].price, 350); assert.equal(order.heldValue, 0);
  const product = await db.nightProduct.findUniqueOrThrow({ where: { id: order.items[0].nightProductId } });
  const receipt = await db.nightStockTxn.findMany({ where: { storeId: order.storeId, refId: order.id, type: 'stockIn' } });
  assert.equal(receipt.length, 1); assert.equal(receipt[0].delta, 2);
  const previous = await db.nightStockTxn.findFirstOrThrow({ where: { nightProductId: product.id, createdAt: { lt: receipt[0].createdAt } }, orderBy: { createdAt: 'desc' } });
  assert.equal(receipt[0].afterStock, previous.afterStock + 2);
  const latest = await db.nightStockTxn.findFirstOrThrow({ where: { nightProductId: product.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  assert.equal(product.stock, latest.afterStock);
  const report = await db.nightInventoryReport.findFirstOrThrow({ where: { stockOrderId: order.id, kind: 'receipt-shortage' } });
  const approved = process.argv.includes('--approved');
  assert.equal(report.status, approved ? 'approved' : 'pending'); assert.equal(report.heldValue, approved ? 0 : 350);
  const quota = await new NightInventoryService(db).summary(order.storeId);
  assert.equal(quota.usedQuota, quota.stockValue + quota.reservedValue);
  assert.ok(quota.shortageValue >= report.heldValue);
  const baselineIndex = process.argv.indexOf('--before');
  if (approved && baselineIndex >= 0) {
    const text = fs.readFileSync(process.argv[baselineIndex + 1], 'utf8');
    const before = JSON.parse(text.slice(text.indexOf('{')));
    assert.equal(before.orderId, order.id);
    assert.equal(before.reportHeldValue, 350);
    assert.equal(quota.stockValue, before.stockValue);
    assert.equal(quota.usedQuota, before.usedQuota - 350);
    assert.equal(quota.usableQuota, before.usableQuota + 350);
  }
  console.log(JSON.stringify({ verified: true, orderId: order.id, requestedQuantity: 3, receivedQuantity: 2, receiptTxnCount: receipt.length, productStock: product.stock, inventoryValue: product.inventoryValue, reportId: report.id, reportStatus: report.status, reportHeldValue: report.heldValue, ...quota }, null, 2));
} finally { await db.$disconnect(); }
