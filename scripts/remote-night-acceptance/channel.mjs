import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { readFileSync } from 'node:fs';
import { assertAcceptanceEnvironment, runtimeRequire, createScope } from './guard.mjs';

const marker = assertAcceptanceEnvironment();
// The existing test deployment contains live external credentials. Prevent all
// accidental HTTP egress (including scheduled jobs) before importing the app.
const hosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'api', 'buchuqin-api', 'admin-test.buchuqin.com']);
function checkHost(input) {
  const host = typeof input === 'string' || input instanceof URL
    ? new URL(input).hostname : (input?.hostname || input?.host?.split(':')[0] || 'localhost');
  if (!hosts.has(host)) throw new Error('测试验收禁止向外部业务服务发送HTTP请求');
}
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  checkHost(typeof input?.url === 'string' ? input.url : input);
  return originalFetch(input, { ...options, redirect: 'manual' });
};
for (const module of [http, https]) for (const method of ['request', 'get']) {
  const original = module[method];
  module[method] = function(input, ...args) {
    checkHost(input);
    if (args[0] && typeof args[0] === 'object') checkHost(args[0]);
    return original.call(this, input, ...args);
  };
}
syncBuiltinESMExports();
runtimeRequire('reflect-metadata');
const { PrismaClient } = runtimeRequire('@prisma/client');
const db = new PrismaClient();
const scoped = createScope(db, marker);
const { AuthController } = runtimeRequire('./dist/src/auth/auth.controller.js');
const originalCode2Session = AuthController.prototype.code2Session;
AuthController.prototype.code2Session = async function(credentials, code) {
  const ids = new Set(['wx2026110700000001', 'wx2026110700000002']);
  if (!ids.has(credentials.appid)) return originalCode2Session.call(this, credentials, code);
  const org = await db.organization.findFirst({ where: { name: marker.organizationName, OR: [{ wxAppId: credentials.appid }, { deliveryWxAppId: credentials.appid }] }, select: { mchId: true, privateKey: true } });
  const privateMaterial = JSON.parse(readFileSync('/acceptance/credentials.json', 'utf8'));
  assert.ok(privateMaterial.authNonce?.length >= 32, '缺少测试身份适配材料');
  const prefix = `QA20261107:${privateMaterial.authNonce}:`;
  assert.ok(org && !org.mchId && !org.privateKey && typeof code === 'string' && code.startsWith(prefix), '测试身份适配拒绝');
  const tag = code.slice(prefix.length);
  assert.match(tag, /^[a-zA-Z0-9_-]{1,40}$/);
  return { openid: `qa20261107_${credentials.appid}_${tag}` };
};
const { PaymentsService } = runtimeRequire('./dist/src/payments/payments.service.js');
const wrap = (method, campusAt, mock) => {
  const original = PaymentsService.prototype[method];
  PaymentsService.prototype[method] = async function(...args) {
    if (await scoped(await campusAt(args))) return mock(...args);
    return original.apply(this, args);
  };
};
wrap('nightPrepay', args => args[0]?.campusId, input => {
  assert.match(input.outTradeNo, /^(YX|ND)/);
  assert.ok(Number.isSafeInteger(input.amount) && input.amount > 0);
  return { appId: 'LOCAL_PREVIEW_ONLY', merchantId: 'REMOTE_ACCEPTANCE_ONLY', timeStamp: String(Math.floor(Date.now() / 1000)), nonceStr: 'REMOTE_ACCEPTANCE_ONLY', package: 'prepay_id=REMOTE_ACCEPTANCE_ONLY', signType: 'RSA', paySign: 'REMOTE_ACCEPTANCE_ONLY' };
});
wrap('nightTradeState', args => args[1], () => ({ tradeState: 'NOTPAY' }));
const dayCampus = async orderNo => (await db.order.findUnique({ where: { orderNo }, select: { campusId: true } }))?.campusId;
wrap('applyWechatRefund', async args => args[5] || await dayCampus(args[0]), (_no, _total, _amount, refundNo) => ({ status: 'SUCCESS', refundId: 'REMOTE_TEST_' + refundNo }));
wrap('queryWechatRefund', async args => args[1] || (await db.refund.findUnique({ where: { id: args[0] }, select: { order: { select: { campusId: true } } } }))?.order.campusId, refundNo => ({ status: 'SUCCESS', refundId: 'REMOTE_TEST_' + refundNo }));

