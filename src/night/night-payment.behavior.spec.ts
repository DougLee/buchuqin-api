import { createCipheriv, generateKeyPairSync, sign } from 'node:crypto';
import { PaymentsService } from '../payments/payments.service';
import { PrismaService } from '../database/prisma.service';
import { BusinessService } from '../business/business.service';

/** Real signing/decryption, fake gateway transport. No network or database access. */
describe('夜宵支付验签、金额与商户隔离', () => {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const env = { WX_APPID_USER: 'WX_USER_A', WX_APPID_DELIVERY: 'WX_DELIVERY_A', WX_MCH_ID: 'MERCHANT_A', WX_APIV3_KEY: '12345678901234567890123456789012', WX_SERIAL_NO: 'FAKE_SERIAL', WX_PRIVATE_KEY: keys.privateKey, WX_NOTIFY_URL: 'http://localhost:3150/api/v1/payments/wechat/notify', WX_WXPAY_PUBLIC_KEY: keys.publicKey };
  const saved = new Map<string, string | undefined>();
  beforeEach(() => {
    for (const [key, value] of Object.entries(env)) { saved.set(key, process.env[key]); process.env[key] = value; }
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('TEST_NETWORK_DISABLED'));
  });
  afterEach(() => { jest.restoreAllMocks(); for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } saved.clear(); });
  function fixture() {
    const target = { payableAmount: 550, amount: 50000, payMerchantId: 'MERCHANT_A', payAppId: 'WX_USER_A', store: { campusId: 'CAMPUS_A' } };
    const db = {
      order: { findUnique: jest.fn().mockResolvedValue(null) },
      nightOrder: { findUnique: jest.fn().mockResolvedValue(target) },
      nightDepositOrder: { findUnique: jest.fn().mockResolvedValue({ ...target, payAppId: 'WX_DELIVERY_A' }) },
      campus: { findUnique: jest.fn().mockResolvedValue({ organizationId: null }) },
      organization: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn() },
    };
    const service = new PaymentsService(db as unknown as PrismaService, {} as BusinessService);
    const onPaid = jest.fn().mockResolvedValue(undefined);
    service.registerNightPaymentHandler({ onPaid });
    return { service, onPaid, db };
  }
  function notice(overrides: Record<string, unknown> = {}) {
    const event = { appid: 'WX_USER_A', mchid: 'MERCHANT_A', out_trade_no: 'YX_LOCAL_1', transaction_id: 'WX_LOCAL_TX', trade_state: 'SUCCESS', amount: { total: 550, currency: 'CNY' }, ...overrides };
    const nonce = '123456789012', ad = 'transaction';
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(env.WX_APIV3_KEY), Buffer.from(nonce));
    cipher.setAAD(Buffer.from(ad));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(event)), cipher.final(), cipher.getAuthTag()]).toString('base64');
    const body = { event_type: 'TRANSACTION.SUCCESS', resource: { ciphertext, nonce, associated_data: ad } };
    const raw = JSON.stringify(body), timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign('RSA-SHA256', Buffer.from(`${timestamp}\n${nonce}\n${raw}\n`), keys.privateKey).toString('base64');
    return { body, raw, headers: { 'wechatpay-signature': signature, 'wechatpay-timestamp': timestamp, 'wechatpay-nonce': nonce, 'wechatpay-serial': 'PUB_KEY_ID_LOCAL' } };
  }
  it('真实验签和解密后，匹配原金额/币种/商户/AppID才分发夜宵支付', async () => {
    const f = fixture(), n = notice();
    expect(await f.service.notify(n.headers, n.raw, n.body)).toMatchObject({ code: 'SUCCESS' });
    expect(f.onPaid).toHaveBeenCalledWith('YX_LOCAL_1', 'WX_LOCAL_TX');
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    { amount: { total: 1, currency: 'CNY' } }, { amount: { total: 550, currency: 'USD' } },
    { mchid: 'MERCHANT_B' }, { appid: 'WX_USER_B' }, { amount: undefined },
  ])('已签名但交易信息不匹配也不得落账：%j', async overrides => {
    const f = fixture(), n = notice(overrides);
    expect(await f.service.notify(n.headers, n.raw, n.body)).toMatchObject({ code: 'FAIL' });
    expect(f.onPaid).not.toHaveBeenCalled();
  });
  it('伪造签名在解密和业务处理前拒绝', async () => {
    const f = fixture(), n = notice();
    await expect(f.service.notify({ ...n.headers, 'wechatpay-signature': 'invalid' }, n.raw, n.body)).rejects.toThrow('验签失败');
    expect(f.onPaid).not.toHaveBeenCalled();
  });
  it('押金回调使用履约端AppID和原缴纳金额', async () => {
    const f = fixture(), n = notice({ appid: 'WX_DELIVERY_A', out_trade_no: 'ND_LOCAL_1', amount: { total: 50000, currency: 'CNY' } });
    expect(await f.service.notify(n.headers, n.raw, n.body)).toMatchObject({ code: 'SUCCESS' });
    expect(f.onPaid).toHaveBeenCalledWith('ND_LOCAL_1', 'WX_LOCAL_TX');
  });
  it('组织B夜宵主动查单使用B商户签名，不再回查白天订单而回落A商户', async () => {
    const f = fixture();
    f.db.campus.findUnique.mockResolvedValue({ organizationId: 'ORG_B' });
    f.db.organization.findUnique.mockResolvedValue({ id: 'ORG_B', wxAppId: 'WX_USER_B', wxSecret: 'FAKE', mchId: 'MERCHANT_B', mchApiV3Key: env.WX_APIV3_KEY, serialNo: 'SERIAL_B', privateKey: keys.privateKey, notifyDomain: 'http://localhost:3150' });
    f.db.nightOrder.findUnique.mockResolvedValue({ payableAmount: 550, payMerchantId: 'MERCHANT_B', payAppId: 'WX_USER_B', store: { campusId: 'CAMPUS_B' } });
    jest.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ out_trade_no: 'YX_LOCAL_1', trade_state: 'SUCCESS', transaction_id: 'WX_LOCAL_TX', appid: 'WX_USER_B', mchid: 'MERCHANT_B', amount: { total: 550, currency: 'CNY' } }), { status: 200 }));
    expect(await f.service.nightTradeState('YX_LOCAL_1', 'CAMPUS_B')).toMatchObject({ tradeState: 'SUCCESS' });
    expect(String(jest.mocked(fetch).mock.calls[0][0])).toContain('mchid=MERCHANT_B');
    expect((jest.mocked(fetch).mock.calls[0][1]?.headers as Record<string, string>).Authorization).toContain('mchid="MERCHANT_B"');
    expect(f.db.order.findUnique).not.toHaveBeenCalled();
  });
  it('原预支付商户变化时拒绝重建跨商户支付单', async () => {
    const f = fixture();
    await expect(f.service.nightPrepay({ campusId: 'CAMPUS_A', outTradeNo: 'YX_LOCAL_1', amount: 550, openid: 'FAKE', description: '测试', expectedMerchantId: 'MERCHANT_B' })).rejects.toThrow('商户配置已变化');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('夜宵退款查单404保留未知，原商户配置不匹配时禁止发往其他商户', async () => {
    const f = fixture();
    jest.mocked(fetch).mockImplementation(async () => new Response('', { status: 404 }));
    expect(await f.service.queryWechatRefund('NR_LOCAL', 'CAMPUS_A', { preserveUnknown: true, expectedMerchantId: 'MERCHANT_A' })).toEqual({ status: 'NOTFOUND' });
    jest.mocked(fetch).mockClear();
    await expect(f.service.applyWechatRefund('YX_LOCAL', 550, 550, 'NR_LOCAL', '测试', 'CAMPUS_A', 'MERCHANT_B')).rejects.toThrow('待确认');
    expect(fetch).not.toHaveBeenCalled();
  });
});
