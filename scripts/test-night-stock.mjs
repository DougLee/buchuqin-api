import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareNightRequestIndex } from './prepare-night-request-index.mjs';

const line = fs.readFileSync('.env', 'utf8').split(/\r?\n/).find(x => x.startsWith('DATABASE_URL='));
const url = new URL(process.env.DATABASE_URL || line?.slice(13).replace(/^['"]|['"]$/g, '') || '');
if (!url.pathname.endsWith('_spec')) throw new Error('只允许 _spec 数据库，拒绝修改业务或生产库');
const schema = process.env.NIGHT_STOCK_SCHEMA || 'night_stock_workflow_20261106';
if (!/^night_stock_[a-z0-9_]+$/.test(schema)) throw new Error('只允许独立 night_stock_ schema');
url.searchParams.set('schema', schema);
const env = { ...process.env, DATABASE_URL: url.toString(), NIGHT_STOCK_INTEGRATION: '1' };
const caseIndex = process.argv.indexOf('--case');
const caseArgs = caseIndex >= 0 ? ['--testNamePattern', process.argv[caseIndex + 1] || ''] : [];
console.log(`隔离库存验收：数据库 ${url.pathname.slice(1)}，schema ${schema}`);
if (!process.argv.includes('--skip-push')) await prepareNightRequestIndex(env.DATABASE_URL);
for (const [command, args] of [
  ...(!process.argv.includes('--skip-push') ? [['prisma', ['db', 'push', '--skip-generate']]] : []),
  ['jest', ['--runInBand', ...(process.argv.includes('--rbac') ? ['--testPathPatterns', 'admin/rbac|common/pagination'] : process.argv.includes('--all-night') ? ['--testPathPatterns', '/night/'] : ['--runTestsByPath', 'src/night/night-inventory.integration.spec.ts']), ...caseArgs]],
]) {
  const result = spawnSync(path.resolve('node_modules/.bin', command), args, { env, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
