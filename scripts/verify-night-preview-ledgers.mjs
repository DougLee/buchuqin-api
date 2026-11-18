import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const line = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/).find(x => x.startsWith('DATABASE_URL='));
const url = new URL(line?.slice(13).replace(/^['"]|['"]$/g, '') || '');
if (!url.pathname.endsWith('_spec')) throw new Error('只允许独立测试库账本核对');
url.searchParams.set('schema', 'night_stock_preview_20261106');
process.env.DATABASE_URL = url.toString(); process.env.NODE_ENV = 'test';
await import('./night-preview-network-guard.mjs');
const require = createRequire(import.meta.url);
const { PrismaClient } = require('@prisma/client');
const { NightInventoryService } = require('../dist/src/night/night-inventory.service.js');
const db = new PrismaClient();
try {
  const inventory = new NightInventoryService(db);
  const stores = await db.nightStore.findMany({ where: { campusId: 'night-preview-campus' }, include: { depositTxns: true, products: true, depositRefunds: true } });
  const evidence = [];
  for (const store of stores) {
    const pendingReports = await db.nightInventoryReport.findMany({ where: { storeId: store.id, status: 'pending', kind: { in: ['loss', 'stocktake'] } } });
    const frozen = new Map();
    for (const report of pendingReports) for (const item of report.items) {
      if (item.delta < 0) frozen.set(item.nightProductId, (frozen.get(item.nightProductId) ?? 0) + item.quantity);
    }
    const ledger = store.depositTxns.reduce((sum, row) => sum + (row.type === 'deposit' ? row.amount : -row.amount), 0);
    assert.equal(store.deposit, ledger, `押金余额与流水不符：${store.id}`);
    for (const product of store.products) {
      assert.ok(product.stock >= 0 && product.frozenStock >= 0 && product.inventoryValue >= 0);
      assert.equal(product.frozenStock, frozen.get(product.id) ?? 0, `冻结库存必须对应待审盘亏/损耗：${product.id}`);
      if (product.stock === 0) assert.equal(product.inventoryValue, 0, `零库存不能残留可售货值：${product.id}`);
    }
    for (const refund of store.depositRefunds) {
      const matching = store.depositTxns.filter(txn => txn.id === `refund-${refund.id}`);
      assert.equal(matching.length, refund.status === 'succeeded' ? 1 : 0, `退押流水必须只对应确认成功：${refund.id}`);
      if (matching.length) assert.equal(matching[0].amount, refund.amount);
    }
    const quota = await inventory.summary(store.id);
    assert.equal(quota.usedQuota, quota.stockValue + quota.reservedValue);
    assert.equal(quota.usableQuota, Math.max(0, store.deposit - quota.usedQuota));
    if (store.buildingId === 'night-preview-recruit-building') {
      assert.equal(store.managerStaffId, null); assert.equal(store.commissionRate, 0); assert.equal(store.deposit, 0); assert.equal(store.products.length, 0); assert.equal(store.status, 'closed');
    }
    evidence.push({ storeId: store.id, status: store.status, managerStaffId: store.managerStaffId, commissionRate: store.commissionRate, deposit: store.deposit, depositLedger: ledger, depositTxnCount: store.depositTxns.length, depositRefundCount: store.depositRefunds.length, ...quota });
  }
  const warehouses = await db.product.findMany({ where: { campusId: 'night-preview-campus', nightCatalog: false } });
  const approved = await db.nightStockOrder.findMany({ where: { store: { campusId: 'night-preview-campus' }, status: 'approved' }, select: { items: true } });
  const reserved = new Map();
  for (const order of approved) for (const line of order.items) reserved.set(line.warehouseProductId, (reserved.get(line.warehouseProductId) ?? 0) + line.quantity);
  for (const product of warehouses) {
    // Product.stock is available stock; night reservation has already moved out of it.
    assert.ok(product.stock >= product.lockedStock && product.lockedStock >= 0 && product.nightReservedStock >= 0, `共享仓可用数不合法：${product.id}`);
    assert.equal(product.nightReservedStock, reserved.get(product.id) ?? 0, `夜宵预留应等于已批准未出库备货单：${product.id}`);
  }
  const intents = await db.nightDepositOrder.findMany({ where: { store: { campusId: 'night-preview-campus' }, status: 'paid' } });
  for (const intent of intents) {
    const ledger = await db.nightDepositTxn.findMany({ where: { storeId: intent.storeId, type: 'deposit', payOrderNo: intent.outTradeNo } });
    assert.equal(ledger.length, 1); assert.equal(ledger[0].amount, intent.amount);
  }
  const reports = await db.nightInventoryReport.findMany({ where: { storeId: 'night-preview-store', reason: { startsWith: '本机H5' }, kind: { in: ['loss', 'stocktake'] } } });
  const reportEvidence = [];
  for (const report of reports) {
    const txns = await db.nightStockTxn.findMany({ where: { refId: report.id } });
    for (const item of report.items) {
      const own = txns.filter(txn => txn.nightProductId === item.nightProductId);
      if (item.delta < 0) {
        const freeze = own.filter(txn => txn.type === 'reportFreeze');
        assert.equal(freeze.length, 1); assert.equal(freeze[0].delta, -item.quantity);
        const reviewed = own.filter(txn => ['loss', 'reportRelease'].includes(txn.type));
        assert.equal(reviewed.length, report.status === 'pending' ? 0 : 1);
        if (reviewed.length) assert.equal(reviewed[0].delta, report.status === 'approved' ? 0 : item.quantity);
      } else if (item.delta > 0) {
        const gains = own.filter(txn => txn.type === 'stocktake');
        assert.equal(gains.length, report.status === 'approved' ? 1 : 0);
        if (gains.length) assert.equal(gains[0].delta, item.quantity);
      }
    }
    if (report.status !== 'pending') assert.equal(report.heldValue, 0);
    reportEvidence.push({ reportId: report.id, kind: report.kind, status: report.status, heldValue: report.heldValue, items: report.items, txnCount: txns.length });
  }
  console.log(JSON.stringify({ verified: true, schema: 'night_stock_preview_20261106', stores: evidence, warehouseCount: warehouses.length, paidDepositIntents: intents.length, reportEvidence }, null, 2));
} finally { await db.$disconnect(); }
