import { call, state, save, items } from './http.mjs';
for (const role of ['buyer', 'foreignBuyer']) {
  const user = state.users[role];
  const buildingName = role === 'buyer' ? '验收9栋' : '对照1栋';
  const rows = items(await call('/api/v1/addresses', 'GET', undefined, user.token));
  const address = rows.find(row => row.buildingName === buildingName) || await call('/api/v1/addresses', 'POST', { buildingName, floor: 2, room: '201', contactName: role === 'buyer' ? '夜宵验收买家' : '跨校区对照买家', phone: user.testPhone, isDefault: true }, user.token);
  state[role + 'AddressId'] = address.id; save();
}
console.log('Normal registered-room addresses created through user API.');
