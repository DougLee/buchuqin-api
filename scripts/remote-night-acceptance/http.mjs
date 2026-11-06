// Client-side harness: normal HTTP calls to the deployed TEST domain only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
export const root = '/tmp/night-remote-acceptance';
export const session = JSON.parse(fs.readFileSync(root + '/session.json', 'utf8'));
assert.equal(session.origin, 'https://admin-test.buchuqin.com');
export const state = fs.existsSync(root + '/state.json') ? JSON.parse(fs.readFileSync(root + '/state.json', 'utf8')) : {};
export const items = value => Array.isArray(value) ? value : value.items;
export function save() { fs.writeFileSync(root + '/state.json', JSON.stringify(state, null, 2), { mode: 0o600 }); }
export async function call(route, method = 'GET', body, token = session.adminToken, expected = method === 'POST' ? 201 : 200) {
  assert.ok(route.startsWith('/api/v1/'));
  const url = new URL(route, session.origin); assert.equal(url.origin, session.origin);
  const response = await fetch(url, { method, redirect: 'manual', headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) }, ...(body !== undefined ? { body: body instanceof FormData ? body : JSON.stringify(body) } : {}) });
  const data = await response.json();
  fs.appendFileSync(root + '/http-evidence.jsonl', JSON.stringify({ time: new Date().toISOString(), method, route, status: response.status, expected, message: data.message || '' }) + '\n');
  assert.equal(response.status, expected, `${method} ${route}: ${data.message}`);
  return data.data;
}
export const q = campusId => '?campus=' + encodeURIComponent(campusId);
