import { PrismaService } from '../database/prisma.service';
import { campusOrganizationId } from './organization';

/**
 * IKKRMT（ADR-0001 决策 1+2）：微信支付/订阅消息按组织路由。
 *
 * ADR 决策 1（钉死）：组织 B 是独立经营主体，走**独立商户号 + 独立 AppID**
 * （方案 a）——资金彻底隔离、对账清晰；组织 A 商户配置原样冻结在 env。
 * ADR 决策 2：组织微信配置存 Organization 表（IKKRMM 7 字段，IKKRMS 后台
 * 维护），env 只留组织 A 存量兜底。
 *
 * 路由规则（全链唯一口径）：组织行微信 7 字段**齐备**才返回组织配置对象；
 * 任一缺失/组织不存在/无归属 → 返回 null，调用方回落 env（=组织 A 现状，
 * 行为一字不变）。不做半套配置的混合路由——半套配置只会把支付请求打成
 * 「组织 AppID + env 商户号」的错配单，宁可整套回落。
 */

/** 组织级微信配置（含小程序凭证 + 支付商户凭证；敏感字段，仅服务端使用）。 */
export interface OrgWechatConfig {
  organizationId: string;
  /** 小程序 AppID（支付 payer.openid / 订阅消息 access_token 所属小程序） */
  appId: string;
  /** 小程序 Secret（订阅消息 stable_token 用） */
  secret: string;
  /** 微信支付商户号（组织 B 独立商户号） */
  mchId: string;
  /** 商户 APIv3 密钥（回调解密） */
  apiV3Key: string;
  /** 商户证书序列号（请求签名 Authorization 头） */
  serialNo: string;
  /** 商户私钥 PEM（请求签名；可单行 \n 转义，同 env 口径） */
  privateKey: string;
  /** 支付回调完整 URL（组织 notifyDomain + 全局前缀 + 回调路由） */
  notifyUrl: string;
}

/** 组织行微信 7 字段是否齐备（不含空串/纯空白——后台清空=回落 env）。 */
function orgConfigReady(org: {
  wxAppId: string | null;
  wxSecret: string | null;
  mchId: string | null;
  mchApiV3Key: string | null;
  serialNo: string | null;
  privateKey: string | null;
  notifyDomain: string | null;
}): boolean {
  return Boolean(
    org.wxAppId?.trim() &&
    org.wxSecret?.trim() &&
    org.mchId?.trim() &&
    org.mchApiV3Key?.trim() &&
    org.serialNo?.trim() &&
    org.privateKey?.trim() &&
    org.notifyDomain?.trim(),
  );
}

/** PEM 还原：后台粘贴可能带单行 \n 转义（同 env WX_PRIVATE_KEY 口径）。 */
export function normalizePem(pem: string): string {
  return pem.includes('\\n') ? pem.replaceAll('\\n', '\n') : pem;
}

/**
 * 支付回调完整 URL：notifyDomain（如 https://api.buchuqin.com，去尾斜杠）
 * + 全局前缀 api/v1 + 回调路由（与 main.ts setGlobalPrefix / payments 路由
 * 对齐；组织 B 独立域名回调即此 URL）。
 */
export function orgNotifyUrl(notifyDomain: string): string {
  return `${notifyDomain.trim().replace(/\/+$/, '')}/api/v1/payments/wechat/notify`;
}

/**
 * 按组织 ID 取组织级微信配置：
 * - 组织行微信 7 字段齐备 → 组织配置对象（组织 B 独立商户号 + 独立 AppID）
 * - 任一缺失 / 组织不存在 / organizationId 为空 → null（回落 env=组织 A 现状）
 */
export async function orgWechatConfig(
  db: PrismaService,
  organizationId?: string | null,
): Promise<OrgWechatConfig | null> {
  const id = organizationId?.trim();
  if (!id) return null;
  const org = await db.organization.findUnique({ where: { id } });
  if (!org || !orgConfigReady(org)) return null;
  return {
    organizationId: org.id,
    appId: org.wxAppId!.trim(),
    secret: org.wxSecret!.trim(),
    mchId: org.mchId!.trim(),
    apiV3Key: org.mchApiV3Key!.trim(),
    serialNo: org.serialNo!.trim(),
    privateKey: normalizePem(org.privateKey!),
    notifyUrl: orgNotifyUrl(org.notifyDomain!),
  };
}

/**
 * 校区 → 组织微信配置（订单/退款路由的入口形态：campusId 推组织，杜绝
 * 客户端直传组织参数）。无归属或配置不齐 → null（回落 env）。
 */
export async function campusWechatConfig(
  db: PrismaService,
  campusId?: string | null,
): Promise<OrgWechatConfig | null> {
  const organizationId = await campusOrganizationId(db, campusId);
  return orgWechatConfig(db, organizationId);
}
