import type { AuthRequest } from '../../auth/jwt-auth.guard';
import type { RbacContext } from './rbac.service';
import {
  LEGACY_ROLE_MAP,
  MENU_NODES,
  ROLE_TEMPLATES,
} from './registry';

/**
 * 单测夹具（RBAC 蛋词体系）：旧五角色 → 等价 RBAC 上下文。
 * 语义 = 启动迁移的实际产物（LEGACY_ROLE_MAP + ROLE_TEMPLATES）：
 * admin→超管通配（patterns 空，allow 走 super 分支）；hq→总部长平台级；
 * operations/warehouse/finance→校区级。
 * patterns/menuCodes 推导与 RbacService.getEffective 同构：
 * patterns=模板各节点 perms 并集（campus 角色取 type2+菜单行全部 perms，
 * hq 平台角色同理）；menuCodes=type!=2 的节点 code。
 */
const NODE_BY_CODE = new Map(MENU_NODES.map((n) => [n.code, n]));

function ctxFromTemplate(
  role: string,
  template: { menuCodes: string[] },
  campusId: string,
  platform: boolean,
): RbacContext {
  const patterns = new Set<string>();
  const menuCodes = new Set<string>();
  for (const code of template.menuCodes) {
    const node = NODE_BY_CODE.get(code);
    if (!node) continue;
    for (const p of node.perms ?? []) patterns.add(p);
    if (node.type !== 2) menuCodes.add(code);
  }
  return {
    accountId: `spec-${role}`,
    username: role,
    nickname: role,
    campusId,
    platform,
    super: false,
    campuses: platform ? [] : [campusId],
    patterns,
    menuCodes,
  };
}

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
      patterns: new Set<string>(),
      menuCodes: new Set(
        MENU_NODES.filter((n) => n.type !== 2).map((n) => n.code),
      ),
    };
  }
  const plan = LEGACY_ROLE_MAP[role];
  const template = ROLE_TEMPLATES.find((t) => t.code === plan?.template);
  if (!template)
    throw new Error(`spec 夹具不支持角色: ${role}（非后台角色）`);
  return ctxFromTemplate(
    role,
    template,
    campusId,
    plan.scope === 'platform',
  );
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
