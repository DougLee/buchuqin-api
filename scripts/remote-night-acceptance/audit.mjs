import assert from 'node:assert/strict';
import { assertAcceptanceEnvironment, createScope, runtimeRequire } from './guard.mjs';
const marker = assertAcceptanceEnvironment();
const { PrismaClient } = runtimeRequire('@prisma/client');
const { NightInventoryService } = runtimeRequire('./dist/src/night/night-inventory.service.js');
const db = new PrismaClient(), scope = createScope(db, marker);
try {
  const organization = await db.organization.findFirstOrThrow({ where: { name: marker.organizationName }, select: { id: true } });
  const campuses = await db.campus.findMany({ where: { organizationId: organization.id }, select: { id: true } });
  const campusIds = campuses.map(row => row.id); assert.equal(campusIds.length, 2);
  for (const id of campusIds) assert.ok(await scope(id));
  const inventory = new NightInventoryService(db), stores = await db.nightStore.findMany({ where: { campusId: { in: campusIds } } });
  const results = [];
  for (const store of stores) {
    const txns = await db.nightDepositTxn.findMany({ where: { storeId: store.id } });
    const expected = txns.reduce((sum, row) => sum + (row.type === 'deposit' ? row.amount : -row.amount), 0);
    assert.equal(store.deposit, expected, '押金账实不符');
    const quota = await inventory.summary(store.id); assert.equal(quota.usedQuota, quota.stockValue + quota.reservedValue);
    assert.equal(quota.reservedValue, 0); assert.equal(quota.frozenValue, 0);
    const open = await db.nightOrder.count({ where: { storeId: store.id, status: { in: ['pending-payment', 'pending-accept', 'delivering', 'delivered', 'cancelling', 'exception'] } } }); assert.equal(open, 0);
    const pending = await db.nightInventoryReport.count({ where: { storeId: store.id, status: 'pending' } }); assert.equal(pending, 0);
    const products = await db.nightProduct.findMany({ where: { storeId: store.id }, select: { id: true, stock: true, frozenStock: true, inventoryValue: true } });
    for (const product of products) { assert.ok(product.stock >= 0); assert.equal(product.frozenStock, 0); assert.ok(product.inventoryValue >= 0); }
    results.push({ storeId: store.id, deposit: store.deposit, quota, products, openOrders: open, pendingReports: pending, depositLedgerBalanced: true });
  }
  const warehouses = await db.product.findMany({ where: { campusId: { in: campusIds }, nightCatalog: false }, select: { id: true, stock: true, lockedStock: true, nightReservedStock: true } });
  for (const row of warehouses) { assert.equal(row.lockedStock, 0); assert.equal(row.nightReservedStock, 0); assert.ok(row.stock >= 0); }
  const pendingRefunds = await db.nightRefund.count({ where: { store: { campusId: { in: campusIds } }, status: { in: ['requested', 'submitting', 'processing', 'unknown'] } } }); assert.equal(pendingRefunds, 0);
  console.log(JSON.stringify({ audit: 'passed', readOnly: true, productionConnected: false, results, warehouses, pendingRefunds }, null, 2));
} finally { await db.$disconnect(); }
