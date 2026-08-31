import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';

/**
 * 芯烨云（XPYUN）云打印小票（IKBT6N）。
 *
 * 出库顺手打：BusinessService.outbound 事务成功后 fire-and-forget 出票；
 * 订单抽屉补打走 AdminService.reprintReceipt（写审计日志）。
 * 校区自主绑定（IKBW0Q）：校区在后台绑定终端（Printer 表，一校区一台），
 * 打印按订单校区取绑定 SN；未绑定的校区回落 env 单机（试点兼容）。
 *
 * 账号 env 门控 + 静默降级（同 NotificationsService 模式）：
 * - XPYUN_USER / XPYUN_USERKEY：开发者账号（admin.xpyun.net 控制台），账号级
 * - XPYUN_PRINTER_SN：试点期 env 单机 SN，仅作未绑定校区的回落
 * 凭证未配置记 debug 跳过；发送失败仅 warn，绝不阻断出库事务。
 * 调用方一律 fire-and-forget（void 调用，勿 await 进事务）。
 *
 * 接口要点（open.xpyun.net 文档 v1.9+）：
 * - POST https://open.xpyun.net/api/openapi/xprinter/print，JSON
 * - 公共参数 user + timestamp(10 位秒) + sign = SHA1(user+UserKEY+timestamp) 40 位小写
 * - content 为排版文本 ≤ 12K；成功 code=0，data=云打印订单号
 * - 58mm 纸 16 汉字/行（32 半角位）；80mm 24/48（预留 WIDE 宏切换）
 */

/** 58mm 每行半角位宽（16 个汉字）。 */
const LINE_WIDTH = 32;

export interface ReceiptOrderContext {
  id: string;
  orderNo: string;
  campusId: string;
  /** 票头仓库名（Campus.warehouseName，调用方带出）。 */
  warehouseName?: string;
  deliveryMode: string;
  deliverySlot?: string | null;
  estimatedArrival?: string | null;
  remark?: string | null;
  createdAt: Date | string;
  /** 支付时落库的地址快照（Address 记录全量 json）。 */
  address?: {
    buildingName?: string;
    room?: string;
    contactName?: string;
    phone?: string;
  } | null;
  items?: Array<{
    product?: { name?: string; price?: number };
    quantity: number;
  }> | null;
  /** 以下金额单位均为分（IK8W5K）。 */
  productAmount: number;
  deliveryFee: number;
  discount: number;
  payableAmount: number;
}

/** 排版标签（open.xpyun.net 开放平台标签规范）。 */
const TAG = {
  center: (s: string) => `<C>${s}</C>`,
  /** 双倍宽高加粗：票头店名。 */
  big: (s: string) => `<CB>${s}</CB>`,
  bold: (s: string) => `<B>${s}</B>`,
  qr: (s: string) => `<QR>${s}</QR>`,
} as const;

@Injectable()
export class PrinterService {
  private readonly logger = new Logger(PrinterService.name);
  private static readonly PRINT_URL =
    'https://open.xpyun.net/api/openapi/xprinter/print';
  private static readonly ADD_URL =
    'https://open.xpyun.net/api/openapi/xprinter/addPrinters';

  /** 账号级凭证是否已配置（终端 SN 可来自校区绑定记录，不在此列）。 */
  get accountConfigured(): boolean {
    return Boolean(process.env.XPYUN_USER && process.env.XPYUN_USERKEY);
  }

  /** sign = SHA1(user + UserKEY + timestamp)，40 位小写（开放平台约定）。 */
  static sign(user: string, userKey: string, timestamp: number): string {
    return createHash('sha1')
      .update(`${user}${userKey}${timestamp}`)
      .digest('hex');
  }

