import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { call, state, save, q, items } from './http.mjs';
if (!state.boundaryOrganizationId) {
  const org = await call('/api/v1/admin/organizations', 'POST', { name: '夜宵验收组织边界对照20261107', shortName: '边界对照', wxAppId: 'wx2026110700000003' });
  state.boundaryOrganizationId = org.id; save();
  const campus = await call('/api/v1/admin/campuses', 'POST', { organizationId: org.id, name: '夜宵组织边界对照校区20261107', shortName: '边界对照', warehouseName: '边界验收仓' });
  state.boundaryCampusId = campus.id; save();
  const password = randomBytes(24).toString('base64url');
  await call('/api/v1/admin/accounts', 'POST', { username: 'qa7_other_org', password, nickname: '验收其他组织管理员', orgLevel: 'org', organizationId: org.id, grants: [{ roleCode: 'qa1107-operator', scope: 'campus', campusId: campus.id }] });
  state.boundaryAdmin = await call('/api/v1/auth/admin-login', 'POST', { username: 'qa7_other_org', password }, null, 200); save();
}
const token = state.boundaryAdmin.token, passed = [];
for (const [name, route, method, body] of [
  ['other organization cannot list main campus stores', '/api/v1/admin/night/stores' + q(state.campusId), 'GET'],
  ['other organization cannot read main store by id', '/api/v1/admin/night/stores/' + state.storeId, 'GET'],
  ['other organization cannot edit main catalog', '/api/v1/admin/night/catalog/' + state.catalog[0].id, 'PATCH', { price: 900 }],
  ['other organization cannot configure main campus', '/api/v1/admin/night/config' + q(state.campusId), 'PUT', { campusId: state.campusId, nightEnabled: false }],
  ['other organization cannot refund main order', '/api/v1/admin/night/orders/' + state.mainOrderId + '/refund', 'POST', { reason: '应拒绝跨组织退款' }],
]) { await call(route, method, body, token, 403); passed.push(name); }
assert.equal(items(await call('/api/v1/admin/night/stores' + q(state.boundaryCampusId), 'GET', undefined, token)).length, 0);
state.organizationChecksPassed = passed; save(); console.log(JSON.stringify({ passed: passed.length, cases: passed }, null, 2));
