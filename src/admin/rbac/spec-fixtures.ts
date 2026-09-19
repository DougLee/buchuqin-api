import type { AuthRequest } from '../../auth/jwt-auth.guard';
import type { RbacContext } from './rbac.service';
import { LEGACY_ROLE_MAP, ROLE_TEMPLATES } from './registry';

/**
 * 单测夹具（RBAC V1）：旧五角色 → 等价 RBAC 上下文。
 * 语义 = 启动迁移的实际产物（LEGACY_ROLE_MAP + ROLE_TEMPLATES）：
 * admin→超管通配；hq→总部长平台级；operations/warehouse/finance→校区级。
 */
export function legacyRbacCtx(
  role: string,
  campusId = 'campus-hbut',
): RbacContext {
  if (role === 'admin') {
    return {
      accountId: 'spec-admin',
      username: 'admin',
      nickname: '管理员',
      campusId,
      platform: true,
      super: true,
      campuses: [],
      permissions: new Set<string>(),
    };
  }
  const plan = LEGACY_ROLE_MAP[role];
  const template = ROLE_TEMPLATES.find((t) => t.code === plan?.template);
  if (!template)
    throw new Error(`spec 夹具不支持角色: ${role}（非后台角色）`);
  const isPlatform = plan.scope === 'platform';
  return {
    accountId: `spec-${role}`,
    username: role,
    nickname: role,
    campusId,
    platform: isPlatform,
    super: false,
    campuses: isPlatform ? [] : [campusId],
    permissions: new Set(
      isPlatform ? template.platformPermissions : template.campusPermissions,
    ),
  };
}

/** 带旧角色语义的请求夹具：{ user: {...claims}, rbac: 有效权限上下文 } */
export function specReq(
  role: string,
  campusId = 'campus-hbut',
): AuthRequest {
  const ctx = legacyRbacCtx(role, campusId);
  return {
    user: {
      id: ctx.accountId,
      campusId,
      role: role as never,
    },
    rbac: ctx,
  } as unknown as AuthRequest;
}