  /** 推送已排版文本到云打印机（凭证未配置静默跳过；失败抛错由调用方兜底）。
   *  snOverride：校区绑定打印机的终端号（IKBW0Q）；缺省回落 env 单机。 */
  async printRaw(content: string, snOverride?: string): Promise<void> {
    const user = process.env.XPYUN_USER;
    const userKey = process.env.XPYUN_USERKEY;
    const sn = snOverride ?? process.env.XPYUN_PRINTER_SN;
    if (!user || !userKey || !sn) {
      this.logger.debug('芯烨云凭证未配置（XPYUN_USER/USERKEY/PRINTER_SN），跳过打印');
      return;
    }
    const timestamp = Math.floor(Date.now() / 1000);
    const res = await fetch(PrinterService.PRINT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
      body: JSON.stringify({
        user,
        timestamp,
        sign: PrinterService.sign(user, userKey, timestamp),
        sn,
        content,
      }),
    });
    const data = (await res.json().catch(() => null)) as
      | { code?: number; msg?: string }
      | null;
    if (!res.ok || !data || data.code !== 0)
      throw new Error(
        `芯烨云打印失败(${data?.code ?? res.status}): ${data?.msg ?? '无返回'}`,
      );
  }

  /** 订单小票：构建 58mm 票面并推送（snOverride 见 printRaw，IKBW0Q）。 */
  async printOrderReceipt(
    order: ReceiptOrderContext,
    snOverride?: string,
  ): Promise<void> {
    await this.printRaw(this.buildReceipt(order), snOverride);
  }

  /** 绑定终端到开发者账号（IKBW0Q）：POST addPrinters，items=[{sn,name}]。
   *  芯烨云没有按台密钥——归属校验在云端（SN 与账号绑定，错误码 1001），
   *  此前误引入 key 参数（易联云/飞鹅的设计）已移除（IKC3FF 实证）。
   *  幂等：终端已存在（failMsg 1011 PRINTER_EXIST）视为绑定成功；
   *  其余失败原样透传云端提示。 */
  async addPrinter(sn: string, name?: string): Promise<void> {
    const user = process.env.XPYUN_USER;
    const userKey = process.env.XPYUN_USERKEY;
    if (!user || !userKey)
      throw new BadRequestException(
        '芯烨云账号未配置（XPYUN_USER/XPYUN_USERKEY），请联系平台管理员',
      );
    const timestamp = Math.floor(Date.now() / 1000);
    const res = await fetch(PrinterService.ADD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json;charset=UTF-8' },
      body: JSON.stringify({
        user,
        timestamp,
        sign: PrinterService.sign(user, userKey, timestamp),
        items: [{ sn, name: name || sn }],
      }),
    });
    const data = (await res.json().catch(() => null)) as
      | {
          code?: number;
          msg?: string;
          data?: { success?: string[]; fail?: string[]; failMsg?: string[] };
        }
      | null;
    if (!res.ok || !data || data.code !== 0)
      throw new BadRequestException(
        `芯烨云绑定失败(${data?.code ?? res.status}): ${data?.msg ?? '无返回'}`,
      );
    const failMsg = (data.data?.failMsg ?? []).join('; ');
    // 1011 PRINTER_EXIST = 终端已在账号下，视为绑定成功
    if (failMsg && !/1011|EXIST/i.test(failMsg))
      throw new BadRequestException(`芯烨云绑定失败: ${failMsg}`);
  }

  /** 测试小票（IKBW0Q）：绑定后连通性验证，58mm 简票。 */
  async printTest(sn: string): Promise<void> {
    const lines = [
      TAG.center(TAG.big('不出寝食社')),
      TAG.center('打印机测试小票'),
      '-'.repeat(LINE_WIDTH),
      `时间：${fmtTime(new Date())}`,
      `终端：${sn}`,
      '-'.repeat(LINE_WIDTH),
      TAG.center('连通正常，可打印订单小票'),
      '<CUT>',
    ];
    await this.printRaw(lines.join('\n'), sn);
  }

  /** 票面构建：表头/收件信息/商品清单/金额/订单号二维码/切刀。 */
  buildReceipt(order: ReceiptOrderContext): string {
    const address = order.address ?? {};
    const lines: string[] = [];
    // 票头：仓库名大字 + 平台名
    lines.push(TAG.center(TAG.big(order.warehouseName || '不出寝食社')));
    lines.push(TAG.center('校园寝售 · 极速到寝'));
    lines.push('-'.repeat(LINE_WIDTH));
    lines.push(`订单号：${order.orderNo}`);
    lines.push(`下单时间：${fmtTime(order.createdAt)}`);
    lines.push(
      `配送方式：${order.deliveryMode === 'instant' ? '即时达' : '预约达'}` +
        (order.estimatedArrival ? ` ${order.estimatedArrival}` : ''),
    );
    lines.push(
      `收件：${[address.buildingName, address.room].filter(Boolean).join(' ') || '—'}`,
    );
    if (address.contactName || address.phone)
      lines.push(
        `联系人：${address.contactName ?? ''} ${maskPhone(address.phone)}`.trim(),
      );
    if (order.remark) lines.push(`备注：${order.remark}`);
    lines.push('-'.repeat(LINE_WIDTH));
    // 商品清单：品名×数量居左，单价右对齐（快照价即成交价，含促销锁价）
    for (const line of order.items ?? []) {
      const name = line.product?.name ?? '未知商品';
      const price = line.product?.price;
      lines.push(
        itemLine(`${name} x${line.quantity}`, price == null ? '' : yuan(price)),
      );
    }
    lines.push('-'.repeat(LINE_WIDTH));
    lines.push(itemLine('商品金额', yuan(order.productAmount)));
    lines.push(itemLine('配送费', yuan(order.deliveryFee)));
    if (order.discount > 0)
      lines.push(itemLine('优惠', `-${yuan(order.discount)}`));
    lines.push(itemLine('实付', TAG.bold(yuan(order.payableAmount))));
    lines.push('-'.repeat(LINE_WIDTH));
    // 票尾：订单号二维码（仓管/客服扫码查单）+ 感谢语 + 切刀
    lines.push(TAG.center(TAG.qr(order.orderNo)));
    lines.push(TAG.center('扫码核验订单'));
    lines.push(TAG.center('感谢惠顾，欢迎再次下单'));
    lines.push('<CUT>');
    return lines.join('\n');
  }
}

