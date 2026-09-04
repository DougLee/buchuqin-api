import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';

/**
 * 芯烨云（XPYUN）云打印小票（IKBT6N）。
 *
 * 支付成功即出票（2026-08-28 定版，当仓库备货单）：BusinessService 支付回调
 * fire-and-forget 出票；订单抽屉补打走 AdminService.reprintReceipt（写审计日志）。
 * 校区自主绑定（IKBW0Q）：校区在后台绑定终端（Printer 表，一校区一台），
 * 打印按订单校区取绑定 SN；未绑定的校区回落 env 单机（试点兼容）。
 * 多联打印（IKCZOX；IKD6H4 调整联序）：Printer.copies 1/2/3——1=单联无联名
 * （旧票面），2=商家联+客户联，3=再加骑手联；一次 POST 拼 N 张票（每联尾
 * <CUT>），原子同成败，失败走补打兜底；出纸顺序商家→客户→骑手（卷纸后打在外）。
 * 库位（IKD6H4）：商品明细下缩进显示「▸ 区域-编号」，attachLocations 实时注入。
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
    product?: {
      /** 快照自带商品 id（attachLocations 按 it 查实时库位）。 */
      id?: string;
      name?: string;
      price?: number;
      /** 库位（IKD6H4）：打印时实时查商品表注入，快照不含。 */
      location?: string;
      locationCode?: string;
    };
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

/** 联次标签（IKD6H4 调整 IKCZOX 初版）：下标即出纸顺序，copies=N 取前 N 个。
 *  1=商家单张；2=商家+客户；3=商家+客户+骑手（骑手联最外先揭，客户联贴袋）。 */
const COPY_LABELS = ['商家联', '客户联', '骑手联'] as const;

@Injectable()
export class PrinterService {
  private readonly logger = new Logger(PrinterService.name);
  constructor(private readonly db: PrismaService) {}
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
   *  snOverride：校区绑定打印机的终端号（IKBW0Q）；缺省回落 env 单机。
   *  cacheIfOffline（IKCJ35）：mode=1 离线暂存——设备不在线时订单缓存云端队列，
   *  恢复在线后自动打出（expiresIn 有效期内）。订单小票开、测试打印不开。 */
  async printRaw(
    content: string,
    snOverride?: string,
    opts?: { cacheIfOffline?: boolean },
  ): Promise<void> {
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
        // IKCJ35：订单小票离线暂存（默认 0 实时拒单，2026-09-01 离线 19 分钟丢两单）；
        // 4 小时有效——备货单过夜无意义，不取 86400 上限。
        ...(opts?.cacheIfOffline ? { mode: 1, expiresIn: 14400 } : {}),
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

  /** 库位实时注入（IKD6H4）：按 items 快照里的 product id 查当前库位——
   *  分拣要的是「现在放哪」，补打老订单同样正确；已删商品该行跳过库位。
   *  调用时机：组装 ReceiptOrderContext 之后、推送之前。 */
  async attachLocations(
    items?: ReceiptOrderContext['items'],
  ): Promise<ReceiptOrderContext['items']> {
    const lines = items ?? [];
    const ids = lines
      .map((line) => line.product?.id)
      .filter((id): id is string => typeof id === 'string' && Boolean(id));
    if (!ids.length) return lines;
    const rows = await this.db.product.findMany({
      where: { id: { in: ids } },
      select: { id: true, location: true, locationCode: true },
    });
    const locMap = new Map(rows.map((row) => [row.id, row]));
    return lines.map((line) => {
      const hit = line.product?.id ? locMap.get(line.product.id) : undefined;
      return {
        ...line,
        product: {
          ...line.product,
          location: hit?.location || undefined,
          locationCode: hit?.locationCode || undefined,
        },
      };
    });
  }

  /** 订单小票：构建 58mm 票面并推送（snOverride 见 printRaw，IKBW0Q）。
   *  copies（IKCZOX）：1=旧票面无联名；2/3 按联序标联名拼一张 content 一次推送。 */
  async printOrderReceipt(
    order: ReceiptOrderContext,
    snOverride?: string,
    copies = 1,
  ): Promise<void> {
    const n = Math.min(Math.max(1, Math.floor(copies)), COPY_LABELS.length);
    const parts =
      n <= 1
        ? [this.buildReceipt(order)]
        : COPY_LABELS.slice(0, n).map((label) =>
            this.buildReceipt(order, label),
          );
    await this.printRaw(parts.join('\n'), snOverride, {
      cacheIfOffline: true,
    });
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

  /** 票面构建：表头/收件信息/商品清单/金额/订单号二维码/切刀。
   *  copyLabel（IKCZOX）：多联时票头联名行（仓库名/标语之后、分隔线之前）。 */
  buildReceipt(order: ReceiptOrderContext, copyLabel?: string): string {
    const address = order.address ?? {};
    const lines: string[] = [];
    // 票头：仓库名大字 + 平台名（+ 联名）
    lines.push(TAG.center(TAG.big(order.warehouseName || '不出寝食社')));
    lines.push(TAG.center('校园寝售 · 极速到寝'));
    if (copyLabel) lines.push(TAG.center(TAG.bold(`— ${copyLabel} —`)));
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
    // 商品清单：品名×数量居左，单价右对齐（快照价即成交价，含促销锁价）；
    // 库位独立缩进行（IKD6H4 分拣备货单）：区域+编号都带，未配库位跳过
    for (const line of order.items ?? []) {
      const name = line.product?.name ?? '未知商品';
      const price = line.product?.price;
      lines.push(
        itemLine(`${name} x${line.quantity}`, price == null ? '' : yuan(price)),
      );
      const loc = [line.product?.location, line.product?.locationCode]
        .filter(Boolean)
        .join('-');
      if (loc) lines.push(`  ▸ ${loc}`);
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
/** 小票时间固定按东八区渲染：API 容器时区是 UTC（无 TZ），getHours() 等本地
 *  方法在容器里会少 8 小时；业务是中国校园场景，显式锁 Asia/Shanghai 不依赖部署环境。 */
const SHANGHAI_TIME = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
function fmtTime(t: Date | string): string {
  const d = t instanceof Date ? t : new Date(t);
  const parts = Object.fromEntries(
    SHANGHAI_TIME.formatToParts(d).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}
function maskPhone(phone?: string): string {
  if (!phone) return '';
  return phone.length === 11 ? `${phone.slice(0, 3)}****${phone.slice(7)}` : phone;
}
