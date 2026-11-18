import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { call, state, q, items } from '../remote-night-acceptance/http.mjs';
const org = items(await call('/api/v1/admin/organizations')).find(x => x.id === state.organizationId);
assert.equal(org?.name, '夜宵部署验收20261107');
await call('/api/v1/admin/night/stores' + q(state.campusId), 'POST', { campusId: state.campusId, buildingId: state.buildingId, commissionRate: 2000 }, undefined, 400);
console.log('PASS 同楼栋重复建店400，不产生新店');
const token = state.users.buyer.token;
const coupons = await call('/api/v1/night/coupons', 'GET', undefined, token);
const held = coupons.mine.find(x => ['claimed', 'released'].includes(x.status) && x.coupon.name === '验收night券20261107');
assert.ok(held);
const catalog = items(await call('/api/v1/admin/coupons' + q(state.campusId) + '&businessType=night'));
const template = catalog.find(x => x.id === held.coupon.id);
assert.equal(template?.campusId, state.campusId);
let order;
try {
  await call('/api/v1/admin/coupons/' + template.id + q(state.campusId), 'PATCH', { status: 'paused' });
  await call('/api/v1/night/coupons/' + template.id + '/claim', 'POST', undefined, token, 400);
  const visible = await call('/api/v1/night/coupons', 'GET', undefined, token);
  assert.ok(visible.mine.some(x => x.id === held.id && ['claimed', 'released'].includes(x.status)));
  const product = (await call('/api/v1/night/stores/' + state.storeId + '/products', 'GET', undefined, token)).find(x => x.catalogProductId === 'cmw5g0nf60038ki019aijpkqw');
  order = await call('/api/v1/night/orders', 'POST', { requestId: 'parity-paused-coupon-' + randomUUID(), storeId: state.storeId, addressId: state.buyerAddressId, couponId: held.id, items: [{ productId: product.id, quantity: 1 }], remark: '暂停发放不作废已领券验收' }, token);
  assert.equal(order.couponDiscount, 100);
  console.log('PASS 暂停发放拒新领，已领有效券仍可锁单抵100分');
} finally {
  if (order) await call('/api/v1/night/orders/' + order.id + '/cancel', 'POST', { reason: '验收未支付取消，恢复库存和券' }, token);
  await call('/api/v1/admin/coupons/' + template.id + q(state.campusId), 'PATCH', { status: template.status });
}
console.log('PASS 取消测试单并恢复券模板原状态；未付款、未增押金或库存');
