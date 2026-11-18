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
  const official = await db.product.findFirstOrThrow({ where: { barcode: '6902026110701', catalogScope: 'platform' }, include: { category: true } });
  assert.equal(official.price, 500); assert.equal(official.originalPrice, 600); assert.equal(official.retailUnit, '听'); assert.equal(official.category.name, '饮料');
  const copies = await db.product.findMany({ where: { campusId: 'night-preview-campus', nightCatalog: true, sourceProductId: official.id }, include: { category: true, warehouseProduct: true } });
  assert.equal(copies.length, 1);
  const catalog = copies[0];
  assert.equal(catalog.price, 580); assert.equal(catalog.originalPrice, 0); assert.equal(catalog.retailUnit, '罐'); assert.equal(catalog.category.name, '夜宵验收商品');
  assert.equal(catalog.warehouseProduct.stock, 0); assert.equal(catalog.warehouseProduct.nightReservedStock, 0); assert.equal(catalog.stock, 0);
  const attached = await db.nightProduct.findMany({ where: { storeId: 'night-preview-store', catalogProductId: catalog.id } });
  assert.equal(attached.length, 1); assert.equal(attached[0].stock, 0); assert.equal(attached[0].inventoryValue, 0); assert.equal(attached[0].frozenStock, 0);
  assert.equal(await db.nightStockTxn.count({ where: { nightProductId: attached[0].id } }), 0);
  console.log(JSON.stringify({ verified: true, officialId: official.id, catalogId: catalog.id, warehouseId: catalog.warehouseProductId, nightProductId: attached[0].id, officialPrice: official.price, nightPrice: catalog.price, officialCategory: official.category.name, nightCategory: catalog.category.name, officialUnit: official.retailUnit, nightUnit: catalog.retailUnit, importedCopies: copies.length, warehouseStock: 0, buildingStock: 0, stockTxnCount: 0 }, null, 2));
} finally { await db.$disconnect(); }
