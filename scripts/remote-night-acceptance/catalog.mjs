import fs from 'node:fs';
import assert from 'node:assert/strict';
import { call, state, save, q, items, session } from './http.mjs';
const scope = q(state.campusId);
if (!state.uploadUrl) {
  const file = fs.readFileSync(new URL('../../../buchuqin-delivery-weapp/src/static/tabbar/tab-work-active.png', import.meta.url));
  const form = new FormData(); form.append('file', new Blob([file], { type: 'image/png' }), 'night-acceptance.png');
  const upload = await call('/api/v1/files/images' + scope + '&folder=app/product', 'POST', form);
  assert.ok(upload.url.startsWith(session.origin + '/api/v1/uploads/night-acceptance/'));
  assert.equal((await fetch(upload.url, { redirect: 'manual' })).status, 200);
  state.uploadUrl = upload.url; save();
}
const officialScope = q('campus-official');
let categories = await call('/api/v1/admin/categories' + officialScope);
let category = items(categories).find(row => row.name === '夜宵验收20261107');
if (!category) category = await call('/api/v1/admin/categories' + officialScope, 'POST', { name: '夜宵验收20261107', sort: 999 });
state.officialCategoryId = category.id; save();
if (state.officialProductIds?.length !== 2) {
  state.officialProductIds ||= [];
  for (const [index, name] of ['验收香烤面包20261107', '验收柠檬茶20261107'].entries()) {
    if (state.officialProductIds[index]) continue;
    const product = await call('/api/v1/admin/products?view=official', 'POST', { barcode: '202611070001' + index, name, categoryId: category.id, price: 400, originalPrice: 800, costPrice: 300, wholesalePrice: 400, stock: 0, image: state.uploadUrl, retailUnit: index ? '瓶' : '袋', unitsPerCase: 1 });
    state.officialProductIds.push(product.id); save();
    await call('/api/v1/admin/products/' + product.id + '?view=official', 'PATCH', { status: 'on-sale' });
  }
}
if (!state.dayImported) {
  const imported = await call('/api/v1/admin/products/import' + scope, 'POST', { productIds: state.officialProductIds });
  assert.equal(imported.importedCount, 2); state.dayImported = true; save();
}
await call('/api/v1/admin/night/catalog/import' + scope, 'POST', { productIds: state.officialProductIds });
const catalog = items(await call('/api/v1/admin/night/catalog' + scope + '&keyword=20261107'));
assert.equal(catalog.length, 2);
const day = items(await call('/api/v1/admin/products' + scope + '&view=campus&keyword=20261107'));
assert.equal(day.length, 2);
state.catalog = catalog.map(row => ({ id: row.id, name: row.name, warehouseProductId: row.warehouseProductId, price: row.price }));
state.day = day.map(row => ({ id: row.id, name: row.name })); save();
for (const row of catalog) {
  assert.ok(day.some(product => product.id === row.warehouseProductId));
  await call('/api/v1/admin/night/catalog/' + row.id + scope, 'PATCH', { status: 'on-sale', price: 800, subtitle: '部署验收专用商品' });
  await call('/api/v1/admin/products/' + row.warehouseProductId + scope + '&view=campus', 'PATCH', { price: 600, status: 'on-sale' });
}
// HQ-sourced products must follow ordering, procurement and receipt. The normal
// API correctly rejects using manual LOCAL stock-in to bypass this chain.
if (!state.upstreamBatchId) {
  const batch = await call('/api/v1/admin/restock/batches', 'POST', { name: '夜宵验收供货20261107', startAt: new Date(Date.now() - 60000).toISOString(), endAt: new Date(Date.now() + 86400000).toISOString() });
  state.upstreamBatchId = batch.id; save();
}
if (!state.upstreamOrderId) {
  const order = await call('/api/v1/admin/restock/batches/' + state.upstreamBatchId + '/order' + scope, 'PUT', { items: state.officialProductIds.map(productId => ({ productId, cases: 100 })) });
  state.upstreamOrderId = order.id; save();
  await call('/api/v1/admin/restock/orders/' + order.id + '/audit', 'POST', { action: 'confirm', note: '20261107验收正常审核' });
}
if (!state.purchaseOrderId) {
  const purchase = await call('/api/v1/admin/restock/batches/' + state.upstreamBatchId + '/purchase-order', 'POST', { supplierName: '验收供应商20261107', lines: state.officialProductIds.map(productId => ({ productId, unitCost: 300 })) });
  state.purchaseOrderId = purchase.id; save();
}
if (!state.upstreamReceived) {
  await call('/api/v1/admin/purchase/orders/' + state.purchaseOrderId + '/receive', 'POST', { lines: state.officialProductIds.map(productId => ({ productId, receiveCases: 100, badCases: 0, note: '验收实收' })) });
  await call('/api/v1/admin/restock/orders/' + state.upstreamOrderId + '/ship', 'POST', { note: '验收发往专用校区' });
  await call('/api/v1/admin/restock/orders/' + state.upstreamOrderId + '/receipt' + scope, 'POST');
  state.upstreamReceived = true; save();
}
const inventory = items(await call('/api/v1/admin/inventory' + scope));
for (const row of state.day) assert.equal(inventory.find(product => product.id === row.id)?.stock, 100);
const duplicate = await call('/api/v1/admin/night/catalog/import' + scope, 'POST', { productIds: state.officialProductIds });
assert.equal(duplicate.importedCount, 0);
console.log(JSON.stringify({ catalog: 'passed', officialProducts: state.officialProductIds, nightCatalog: state.catalog, sharedWarehouse: true, duplicateImportAdded: 0, imageUpload: 'real authenticated endpoint, external storage simulated' }, null, 2));
