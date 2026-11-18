import assert from 'node:assert/strict';
import { call, state, save, q, items } from './http.mjs';
import { externalConfirm } from './payment-helper.mjs';
const s = q(state.campusId), route = '/api/v1/night-rider/night/';
const passed = [...(state.financeChecksPassed || [])];
const test = async (name, fn) => { if (passed.includes(name)) return; await fn(); passed.push(name); state.financeChecksPassed = passed; save(); console.log('PASS ' + name); };
await test('main deposit top-up charges only 500 yuan difference and repeated confirmation credits once', async () => {
  const token = state.manager.token;
  const intent = await call(route + 'deposit/pay', 'POST', { targetTier: 100000 }, token);
  state.mainTopUpIntent = intent.depositOrderId; save();
  assert.equal(intent.amount, 50000);
  externalConfirm('deposit', intent.depositOrderId, state.mainStaffId); externalConfirm('deposit', intent.depositOrderId, state.mainStaffId);
  const deposit = await call(route + 'deposit', 'GET', undefined, token);
  assert.equal(deposit.deposit, 100000); assert.equal(deposit.total, 2);
});
await test('stock prevents deposit refund and accounts without finance permission are rejected', async () => {
  await call('/api/v1/admin/night/stores/' + state.storeId + '/deposit/refund' + s, 'POST', { requestId: 'blocked-refund-stock-20261107' }, undefined, 400);
  await call('/api/v1/admin/night/stores/' + state.storeId + '/deposit/refund' + s, 'POST', { requestId: 'blocked-finance-role-20261107' }, state.adminSessions.operator.token, 403);
});
await test('pending commissions settle once, financial paid marker is idempotent', async () => {
  const before = await call(route + 'dashboard', 'GET', undefined, state.manager.token); assert.equal(before.todayIncome, 660);
  const batch = await call('/api/v1/admin/night/settlements/settle' + s, 'POST', { campusId: state.campusId, storeIds: [state.storeId] }, state.adminSessions.operator.token);
  assert.equal(batch.commissionTotal + batch.deliveryFeeTotal, 660); state.settlementBatch = batch.batch; save();
  const again = await call('/api/v1/admin/night/settlements/settle' + s, 'POST', { campusId: state.campusId, storeIds: [state.storeId] }, state.adminSessions.operator.token); assert.equal(again.txnCount, 0);
  const marker = { remark: '验收模拟线下打款登记，不代表真实打款' };
  await call('/api/v1/admin/night/settlements/' + batch.batch + '/pay' + s, 'POST', marker, state.adminSessions.operator.token);
  await call('/api/v1/admin/night/settlements/' + batch.batch + '/pay' + s, 'POST', marker, state.adminSessions.operator.token);
  const rows = items(await call('/api/v1/admin/night/settlements' + s)); assert.equal(rows.find(row => row.batch === batch.batch).markedPaid, true);
  assert.equal((await call(route + 'dashboard', 'GET', undefined, state.manager.token)).todayIncome, 660);
});
await test('empty comparison store deposit deduction and original-route partial/full refund maintain ledger', async () => {
  const token = state.staffSessions.intern.token, storeId = state.internStoreId, owner = state.staffSessions.intern.user.id;
  const intent = await call(route + 'deposit/pay', 'POST', { targetTier: 50000 }, token); state.internDepositIntent = intent.depositOrderId; save();
  externalConfirm('deposit', intent.depositOrderId, owner);
  await call('/api/v1/admin/night/stores/' + storeId + '/deposit/deduct' + s, 'POST', { amount: 1000, reason: '验收判责扣款' });
  const partial = { requestId: 'partial-deposit-refund-20261107', amount: 10000, reason: '验收原路部分退押' };
  await call('/api/v1/admin/night/stores/' + storeId + '/deposit/refund' + s, 'POST', partial);
  await call('/api/v1/admin/night/stores/' + storeId + '/deposit/refund' + s, 'POST', partial);
  assert.equal((await call(route + 'deposit', 'GET', undefined, token)).deposit, 39000);
  await call('/api/v1/admin/night/stores/' + storeId + '/deposit/refund' + s, 'POST', { requestId: 'remaining-deposit-refund-20261107', reason: '验收余款退押' });
  const detail = await call(route + 'deposit', 'GET', undefined, token); assert.equal(detail.deposit, 0);
  assert.equal(detail.txns.filter(row => row.type === 'refund').reduce((sum, row) => sum + row.amount, 0), 49000);
  await call(route + 'store/open', 'POST', undefined, token, 400);
});
console.log(JSON.stringify({ passed: passed.length, cases: passed }, null, 2));