/** 半角位宽：CJK 全角记 2，其余记 1。 */
function charWidth(ch: string): number {
  return /[⺀-鿿豈-﫿！-｠　-〿]/.test(ch)
    ? 2
    : 1;
}
function textWidth(s: string): number {
  return [...s].reduce((n, ch) => n + charWidth(ch), 0);
}
/** 按 halfwidth 位截断（含省略号）。 */
function truncate(s: string, max: number): string {
  let w = 0;
  const out: string[] = [];
  for (const ch of s) {
    const cw = charWidth(ch);
    if (w + cw > max - 1) return out.join('') + '…';
    out.push(ch);
    w += cw;
  }
  return s;
}
/** 左右两栏拼行：左侧截断，右侧贴右边距（标签宽度按原文本近似计）。 */
function itemLine(left: string, right: string): string {
  const leftMax = LINE_WIDTH - Math.max(textWidth(right), 4);
  const fixedLeft = truncate(left, leftMax);
  const pad = Math.max(1, LINE_WIDTH - textWidth(fixedLeft) - textWidth(right));
  return fixedLeft + ' '.repeat(pad) + right;
}
/** 金额格式化：全角 ￥——半角 ¥(U+00A5) 不在 GBK 字符集，打印时会被云端静默丢弃。 */
const yuan = (fen: number) => `￥${(Number(fen) / 100).toFixed(2)}`;
function fmtTime(t: Date | string): string {
  const d = t instanceof Date ? t : new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function maskPhone(phone?: string): string {
  if (!phone) return '';
  return phone.length === 11 ? `${phone.slice(0, 3)}****${phone.slice(7)}` : phone;
}
