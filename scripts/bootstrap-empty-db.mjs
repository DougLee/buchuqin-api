/** Empty-database bootstrap preserving historical SQL/checksums, including its known order inversion.
 * Default is plan-only. Never run against an existing schema. Upgrade existing databases with migrate deploy.
 */
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import pg from 'pg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--apply' && !arg.startsWith('--through='))) throw new Error('Unknown argument');
const through = args.find(arg => arg.startsWith('--through='))?.slice('--through='.length);
const migrationRoot = resolve(root, 'prisma/migrations');
const available = (await readdir(migrationRoot, { withFileTypes: true }))
  .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
if (through && !available.includes(through)) throw new Error('Unknown --through migration');
const names = available.filter(name => !through || name <= through);
const dependency = '20260917000000_restock_batch';
const dependent = '20260915120000_restock_shipment';
if (names.includes(dependent)) {
  if (!names.includes(dependency)) throw new Error('Requested cutoff splits the historical shipment dependency');
  names.splice(names.indexOf(dependency), 1);
  names.splice(names.indexOf(dependent), 0, dependency);
}
console.log(`Empty-schema bootstrap: ${names.length} original migrations; restock_batch precedes restock_shipment.`);
if (!args.includes('--apply')) {
  console.log(names.join('\n'));
  console.log('Plan only. Set DATABASE_URL and use --apply for an empty database.');
  process.exit(0);
}
const sqlFiles = new Map();
for (const name of names) {
  const sql = await readFile(resolve(migrationRoot, name, 'migration.sql'), 'utf8');
  if (/^\s*(BEGIN|COMMIT|ROLLBACK|START TRANSACTION)\b/im.test(sql))
    throw new Error(`Migration ${name} has its own transaction control; manual bootstrap review required`);
  sqlFiles.set(name, sql);
}
const url = new URL(process.env.DATABASE_URL ?? '');
const schema = url.searchParams.get('schema') || 'public';
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error('Unsupported schema identifier');
url.searchParams.delete('schema');
const client = new pg.Client({ connectionString: url.toString() });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query('SELECT pg_advisory_xact_lock(728281002)');
  const existing = await client.query(`SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relkind IN ('r','p','v','m','S','f')`, [schema]);
  if (existing.rowCount) throw new Error('Refusing bootstrap: target schema is not empty. No data was changed.');
  await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  await client.query(`SET LOCAL search_path TO "${schema}"`);
  for (const name of names) {
    await client.query(sqlFiles.get(name));
    console.log(`SQL applied: ${name}`);
  }
  await client.query('COMMIT');
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally { await client.end(); }
// Use Prisma's own resolver, rather than fabricating migration checksums/metadata.
for (const name of names) {
  const result = spawnSync('pnpm', ['exec', 'prisma', 'migrate', 'resolve', '--applied', name], {
    cwd: root, env: process.env, encoding: 'utf8',
  });
  if (result.status !== 0) {
    console.error(`SQL committed, but migration ledger registration failed at ${name}.`);
    console.error('Do not rerun bootstrap or migrate deploy. See docs/rbac/migration-guide.md for ledger recovery.');
    // Do not print CLI diagnostics here: connection failure messages may contain connection details.
    process.exit(1);
  }
  console.log(`Ledger recorded: ${name}`);
}
console.log('Bootstrap complete. Subsequent upgrades use prisma migrate deploy.');
