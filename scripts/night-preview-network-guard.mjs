import http from 'node:http';
import https from 'node:https';

const database = new URL(process.env.DATABASE_URL || '');
if (process.env.NODE_ENV !== 'test' || !database.pathname.endsWith('_spec') || !/^night_stock_[a-z0-9_]+$/.test(database.searchParams.get('schema') || '')) throw new Error('网络隔离只允许独立夜宵测试进程');
const allowed = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'admin-test.buchuqin.com']);
function check(input) {
  const host = typeof input === 'string' || input instanceof URL ? new URL(input).hostname : input?.hostname || input?.host?.split(':')[0] || 'localhost';
  if (!allowed.has(host)) throw new Error(`测试进程禁止连接非白名单HTTP主机：${host}`);
}
const originalFetch = globalThis.fetch;
globalThis.fetch = function(input, options) {
  check(typeof input?.url === 'string' ? input.url : input);
  // A whitelisted host must not redirect a test request into another environment.
  return originalFetch(input, { ...options, redirect: 'manual' });
};
for (const module of [http, https]) {
  for (const method of ['request', 'get']) {
    const original = module[method];
    module[method] = function(input, ...args) {
      check(input);
      // Node's request(url, options) permits options to override the URL hostname.
      if (args[0] && typeof args[0] === 'object') check(args[0]);
      return original.call(this, input, ...args);
    };
  }
}
console.error('夜宵预览HTTP出站白名单已启用；生产API、微信网关及外部存储均不可连接。');
