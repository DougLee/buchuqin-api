import fs from 'node:fs';
import assert from 'node:assert/strict';
import { call, state, save, session, items, q, root } from './http.mjs';

const material = JSON.parse(fs.readFileSync(root + '/credentials.json', 'utf8'));
const login = await call('/api/v1/auth/admin-login', 'POST', { username: material.username, password: material.password }, null, 200);
session.adminToken = login.token;
fs.writeFileSync(root + '/session.json', JSON.stringify(session), { mode: 0o600 });
let organizations = items(await call('/api/v1/admin/organizations'));
let org = organizations.find(row => row.name === '夜宵部署验收20261107');
if (!org) org = await call('/api/v1/admin/organizations', 'POST', { name: '夜宵部署验收20261107', shortName: '夜宵验收', wxAppId: 'wx2026110700000001', deliveryWxAppId: 'wx2026110700000002', wxSecret: 'ACCEPTANCE_ONLY_NO_REAL_WECHAT', deliveryWxSecret: 'ACCEPTANCE_ONLY_NO_REAL_WECHAT' });
state.organizationId = org.id; save();
const campuses = items(await call('/api/v1/admin/campuses?page=1&pageSize=100'));
for (const [key, name, shortName] of [['campusId', '夜宵验收校区20261107', '夜宵验收'], ['foreignCampusId', '权限对照校区20261107', '权限对照']]) {
  const existing = campuses.find(row => row.name === name);
  const campus = existing || await call('/api/v1/admin/campuses', 'POST', { organizationId: org.id, name, shortName, warehouseName: shortName + '校园仓', deliveryFeeInstant: 200, deliveryFeeScheduled: 100, deliveryThreshold: 0 });
  state[key] = campus.id; save();
}
for (const [key, campusId, name] of [['buildingId', state.campusId, '验收9栋'], ['otherBuildingId', state.campusId, '验收10栋'], ['foreignBuildingId', state.foreignCampusId, '对照1栋']]) {
  const existing = items(await call('/api/v1/admin/buildings' + q(campusId))).find(row => row.name === name);
  const building = existing || await call('/api/v1/admin/buildings' + q(campusId), 'POST', { name, floors: 6, hasElevator: true, gender: 'mixed' });
  state[key] = building.id; save();
  const rooms = items(await call(`/api/v1/admin/buildings/${building.id}/rooms` + q(campusId)));
  for (const roomNo of ['201', '202']) if (!rooms.some(row => row.roomNo === roomNo && row.floor === 2)) await call(`/api/v1/admin/buildings/${building.id}/rooms` + q(campusId), 'POST', { floor: 2, roomNo });
}
state.users ||= {};
for (const [key, tag, campusId, phone] of [['candidate', 'candidate', state.campusId, '13800001101'], ['buyer', 'buyer', state.campusId, '13800001102'], ['foreignBuyer', 'foreign-buyer', state.foreignCampusId, '13800001103']]) {
  const result = await call('/api/v1/auth/wechat-login', 'POST', { code: `QA20261107:${material.authNonce}:${tag}`, appid: 'wx2026110700000001', campusId }, null, 200);
  assert.equal(result.user.campusId, campusId);
  state.users[key] = { ...result, testPhone: phone }; save();
  await call('/api/v1/auth/phone', 'POST', { phone }, result.token);
}
console.log(JSON.stringify({ foundation: 'passed', organizationId: state.organizationId, campusId: state.campusId, foreignCampusId: state.foreignCampusId, buildingId: state.buildingId, usersCreatedViaLoginApi: Object.keys(state.users), businessStockOrMoneySeeded: false }, null, 2));
