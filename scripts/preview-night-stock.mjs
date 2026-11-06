import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { seedNightPreview } from './seed-night-preview.mjs';

// Local-only preview. The shared test database/public schema and production are forbidden.
const require = createRequire(import.meta.url);
const line = fs.readFileSync('.env', 'utf8').split(/\r?\n/).find(x => x.startsWith('DATABASE_URL='));
const url = new URL(line?.slice(13).replace(/^['"]|['"]$/g, '') || '');
if (!url.pathname.endsWith('_spec')) throw new Error('预览只允许 _spec 数据库');
url.searchParams.set('schema', 'night_stock_preview_20261106');
const secretPath = '/tmp/night-stock-preview-secret';
if (!fs.existsSync(secretPath)) fs.writeFileSync(secretPath, randomBytes(48).toString('hex'), { mode: 0o600 });
const env = { ...process.env, DATABASE_URL: url.toString(), PORT: '3150', JWT_SECRET: fs.readFileSync(secretPath, 'utf8'), NODE_ENV: 'test', SWAGGER_ENABLED: 'false', WX_MCH_ID: '', WX_APIV3_KEY: '', WX_APPID_USER: '', WX_APPID_DELIVERY: '', WX_NOTIFY_URL: '', CORS_ORIGINS: 'http://localhost:5192,http://127.0.0.1:5192,http://localhost:5191' };
if (!process.argv.includes('--skip-push')) {
  const push = spawnSync(path.resolve('node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], { env, stdio: 'inherit' });
  if (push.status) process.exit(push.status);
}
process.env.DATABASE_URL = env.DATABASE_URL;
const { PrismaClient } = require('@prisma/client');
const { JwtService } = require('@nestjs/jwt');
const { hash } = require('bcryptjs');
const { NightInventoryService } = require('../dist/src/night/night-inventory.service.js');
const { RbacService } = require('../dist/src/admin/rbac/rbac.service.js');
const db = new PrismaClient({ transactionOptions: { timeout: 60000, maxWait: 10000 } });
await new RbacService(db).syncRegistry();
const menu = await db.adminMenu.findUnique({ where: { code: 'night-stores' } });
if (menu && !menu.perms.split(',').includes('GET /admin/night/store-products')) {
  await db.adminMenu.update({ where: { id: menu.id }, data: { perms: `${menu.perms},GET /admin/night/store-products` } });
  await db.rbacState.update({ where: { id: 'global' }, data: { version: { increment: 1 } } });
}
const inventory = new NightInventoryService(db);
const campus = await db.campus.upsert({ where: { id: 'night-preview-campus' }, update: {}, create: { id: 'night-preview-campus', name: '夜宵功能验收校区', shortName: '夜宵验收', warehouseName: '验收仓库', manualClosed: true, nightEnabled: true, nightStartAt: '00:00', nightEndAt: '23:59', nightDeliveryFee: 200 } });
const building = await db.building.upsert({ where: { id: 'night-preview-building' }, update: {}, create: { id: 'night-preview-building', campusId: campus.id, name: '西区9栋' } });
const staff = await db.staff.upsert({ where: { id: 'night-preview-staff' }, update: {}, create: { id: 'night-preview-staff', campusId: campus.id, name: '方福宁（验收）', role: 'building-manager', roleText: '楼长', staffNo: 'NIGHT-PREVIEW', building: building.name, buildingId: building.id, onTimeRate: 100, income: 0 } });
const store = await db.nightStore.upsert({ where: { id: 'night-preview-store' }, update: {}, create: { id: 'night-preview-store', campusId: campus.id, buildingId: building.id, managerStaffId: staff.id, deposit: 50000, commissionRate: 2000 } });
const official = await db.campus.upsert({ where: { id: 'campus-official' }, update: {}, create: { id: 'campus-official', name: '官方商品库', shortName: '官方库', warehouseName: '资料库', status: 'official' } });
const category = await db.category.upsert({ where: { campusId_name: { campusId: official.id, name: '夜宵验收商品' } }, update: {}, create: { campusId: official.id, name: '夜宵验收商品' } });
const names = ['可口可乐 330ml', '乐事原味薯片', '康师傅红烧牛肉面'];
for (const [i, name] of names.entries()) {
  const product = await db.product.upsert({ where: { id: `night-preview-official-${i}` }, update: {}, create: { id: `night-preview-official-${i}`, campusId: official.id, categoryId: category.id, catalogScope: 'platform', name, subtitle: '夜宵验收商品', price: 250 + 100 * i, originalPrice: 350 + 100 * i, barcode: `NIGHT-PREVIEW-${i}`, stock: 0, image: '', tag: '', weight: 0, retailUnit: i === 0 ? '听' : '袋' } });
  await inventory.importCatalog('night-preview-admin', campus.id, [product.id]);
  const catalog = await db.product.findFirstOrThrow({ where: { campusId: campus.id, nightCatalog: true, sourceProductId: product.id } });
  const warehouse = await db.product.findUniqueOrThrow({ where: { id: catalog.warehouseProductId } });
  if (!await db.nightProduct.count({ where: { storeId: store.id, catalogProductId: catalog.id } })) {
    await db.product.update({ where: { id: catalog.id }, data: { status: 'on-sale' } });
    await db.product.update({ where: { id: warehouse.id }, data: { stock: 100 } });
    const request = await inventory.createStockOrder(staff.id, { requestId: `preview-initial-stock-${i}`, items: [{ catalogProductId: catalog.id, quantity: 10 }] });
    await inventory.reviewStockOrder('night-preview-admin', request.id, true, '验收初始库存');
    await inventory.shipStockOrder('night-preview-admin', request.id);
    await inventory.receiveStockOrder(staff.id, request.id, [{ catalogProductId: catalog.id, quantity: 10 }]);
  }
}
let previousPreview;
try { previousPreview = JSON.parse(fs.readFileSync('/tmp/night-stock-preview.json', 'utf8')); } catch {}
const password = previousPreview?.adminUsername === 'night-preview' && typeof previousPreview.adminPassword === 'string' && previousPreview.adminPassword.length >= 16 ? previousPreview.adminPassword : randomBytes(18).toString('base64url');
// One additional official item stays unimported for exercising the admin picker.
await db.product.upsert({ where: { id: 'night-preview-official-extra' }, update: {}, create: { id: 'night-preview-official-extra', campusId: official.id, categoryId: category.id, catalogScope: 'platform', name: '奥利奥夹心饼干', subtitle: '官方库导入验收', price: 300, originalPrice: 500, barcode: 'NIGHT-PREVIEW-EXTRA', stock: 0, image: '', tag: '', weight: 0, retailUnit: '袋' } });
const admin = await db.adminAccount.upsert({ where: { id: 'night-preview-admin' }, update: { passwordHash: await hash(password, 10) }, create: { id: 'night-preview-admin', username: 'night-preview', nickname: '夜宵验收管理员', passwordHash: await hash(password, 10), role: 'hq', campusId: campus.id, orgLevel: 'platform', rbacMigrated: true } });
const superRole = await db.adminRole.upsert({ where: { code: 'super-admin' }, update: {}, create: { code: 'super-admin', name: '验收管理员', builtin: true, seeded: true, menusMigrated: true } });
if (!await db.adminAccountRole.count({ where: { accountId: admin.id, roleId: superRole.id } })) await db.adminAccountRole.create({ data: { accountId: admin.id, roleId: superRole.id, scope: 'platform', grantedBy: 'local-preview' } });
const jwt = new JwtService({ secret: env.JWT_SECRET });
await seedNightPreview(db, inventory, env.DATABASE_URL);
const preview = { campusId: campus.id, storeId: store.id, staffId: staff.id, staffToken: jwt.sign({ id: staff.id, campusId: campus.id, role: staff.role, appKind: 'delivery' }, { expiresIn: '1d' }), adminToken: jwt.sign({ id: admin.id, campusId: campus.id, role: 'hq', sv: admin.sessionVersion }, { expiresIn: '1d' }), adminUser: { id: admin.id, campusId: campus.id, role: 'hq', nickname: admin.nickname }, adminUsername: admin.username, adminPassword: password };
fs.writeFileSync('/tmp/night-stock-preview.json', JSON.stringify(preview), { mode: 0o600 });
await db.$disconnect();
console.log('独立 schema 预览已准备，API http://localhost:3150，凭证仅存 /tmp/night-stock-preview.json');
const server = spawn(process.execPath, ['dist/src/main.js'], { env, stdio: 'inherit' });
process.on('SIGTERM', () => server.kill('SIGTERM'));
process.on('SIGINT', () => server.kill('SIGINT'));
server.on('exit', code => process.exit(code || 0));
