import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

// This directory is NOT copied into the application runtime by Dockerfile.
// It is mounted explicitly on the named TEST host for this acceptance run only.
export function assertAcceptanceEnvironment(env = process.env, markerPath = '/acceptance/environment.json') {
  assert.equal(env.NIGHT_REMOTE_ACCEPTANCE, '20261107', '缺少显式测试验收标记');
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  assert.equal(marker.host, '139.199.3.190');
  assert.equal(marker.origin, 'https://admin-test.buchuqin.com');
  assert.equal(marker.organizationName, '夜宵部署验收20261107');
  const database = new URL(env.DATABASE_URL || '');
  assert.equal(database.hostname, '1Panel-postgresql-rbaV', '禁止连接其他数据库主机');
  assert.equal(database.pathname, '/buchuqinshishe');
  assert.equal(database.searchParams.get('schema'), 'public');
  return marker;
}
export const runtimeRequire = createRequire('/app/package.json');
export function createScope(db, marker) {
  return async campusId => {
    if (typeof campusId !== 'string' || !campusId) return false;
    const campus = await db.campus.findUnique({ where: { id: campusId }, select: { organizationId: true } });
    if (!campus?.organizationId) return false;
    const org = await db.organization.findUnique({ where: { id: campus.organizationId }, select: { name: true, mchId: true, privateKey: true } });
    return org?.name === marker.organizationName && !org.mchId && !org.privateKey;
  };
}
