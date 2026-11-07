import { execFileSync } from 'node:child_process';
import { call, state } from './http.mjs';
export function externalConfirm(kind, id, ownerId) {
  if (!['user', 'deposit', 'day'].includes(kind) || !/^[a-zA-Z0-9_-]{1,100}$/.test(id) || !/^[a-zA-Z0-9_-]{1,100}$/.test(ownerId)) throw Error('Invalid test confirmation');
  execFileSync('ssh', ['-o', 'BatchMode=yes', '139.199.3.190-buchuqin-test', 'docker', 'exec', '-w', '/app', 'buchuqin-api', 'node', '/acceptance/confirm.mjs', kind, id, ownerId], { timeout: 25000, stdio: 'pipe' });
}
export async function payOrder(order) {
  const intent = await call('/api/v1/night/orders/' + order.id + '/pay', 'POST', undefined, state.users.buyer.token);
  externalConfirm('user', order.id, state.users.buyer.user.id);
  return call('/api/v1/night/orders/' + order.id + '/pay-status', 'GET', undefined, state.users.buyer.token);
}
