import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createSign, createVerify, createDecipheriv, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PrismaService } from '../database/prisma.service';
import { BusinessService } from '../business/business.service';

/** 微信支付 v3 商户 API 主机（下单/证书下载都走这里，不是 api.weixin.qq.com）。 */
const WX_PAY_HOST = 'https://api.mch.weixin.qq.com';

/**
 * 微信支付后端（IK8W5I → ADR-0004 真实化）：
 * - WX_APPID_USER + WX_MCH_ID/WX_APIV3_KEY/WX_SERIAL_NO/WX_PRIVATE_KEY(_PATH)/
 *   WX_NOTIFY_URL 齐备才可用；缺失时 prepay/notify 一律 501，无 mock 回退
 *   （演示支付通道 POST /orders/:id/pay 已随 ADR-0004 删除）。
 * - 回调 /payments/wechat/notify：平台证书验签（Wechatpay-Signature，防伪造
 *   回调）+ 时间戳防重放 + APIv3 AES-256-GCM 解密 + business.pay 条件更新幂等。
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  constructor(
    private readonly db: PrismaService,
    private readonly business: BusinessService,
  ) {}
  private privateKeyCache: string | null = null;
  /** 微信平台证书缓存：serialNo → PEM（验签用），未知序列号时刷新一次。 */
  private platformCerts = new Map<string, string>();
  private platformCertsFetchedAt = 0;

  /** 支付商户侧配置是否齐备（不齐备 → prepay/notify 501）。 */
  configured() {
    return Boolean(
      process.env.WX_APPID_USER &&
      process.env.WX_MCH_ID &&
      process.env.WX_APIV3_KEY &&
      process.env.WX_SERIAL_NO &&
      (process.env.WX_PRIVATE_KEY_PATH || process.env.WX_PRIVATE_KEY) &&
      process.env.WX_NOTIFY_URL,
    );
  }
  private privateKey() {
    if (this.privateKeyCache) return this.privateKeyCache;
    const pem = process.env.WX_PRIVATE_KEY
      ? process.env.WX_PRIVATE_KEY
      : readFileSync(process.env.WX_PRIVATE_KEY_PATH!, 'utf8');
    this.privateKeyCache = pem;
    return pem;
  }
  /** 微信支付 v3 请求签名（商户私钥 SHA256withRSA）。 */
  private sign(message: string) {
    const signer = createSign('RSA-SHA256');
    signer.update(message);
    return signer.sign(this.privateKey(), 'base64');
  }
  private authorization(method: string, urlPath: string, body: string) {
    const timestamp = Math.floor(Date.now() / 1000).toString(),
      nonce = randomUUID().replace(/-/g, ''),
      signature = this.sign(
        `${method}\n${urlPath}\n${timestamp}\n${nonce}\n${body}\n`,
      );
    return `WECHATPAY2-SHA256-RSA2048 mchid="${process.env.WX_MCH_ID}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${process.env.WX_SERIAL_NO}",signature="${signature}"`;
  }

  /**
   * JSAPI 统一下单：返回小程序 wx.requestPayment 所需参数。
   * 未配置商户参数 → 501 硬错误（ADR-0004：不再有 mock 演示通道）。
   */
  async prepay(userId: string, orderId: string) {
    if (!this.configured())
      throw new HttpException('微信支付未配置', HttpStatus.NOT_IMPLEMENTED);
    const order = await this.db.order.findFirst({
      where: { id: orderId, userId },
    });
    if (!order) throw new NotFoundException('订单不存在');
    if (order.status !== 'pending-payment')
      throw new BadRequestException('当前状态不可支付');
    const amount = Number(order.payableAmount);
    const appid = process.env.WX_APPID_USER!;
    const user = await this.db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { openid: true },
    });
    if (!user.openid)
      throw new BadRequestException(
        '当前用户无微信 openid，无法发起小程序支付（请用微信登录账号支付）',
      );
    const body = JSON.stringify({
      appid,
      mchid: process.env.WX_MCH_ID,
      description: `不出寝食社订单 ${order.orderNo}`,
      out_trade_no: order.orderNo,
      notify_url: process.env.WX_NOTIFY_URL,
      // 金额单位:分（IK8W5K）：payableAmount 已是整数分，直接作为微信支付 total。
      amount: { total: amount, currency: 'CNY' },
      payer: { openid: user.openid },
    });
    const urlPath = '/v3/pay/transactions/jsapi';
    let response: Response;
    try {
      response = await fetch(`${WX_PAY_HOST}${urlPath}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: this.authorization('POST', urlPath, body),
        },
        body,
        signal: AbortSignal.timeout(6000),
      });
    } catch {
      throw new HttpException('微信支付服务暂不可用', HttpStatus.BAD_GATEWAY);
    }
    const result = (await response.json()) as {
      prepay_id?: string;
      code?: string;
      message?: string;
    };
    if (!response.ok || !result.prepay_id)
      throw new HttpException(
        `微信下单失败：${result.message ?? response.status}`,
        HttpStatus.BAD_GATEWAY,
      );
    // 小程序支付参数（wx.requestPayment）。
    const timeStamp = Math.floor(Date.now() / 1000).toString(),
      nonceStr = randomUUID().replace(/-/g, ''),
      pkg = `prepay_id=${result.prepay_id}`;
    return {
      orderId: order.id,
      orderNo: order.orderNo,
      amount,
      // 订阅消息模板（ADR-0004 两条）：随预下单下发，小程序支付前请求授权
      subscribeTemplates: this.subscribeTemplates(),
      payParams: {
        appId: appid,
        timeStamp,
        nonceStr,
        package: pkg,
        signType: 'RSA',
        paySign: this.sign(`${appid}\n${timeStamp}\n${nonceStr}\n${pkg}\n`),
      },
    };
  }

  /**
   * 微信 v3 退款申请（IKHZKA）：原路退回。
   * - out_refund_no = Refund.id（每单一条申请，重试同号幂等，微信去重）
   * - amount.total 必须为原订单实付金额，refund ≤ total（部分退款）
   * - 受理成功返回微信退款单号与状态（SUCCESS 即到账 / PROCESSING 处理中，
   *   终态由调用方 queryRefund 补齐，v1 不依赖退款回调）
   */
  async applyWechatRefund(
    orderNo: string,
    totalFen: number,
    refundFen: number,
    refundNo: string,
    reason: string,
  ): Promise<{ refundId: string; status: string }> {
    if (!this.configured())
      throw new HttpException('微信支付未配置', HttpStatus.NOT_IMPLEMENTED);
    const body = JSON.stringify({
      out_trade_no: orderNo,
      out_refund_no: refundNo,
      reason: reason.slice(0, 80) || '用户退款',
      amount: { refund: refundFen, total: totalFen, currency: 'CNY' },
    });
    const urlPath = '/v3/refund/domestic/refunds';
    let response: Response;
    try {
      response = await fetch(`${WX_PAY_HOST}${urlPath}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: this.authorization('POST', urlPath, body),
        },
        body,
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw new HttpException('微信退款服务暂不可用', HttpStatus.BAD_GATEWAY);
    }
    const result = (await response.json().catch(() => ({}))) as {
      refund_id?: string;
      status?: string;
      message?: string;
    };
    if (!response.ok || !result.refund_id)
      throw new HttpException(
        `微信退款失败：${result.message ?? response.status}`,
        HttpStatus.BAD_GATEWAY,
      );
    return { refundId: result.refund_id, status: result.status ?? 'PROCESSING' };
  }

  /** 按商户退款单号查退款终态：SUCCESS/PROCESSING/ABNORMAL/CLOSED。 */
  async queryWechatRefund(refundNo: string): Promise<{
    status: string;
    refundId?: string;
  }> {
    if (!this.configured())
      throw new HttpException('微信支付未配置', HttpStatus.NOT_IMPLEMENTED);
    const urlPath = `/v3/refund/domestic/refunds/${refundNo}?mchid=${process.env.WX_MCH_ID}`;
    let response: Response;
    try {
      response = await fetch(`${WX_PAY_HOST}${urlPath}`, {
        headers: {
          Accept: 'application/json',
          Authorization: this.authorization('GET', urlPath, ''),
        },
        signal: AbortSignal.timeout(6000),
      });
    } catch {
      throw new HttpException('微信查退款服务暂不可用', HttpStatus.BAD_GATEWAY);
    }
    if (response.status === 404)
      return { status: 'ABNORMAL' }; // 微信侧无此退款单（从未受理）
    if (!response.ok)
      throw new HttpException(
        `微信查退款失败（${response.status}）`,
        HttpStatus.BAD_GATEWAY,
      );
    const result = (await response.json()) as {
      status?: string;
      refund_id?: string;
    };
    return { status: result.status ?? 'PROCESSING', refundId: result.refund_id };
  }

  /** 订阅消息模板 ID（ADR-0004 精简两条；未配置返回空数组，前端静默跳过授权）。 */
  subscribeTemplates(): string[] {
    return [process.env.WX_TMPL_PAID, process.env.WX_TMPL_DELIVERED].filter(
      (id): id is string => Boolean(id),
    );
  }

  /** 查单：订单支付状态（供前端轮询支付结果）。 */
  async status(userId: string, orderId: string) {
    let order = await this.db.order.findFirst({
      where: { id: orderId, userId },
    });
    if (!order) throw new NotFoundException('订单不存在');
    // IK9SO7 兜底：回调链路故障（公钥/证书配置错误、微信重试中）时，前端支付
    // 完成后的这次查询主动向微信查单，SUCCESS 即落账——不依赖回调也能推进。
    if (
      order.status === 'pending-payment' &&
      Date.now() - order.createdAt.getTime() > 30_000
    ) {
      try {
        const trade = await this.queryWechatTrade(order.orderNo);
        if (trade.trade_state === 'SUCCESS') {
          await this.applyPayment(order, trade.transaction_id);
          order = await this.db.order.findUniqueOrThrow({
            where: { id: order.id },
          });
        }
      } catch {
        // 查单/落账失败不阻塞本地状态返回（异常单已由 applyPayment 内部处理）
      }
    }
    return {
      orderId: order.id,
      orderNo: order.orderNo,
      status: order.status,
      statusText: order.statusText,
      paid: order.paidAt != null,
      paidAt: order.paidAt?.toISOString() ?? null,
      amount: Number(order.payableAmount),
    };
  }

  /**
   * 支付回调（微信服务器 → 本服务，公网公开）：
   * - 验签：Wechatpay-Signature 用微信平台证书 RSA-SHA256 校验
   *   `${timestamp}\n${nonce}\n${rawBody}\n`，防伪造回调把订单置已支付；
   * - 防重放：timestamp 偏离当前超 5 分钟拒绝；
   * - 幂等：复用 business.pay（条件更新抢占支付权，重复通知/并发回调只生效一次）。
   */
  async notify(
    headers: Record<string, string | string[] | undefined>,
    rawBody: string,
    body: {
      event_type?: string;
      resource?: {
        ciphertext?: string;
        nonce?: string;
        associated_data?: string;
      };
    },
  ) {
    if (!this.configured())
      throw new HttpException('微信支付未配置', HttpStatus.NOT_IMPLEMENTED);
    await this.verifyNotifySignature(headers, rawBody);
    const resource = body.resource;
    if (!resource?.ciphertext || !resource.nonce)
      throw new BadRequestException('回调报文缺少加密资源');
    const decrypted = this.decryptResource(
      resource.ciphertext,
      resource.nonce,
      resource.associated_data ?? '',
    );
    const event = JSON.parse(decrypted) as {
      out_trade_no?: string;
      transaction_id?: string;
      trade_state?: string;
    };
    if (event.trade_state !== 'SUCCESS')
      return { code: 'SUCCESS', message: '非成功交易，忽略' };
    const order = await this.db.order.findUnique({
      where: { orderNo: event.out_trade_no ?? '' },
    });
    if (!order) return { code: 'SUCCESS', message: '订单不存在，忽略' };
    await this.applyPayment(order, event.transaction_id);
    return { code: 'SUCCESS', message: 'OK' };
  }

  /**
   * 落账（notify 回调与 status 查单补偿共用）：
   * 幂等——已支付单 pay 直接返回；超时已关单不再复活（条件更新拦截）。
   * G1（2026-08-19 发版 grilling）：微信侧扣款已成功但落账失败（库存不足/
   * 超时关单竞态/用户取消后又完成支付等）。不能吞错放任订单被超时 Cron
   * 关单——转 exception 冻结现场，站内通知安抚用户，客服在商户平台手动
   * 退款或补发（ADR-0004 试点期不自动退款）。
   */
  private async applyPayment(
    order: { id: string; userId: string; orderNo: string },
    transactionId?: string,
  ) {
    try {
      await this.business.pay(order.userId, order.id);
    } catch (error) {
      const frozen = await this.db.order.updateMany({
        where: {
          id: order.id,
          status: { in: ['pending-payment', 'cancelled'] },
        },
        data: {
          status: 'exception',
          statusText: '支付已收到但订单异常，请联系客服处理',
        },
      });
      // 微信重复回调时第二次不命中（已是 exception），不重复通知/告警
      if (frozen.count) {
        await this.db.notification.create({
          data: {
            userId: order.userId,
            type: 'order',
            title: '订单异常提醒',
            content: `订单 ${order.orderNo} 的支付已收到，但处理出现异常，客服会尽快联系你处理，请勿重复支付。`,
          },
        });
        this.logger.error(
          `支付落账失败转异常单：order=${order.id} orderNo=${order.orderNo} ` +
            `wxTradeId=${transactionId ?? '未知'} ` +
            `reason=${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /**
   * 主动查单（IK9SO7 兜底）：按商户单号向微信查询交易状态。
   * 签名串的 url 必须带 query（微信 v3 规范），失败抛错由调用方决定兜底。
   */
  private async queryWechatTrade(orderNo: string): Promise<{
    trade_state?: string;
    transaction_id?: string;
  }> {
    const urlPath = `/v3/pay/transactions/out-trade-no/${orderNo}?mchid=${process.env.WX_MCH_ID}`;
    let response: Response;
    try {
      response = await fetch(`${WX_PAY_HOST}${urlPath}`, {
        headers: {
          Accept: 'application/json',
          Authorization: this.authorization('GET', urlPath, ''),
        },
        signal: AbortSignal.timeout(6000),
      });
    } catch {
      throw new HttpException('微信查单服务暂不可用', HttpStatus.BAD_GATEWAY);
    }
    if (response.status === 404)
      return { trade_state: 'NOTFOUND' }; // 微信侧无此单（未拉起过支付）
    if (!response.ok)
      throw new HttpException(
        `微信查单失败（${response.status}）`,
        HttpStatus.BAD_GATEWAY,
      );
    return (await response.json()) as { trade_state?: string };
  }

  /** APIv3 回调资源解密：AES-256-GCM（key=APIv3Key，尾 16 字节为 authTag）。 */
  private decryptResource(
    ciphertext: string,
    nonce: string,
    associatedData: string,
  ) {
    const buf = Buffer.from(ciphertext, 'base64');
    const authTag = buf.subarray(buf.length - 16);
    const data = buf.subarray(0, buf.length - 16);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      Buffer.from(process.env.WX_APIV3_KEY!, 'utf8'),
      Buffer.from(nonce, 'utf8'),
    );
    decipher.setAuthTag(authTag);
    decipher.setAAD(Buffer.from(associatedData, 'utf8'));
    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
      'utf8',
    );
  }

  /** 回调验签：平台证书 + RSA-SHA256 + 5 分钟时间戳容差（防伪造/防重放）。 */
  private async verifyNotifySignature(
    headers: Record<string, string | string[] | undefined>,
    rawBody: string,
  ) {
    const pick = (name: string) => {
      const value = headers[name];
      return Array.isArray(value) ? value[0] : value;
    };
    const signature = pick('wechatpay-signature'),
      timestamp = pick('wechatpay-timestamp'),
      nonce = pick('wechatpay-nonce'),
      serial = pick('wechatpay-serial');
    if (!signature || !timestamp || !nonce || !serial)
      throw new UnauthorizedException('回调缺少验签头');
    // IK9SO7 排查：serial 只用于「选哪把钥」，真正的信任锚是验签本身。
    // 记录 incoming serial 与配置的公钥 ID 对比，配置抄录有误时一眼可辨。
    this.logger.debug(
      `回调验签头 serial=${serial} 配置公钥ID=${process.env.WX_WXPAY_PUBLIC_KEY_ID ?? '未配置'}`,
    );
    if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300)
      throw new UnauthorizedException('回调时间戳超出容差');
    // 验签钥二选一：微信支付公钥（2024+ 新商户，WX_WXPAY_PUBLIC_KEY[_ID] 配置）
    // 或平台证书（老商户，GET /v3/certificates 下载缓存）。
    const cert =
      this.wechatPayPublicKey(serial) ??
      (await this.platformCertificate(serial));
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${timestamp}\n${nonce}\n${rawBody}\n`);
    if (!verifier.verify(cert, signature, 'base64')) {
      // IK9SO7：验签失败要区分「选错钥」还是「伪造回调」——serial 与选钥
      // 来源都在日志里，公钥配置错误（下载错文件/复制错行）可当场定位
      this.logger.error(
        `回调验签失败 serial=${serial}（配置公钥ID=${process.env.WX_WXPAY_PUBLIC_KEY_ID ?? '未配置'}）`,
      );
      throw new UnauthorizedException('回调验签失败');
    }
  }

  /**
   * 微信支付公钥验签（2024 年后新入驻商户：无平台证书，只有公钥）：
   * 配置 WX_WXPAY_PUBLIC_KEY（PEM，可单行 \n 转义）+ WX_WXPAY_PUBLIC_KEY_ID
   * （PUB_KEY_ID_…，商户平台 API 安全页下载公钥时同页展示）。
   * IK9SO7：serial 仅是选钥索引，公钥本身才是信任锚——微信回调 serial 与配置
   * ID 不完全相等（抄录有误/商户侧换了公钥）但同为 PUB_KEY_ID_ 前缀时，仍选
   * 公钥验签。否则会错误回落平台证书模式，公钥商户调 /v3/certificates 微信
   * 返回 406 → 抛 502 → 微信无限重试，真实回调永远进不来（生产已发生）。
   * 老商户（平台证书模式）回调 serial 是 hex 序列号，不带该前缀，不受影响。
   */
  private wechatPayPublicKey(serial: string): string | null {
    const key = process.env.WX_WXPAY_PUBLIC_KEY,
      id = process.env.WX_WXPAY_PUBLIC_KEY_ID;
    if (!key || !id) return null;
    if (serial !== id && !serial.startsWith('PUB_KEY_ID_')) return null;
    return key.includes('\\n')
      ? key.replaceAll('\\n', '\n') // .env 单行转义还原为多行 PEM
      : key;
  }

  /** 取指定序列号的微信平台证书（缓存 miss 先刷新一次再判定）。 */
  private async platformCertificate(serial: string): Promise<string> {
    if (!this.platformCerts.has(serial))
      await this.refreshPlatformCertificates();
    const cert = this.platformCerts.get(serial);
    if (!cert) throw new UnauthorizedException('未知的微信平台证书序列号');
    return cert;
  }

  /**
   * 下载微信平台证书（GET /v3/certificates，商户私钥签名请求，
   * 响应用 APIv3Key AES-GCM 解密）。60 秒内不重复拉取。
   */
  private async refreshPlatformCertificates() {
    if (
      this.platformCerts.size &&
      Date.now() - this.platformCertsFetchedAt < 60_000
    )
      return;
    const urlPath = '/v3/certificates';
    let response: Response;
    try {
      response = await fetch(`${WX_PAY_HOST}${urlPath}`, {
        headers: {
          Accept: 'application/json',
          Authorization: this.authorization('GET', urlPath, ''),
        },
        signal: AbortSignal.timeout(6000),
      });
    } catch {
      throw new HttpException(
        '微信平台证书服务暂不可用',
        HttpStatus.BAD_GATEWAY,
      );
    }
    if (!response.ok) {
      const detail = await response.text();
      // IK9SO7：公钥模式商户（2024+）调 /v3/certificates 微信返回
      // 406 PARAM_ERROR——此前报文被吞只剩 502，微信无限重试且无从排查
      this.logger.error(
        `微信平台证书下载失败 status=${response.status} body=${detail.slice(0, 200)}`,
      );
      throw new HttpException(
        `微信平台证书下载失败（${response.status}）`,
        HttpStatus.BAD_GATEWAY,
      );
    }
    const result = (await response.json()) as {
      data?: Array<{
        serial_no: string;
        encrypt_certificate: {
          ciphertext: string;
          nonce: string;
          associated_data?: string;
        };
      }>;
    };
    for (const item of result.data ?? []) {
      const encrypted = item.encrypt_certificate;
      this.platformCerts.set(
        item.serial_no,
        this.decryptResource(
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.associated_data ?? '',
        ),
      );
    }
    this.platformCertsFetchedAt = Date.now();
  }
}
