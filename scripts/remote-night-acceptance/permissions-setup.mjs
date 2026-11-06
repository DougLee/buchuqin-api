import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { call, state, save, q, root } from './http.mjs';
const material = JSON.parse(fs.readFileSync(root + '/credentials.json', 'utf8'));
state.staffSessions ||= {};
if (!state.unboundBuildingId) {
  const building = await call('/api/v1/admin/buildings' + q(state.campusId), 'POST', { name: '验收未开夜宵11栋', floors: 3, hasElevator: false, gender: 'mixed' });
  state.unboundBuildingId = building.id; save();
}
for (const [key, role, name, buildingId, campusId] of [
  ['intern', 'intern-building-manager', '验收实习楼长', state.otherBuildingId, state.campusId],
  ['rider', 'fulltime-rider', '验收配送员', null, state.campusId],
  ['unbound', 'building-manager', '验收未绑店楼长', state.unboundBuildingId, state.campusId],
  ['foreignManager', 'building-manager', '对照校区楼长', state.foreignBuildingId, state.foreignCampusId],
]) {
  if (!state.staffSessions[key]) {
    const staffNo = 'QA1107' + key;
    const staff = await call('/api/v1/admin/staff' + q(campusId), 'POST', { campusId, name, staffNo, role, ...(buildingId ? { buildingId } : {}), phone: '13800001200', status: 'online' });
    const auth = await call('/api/v1/auth/staff-bind', 'POST', { code: `QA20261107:${material.authNonce}:${key}`, appid: 'wx2026110700000002', staffNo, name }, null, 200);
    assert.equal(auth.user.id, staff.id); state.staffSessions[key] = auth; save();
  }
}
if (!state.internStoreId) {
  const store = await call('/api/v1/admin/night/stores' + q(state.campusId), 'POST', { buildingId: state.otherBuildingId, managerStaffId: state.staffSessions.intern.user.id, commissionRate: 2000 });
  state.internStoreId = store.id; save();
}
state.adminSessions ||= {};
for (const [key, campusId, codes] of [
  ['reader', state.campusId, ['night-stores', 'night-orders', 'night-settlements']],
  ['operator', state.campusId, ['night-stores', 'night-stores.write', 'night-orders', 'night-orders.refund', 'night-settlements', 'night-settlements.write']],
  ['foreignOperator', state.foreignCampusId, ['night-stores', 'night-stores.write', 'night-orders', 'night-orders.refund']],
]) {
  if (state.adminSessions[key]) continue;
  const code = 'qa1107-' + key.toLowerCase();
  await call('/api/v1/admin/rbac/roles', 'POST', { code, name: '验收' + key, menuCodes: codes });
  const password = randomBytes(24).toString('base64url');
  const username = 'qa7_' + key;
  const account = await call('/api/v1/admin/accounts', 'POST', { username, password, nickname: '夜宵验收' + key, orgLevel: 'campus', grants: [{ roleCode: code, scope: 'campus', campusId }] });
  const auth = await call('/api/v1/auth/admin-login', 'POST', { username, password }, null, 200);
  state.adminSessions[key] = { ...auth, accountId: account.id, username, password }; save();
}
console.log('Normal staff-bind and campus-scoped reader/operator accounts prepared.');
