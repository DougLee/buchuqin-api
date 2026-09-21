/** Read-only, repeatable snapshot compatible with pre/post marker schemas. No password hashes. */
import { writeFile } from 'node:fs/promises';
import pg from 'pg';
const output = process.argv[2];
if (!output) throw new Error('Usage: DATABASE_URL=... node scripts/rbac-snapshot.mjs <output.json>');
const url = new URL(process.env.DATABASE_URL ?? '');
const schema = url.searchParams.get('schema') || 'public';
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error('Unsupported schema');
url.searchParams.delete('schema');
const client = new pg.Client({ connectionString: url.toString() });
await client.connect();
try {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await client.query(`SET LOCAL search_path TO "${schema}"`);
  const queries = {
    accounts: `SELECT id,username,nickname,role,"campusId",status,"sessionVersion",to_jsonb(a)->'rbacMigrated' AS "rbacMigrated" FROM "AdminAccount" a ORDER BY id`,
    roles: `SELECT id,code,name,status,builtin,seeded,menus,to_jsonb(r)->'menusMigrated' AS "menusMigrated" FROM "AdminRole" r ORDER BY id`,
    grants: `SELECT "accountId","roleId",scope,"campusId" FROM "AdminAccountRole" ORDER BY "accountId","roleId",scope,"campusId"`,
    menus: `SELECT id,code,"parentId",name,type,perms,path,"viewPath",icon,"orderNum","isShow",status,to_jsonb(m)->'keepAlive' AS "keepAlive" FROM "AdminMenu" m ORDER BY id`,
    roleMenus: `SELECT "roleId","menuId" FROM "AdminRoleMenu" ORDER BY "roleId","menuId"`,
    legacyAccess: `SELECT "accountId","campusId" FROM "AdminCampusAccess" ORDER BY "accountId","campusId"`,
    legacyPermissions: `SELECT p.code,r."roleId" FROM "AdminRolePermission" r JOIN "AdminPermission" p ON p.id=r."permissionId" ORDER BY r."roleId",p.code`,
    campuses: `SELECT id,status,type FROM "Campus" ORDER BY id`,
    explicitEdits: `SELECT action,"entityType","entityId","createdAt" FROM "AuditLog" WHERE action IN ('rbac.grant.set','rbac.role.create','rbac.role.update','rbac.role.delete') ORDER BY "createdAt",id`,
    version: `SELECT id,version FROM "RbacState" ORDER BY id`,
    migrations: `SELECT migration_name,checksum,finished_at,rolled_back_at FROM "_prisma_migrations" ORDER BY migration_name,started_at`,
  };
  const snapshot = { capturedAt: new Date().toISOString(), schema, data: {} };
  for (const [key, sql] of Object.entries(queries)) snapshot.data[key] = (await client.query(sql)).rows;
  await client.query('COMMIT');
  // Never overwrite a previous before/after snapshot accidentally.
  await writeFile(output, JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(`Read-only RBAC snapshot saved: ${snapshot.data.accounts.length} accounts; no password hashes.`);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally { await client.end(); }
