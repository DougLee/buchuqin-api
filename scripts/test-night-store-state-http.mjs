import fs from 'node:fs';
import assert from 'node:assert/strict';

const fixture = JSON.parse(fs.readFileSync('/tmp/night-stock-preview.json', 'utf8'));
const { user } = JSON.parse(fs.readFileSync('/tmp/night-security-sessions.json', 'utf8'));
assert.equal(fixture.storeId, 'night-preview-store'); assert.equal(fixture.campusId, 'night-preview-campus');
const expected = process.argv[2];
assert.ok(['paused', 'closed'].includes(expected), '必须先通过H5暂停或打烊');
const base = 'http://localhost:3150/api/v1';
const read = async (route, token) => {
  const response = await fetch(base + route, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  return (await response.json()).data;
};
const dash = await read('/night-rider/night/dashboard', fixture.staffToken);
assert.equal(dash.store.id, fixture.storeId); assert.equal(dash.store.status, expected);
const products = await read(`/night/stores/${fixture.storeId}/products`, user);
const product = products.find(row => row.name.includes('可口可乐'));
assert.ok(product && product.stock > 0);
const response = await fetch(base + '/night/orders', { method: 'POST', headers: { Authorization: `Bearer ${user}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: `closed-state-${Date.now()}`, storeId: fixture.storeId, addressId: 'night-demo-address-0', items: [{ productId: product.id, quantity: 1 }] }) });
const result = await response.json();
assert.equal(response.status, 400); assert.match(result.message, /未营业/);
const after = await read(`/night/stores/${fixture.storeId}/products`, user);
assert.equal(after.find(row => row.id === product.id).stock, product.stock);
console.log(JSON.stringify({ passed: true, state: expected, rejectedStatus: response.status, message: result.message, beforeStock: product.stock, afterStock: product.stock, localOnly: true }, null, 2));
