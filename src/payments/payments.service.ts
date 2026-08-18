import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
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

  /** 查单：订单支付状态（供前端轮询支付结果）。 */
  async status(userId: string, orderId: string) {
    const order = await this.db.order.findFirst({
      where: { id: orderId, userId },
    });
    if (!order) throw new NotFoundException('订单不存在');
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
    // 幂等：已支付单 pay 直接返回；超时已关单不再复活（条件更新拦截）。
    try {
      await this.business.pay(order.userId, order.id);
    } catch {
      // 关单/取消与回调并发时以先到者为准，仍回 SUCCESS 避免微信重试风暴。
    }
    return { code: 'SUCCESS', message: 'OK' };
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
    if (Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > 300)
      throw new UnauthorizedException('回调时间戳超出容差');
    const cert = await this.platformCertificate(serial);
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${timestamp}\n${nonce}\n${rawBody}\n`);
    if (!verifier.verify(cert, signature, 'base64'))
      throw new UnauthorizedException('回调验签失败');
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
    if (!response.ok)
      throw new HttpException(
        `微信平台证书下载失败（${response.status}）`,
        HttpStatus.BAD_GATEWAY,
      );
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
