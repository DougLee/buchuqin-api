import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const guard = new URL('./night-preview-network-guard.mjs', import.meta.url).href;
const testUrl = 'postgresql://fixture:fixture@127.0.0.1:54321/example_spec?schema=night_stock_preview_20261106';
function child(code, overrides = {}) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, encoding: 'utf8', timeout: 5000, env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: testUrl, ...overrides } });
}

test('隔离预加载拒绝非test进程、业务数据库名和public schema，尚未进行数据库或网络连接', () => {
  for (const env of [{ NODE_ENV: 'production' }, { DATABASE_URL: testUrl.replace('example_spec', 'business_database') }, { DATABASE_URL: testUrl.replace('night_stock_preview_20261106', 'public') }]) {
    const result = child(`await import(${JSON.stringify(guard)});`, env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /只允许独立夜宵测试进程/);
  }
});

test('HTTP与fetch离线桩确认拒绝外部主机和URL参数覆盖；没有发送任何真实请求', () => {
  const result = child(`
    import assert from 'node:assert/strict';
    import http from 'node:http'; import https from 'node:https';
    let escaped = 0;
    globalThis.fetch = async (_input, options) => { escaped++; return { options }; };
    for (const module of [http, https]) for (const method of ['request', 'get']) module[method] = () => { escaped++; return {}; };
    await import(${JSON.stringify(guard)});
    for (const module of [http, https]) for (const method of ['request', 'get']) {
      assert.throws(() => module[method]('https://admin.buchuqin.com/api/v1'), /非白名单/);
      assert.throws(() => module[method]({ hostname: 'api.mch.weixin.qq.com' }), /非白名单/);
      assert.throws(() => module[method]('http://localhost:3150', { hostname: 'admin.buchuqin.com' }), /非白名单/);
    }
    assert.throws(() => fetch('https://admin.buchuqin.com/api/v1'), /非白名单/);
    assert.equal(escaped, 0);
    const allowed = await fetch('http://localhost:3150/api/v1/night/entry', { redirect: 'follow' });
    assert.equal(allowed.options.redirect, 'manual');
    assert.equal(escaped, 1); // Only our offline stub was invoked.
  `);
  assert.equal(result.status, 0, result.stderr);
});

test('集成测试入口拒绝业务库名与非独立schema，不启动Prisma或Jest', () => {
  const entry = new URL('./test-night-stock.mjs', import.meta.url).href;
  for (const env of [{ DATABASE_URL: testUrl.replace('example_spec', 'business_database') }, { NIGHT_STOCK_SCHEMA: 'public' }]) {
    const result = child(`await import(${JSON.stringify(entry)});`, env);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /只允许.*(_spec|night_stock_)/);
    assert.ok(!result.stdout.includes('Prisma schema loaded'));
  }
});
