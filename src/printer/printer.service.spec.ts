import { PrinterService, ReceiptOrderContext } from './printer.service';

/** 小票打印（IKBT6N）：sign 算法与 58mm 票面构建；网络调用用 stub 不真实外发。 */
describe('PrinterService (IKBT6N)', () => {
  // IKHFDZ：printOrderReceipt 取号需 db（raw 发号+order 回写）——单测 stub
  const dbStub = {
    $queryRaw: async () => [{ seq: 7 }],
    order: { update: async () => ({}) },
  } as never;
  const service = new PrinterService(dbStub);
  const order: ReceiptOrderContext = {
    id: 'order-1',
    dailySeq: 7,
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

    it('商品行折行：名独立行（超宽折行不截断）、x数量￥单价并排一行', () => {
      // IKHFDZ 同批定版：名与量价分离，三要素全保全
      expect(content).toContain('农夫山泉 550ml');
      expect(content).toContain('x2');
      expect(content).toContain('￥2');
      // 超长品名不再截断：折行后每行都在 32 列内且内容完整
      const nameLines = content
        .split('\n')
        .filter((l) => l.includes('特别长的一个商品名称') || l.trim().startsWith('要'));
      expect(nameLines.length).toBeGreaterThanOrEqual(1);
      const truncated = content.split('\n').find((l) => l.endsWith('…'));
      expect(truncated).toBeUndefined();
    });
    it('票头含当日分拣序号大字（商家联口径，IKHFDZ）', () => {
      expect(content).toContain('单号 7');
    });

    it('库位行【】括号强调、常规字号（2026-09-05 道哥定版）', () => {
      expect(content).toContain('  【库位:A区-01】');
      expect(content).not.toContain('<B>  【库位');
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

    it('实付行放大金额：空格基准 11、物理宽 ≤27 列（2026-09-05 道哥定版）', () => {
      const line = content.split('\n').find((l) => l.startsWith('实付'));
      expect(line).toBeTruthy();
      const bare = (line as string).replace(/<[^>]+>/g, '');
      const m = bare.match(/^实付( +)(\S+)$/);
      expect(m).toBeTruthy();
      const wAmount = [...(m as RegExpMatchArray)[2]].reduce(
        (n, ch) => n + (/[⺀-鿿豈-﫿！-｠　-〿]/.test(ch) ? 2 : 1),
        0,
      );
      // <B> 放大段物理列 ×2：实付(4) + 空格(基准 11) + 金额×2 ≤ 27
      expect((m as RegExpMatchArray)[1].length).toBeLessThanOrEqual(11);
      expect(4 + (m as RegExpMatchArray)[1].length + wAmount * 2).toBeLessThanOrEqual(27);
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

  describe('printOrderReceipt 联间间隔（IKFFHO）', () => {
    const okRes = () =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ code: 0, data: 'cloud-id' }),
      } as Response);
    beforeEach(() => {
      process.env.XPYUN_USER = 'u';
      process.env.XPYUN_USERKEY = 'k';
      process.env.XPYUN_PRINTER_SN = 'SN123';
    });
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('gap=0：copies=2 仍是单次 POST 拼联（存量行为不变）', async () => {
      const fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockImplementation(okRes as never);
      await service.printOrderReceipt(order, undefined, 2, 0);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const body = JSON.parse(
        (fetchSpy.mock.calls[0][1] as RequestInit).body as string,
      );
      // 两联拼一个 content，各自带 <CUT>
      expect((body.content.match(/<CUT>/g) || []).length).toBe(2);
      expect(body.content).toContain('商家联');
      expect(body.content).toContain('客户联');
    });

    it('gap>0：拆 N 次推送且第二次在 sleep 之后（发送侧延迟）', async () => {
      const fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockImplementation(okRes as never);
      // 真实 sleep 缩到 10ms 级别不可行——直接监听全局 setTimeout 累计时长
      const delays: number[] = [];
      jest.spyOn(global, 'setTimeout').mockImplementation(((cb: () => void, ms?: number) => {
        delays.push(ms ?? 0);
        cb();
        return 0 as never;
      }) as never);
      await service.printOrderReceipt(order, undefined, 2, 3);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      // 每联独立 <CUT>，联间不再拼接
      for (const call of fetchSpy.mock.calls) {
        const c = JSON.parse((call[1] as RequestInit).body as string).content;
        expect((c.match(/<CUT>/g) || []).length).toBe(1);
      }
      // 2 联只 sleep 1 次，间隔 = gapSeconds × 1000
      expect(delays).toEqual([3000]);
      // 第二联（客户联）剥掉库位
      const second = JSON.parse(
        (fetchSpy.mock.calls[1][1] as RequestInit).body as string,
      ).content;
      expect(second).not.toContain('库位');
    });

    it('gap>0 中间联失败：warn 后后续联照发（各联独立）', async () => {
      let call = 0;
      jest.spyOn(global, 'fetch').mockImplementation((() => {
        call++;
        return call === 2
          ? Promise.resolve({
              ok: true,
              json: () => Promise.resolve({ code: 1001, msg: 'mock fail' }),
            } as Response)
          : okRes();
      }) as never);
      jest.spyOn(global, 'setTimeout').mockImplementation(((cb: () => void) => {
        cb();
        return 0 as never;
      }) as never);
      const warnSpy = jest
        .spyOn((service as never as { logger: { warn: jest.Mock } }).logger, 'warn')
        .mockImplementation(() => undefined);
      await service.printOrderReceipt(order, undefined, 3, 2);
      expect(fetchSpyCount()).toBe(3);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      function fetchSpyCount() {
        return call;
      }
    });

    it('gap 越界钳制：99 → 10（上限），-1 → 0（走单 POST）', async () => {
      const fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockImplementation(okRes as never);
      const delays: number[] = [];
      jest.spyOn(global, 'setTimeout').mockImplementation(((cb: () => void, ms?: number) => {
        delays.push(ms ?? 0);
        cb();
        return 0 as never;
      }) as never);
      await service.printOrderReceipt(order, undefined, 2, 99);
      expect(delays).toEqual([10000]);
      delays.length = 0;
      fetchSpy.mockClear();
      await service.printOrderReceipt(order, undefined, 2, -1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(delays).toEqual([]);
    });
  });
});