// Day prepay keeps its real owner/status/openid/amount validation; only credentials and JSAPI transport are simulated.
wrap('campusCreds', args => args[0], async campusId => ({
  appId: 'LOCAL_PREVIEW_ONLY', mchId: 'REMOTE_ACCEPTANCE_ONLY', privateKey: 'REMOTE_ACCEPTANCE_ONLY_NO_KEY',
  apiV3Key: 'REMOTE_ACCEPTANCE_ONLY_NO_KEY', serialNo: 'REMOTE_ACCEPTANCE_ONLY', notifyUrl: marker.origin + '/api/v1/payments/wechat/notify',
  organizationId: (await db.campus.findUniqueOrThrow({ where: { id: campusId }, select: { organizationId: true } })).organizationId,
}));
const originalJsapiPrepay = PaymentsService.prototype.jsapiPrepay;
PaymentsService.prototype.jsapiPrepay = async function(creds, input) {
  if (creds.mchId !== 'REMOTE_ACCEPTANCE_ONLY' || creds.privateKey !== 'REMOTE_ACCEPTANCE_ONLY_NO_KEY') return originalJsapiPrepay.call(this, creds, input);
  const order = await db.order.findUniqueOrThrow({ where: { orderNo: input.outTradeNo } });
  assert.ok(await scoped(order.campusId)); assert.match(input.openid, /^qa20261107_/);
  assert.equal(input.amount, order.payableAmount); assert.ok(Number.isSafeInteger(input.amount) && input.amount > 0);
  const folder = '/tmp/night-acceptance-day-intents'; await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  assert.match(order.id, /^[a-zA-Z0-9_-]{1,100}$/);
  await fs.writeFile(path.join(folder, order.id + '.json'), JSON.stringify({ orderNo: order.orderNo, userId: order.userId, amount: input.amount, openid: input.openid, createdAt: Date.now() }), { mode: 0o600 });
  return { appId: 'LOCAL_PREVIEW_ONLY', timeStamp: String(Math.floor(Date.now() / 1000)), nonceStr: 'REMOTE_ACCEPTANCE_ONLY', package: 'prepay_id=REMOTE_ACCEPTANCE_ONLY', signType: 'RSA', paySign: 'REMOTE_ACCEPTANCE_ONLY' };
};
wrap('queryWechatTrade', args => dayCampus(args[0]), () => ({ trade_state: 'NOTPAY' }));

// Preserve the real upload route, authentication, RBAC, file limits and compression.
// Only the external object-storage boundary changes for this acceptance tenant.
const uploadContext = new AsyncLocalStorage();
const COS = runtimeRequire('cos-nodejs-sdk-v5');
const originalPut = COS.prototype.putObject;
COS.prototype.putObject = function(options, callback) {
  const context = uploadContext.getStore();
  if (!context) return originalPut.call(this, options, callback);
  const key = String(options.Key || '');
  if (!key || key.includes('..') || path.isAbsolute(key)) throw new Error('验收文件路径不合法');
  context.key = key;
  const target = path.resolve('/app/uploads/night-acceptance', key);
  fs.mkdir(path.dirname(target), { recursive: true })
    .then(() => fs.writeFile(target, options.Body, { flag: 'wx' }))
    .then(() => callback(null, { Location: marker.origin + '/api/v1/uploads/night-acceptance/' + key, statusCode: 200 }), callback);
  return { abort() {} };
};
const { FilesController } = runtimeRequire('./dist/src/files/files.controller.js');
const originalUpload = FilesController.prototype.uploadImage;
async function upload(req, folder, file) {
  const campus = typeof req.query?.campus === 'string' ? req.query.campus : req.user.campusId;
  if (!await scoped(campus)) return originalUpload.call(this, req, folder, file);
  if (folder === 'app/idcard') throw new Error('本轮不使用身份证材料进行外部验收');
  const context = {};
  return uploadContext.run(context, async () => {
    const result = await originalUpload.call(this, req, folder, file);
    const oldUrl = result.data?.url;
    if (typeof oldUrl === 'string') {
      // The original controller constructs its URL from the configured COS base;
      // return the already-written test-host file without fetching that base.
      const key = context.key;
      assert.ok(key, '测试文件尚未写入');
      result.data.url = marker.origin + '/api/v1/uploads/night-acceptance/' + key;
      result.data.externalSimulation = true;
    }
    return result;
  });
}
for (const key of Reflect.getMetadataKeys(originalUpload)) Reflect.defineMetadata(key, Reflect.getMetadata(key, originalUpload), upload);
FilesController.prototype.uploadImage = upload;
console.log('【测试环境外部适配】仅夜宵部署验收20261107组织模拟微信支付/退款及对象存储；真实业务与权限不变，无公开模拟回调接口。');
