import { ForbiddenException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { campusOrganizationId } from './organization';

/**
 * IKKRMU（ADR-0001 多租户）：组织授权与校区功能开关——营销切片。
 *
 * 数据口径（schema 注释同源）：
 * - Organization.capabilities：null=全开（组织 A 现状，行为零变化）；JSON
 *   数组=已开通能力**白名单**（如 ["marketing"]；空数组=全关）
 * - Campus.features：null=继承组织；JSON 数组=校区级白名单
 *
 * 判定语义（只能收窄不能放大）：组织关 → 校区必关（校区显式开也无效）；
 * 组织开/null → 校区 null=继承（开）、数组不含该能力=显式关。
 * 校区无组织归属/不存在 → 全开（平台伪校区与组织 A 存量路径同口径，
 * 不因缺配置误伤）。
 */

/** 能力标识（本切片仅 marketing；后续切片在此追加）。 */
export type Capability = 'marketing';

/** JSON 值 → 字符串数组白名单；形态不合法（非字符串数组）视同未配置。 */
function allowlist(
  value: Prisma.JsonValue | null | undefined,
): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.every((x) => typeof x === 'string') ? (value as string[]) : null;
}

/**
 * 营销能力开关（全链唯一入口）：
 * 组织 capabilities 不含 marketing 或校区 features 显式关 → false。
 */
export async function marketingEnabled(
  db: PrismaService,
  campusId?: string | null,
): Promise<boolean> {
  if (!campusId) return true;
  const organizationId = await campusOrganizationId(db, campusId);
  if (!organizationId) return true;
  const org = await db.organization.findUnique({
    where: { id: organizationId },
    select: { capabilities: true },
  });
  if (!org) return true;
  const caps = allowlist(org.capabilities);
  if (caps && !caps.includes('marketing')) return false; // 组织关：校区不可覆盖
  const campus = await db.campus.findUnique({
    where: { id: campusId },
    select: { features: true },
  });
  const feats = allowlist(campus?.features);
  if (feats && !feats.includes('marketing')) return false; // 校区显式关
  return true;
}

/** 写端点前置校验：营销能力关闭 → 403「营销能力未开通」（admin 写端点用）。 */
export async function assertMarketingEnabled(
  db: PrismaService,
  campusId?: string | null,
): Promise<void> {
  if (!(await marketingEnabled(db, campusId)))
    throw new ForbiddenException('营销能力未开通');
}
