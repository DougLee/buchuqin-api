import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

/** 订单最小形态（渠道推送只需这些字段，避免服务间循环依赖具体类型）。 */
export interface OrderPushContext {
  id: string;
  userId: string;
  orderNo: string;
  status: string;
  statusText: string;
  payableAmount?: number; // 金额单位:分
  address?: unknown;
}

/**
 * 消息通知渠道扇出（IK8W5M，PRD §15.1 矩阵）。
 *
 * 站内信已实现（Notification 模型，业务服务直接写入）；本服务负责 App 外渠道：
 * - 小程序订阅消息：ADR-0004 精简为支付成功 + 已送达两条（其余状态不再推）
 * - 短信兜底：已送达、退款结果（服务商待定，预留接入点）
 * - 楼长企微：关键节点（需企微自建应用，另行立项，预留接入点）
 *
 * 全部 env 门控 + 静默降级：凭证未配置记 debug 日志跳过；发送失败仅 warn 不抛出，
 * 绝不阻断订单业务流。调用方一律 fire-and-forget（void 调用，勿 await 进事务）。
 *
 * 凭证（ADR-0004 发版批次对齐）：WX_APPID_USER/WX_SECRET_USER（同微信登录/支付），
 * 模板精简为 2 条（WX_TMPL_PAID/WX_TMPL_DELIVERED，2026-08-21 已配置并完成
 * 字段对齐 IKA57K）。短信/企微仍为预留接入点。
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  /** 微信 access_token 缓存（7200s 有效期，提前 5 分钟刷新）。 */
  private wxToken: { token: string; expiresAt: number } | null = null;

  constructor(private readonly db: PrismaService) {}

  /** 订单状态推送：按 PRD §15.1 矩阵映射状态 → 订阅消息事件，已送达附带短信兜底。 */
  async orderStatusPush(order: OrderPushContext): Promise<void> {
    const event = NotificationsService.STATUS_EVENT[order.status];
    if (!event) return; // 非通知节点（如 cancelled/exception 由其他入口处理）
    await this.sendSubscribeMessage(order, event);
    if (order.status === 'delivered') await this.sendSms(order, '已送达');
  }

  /** 退款结果推送：订阅消息 + 短信兜底（PRD §15.1）。 */
  async refundResultPush(
    userId: string,
    orderNo: string,
    amountFen: number,
    approved: boolean,
  ): Promise<void> {
    const order: OrderPushContext = {
      id: '',
      userId,
      orderNo,
      status: 'refunded',
      statusText: approved ? '退款成功' : '售后已拒绝',
      payableAmount: amountFen,
    };
    await this.sendSubscribeMessage(order, 'refund');
    await this.sendSms(order, order.statusText);
  }

  /**
   * 楼长企微关键节点推送（预留）：企微自建应用凭证 + 员工 userid 映射均未就绪，
   * env 不齐时静默跳过。TODO(企微集成 issue)：Staff 增加 wecomUserId 字段后正式启用。
   */
  async wecomToStaff(staffNo: string, text: string): Promise<void> {
    const corpId = process.env.WECOM_CORPID;
    const secret = process.env.WECOM_CORPSECRET;
    const agentId = process.env.WECOM_AGENTID;
    if (!corpId || !secret || !agentId) {
      this.logger.debug(`企微渠道未配置，跳过 → ${staffNo}: ${text}`);
      return;
    }
    try {
      const tokenRes = await fetch(
        `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${corpId}&corpsecret=${secret}`,
      );
      const tokenBody = (await tokenRes.json()) as {
        access_token?: string;
        errcode?: number;
      };
      if (!tokenBody.access_token)
        throw new Error(`gettoken ${tokenBody.errcode}`);
      // TODO: userid 映射就绪前发到 env 配置的测试接收人，避免误发。
      const receiver = process.env.WECOM_TEST_USERID;
      if (!receiver) {
        this.logger.debug(
          `WECOM_TEST_USERID 未配置，跳过 → ${staffNo}: ${text}`,
        );
        return;
      }
      const sendRes = await fetch(
        `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${tokenBody.access_token}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            touser: receiver,
            msgtype: 'text',
            agentid: Number(agentId),
            text: { content: `[${staffNo}] ${text}` },
          }),
        },
      );
      const sendBody = (await sendRes.json()) as { errcode?: number };
      if (sendBody.errcode) throw new Error(`send ${sendBody.errcode}`);
    } catch (error) {
      this.logger.warn(`企微推送失败（已忽略）: ${(error as Error).message}`);
    }
  }

  /** 状态 → 通知事件映射（PRD §15.1：支付成功/出库/一级配送中/即将到楼/已送达/退款）。 */
  private static readonly STATUS_EVENT: Record<string, string> = {
    paid: 'paid',
    picking: 'picking',
    'first-mile': 'first-mile',
    'waiting-handover': 'arriving',
    delivered: 'delivered',
    refunded: 'refund',
  };

  /** 事件 → 订阅消息模板 ID 环境变量（微信公众平台申请后配置）。 */
  private static readonly TEMPLATE_ENV: Record<string, string> = {
    paid: 'WX_TMPL_PAID',
    picking: 'WX_TMPL_PICKING',
    'first-mile': 'WX_TMPL_FIRST_MILE',
    arriving: 'WX_TMPL_ARRIVING',
    delivered: 'WX_TMPL_DELIVERED',
    refund: 'WX_TMPL_REFUND',
  };

  /** 小程序订阅消息（env 门控）：WX_APPID_USER/WX_SECRET_USER + 模板 ID 齐备才发送。 */
  private async sendSubscribeMessage(
    order: OrderPushContext,
    event: string,
  ): Promise<void> {
    const templateId =
      process.env[NotificationsService.TEMPLATE_ENV[event] ?? ''];
    if (
      !process.env.WX_APPID_USER ||
      !process.env.WX_SECRET_USER ||
      !templateId
    ) {
      this.logger.debug(
        `订阅消息未配置（${event}），跳过 → ${order.orderNo} ${order.statusText}`,
      );
      return;
    }
    try {
      const user = await this.db.user.findUnique({
        where: { id: order.userId },
        select: { openid: true },
      });
      if (!user?.openid) {
        this.logger.debug(`用户无 openid，跳过订阅消息 → ${order.orderNo}`);
        return;
      }
      // IKA57K：字段对齐道哥实际申请的两条模板（2026-08-21 gettemplate 拉取）——
      // 付款成功：thing11 商品名称 / date3 付款时间 / amount2 付款金额 / time13 订单时间
      // 配送完成：character_string2 订单编号 / thing3 配送地址 / time6 送达时间 / thing7 商品名称
      // （此前 thing1/phrase2 占位与模板不匹配，线上 47003 data.thing11.value is empty）
      const row = order.id
        ? await this.db.order.findUnique({
            where: { id: order.id },
            select: { items: true, address: true, createdAt: true, paidAt: true },
          })
        : null;
      const items = Array.isArray(row?.items)
        ? (row.items as Array<{ name?: string }>)
        : [];
      const addr = (row?.address ?? {}) as Record<string, unknown>;
      const clip = (text: string) =>
        text.length > 20 ? `${text.slice(0, 19)}…` : text;
      const itemSummary = clip(
        items
          .map((item) => item.name ?? '')
          .filter(Boolean)
          .join('、') || '校园好物',
      );
      const addressText = clip(
        [
          addr.buildingName as string | undefined,
          addr.floor != null ? `${addr.floor}楼` : '',
          addr.room as string | undefined,
        ]
          .filter(Boolean)
          .join(' ') || '校园内地址',
      );
      const token = await this.wechatAccessToken();
      const data: Record<string, { value: string }> =
        event === 'paid'
          ? {
              thing11: { value: itemSummary },
              date3: {
                value: NotificationsService.fmtCn(row?.paidAt ?? new Date()),
              },
              amount2: {
                value: `${((order.payableAmount ?? 0) / 100).toFixed(2)}元`,
              },
              time13: {
                value: NotificationsService.fmtCn(row?.createdAt ?? new Date()),
              },
            }
          : event === 'delivered'
            ? {
                character_string2: { value: order.orderNo.slice(0, 32) },
                thing3: { value: addressText },
                time6: {
                  value: NotificationsService.fmtCn(new Date(), true),
                },
                thing7: { value: itemSummary },
              }
            : {
                // 其余事件暂无已申请模板（env 未配 → 上面已跳过），留通用兜底
                thing1: { value: order.orderNo.slice(0, 20) },
                phrase2: { value: order.statusText.slice(0, 5) },
              };
      const res = await fetch(
        `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${token}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            touser: user.openid,
            template_id: templateId,
            page: `pages/order/detail?id=${order.id}`,
            data,
          }),
        },
      );
      const body = (await res.json()) as { errcode?: number; errmsg?: string };
      if (body.errcode) throw new Error(`${body.errcode} ${body.errmsg}`);
    } catch (error) {
      this.logger.warn(
        `订阅消息推送失败（已忽略）: ${(error as Error).message}`,
      );
    }
  }

  /**
   * 北京时间格式化（订阅消息 time/date 字段展示用）。容器跑 UTC，订单客群在
   * 中国（湖工大），直接 +8 偏移避免引时区库；模板示例格式 "2020-09-24 11:20:56"。
   */
  private static fmtCn(date: Date, withSeconds = false): string {
    const t = new Date(date.getTime() + 8 * 3600_000);
    const iso = t.toISOString();
    return withSeconds ? iso.slice(0, 19).replace('T', ' ') : iso.slice(0, 16).replace('T', ' ');
  }

  /** 微信 access_token：client_credential 模式，带缓存与提前刷新。 */
  private async wechatAccessToken(): Promise<string> {
    if (this.wxToken && this.wxToken.expiresAt > Date.now())
      return this.wxToken.token;
    const res = await fetch(
      `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential` +
        `&appid=${process.env.WX_APPID_USER}&secret=${process.env.WX_SECRET_USER}`,
    );
    const body = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
      errcode?: number;
      errmsg?: string;
    };
    if (!body.access_token)
      throw new Error(`token ${body.errcode} ${body.errmsg}`);
    this.wxToken = {
      token: body.access_token,
      expiresAt: Date.now() + ((body.expires_in ?? 7200) - 300) * 1000,
    };
    return body.access_token;
  }

  /**
   * 短信兜底（预留接入点）：已送达/退款结果。服务商未定（阿里云/腾讯云短信），
   * SMS_ENABLED=true 时仅提示待接入；凭证就绪后在此实现真实发送。
   */
  private async sendSms(order: OrderPushContext, scene: string): Promise<void> {
    if (process.env.SMS_ENABLED !== 'true') {
      this.logger.debug(`短信渠道未启用，跳过 → ${order.orderNo} ${scene}`);
      return;
    }
    // TODO(短信服务商): 接入真实短信 SDK（需道哥提供服务商凭证与签名/模板）。
    this.logger.warn(
      `短信渠道已启用但服务商未接入，跳过 → ${order.orderNo} ${scene}`,
    );
  }
}
