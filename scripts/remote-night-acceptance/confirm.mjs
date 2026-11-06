import assert from 'node:assert/strict';
import { assertAcceptanceEnvironment, runtimeRequire, createScope } from './guard.mjs';
const marker = assertAcceptanceEnvironment();
const { PrismaClient } = runtimeRequire('@prisma/client');
const { NightOrderService } = runtimeRequire('./dist/src/night/night-order.service.js');
const db = new PrismaClient();
const scoped = createScope(db, marker);
try {
  const [kind, id, ownerId] = process.argv.slice(2);
  assert.match(id || '', /^[a-zA-Z0-9_-]{1,100}$/);
  assert.match(ownerId || '', /^[a-zA-Z0-9_-]{1,100}$/);
  const orders = new NightOrderService(db, { registerNightPaymentHandler() {} });
  if (kind === 'user') {
    const order = await db.nightOrder.findUniqueOrThrow({ where: { id }, include: { store: true } });
    assert.equal(order.userId, ownerId); assert.ok(await scoped(order.store.campusId));
    assert.equal(order.payMerchantId, 'REMOTE_ACCEPTANCE_ONLY');
    assert.ok(['pending-payment', 'pending-accept'].includes(order.status));
    await orders.applyNightOrderPaid(order.orderNo, 'REMOTE_ACCEPTANCE_ONLY');
  } else if (kind === 'deposit') {
    const intent = await db.nightDepositOrder.findUniqueOrThrow({ where: { id }, include: { store: true } });
    assert.equal(intent.store.managerStaffId, ownerId); assert.ok(await scoped(intent.store.campusId));
    assert.equal(intent.payMerchantId, 'REMOTE_ACCEPTANCE_ONLY');
    assert.ok(['pending', 'paid'].includes(intent.status));
    await orders.applyNightDepositPaid(intent.outTradeNo, 'REMOTE_ACCEPTANCE_ONLY');
  } else throw new Error('不支持的测试确认类型');
  console.log(JSON.stringify({ confirmed: true, externalSimulation: true, kind, id }));
} catch (error) { console.error('测试确认拒绝：' + (error.code || error.message)); process.exitCode = 1; }
finally { await db.$disconnect(); }
