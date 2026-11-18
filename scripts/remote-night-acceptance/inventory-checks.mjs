import assert from 'node:assert/strict';
import { call, state, save, q, items } from './http.mjs';
const s = q(state.campusId), rider = state.manager.token;
const route = '/api/v1/night-rider/night/';
const passed = [];
const test = async (name, fn) => { await fn(); passed.push(name); console.log('PASS ' + name); };
const dash = () => call(route + 'dashboard', 'GET', undefined, rider);
const goods = () => call(route + 'products', 'GET', undefined, rider);
const product = async () => (await goods()).find(row => row.catalogProductId === state.catalog[0].id);
const warehouse = async () => items(await call('/api/v1/admin/inventory' + s)).find(row => row.id === state.catalog[0].warehouseProductId);
const make = (tag, quantity = 1) => call(route + 'stock/orders', 'POST', { requestId: 'remote-20261107-v2-' + tag, items: [{ catalogProductId: state.catalog[0].id, quantity }] }, rider);
const review = (id, approved) => call('/api/v1/admin/night/stock-orders/' + id + '/review' + s, 'POST', { approved, reason: '部署验收-' + approved }, state.adminSessions.operator.token);
const cancel = id => call(route + 'stock/orders/' + id + '/cancel', 'POST', { reason: '验收取消' }, rider);
const base = await dash();
await test('main H5 purchase completed with 340 cents income and quota released', async () => {
  const order = await call('/api/v1/night/orders/' + state.mainOrderId, 'GET', undefined, state.users.buyer.token);
  assert.equal(order.status, 'completed'); assert.equal(order.payableAmount, 900);
  assert.equal(base.todayIncome, 340); assert.equal(base.reservedValue, 0);
});
await test('duplicate stock submission holds quota once; requested cancellation restores it', async () => {
  const first = await make('cancel-request'); const again = await make('cancel-request'); assert.equal(first.id, again.id);
  assert.equal((await dash()).usedQuota, base.usedQuota + 800);
  await call(route + 'stock/orders/' + first.id + '/receive', 'POST', { items: [{ catalogProductId: state.catalog[0].id, quantity: 1 }] }, rider, 400);
  await cancel(first.id); await cancel(first.id); assert.equal((await dash()).usedQuota, base.usedQuota);
});
await test('rejected stock request releases quota without warehouse mutation', async () => {
  const before = await warehouse(); const order = await make('reject-request'); await review(order.id, false);
  assert.equal((await dash()).usedQuota, base.usedQuota); assert.equal((await warehouse()).stock, before.stock);
});
await test('approved stock cancellation restores warehouse reservation exactly once', async () => {
  const before = await warehouse(), order = await make('cancel-approved', 2); await review(order.id, true); await review(order.id, true);
  const held = await warehouse(); assert.equal(held.stock, before.stock - 2); assert.equal(held.nightReservedStock, 2);
  await call(route + 'stock/orders/' + order.id + '/cancel', 'POST', { reason: '楼长不可撤回已审核单' }, rider, 400);
  await call('/api/v1/admin/night/stock-orders/' + order.id + '/cancel' + s, 'POST', { reason: '验收校区撤销已审核单' }, state.adminSessions.operator.token);
  const after = await warehouse(); assert.equal(after.stock, before.stock); assert.equal(after.nightReservedStock, 0);
});
await test('over quota request is rejected without stock or quota mutation', async () => {
  await call(route + 'stock/orders', 'POST', { requestId: 'remote-over-quota-20261107', items: [{ catalogProductId: state.catalog[0].id, quantity: 999 }] }, rider, 400);
  assert.equal((await dash()).usedQuota, base.usedQuota);
});
async function report(tag, kind, quantity) {
  const row = await product();
  return call(route + 'inventory/reports', 'POST', { requestId: 'remote-report-' + tag + '-20261107', kind, reason: '验收' + tag, items: [{ nightProductId: row.id, inventoryVersion: row.inventoryVersion, quantity }] }, rider);
}
const reviewReport = (id, approved) => call('/api/v1/admin/night/inventory-reports/' + id + '/review' + s, 'POST', { approved, reason: '验收核实' }, state.adminSessions.operator.token);
await test('loss freezes goods but holds quota; rejection restores availability', async () => {
  const before = await product(), quota = (await dash()).usedQuota; const loss = await report('loss-reject', 'loss', 2);
  assert.equal((await product()).stock, before.stock - 2); assert.equal((await dash()).usedQuota, quota);
  await reviewReport(loss.id, false); assert.equal((await product()).stock, before.stock); assert.equal((await dash()).usedQuota, quota);
});
await test('loss approval releases held value once', async () => {
  const before = await product(), quota = (await dash()).usedQuota; const loss = await report('loss-approve', 'loss', 1);
  await reviewReport(loss.id, true); await reviewReport(loss.id, true);
  assert.equal((await product()).stock, before.stock - 1); assert.equal((await dash()).usedQuota, quota - 800);
});
await test('stocktake gain is unavailable until approval, then added once', async () => {
  const before = await product(), quota = (await dash()).usedQuota; const gain = await report('gain', 'stocktake', before.stock + 2);
  assert.equal((await product()).stock, before.stock); await reviewReport(gain.id, true); await reviewReport(gain.id, true);
  assert.equal((await product()).stock, before.stock + 2); assert.equal((await dash()).usedQuota, quota + 1600);
});
await test('stocktake loss holds value until approval', async () => {
  const before = await product(), quota = (await dash()).usedQuota; const loss = await report('stocktake-loss', 'stocktake', before.stock - 1);
  assert.equal((await dash()).usedQuota, quota); await reviewReport(loss.id, true); assert.equal((await dash()).usedQuota, quota - 800);
});
await test('editing catalog price does not revalue existing store assets', async () => {
  const before = await product(), quota = (await dash()).usedQuota;
  await call('/api/v1/admin/night/catalog/' + state.catalog[0].id + s, 'PATCH', { price: 1000 });
  assert.equal((await product()).inventoryValue, before.inventoryValue); assert.equal((await dash()).usedQuota, quota);
  await call('/api/v1/admin/night/catalog/' + state.catalog[0].id + s, 'PATCH', { price: 800 });
});
await test('repeat main actual receipt is idempotent; changing received count is rejected', async () => {
  const orders = items(await call(route + 'stock/orders', 'GET', undefined, rider)); const main = orders.find(row => row.id === state.stockOrders.find(x => x.status === 'received').id);
  const before = await goods(); const received = main.items.map(row => ({ catalogProductId: row.catalogProductId, quantity: row.receivedQuantity }));
  await call(route + 'stock/orders/' + main.id + '/receive', 'POST', { items: received }, rider);
  assert.deepEqual((await goods()).map(row => [row.id, row.stock, row.inventoryValue]), before.map(row => [row.id, row.stock, row.inventoryValue]));
  received[0].quantity += 1; await call(route + 'stock/orders/' + main.id + '/receive', 'POST', { items: received }, rider, 400);
});
state.inventoryChecksPassed = passed; save(); console.log(JSON.stringify({ passed: passed.length, cases: passed }, null, 2));
