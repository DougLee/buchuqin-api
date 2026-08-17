import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createSign, createDecipheriv, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PrismaService } from '../database/prisma.service';
import { BusinessService } from '../business/business.service';

/**
 * 微信支付后端（IK8W5I，env 门控 + mock 回退）：
 * - WX_MCH_ID/WX_APIV3_KEY/WX_SERIAL_NO/WX_PRIVATE_KEY_PATH/WX_NOTIFY_URL 齐备时走
 *   微信支付 v3（JSAPI 统一下单 + 小程序支付参数签名）；缺失时 prepay 返回 { mock: true }，
 *   前端继续走 POST /orders/:id/pay 演示支付通道。
 * - 回调 /payments/wechat/notify：APIv3 AES-256-GCM 解密 + 复用 business.pay 的
 *   条件更新幂等处理；验签为占位实现（TODO：平台证书验签）。
 */
@Injectable()
export class PaymentsService {
  constructor(
    private readonly db: PrismaService,
    private readonly business: BusinessService,
  ) {}
  private privateKeyCache: string | null = null;

  /** 支付商户侧配置是否齐备（不齐备 → prepay mock 回退、notify 501）。 */
  configured() {
    return Boolean(
      process.env.WX_APPID &&
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
   * 未配置商户参数 → { mock: true }（演示支付通道）。
   */
  async prepay(userId: string, orderId: string) {
    const order = await this.db.order.findFirst({
      where: { id: orderId, userId },
    });
    if (!order) throw new NotFoundException('订单不存在');
    if (order.status !== 'pending-payment')
      throw new BadRequestException('当前状态不可支付');
    const amount = Number(order.payableAmount);
    if (!this.configured())
      return {
        mock: true,
        orderId: order.id,
        orderNo: order.orderNo,
        amount,
        // 前端拿到 mock 后调用 POST /orders/:id/pay 完成演示支付。
        hint: '微信支付未配置，走演示支付通道 POST /orders/:id/pay',
      };
    const user = await this.db.user.findUniqueOrThrow({
      where: { id: userId },
      select: { openid: true },
    });
    if (!user.openid)
      throw new BadRequestException(
        '当前用户无微信 openid，无法发起小程序支付（请用微信登录账号支付）',
      );
    const body = JSON.stringify({
      appid: process.env.WX_APPID,
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
      response = await fetch(`https://api.weixin.qq.com${urlPath}`, {
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
      mock: false,
      orderId: order.id,
      orderNo: order.orderNo,
      amount,
      payParams: {
        appId: process.env.WX_APPID,
        timeStamp,
        nonceStr,
        package: pkg,
        signType: 'RSA',
        paySign: this.sign(
          `${process.env.WX_APPID}\n${timeStamp}\n${nonceStr}\n${pkg}\n`,
        ),
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
      // 未配置商户参数时前端应走演示支付通道。
      mock: !this.configured(),
    };
  }

  /**
   * 支付回调（微信服务器 → 本服务，公网公开）：
   * - 验签占位（TODO(IK8W5I)：加载平台证书验 Wechatpay-Signature，当前仅解密校验）；
   * - 幂等：复用 business.pay（条件更新抢占支付权，重复通知/并发回调只生效一次）。
   */
  async notify(body: {
    event_type?: string;
    resource?: {
      ciphertext?: string;
      nonce?: string;
      associated_data?: string;
    };
  }) {
    if (!this.configured())
      throw new HttpException('微信支付未配置', HttpStatus.NOT_IMPLEMENTED);
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
}
