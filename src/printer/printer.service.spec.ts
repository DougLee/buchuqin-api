import { PrinterService, ReceiptOrderContext } from './printer.service';

/** 小票打印（IKBT6N）：sign 算法与 58mm 票面构建；网络调用用 stub 不真实外发。 */
describe('PrinterService (IKBT6N)', () => {
  const service = new PrinterService();
  const order: ReceiptOrderContext = {
    id: 'order-1',
    orderNo: 'BCQ20260828TEST01',
    campusId: 'campus-hbut',
    warehouseName: '湖工大校园仓',
    deliveryMode: 'instant',
    estimatedArrival: '预计 30-60 分钟送达',
    remark: '放门口即可',
    createdAt: new Date('2026-08-28T12:30:00+08:00'),
    address: {
      buildingName: '西区 3 栋',
      room: '302',
      contactName: '张同学',
      phone: '13800001234',
    },
    items: [
      {
        product: { name: '农夫山泉 550ml', price: 200, location: 'A区', locationCode: '01' },
        quantity: 2,
      },
      { product: { name: '特别长的一个商品名称需要被截断处理才行哦', price: 1250 }, quantity: 1 },
    ],
    productAmount: 1650,
    deliveryFee: 400,
    discount: 100,
    payableAmount: 1950,
  };

  describe('sign', () => {
    it('SHA1(user+UserKEY+timestamp) 40 位小写', () => {
      const sign = PrinterService.sign('dev-user', 'dev-key', 1756355400);
      expect(sign).toMatch(/^[0-9a-f]{40}$/);
      // 固定向量：node crypto sha1('dev-userdev-key1756355400')
      const expected = require('node:crypto')
        .createHash('sha1')
        .update('dev-userdev-key1756355400')
        .digest('hex');
      expect(sign).toBe(expected);
    });
  });

  describe('buildReceipt', () => {
    const content = service.buildReceipt(order);

    it('票头仓库名 + 订单号 + 收件信息齐备', () => {
      expect(content).toContain('湖工大校园仓');
      expect(content).toContain('BCQ20260828TEST01');
      expect(content).toContain('西区 3 栋 302');
      // 电话脱敏
      expect(content).toContain('138****1234');
      expect(content).not.toContain('13800001234');
    });

    it('商品行含数量与单价（快照价转元、去尾零）', () => {
      expect(content).toContain('农夫山泉 550ml x2');
      expect(content).toContain('￥2');
      // 超长品名被截断且不破坏行结构（换行仍在）
      const longLine = content
        .split('\n')
        .find((l) => l.includes('特别长的一个商品名称'));
      expect(longLine).toBeTruthy();
    });

    it('库位行粗体（2026-09-05 道哥）', () => {
      expect(content).toContain('<B>  库位:A区-01</B>');
    });

    it('右对齐行不超 31 半角位（2026-09-05 挤行孤零回归）', () => {
      const w = (s: string) =>
        [...s.replace(/<[^>]+>/g, '')].reduce(
          (n, ch) => n + (/[⺀-鿿豈-﫿！-｠　-〿]/.test(ch) ? 2 : 1),
          0,
        );
      const money = content.split('\n').filter((l) => l.includes('￥'));
      expect(money.length).toBeGreaterThan(0);
      for (const line of money) expect(w(line)).toBeLessThanOrEqual(31);
    });

    it('金额段含商品金额/配送费/优惠/实付（去尾零）', () => {
      expect(content).toContain('商品金额');
      expect(content).toContain('￥4');
      expect(content).toContain('-￥1');
      expect(content).toContain('￥19.5');
      expect(content).not.toContain('.00');
    });

    it('票尾订单号二维码 + 切刀', () => {
      expect(content).toContain(`<QR>${order.orderNo}</QR>`);
      expect(content.endsWith('<CUT>')).toBe(true);
    });
  });

  describe('printRaw', () => {
    const ENV = { ...process.env };
    afterEach(() => {
      process.env = { ...ENV };
      jest.restoreAllMocks();
    });

    it('凭证未配置时静默跳过（不外发）', async () => {
      delete process.env.XPYUN_USER;
      delete process.env.XPYUN_USERKEY;
      delete process.env.XPYUN_PRINTER_SN;
      const fetchSpy = jest.spyOn(global, 'fetch');
      await expect(service.printRaw('test')).resolves.toBeUndefined();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(service.accountConfigured).toBe(false);
    });

    it('云端返回 code!=0 时抛错（调用方兜底）', async () => {
      process.env.XPYUN_USER = 'u';
      process.env.XPYUN_USERKEY = 'k';
      process.env.XPYUN_PRINTER_SN = 'SN123';
      jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ code: 23001, msg: 'sign error' }), {
          status: 200,
        }),
      );
      await expect(service.printRaw('test')).rejects.toThrow(/23001/);
    });

    it('配置齐备时 POST print 且 body 带 sign/sn', async () => {
      process.env.XPYUN_USER = 'u';
      process.env.XPYUN_USERKEY = 'k';
      process.env.XPYUN_PRINTER_SN = 'SN123';
      const fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(
          new Response(JSON.stringify({ code: 0, data: 'print-id' }), {
            status: 200,
          }),
        );
      await service.printRaw('hello');
      const [url, init] = fetchSpy.mock.calls[0];
      expect(String(url)).toContain('/xprinter/print');
      const body = JSON.parse(String(init?.body)) as {
        user: string;
        sn: string;
        sign: string;
        content: string;
      };
      expect(body.user).toBe('u');
      expect(body.sn).toBe('SN123');
      expect(body.sign).toMatch(/^[0-9a-f]{40}$/);
      expect(body.content).toBe('hello');
    });
  });
});
