import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { seedNightPreview } from './seed-night-preview.mjs';
const require = createRequire(import.meta.url);
const line = fs.readFileSync('.env', 'utf8').split(/\r?\n/).find(x => x.startsWith('DATABASE_URL='));
const url = new URL(line?.slice(13).replace(/^['"]|['"]$/g, '') || '');
if (!url.pathname.endsWith('_spec')) throw new Error('只允许独立预览数据库');
url.searchParams.set('schema', 'night_stock_preview_20261106');
process.env.DATABASE_URL = url.toString();
const { PrismaClient } = require('@prisma/client');
const { NightInventoryService } = require('../dist/src/night/night-inventory.service.js');
const db = new PrismaClient(), inventory = new NightInventoryService(db);
try {
  const campusId = 'night-preview-campus';
  assert.ok(await db.auditLog.findFirst({ where: { campusId, action: 'night.preview.realistic.v1' } }), '请先准备预览数据');
  const snapshot = async () => ({ products: await db.nightProduct.findMany({ where: { store: { campusId } }, orderBy: { id: 'asc' } }), orders: await db.nightOrder.count({ where: { store: { campusId } } }), stock: await db.nightStockOrder.count({ where: { store: { campusId } } }) });
  const before = await snapshot();
  await seedNightPreview(db, inventory, url.toString());
  assert.deepEqual(await snapshot(), before, '重启准备数据不得覆盖手工库存/订单');
  const stores = await db.nightStore.findMany({ where: { campusId } });
  assert.equal(stores.length, 3);
  for (const s of stores) {
    const quota = await inventory.summary(s.id);
    assert.ok(quota.usedQuota >= 0 && quota.usedQuota <= quota.deposit);
    const ledger = await db.nightDepositTxn.findMany({ where: { storeId: s.id } });
    assert.equal(ledger.reduce((sum, row) => sum + (row.type === 'deposit' ? row.amount : -row.amount), 0), s.deposit, '押金账本与余额一致');
    for (const p of before.products.filter(p => p.storeId === s.id)) {
      const sum = await db.nightStockTxn.aggregate({ where: { nightProductId: p.id }, _sum: { delta: true } });
      assert.equal(sum._sum.delta ?? 0, p.stock, `库存流水与可售库存一致：${p.id}`);
      assert.ok(p.stock >= 0 && p.frozenStock >= 0 && p.inventoryValue >= 0);
    }
  }
  const stockStates = new Set((await db.nightStockOrder.findMany({ where: { store: { campusId } }, select: { status: true } })).map(r => r.status));
  for (const state of ['requested', 'approved', 'shipped', 'received', 'rejected', 'cancelled']) assert.ok(stockStates.has(state), `缺少 ${state} 场景`);
  const orderStates = new Set((await db.nightOrder.findMany({ where: { store: { campusId } }, select: { status: true } })).map(r => r.status));
  for (const state of ['completed', 'delivering', 'pending-accept', 'cancelled']) assert.ok(orderStates.has(state), `缺少 ${state} 订单`);
  const catalog = await inventory.catalog(campusId);
  assert.ok(catalog.length >= 20);
  assert.ok(new Set(catalog.map(p => p.categoryName)).size >= 4);
  assert.ok((await inventory.campusProducts(campusId, { stock: 'frozen' })).length > 0);
  const pictured = catalog.filter(p => p.image);
  assert.ok(pictured.length >= 20);
  const image = await fetch(pictured[0].image); assert.equal(image.status, 200);
  console.log(`模拟数据验收通过：${stores.length} 栋楼、${catalog.length} 种夜宵商品、${before.products.length} 条楼栋商品、${before.orders} 笔订单；库存流水、押金、额度、图片与重复执行均一致。`);
} finally { await db.$disconnect(); }
