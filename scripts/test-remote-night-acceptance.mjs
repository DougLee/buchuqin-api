import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertAcceptanceEnvironment, createScope } from './remote-night-acceptance/guard.mjs';
const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'night-remote-guard-'));
const marker = path.join(folder, 'environment.json');
const expected = { host: '139.199.3.190', origin: 'https://admin-test.buchuqin.com', organizationName: '夜宵部署验收20261107' };
fs.writeFileSync(marker, JSON.stringify(expected));
const env = { NIGHT_REMOTE_ACCEPTANCE: '20261107', DATABASE_URL: 'postgresql://fixture:fixture@1Panel-postgresql-rbaV:5432/buchuqinshishe?schema=public' };
test('验收适配必须有显式标记、固定测试宿主信息和固定测试数据库目标，不连接网络', () => {
  assert.deepEqual(assertAcceptanceEnvironment(env, marker), expected);
  for (const invalid of [{ ...env, NIGHT_REMOTE_ACCEPTANCE: '' }, { ...env, DATABASE_URL: env.DATABASE_URL.replace('1Panel-postgresql-rbaV', 'other-database') }, { ...env, DATABASE_URL: env.DATABASE_URL.replace('/buchuqinshishe', '/other_database') }, { ...env, DATABASE_URL: env.DATABASE_URL.replace('schema=public', 'schema=other') }]) assert.throws(() => assertAcceptanceEnvironment(invalid, marker));
  const wrong = path.join(folder, 'wrong.json');
  fs.writeFileSync(wrong, JSON.stringify({ ...expected, origin: 'https://invalid.example' }));
  assert.throws(() => assertAcceptanceEnvironment(env, wrong));
});
test('只有明确命名且无真实支付凭证的验收组织可使用模拟通道，其他组织拒绝', async () => {
  let organization = { name: expected.organizationName, mchId: null, privateKey: null };
  const scoped = createScope({ campus: { findUnique: async ({ where }) => where.id === 'qa-campus' ? { organizationId: 'qa-org' } : null }, organization: { findUnique: async () => organization } }, expected);
  assert.equal(await scoped('qa-campus'), true);
  assert.equal(await scoped('foreign-campus'), false);
  assert.equal(await scoped(undefined), false);
  organization = { ...organization, mchId: 'actual-merchant' }; assert.equal(await scoped('qa-campus'), false);
  organization = { name: '其他组织', mchId: null, privateKey: null }; assert.equal(await scoped('qa-campus'), false);
});
test.after(() => fs.rmSync(folder, { recursive: true, force: true }));
