import assert from 'node:assert/strict';
import { call, state, save, q, items } from './http.mjs';
const rows = items(await call('/api/v1/night/orders', 'GET', undefined, state.users.buyer.token));
const order = rows.find(row => row.remark === '20261107正常夜宵链路验收');
assert.ok(order); state.mainOrderId = order.id; save();
const detail = await call('/api/v1/night/orders/' + order.id, 'GET', undefined, state.users.buyer.token);
const admin = await call('/api/v1/admin/night/orders/' + order.id + q(state.campusId));
assert.equal(admin.status, detail.status);
console.log(JSON.stringify({ id: order.id, user: detail, admin }, null, 2));
