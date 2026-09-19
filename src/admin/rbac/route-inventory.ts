import { RequestMethod } from '@nestjs/common';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { AdminController } from '../admin.controller';
import { ADMIN_URL_WHITELIST, ALL_PERM_PATTERNS } from './registry';
import { matchUrl } from './rbac.service';

/**
 * 路由清单（自检闭环用）：从 AdminController 装饰器元数据枚举全部路由，
 * 供两处消费——
 * 1) rbac.spec：模式覆盖检查（每条路由必须被 ≥1 个 registry perms 模式匹配，
 *    或在守卫白名单内）——发现漏配即红；
 * 2) rbac.integration.spec：全端点矩阵扫描（超管 token 逐个打非 403）。
 */

const METHOD_NAMES: Record<number, string> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.ALL]: 'ALL',
};

export interface AdminRoute {
  method: string;
  /** Nest 路由模式（含 :param 段），如 '/admin/products/:id' */
  path: string;
}

export function listAdminRoutes(): AdminRoute[] {
  const ctrlPath = (Reflect.getMetadata(PATH_METADATA, AdminController) as string) ?? '';
  const out: AdminRoute[] = [];
  for (const key of Object.getOwnPropertyNames(AdminController.prototype)) {
    if (key === 'constructor') continue;
    const handler = AdminController.prototype[key as keyof typeof AdminController.prototype];
    if (typeof handler !== 'function') continue;
    const methodNum = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
    const subPath = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
    if (methodNum === undefined || subPath === undefined) continue;
    const method = METHOD_NAMES[methodNum];
    if (!method) continue;
    for (const s of Array.isArray(subPath) ? subPath : [subPath]) {
      const path = `/${ctrlPath}/${String(s)}`.replace(/\/+$/, '') || `/${ctrlPath}`;
      out.push({ method, path });
    }
  }
  return out.sort((a, b) =>
    a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path),
  );
}

/** :param 段替换为样例值（矩阵扫描直接请求用；不同参数名给不同值便于肉眼排查） */
export function concreteRoute(route: AdminRoute): { method: string; path: string } {
  let i = 0;
  return {
    method: route.method,
    path: route.path.replace(/:[A-Za-z0-9_]+/g, () => `spec-p${++i}`),
  };
}

/** 模式覆盖检查：返回未被任何 registry 模式覆盖、也不在白名单的路由（应为空） */
export function uncoveredRoutes(): AdminRoute[] {
  return listAdminRoutes().filter(({ method, path }) => {
    if (method === 'ALL') return false;
    if (ADMIN_URL_WHITELIST.has(`${method} ${path}`)) return false;
    const { path: concrete } = concreteRoute({ method, path });
    return !matchUrl(ALL_PERM_PATTERNS, method, concrete);
  });
}
