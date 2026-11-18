import fs from 'node:fs';
import { assertAcceptanceEnvironment, runtimeRequire } from './guard.mjs';
const marker = assertAcceptanceEnvironment();
const { PrismaClient } = runtimeRequire('@prisma/client');
const { hash } = runtimeRequire('bcryptjs');
const { JwtService } = runtimeRequire('@nestjs/jwt');
const { RbacService } = runtimeRequire('./dist/src/admin/rbac/rbac.service.js');
const db = new PrismaClient();
try {
  const material = JSON.parse(fs.readFileSync('/acceptance/credentials.json', 'utf8'));
  if (material.username !== 'night_e2e_20261107' || material.password?.length < 24) throw new Error('验收账号材料不合法');
  await new RbacService(db).syncRegistry();
  const account = await db.adminAccount.upsert({ where: { id: 'night-remote-admin-20261107' }, update: {}, create: { id: 'night-remote-admin-20261107', username: material.username, passwordHash: await hash(material.password, 10), nickname: '夜宵部署验收管理员', role: 'admin', campusId: 'campus-hq', orgLevel: 'platform', rbacMigrated: true } });
  if (account.username !== material.username) throw new Error('验收账号归属冲突');
  const role = await db.adminRole.findUniqueOrThrow({ where: { code: 'super-admin' } });
  if (!await db.adminAccountRole.count({ where: { accountId: account.id, roleId: role.id, scope: 'platform' } })) {
    await db.adminAccountRole.create({ data: { accountId: account.id, roleId: role.id, scope: 'platform', grantedBy: 'night-remote-acceptance-20261107' } });
    await db.auditLog.create({ data: { campusId: 'campus-hq', operator: account.id, action: 'night.remote.acceptance.bootstrap', entityType: 'adminAccount', entityId: account.id, after: { testOnly: true, date: '20261107' } } });
  }
  const jwt = new JwtService({ secret: process.env.JWT_SECRET });
  // stdout MUST be redirected into a 0600 local material file, never archived.
  console.log(JSON.stringify({ origin: marker.origin, username: material.username, password: material.password, adminId: account.id, adminToken: jwt.sign({ id: account.id, campusId: account.campusId, role: account.role, appKind: 'admin', sv: account.sessionVersion }, { expiresIn: '1d' }) }));
} catch (error) {
  console.error('验收引导失败：' + (error.code || error.name)); process.exitCode = 1;
} finally { await db.$disconnect(); }
