import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Prisma, AdminAccount } from '@prisma/client';
import { hash } from 'bcryptjs';
import type { CreateAccountDto, UpdateAccountDto } from '../dto';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';
import { isSuperOnlyOperation, PLATFORM_PATTERNS } from './access-policy';
import { ALL_PERM_PATTERNS, MENU_NODES, ROLE_TEMPLATES, SUPER_ROLE_CODE, LEGACY_ROLE_MAP } from './registry';

/**
 * RBAC 服务（蛋词体系对齐版，2026-09-19 拍板 B）：
 * - 菜单+按钮权限合一棵树（AdminMenu，perms=URL 模式逗号串）；
 * - 判权=用户 perms 模式集与请求 method+path 匹配（matchUrl）；
 * - 保留 buchuqin 内核：super-admin 通配 / 会话版本踢线 / 审计同事务 / 校区 scope。
 * 缓存：key 含 (sessionVersion, rbacVersion, campusId)，授权变更 bump 即失效；读取失败默认拒绝。
 */

export interface RbacContext {
  accountId: string;
  username: string;
  nickname: string;
  campusId: string;
  platform: boolean;
  super: boolean;
  campuses: string[];
  /** URL 模式串（"METHOD /admin/…"）并集 */
  patterns: Set<string>;
  /** Only patterns granted by platform-scoped roles; prevents mixed-scope escalation. */
  platformPatterns?: Set<string>;
  /** 可见菜单节点 code（目录+菜单行，非按钮） */
  menuCodes: Set<string>;
}

/** URL 模式匹配：模式 "METHOD /admin/x/:id" 与请求比对，:seg 通配单段 */
export function matchUrl(patterns: Iterable<string>, method: string, path: string): boolean {
  const segs = path.replace(/\/+$/, '').split('/');
  for (const p of patterns) {
    const sp = p.indexOf(' ');
    if (sp < 0) continue;
    if (p.slice(0, sp) !== method) continue;
    const pat = p.slice(sp + 1).replace(/\/+$/, '').split('/');
    if (pat.length !== segs.length) continue;
    let ok = true;
    for (let i = 0; i < pat.length; i++) {
      if (pat[i].startsWith(':')) continue;
      if (pat[i] !== segs[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

interface CacheEntry {
  ctx: RbacContext;
  expiresAt: number;
}

const SUPER_GUARD_LOCK = 728281001;

@Injectable()
export class RbacService implements OnModuleInit {
  private readonly logger = new Logger(RbacService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private static readonly TTL_MS = 15_000;

  constructor(private readonly db: PrismaService) {}

  /* ==================== 启动同步：菜单树登记 + 存量迁移 ==================== */

  async onModuleInit() {
    try {
      await this.syncRegistry();
    } catch (e) {
      this.logger.error(`RBAC registry sync failed: ${String(e)}`);
      throw e;
    }
  }

  /**
   * 幂等启动同步：
   * 1) MENU_NODES 按 code 首次登记，已有节点的结构/权限/显示配置不覆盖；
   * 2) 内置超管；模板角色首灌 role_menu（seeded 标记）；
   * 3) 存量角色迁移：未迁移且无 role_menu 行的角色，旧 role_permissions(权限码)+role.menus(菜单key)
   *    → role_menu（按 code 找行）；
   * 4) 旧静态角色账号 → AdminAccountRole（同首版逻辑）。
   */
  async syncRegistry(): Promise<void> {
    let changed = false;
    await this.db.$transaction(async (tx) => {
      await this.lockSuperGuard(tx);
      await tx.rbacState.upsert({
        where: { id: 'global' },
        update: {},
        create: { id: 'global', version: 0 },
      });
      // 1) 菜单树 upsert（两轮：先目录后子节点，保证父行存在）
      for (const pass of [0, 1]) {
        for (const node of MENU_NODES.filter((n) =>
          pass === 0 ? !n.parent : !!n.parent,
        )) {
          const parentId = node.parent
            ? (await tx.adminMenu.findUnique({ where: { code: node.parent } }))?.id ?? null
            : null;
          const existing = await tx.adminMenu.findUnique({ where: { code: node.code } });
          if (!existing) {
            await tx.adminMenu.create({
              data: {
                code: node.code, name: node.name, type: node.type,
                perms: (node.perms ?? []).join(','),
                path: node.path ?? '', viewPath: node.type === 1 ? node.code : '',
                icon: node.icon ?? '', orderNum: node.order,
                parentId, builtin: true,
              },
            });
            changed = true;
          }
        }
      }
      // 2) 内置超管
      const superRole = await tx.adminRole.upsert({
        where: { code: SUPER_ROLE_CODE },
        update: {},
        create: {
          code: SUPER_ROLE_CODE, name: '超级管理员',
          remark: '内置：全部权限（通配），不可编辑/删除', builtin: true, seeded: true,
        },
      });
      if (superRole.status !== 'active') {
        await tx.adminRole.update({ where: { id: superRole.id }, data: { status: 'active' } });
        changed = true;
      }
      // 3) 模板角色首灌 role_menu
      const codeToId = new Map(
        (await tx.adminMenu.findMany({ select: { id: true, code: true } })).map((m) => [m.code, m.id]),
      );
      for (const t of ROLE_TEMPLATES) {
        const role = await tx.adminRole.upsert({
          where: { code: t.code },
          update: {},
          create: { code: t.code, name: t.name, remark: t.remark, seeded: false },
        });
        if (role.seeded || role.menusMigrated) continue;
        await tx.adminRoleMenu.createMany({
          data: t.menuCodes
            .map((c) => codeToId.get(c))
            .filter((id): id is string => !!id)
            .map((menuId) => ({ roleId: role.id, menuId })),
          skipDuplicates: true,
        });
        await tx.adminRole.update({ where: { id: role.id }, data: { seeded: true } });
        changed = true;
      }
      // 4) 存量角色迁移：无 role_menu 行的角色（首版权限体系/两层菜单体系 → 菜单树）
      const staleRoles = await tx.adminRole.findMany({
        where: { builtin: false, menusMigrated: false, adminRoleMenus: { none: {} } },
        include: {
          permissions: { include: { permission: { select: { code: true } } } },
        },
      });
      for (const role of staleRoles) {
        const codes = new Set<string>([
          ...role.permissions.map((p) => p.permission.code),
          ...((role.menus as unknown as string[] | null) ?? []),
        ]);
        const menuIds = [...codes]
          .map((c) => codeToId.get(c))
          .filter((id): id is string => !!id);
        if (menuIds.length) {
          await tx.adminRoleMenu.createMany({
            data: menuIds.map((menuId) => ({ roleId: role.id, menuId })),
            skipDuplicates: true,
          });
          changed = true;
          this.logger.log(`角色 ${role.code} 已迁移到菜单树（${menuIds.length} 节点）`);
        }
      }
      await tx.adminRole.updateMany({ where: { menusMigrated: false }, data: { menusMigrated: true } });
      // 5) 旧账号迁移（同首版：零绑定 + 旧五角色 → 模板授权）
      const legacyAccounts = await tx.adminAccount.findMany({
        where: { rbacMigrated: false, rbacRoles: { none: {} }, role: { in: Object.keys(LEGACY_ROLE_MAP) } },
        include: { accesses: { select: { campusId: true } } },
      });
      const campusIds = new Set((await tx.campus.findMany({ select: { id: true } })).map((c) => c.id));
      for (const acc of legacyAccounts) {
        const plan = LEGACY_ROLE_MAP[acc.role];
        const role = await tx.adminRole.findUnique({ where: { code: plan.template } });
        if (!role) continue;
        if (plan.scope === 'platform') {
          await tx.adminAccountRole.create({
            data: { accountId: acc.id, roleId: role.id, scope: 'platform', grantedBy: 'migration' },
          });
        } else {
          const targets = [...new Set([acc.campusId, ...acc.accesses.map((a) => a.campusId)])]
            .filter((c) => campusIds.has(c));
          if (!targets.length) continue;
          await tx.adminAccountRole.createMany({
            data: targets.map((c) => ({
              accountId: acc.id, roleId: role.id, scope: 'campus', campusId: c, grantedBy: 'migration',
            })),
          });
        }
        changed = true;
      }
      await tx.adminAccount.updateMany({ where: { rbacMigrated: false }, data: { rbacMigrated: true } });
      if (changed) await this.bumpVersion(tx);
    });
    if (changed) this.cache.clear();
  }

  /* ==================== 版本与缓存 ==================== */

  private async bumpVersion(tx: Prisma.TransactionClient) {
    const state = await tx.rbacState.update({
      where: { id: 'global' },
      data: { version: { increment: 1 } },
    });
    return state.version;
  }

  private async currentVersion(): Promise<number> {
    const s = await this.db.rbacState.findUnique({ where: { id: 'global' } });
    if (!s) throw new ServiceUnavailableException('权限状态不可用，请稍后重试');
    return s.version;
  }

  async knownCampusIds(): Promise<Set<string>> {
    // Campus creation does not alter RbacState; read current membership so another
    // instance immediately recognizes newly-created targets for platform grants.
    return new Set((await this.db.campus.findMany({ select: { id: true } })).map(c => c.id));
  }

  /* ==================== 有效权限读取 ==================== */

  /**
   * 账号在上下文校区的有效授权：patterns=平台级全部菜单行 perms ∪ 校区级（=上下文）
   * 菜单行 perms；menuCodes=目录/菜单行 code 并集。授权读取失败默认拒绝。
   */
  assertSession(account: AdminAccount, tokenSv?: number): void {
    if (account.status !== 'active') throw new UnauthorizedException('账号已停用');
    if ((tokenSv ?? 0) !== account.sessionVersion)
      // ADMIN_SINGLE_SESSION 顶下线场景：文案明确化（道哥 2026-09-24）
      throw new UnauthorizedException(
        '该账号已在其他设备登录，您已被顶下线；如非本人操作请及时改密',
      );
  }

  async getEffective(account: AdminAccount): Promise<RbacContext> {
    const version = await this.currentVersion();
    const key = `${account.id}|${account.sessionVersion}|${version}|${account.campusId}`;
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.ctx;

    const grants = await this.db.adminAccountRole.findMany({
      where: { accountId: account.id },
      include: { role: true },
    });
    const roleIds: string[] = [];
    const platformRoleIds: string[] = [];
    let platform = false;
    let superAdmin = false;
    const campusGrantIds = new Set<string>();
    for (const g of grants) {
      if (g.role.status !== 'active') continue;
      if (g.role.code === SUPER_ROLE_CODE && g.scope === 'platform') {
        platform = true;
        superAdmin = true;
        continue;
      }
      if (g.role.code === SUPER_ROLE_CODE) continue; // Invalid legacy campus-super binding is never global.
      if (g.scope === 'platform') {
        platform = true;
        roleIds.push(g.roleId);
        platformRoleIds.push(g.roleId);
      } else if (g.campusId) {
        campusGrantIds.add(g.campusId);
        // 校区级角色仅在上下文校区生效（=account.campusId；切换校区换绑定后重算）
        if (g.campusId === account.campusId) roleIds.push(g.roleId);
      }
    }
    const menus = roleIds.length
      ? await this.db.adminMenu.findMany({
          where: {
            status: 'active',
            roleMenus: { some: { roleId: { in: roleIds } } },
          },
          include: { roleMenus: { where: { roleId: { in: platformRoleIds } } } },
        })
      : [];
    const patterns = new Set<string>();
    const platformPatterns = new Set<string>();
    const menuCodes = new Set<string>();
    for (const rm of menus) {
      for (const p of rm.perms.split(',').map((s) => s.trim()).filter(Boolean)) {
        patterns.add(p);
        if (rm.roleMenus.length) platformPatterns.add(p);
      }
      if (rm.type !== 2) menuCodes.add(rm.code);
    }
    const ctx: RbacContext = {
      accountId: account.id,
      username: account.username,
      nickname: account.nickname || account.username,
      campusId: account.campusId,
      platform,
      super: superAdmin,
      campuses: [...campusGrantIds],
      patterns,
      platformPatterns,
      menuCodes,
    };
    this.cache.set(key, { ctx, expiresAt: Date.now() + RbacService.TTL_MS });
    return ctx;
  }

  /** URL 判权（超管通配；蛋词模式核心） */
  allow(ctx: RbacContext, method: string, path: string): boolean {
    if (ctx.super) return true;
    if (isSuperOnlyOperation(method, path)) return false;
    if (matchUrl(PLATFORM_PATTERNS, method, path))
      return matchUrl(ctx.platformPatterns ?? [], method, path);
    return matchUrl(ctx.patterns, method, path);
  }

  /* ==================== permmenu 契约（对齐蛋词 {perms, menus}） ==================== */

  async buildMeResponse(account: AdminAccount) {
    const ctx = await this.getEffective(account);
    const grants = await this.db.adminAccountRole.findMany({
      where: { accountId: account.id },
      include: { role: true },
      orderBy: { createdAt: 'asc' },
    });
    // 菜单行：超管=全部 type!=2；否则角色菜单并集。parentId 输出 code 便于前端组树。
    const rows = ctx.super
      ? await this.db.adminMenu.findMany({
          where: { type: { not: 2 }, status: 'active' },
          orderBy: [{ orderNum: 'asc' }],
        })
      : ctx.menuCodes.size
        ? await this.db.adminMenu.findMany({
            where: { code: { in: [...ctx.menuCodes] }, status: 'active' },
            orderBy: [{ orderNum: 'asc' }],
          })
        : [];
    const allRows = await this.db.adminMenu.findMany({ where: { type: { not: 2 }, status: 'active' } });
    const byId = new Map(allRows.map(m => [m.id, m]));
    const authorizedIds = new Set(rows.filter(m => m.type === 1).map(m => m.id));
    const expanded = new Map(rows.map(m => [m.id, m]));
    for (const row of rows) {
      let parent = row.parentId;
      const seen = new Set<string>();
      while (parent && !seen.has(parent)) {
        seen.add(parent);
        const ancestor = byId.get(parent);
        if (!ancestor) break;
        expanded.set(ancestor.id, ancestor);
        parent = ancestor.parentId;
      }
    }
    const parentCode = new Map(allRows.map(m => [m.id, m.code]));
    return {
      account: {
        id: account.id, username: account.username, nickname: account.nickname,
        status: account.status, campusId: account.campusId,
      },
      platform: ctx.platform,
      platformPerms: [...(ctx.platformPatterns ?? [])].sort(),
      super: ctx.super,
      contextCampusId: account.campusId,
      roles: grants.map((g) => ({
        id: g.role.id, code: g.role.code, name: g.role.name,
        scope: g.scope, campusId: g.campusId,
        status: g.role.status, builtin: g.role.builtin,
      })),
      perms: ctx.super ? ['*'] : [...ctx.patterns].filter(pattern => {
        const space = pattern.indexOf(' ');
        return this.allow(ctx, pattern.slice(0, space), pattern.slice(space + 1));
      }).sort(),
      menus: [...expanded.values()].sort((a, b) => a.orderNum - b.orderNum || a.code.localeCompare(b.code)).map((m) => ({
        id: m.id, code: m.code, parentId: m.parentId ? (parentCode.get(m.parentId) ?? null) : null,
        name: m.name, type: m.type, path: m.path, viewPath: m.viewPath,
        icon: m.icon, orderNum: m.orderNum, isShow: m.isShow,
        keepAlive: m.keepAlive, authorized: authorizedIds.has(m.id),
      })),
      switchableCampuses: await this.switchableCampuses(ctx),
      rbacVersion: await this.currentVersion(),
    };
  }

  private async switchableCampuses(ctx: RbacContext): Promise<string[]> {
    if (ctx.super) return (await this.db.campus.findMany({ select: { id: true } })).map((c) => c.id);
    return ctx.campuses;
  }

  /* ==================== 审计 ==================== */

  private async audit(
    tx: Prisma.TransactionClient,
    entry: {
      operator: string; action: string; entityType: string; entityId: string;
      campusId?: string; before?: unknown; after?: unknown;
    },
  ) {
    await tx.auditLog.create({
      data: {
        campusId: entry.campusId ?? '',
        operator: entry.operator,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        before: (entry.before ?? undefined) as Prisma.InputJsonValue | undefined,
        after: (entry.after ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
  }

  async auditSensitiveAccess(
    operator: string, action: string, entityId: string, campusId: string,
  ) {
    try {
      await this.db.auditLog.create({
        data: { campusId, operator, action, entityType: 'sensitive-access', entityId },
      });
    } catch (e) {
      this.logger.warn(`敏感访问审计写入失败 ${action}/${entityId}: ${String(e)}`);
      throw new ServiceUnavailableException('审计服务暂不可用，请稍后重试');
    }
  }

  /* ==================== 超管保护 ==================== */

  private async countActiveSupers(tx: Prisma.TransactionClient): Promise<number> {
    return tx.adminAccountRole.count({
      where: {
        scope: 'platform',
        role: { code: SUPER_ROLE_CODE, status: 'active' },
        account: { status: 'active' },
      },
    });
  }

  private async lockSuperGuard(tx: Prisma.TransactionClient) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SUPER_GUARD_LOCK})`;
  }

  /* ==================== 账号-角色授权管理（仅超管） ==================== */

  async setAccountRoles(
    actor: { id: string; username: string },
    accountId: string,
    grants: { roleCode: string; scope: 'platform' | 'campus'; campusId?: string | null }[],
  ) {
    await this.db.$transaction(async (tx) => {
      await this.lockSuperGuard(tx);
      await this.replaceAccountGrants(tx, actor, accountId, grants);
    });
    this.cache.clear();
    return grants;
  }

  private async replaceAccountGrants(
    tx: Prisma.TransactionClient,
    actor: { username: string },
    accountId: string,
    grants: { roleCode: string; scope: 'platform' | 'campus'; campusId?: string | null }[],
  ) {
      const before = await tx.adminAccountRole.findMany({
        where: { accountId }, include: { role: { select: { code: true } } },
      });
      const account = await tx.adminAccount.findUnique({ where: { id: accountId } });
      if (!account) throw new BadRequestException('账号不存在');
      const grantKeys = grants.map(g => `${g.roleCode}:${g.scope}:${g.campusId ?? ''}`);
      if (new Set(grantKeys).size !== grants.length)
        throw new BadRequestException('存在重复角色与校区授权');
      for (const g of grants) {
        if (g.scope !== 'platform' && g.scope !== 'campus')
          throw new BadRequestException('授权范围只允许 platform/campus');
        // 超级管理员为系统内置唯一身份（道哥 2026-09-22）：不走授权通道，
        // 仅由启动同步维护在系统主账号上；角色下拉亦不显示
        if (g.roleCode === SUPER_ROLE_CODE)
          throw new BadRequestException('超级管理员不可授予，系统仅保留内置超级管理员账号');
        if (g.scope === 'platform' && g.campusId)
          throw new BadRequestException('平台范围不能指定校区');
        if (g.scope === 'campus' && !g.campusId)
          throw new BadRequestException('校区级授权必须指定校区');
        const role = await tx.adminRole.findUnique({ where: { code: g.roleCode } });
        if (!role) throw new BadRequestException(`角色不存在: ${g.roleCode}`);
        if (g.scope === 'campus') {
          const campus = await tx.campus.findUnique({ where: { id: g.campusId! } });
          if (!campus) throw new BadRequestException(`校区不存在: ${g.campusId}`);
        }
      }
      const isSuperAccount = before.some(
        (b) => b.role.code === SUPER_ROLE_CODE && b.scope === 'platform',
      );
      if (isSuperAccount && account.status === 'active') {
        const keepsSuper = grants.some((g) => g.roleCode === SUPER_ROLE_CODE && g.scope === 'platform');
        if (!keepsSuper) {
          const others = await this.countActiveSupers(tx);
          if (others <= 1)
            throw new ForbiddenException('必须保留至少一个有效的超级管理员');
        }
      }
      const roleIds = new Map(
        (await tx.adminRole.findMany({ select: { id: true, code: true } })).map((r) => [r.code, r.id]),
      );
      await tx.adminAccountRole.deleteMany({ where: { accountId } });
      if (grants.length) {
        await tx.adminAccountRole.createMany({
          data: grants.map((g) => ({
            accountId, roleId: roleIds.get(g.roleCode)!,
            scope: g.scope, campusId: g.scope === 'campus' ? g.campusId! : null,
            grantedBy: actor.username,
          })),
        });
      }
      // 默认校区跟随授权（IKHMKR2 道 2026-09-22）：campusId 必须落在 campus 级
      // 授权集合内，失配（旧数据/换绑）则自动对齐首个校区级授权——
      // 防止登录上下文落在无授权校区导致空白侧栏（lidaomin 案例）
      const campusGrantIds = grants
        .filter((g) => g.scope === 'campus' && g.campusId)
        .map((g) => g.campusId!);
      if (campusGrantIds.length && !campusGrantIds.includes(account.campusId))
        await tx.adminAccount.update({
          where: { id: accountId },
          data: { campusId: campusGrantIds[0] },
        });
      await tx.adminAccount.update({
        where: { id: accountId },
        data: { sessionVersion: { increment: 1 }, rbacMigrated: true },
      });
      await this.bumpVersion(tx);
      await this.audit(tx, {
        operator: actor.username, action: 'rbac.grant.set', entityType: 'admin-account',
        entityId: accountId, campusId: account.campusId,
        before: before.map((b) => ({ role: b.role.code, scope: b.scope, campusId: b.campusId })),
        after: grants,
      });

  }

  /* ==================== 账号状态/改密 ==================== */

  async setAccountStatus(
    actor: { username: string }, accountId: string, status: 'active' | 'disabled',
  ) {
    const r = await this.db.$transaction(async (tx) => {
      await this.lockSuperGuard(tx);
      return this.changeAccountStatus(tx, actor, accountId, status);
    });
    this.cache.clear();
    return r;
  }

  private async changeAccountStatus(
    tx: Prisma.TransactionClient, actor: { username: string },
    accountId: string, status: 'active' | 'disabled',
  ) {
      const account = await tx.adminAccount.findUnique({ where: { id: accountId } });
      if (!account) throw new BadRequestException('账号不存在');
      if (account.status === status) return { id: accountId, status };
      if (status === 'disabled') {
        const isSuper = await tx.adminAccountRole.count({
          where: { accountId, scope: 'platform', role: { code: SUPER_ROLE_CODE } },
        });
        if (isSuper > 0) {
          const others = await this.countActiveSupers(tx);
          if (others <= 1) throw new ForbiddenException('不能停用最后一个有效的超级管理员');
        }
      }
      await tx.adminAccount.update({ where: { id: accountId }, data: { status } });
      await tx.adminAccount.update({
        where: { id: accountId },
        data: { sessionVersion: { increment: 1 } },
      });
      await this.bumpVersion(tx);
      await this.audit(tx, {
        operator: actor.username, action: `rbac.account.${status}`,
        entityType: 'admin-account', entityId: accountId, campusId: account.campusId,
        before: { status: account.status }, after: { status },
      });
      return { id: accountId, status };
  }

  /** Account fields, grants and audit commit together; all super changes share one lock. */
  async createAccount(actor: { id: string; username: string }, input: CreateAccountDto) {
    const passwordHash = await hash(input.password, 10);
    const account = await this.db.$transaction(async tx => {
      await this.lockSuperGuard(tx);
      if (await tx.adminAccount.findUnique({ where: { username: input.username } }))
        throw new BadRequestException('用户名已存在');
      const campusId = input.grants?.find(g => g.scope === 'campus')?.campusId ?? '';
      const created = await tx.adminAccount.create({ data: {
        username: input.username, nickname: input.nickname ?? '', passwordHash,
        role: 'rbac', campusId, rbacMigrated: true,
      } });
      await this.replaceAccountGrants(tx, actor, created.id, input.grants ?? []);
      await this.audit(tx, {
        operator: actor.username, action: 'rbac.account.create', entityType: 'admin-account',
        entityId: created.id, campusId, after: { username: input.username, nickname: created.nickname },
      });
      return { id: created.id, username: created.username, campusId };
    });
    this.cache.clear();
    return account;
  }

  async updateAccount(actor: { id: string; username: string }, accountId: string, input: UpdateAccountDto) {
    if (input.nickname === undefined && !input.password && !input.status && !input.grants)
      throw new BadRequestException('没有可更新的字段');
    const passwordHash = input.password ? await hash(input.password, 10) : undefined;
    const account = await this.db.$transaction(async tx => {
      await this.lockSuperGuard(tx);
      const before = await tx.adminAccount.findUnique({ where: { id: accountId } });
      if (!before) throw new BadRequestException('账号不存在');
      // 内置超管（道哥 2026-09-22）：系统唯一身份，不可编辑
      if (before.username === 'admin')
        throw new BadRequestException('内置超级管理员账号不可编辑');
      if (input.grants) await this.replaceAccountGrants(tx, actor, accountId, input.grants);
      if (input.grants) await this.replaceAccountGrants(tx, actor, accountId, input.grants);
      if (input.status) await this.changeAccountStatus(tx, actor, accountId, input.status);
      const updated = await tx.adminAccount.update({ where: { id: accountId }, data: {
        ...(input.nickname !== undefined ? { nickname: input.nickname } : {}),
        ...(passwordHash ? { passwordHash, sessionVersion: { increment: 1 } } : {}),
      }, select: { id: true, username: true, nickname: true, status: true, role: true } });
      if (input.nickname !== undefined || passwordHash) await this.audit(tx, {
        operator: actor.username, action: 'rbac.account.update', entityType: 'admin-account',
        entityId: accountId, campusId: before.campusId,
        before: { nickname: before.nickname },
        after: { nickname: updated.nickname, passwordReset: !!passwordHash },
      });
      return updated;
    });
    this.cache.clear();
    return account;
  }

  async deleteAccount(actor: { id: string; username: string }, accountId: string) {
    if (actor.id === accountId) throw new BadRequestException('不能删除当前登录账号');
    await this.db.$transaction(async tx => {
      await this.lockSuperGuard(tx);
      const account = await tx.adminAccount.findUnique({ where: { id: accountId } });
      if (!account) throw new BadRequestException('账号不存在');
      // 内置超管（道哥 2026-09-22）：系统唯一身份，不可删除
      if (account.username === 'admin')
        throw new BadRequestException('内置超级管理员账号不可删除');
      const isSuper = await tx.adminAccountRole.count({ where: {
        accountId, scope: 'platform', role: { code: SUPER_ROLE_CODE, status: 'active' },
      } });
      if (isSuper && account.status === 'active' && await this.countActiveSupers(tx) <= 1)
        throw new ForbiddenException('必须保留至少一个有效的超级管理员');
      await tx.adminAccount.delete({ where: { id: accountId } });
      await this.bumpVersion(tx);
      await this.audit(tx, {
        operator: actor.username, action: 'rbac.account.delete', entityType: 'admin-account',
        entityId: accountId, campusId: account.campusId,
        before: { username: account.username, nickname: account.nickname },
      });
    });
    this.cache.clear();
    return { id: accountId, deleted: true };
  }

  /** 重置密码（超管操作）：bump 会话版本，该账号全部旧 token 失效。 */
  async resetAccountPassword(actor: { username: string }, accountId: string, password: string) {
    if (!password || password.length < 8)
      throw new BadRequestException('密码至少 8 位');
    const passwordHash = await hash(password, 10);
    await this.db.$transaction(async (tx) => {
      const account = await tx.adminAccount.findUnique({ where: { id: accountId } });
      if (!account) throw new BadRequestException('账号不存在');
      await tx.adminAccount.update({
        where: { id: accountId },
        data: { passwordHash, sessionVersion: { increment: 1 } },
      });
      await this.audit(tx, {
        operator: actor.username, action: 'rbac.account.reset-password',
        entityType: 'admin-account', entityId: accountId, campusId: account.campusId,
      });
    });
    this.cache.clear();
  }

  /* ==================== 角色管理（仅超管；menuCodes 全量重设） ==================== */

  listRoles() {
    return this.db.adminRole.findMany({
      orderBy: { createdAt: 'asc' },
      include: {
        _count: { select: { accounts: true } },
        adminRoleMenus: { include: { menu: { select: { code: true } } } },
      },
    });
  }

  /** 菜单树（管理页/角色勾选用）：按 orderNum 排序扁平行（前端组树），带 perms 模式。 */
  listMenus() {
    return this.db.adminMenu.findMany({
      where: { status: 'active' },
      orderBy: [{ orderNum: 'asc' }],
    });
  }

  /* ==================== 菜单管理（自建节点；端点判权=rbac.menus.write 模式） ==================== */

  catalog() {
    return {
      views: MENU_NODES.filter(n => n.type === 1).map(n => ({ key: n.code, name: n.name })),
      permissions: ALL_PERM_PATTERNS.map(pattern => ({
        pattern,
        name: MENU_NODES.filter(n => n.perms?.includes(pattern)).map(n => n.name).join(' / '),
      })),
    };
  }

  private validateView(type: number, path: string, view: string) {
    if (type !== 1) return;
    if (!/^\/(?:[a-zA-Z0-9_-]+\/?)*$/.test(path) || ['/login', '/access-denied'].includes(path))
      throw new BadRequestException('菜单路由必须为站内路径，且不能覆盖登录或无权限页');
    const internal = MENU_NODES.some(n => n.type === 1 && n.code === view);
    let external = false;
    try { external = new URL(view).protocol === 'https:'; } catch { /* internal key */ }
    if (!internal && !external) throw new BadRequestException('请选择已登记页面或填写 HTTPS 外链');
  }

  private static readonly PERM_PATTERN_RE =
    /^(GET|POST|PATCH|PUT|DELETE) \/admin\/\S+$/;

  /** perms 数组校验（蛋词模式串），返回可入库的逗号串 */
  private validatePerms(perms?: string[]): string | undefined {
    if (perms === undefined) return undefined;
    const bad = perms.filter((p) => !RbacService.PERM_PATTERN_RE.test(p));
    if (bad.length)
      throw new BadRequestException(
        `perms 模式非法（须为 "METHOD /admin/…"）: ${bad.join(',')}`,
      );
    const unknown = perms.filter(p => !ALL_PERM_PATTERNS.includes(p));
    if (unknown.length) throw new BadRequestException('请选择已登记的接口权限');
    return [...new Set(perms)].join(',');
  }

  /** 建自建节点（builtin=false；code 自动生成 custom-*，不与代码登记冲突） */
  async createMenu(
    actor: { username: string },
    input: {
      name: string;
      type: number;
      parentCode?: string;
      parentId?: string | null;
      viewPath?: string;
      keepAlive?: boolean;
      isShow?: boolean;
      perms?: string[];
      path?: string;
      icon?: string;
      orderNum?: number;
    },
  ) {
    if (![0, 1, 2].includes(input.type))
      throw new BadRequestException('type 只允许 0 目录 / 1 菜单 / 2 按钮');
    if (!input.name?.trim()) throw new BadRequestException('菜单名称不能为空');
    const perms = this.validatePerms(input.perms);
    const code = `custom-${randomUUID().slice(0, 8)}`;
    this.validateView(input.type, input.path ?? '', input.viewPath ?? '');
    const created = await this.db.$transaction(async (tx) => {
      await this.lockSuperGuard(tx);
      if (input.type === 1 && await tx.adminMenu.findFirst({ where: { type: 1, path: input.path } }))
        throw new BadRequestException('该菜单路由已存在');
      let parentId: string | null = null;
      if (input.parentCode || input.parentId) {
        const parent = await tx.adminMenu.findUnique({
          where: input.parentId ? { id: input.parentId } : { code: input.parentCode },
        });
        if (!parent)
          throw new BadRequestException(`父节点不存在: ${input.parentCode}`);
        if (parent.type === 2)
          throw new BadRequestException('按钮节点下不可再挂子节点');
        parentId = parent.id;
      }
      const menu = await tx.adminMenu.create({
        data: {
          code,
          name: input.name.trim(),
          type: input.type,
          parentId,
          perms: perms ?? '',
          path: input.path ?? '',
          viewPath: input.viewPath ?? '',
          keepAlive: input.keepAlive ?? false,
          isShow: input.isShow ?? true,
          icon: input.icon ?? '',
          orderNum: input.orderNum ?? 0,
          builtin: false,
        },
      });
      await this.bumpVersion(tx);
      await this.audit(tx, {
        operator: actor.username,
        action: 'rbac.menu.create',
        entityType: 'admin-menu',
        entityId: menu.id,
        campusId: '',
        after: { code, name: menu.name, type: input.type, parentId, perms: input.perms ?? [] },
      });
      return menu;
    });
    this.cache.clear();
    return created;
  }

  /** 改节点：builtin 行只许表现字段（name/icon/orderNum/isShow）；自建行结构字段可改 */
  async updateMenu(
    actor: { username: string },
    id: string,
    input: {
      name?: string;
      icon?: string;
      orderNum?: number;
      isShow?: boolean;
      type?: number;
      perms?: string[];
      path?: string;
      parentId?: string | null;
      viewPath?: string;
      keepAlive?: boolean;
    },
  ) {
    if (input.type !== undefined && ![0, 1, 2].includes(input.type))
      throw new BadRequestException('type 只允许 0 目录 / 1 菜单 / 2 按钮');
    const perms = this.validatePerms(input.perms);
    const updated = await this.db.$transaction(async (tx) => {
      await this.lockSuperGuard(tx);
      const menu = await tx.adminMenu.findUnique({ where: { id } });
      if (!menu) throw new BadRequestException('菜单节点不存在');
      const type = input.type ?? menu.type;
      this.validateView(type, input.path ?? menu.path, input.viewPath ?? menu.viewPath);
      if (type === 2 && await tx.adminMenu.count({ where: { parentId: id } }))
        throw new BadRequestException('含子节点的目录或菜单不能改为按钮');
      if (type === 1 && await tx.adminMenu.findFirst({ where: {
        id: { not: id }, type: 1, path: input.path ?? menu.path,
      } })) throw new BadRequestException('该菜单路由已存在');
      let parentId: string | null | undefined;
      if (input.parentId !== undefined) {
        if (!input.parentId) {
          parentId = null;
        } else {
          const parent = await tx.adminMenu.findUnique({
            where: { id: input.parentId },
          });
          if (!parent) throw new BadRequestException('父节点不存在');
          if (parent.type === 2)
            throw new BadRequestException('按钮节点下不可再挂子节点');
          if (parent.id === id)
            throw new BadRequestException('父节点不能是自身');
          // 防环：沿新父链上溯，撞到自身即拒绝
          let cur: string | null = parent.parentId;
          while (cur) {
            if (cur === id)
              throw new BadRequestException('不可将节点挂到自己的子孙节点下');
            cur = (await tx.adminMenu.findUnique({ where: { id: cur } }))
              ?.parentId ?? null;
          }
          parentId = parent.id;
        }
      }
      const row = await tx.adminMenu.update({
        where: { id },
        data: {
          ...(input.viewPath !== undefined ? { viewPath: input.viewPath } : {}),
          ...(input.keepAlive !== undefined ? { keepAlive: input.keepAlive } : {}),
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.icon !== undefined ? { icon: input.icon } : {}),
          ...(input.orderNum !== undefined ? { orderNum: input.orderNum } : {}),
          ...(input.isShow !== undefined ? { isShow: input.isShow } : {}),
          ...(input.type !== undefined ? { type: input.type } : {}),
          ...(perms !== undefined ? { perms } : {}),
          ...(input.path !== undefined ? { path: input.path } : {}),
          ...(parentId !== undefined ? { parentId } : {}),
        },
      });
      await this.bumpVersion(tx);
      await this.audit(tx, {
        operator: actor.username,
        action: 'rbac.menu.update',
        entityType: 'admin-menu',
        entityId: id,
        campusId: '',
        before: {
          name: menu.name, icon: menu.icon, orderNum: menu.orderNum,
          isShow: menu.isShow, type: menu.type, perms: menu.perms,
          path: menu.path, parentId: menu.parentId,
        },
        after: input,
      });
      return row;
    });
    this.cache.clear();
    return updated;
  }

  /** 删自建节点（builtin 拒绝）：递归删非 builtin 子树；role_menu 引用由级联清 */
  async deleteMenu(actor: { username: string }, id: string) {
    const result = await this.db.$transaction(async (tx) => {
      const menu = await tx.adminMenu.findUnique({ where: { id } });
      if (!menu) throw new BadRequestException('菜单节点不存在');
      if (menu.builtin) throw new ForbiddenException('内置菜单节点不可删除');
      // 递归收集子树；任何 builtin 后代 → 拒绝（不能拆代码登记的树）
      const subtree = [menu];
      for (let i = 0; i < subtree.length; i++) {
        const children = await tx.adminMenu.findMany({
          where: { parentId: subtree[i].id },
        });
        for (const c of children) {
          if (c.builtin)
            throw new ForbiddenException(
              `子树含内置节点 ${c.code}，不可级联删除`,
            );
          if (!subtree.some((s) => s.id === c.id)) subtree.push(c);
        }
      }
      const ids = subtree.map((m) => m.id);
      await tx.adminMenu.deleteMany({ where: { id: { in: ids } } });
      await this.bumpVersion(tx);
      await this.audit(tx, {
        operator: actor.username,
        action: 'rbac.menu.delete',
        entityType: 'admin-menu',
        entityId: id,
        campusId: '',
        before: { codes: subtree.map((m) => m.code) },
      });
      return { id, deleted: ids.length, codes: subtree.map((m) => m.code) };
    });
    this.cache.clear();
    return result;
  }

  private async assertMenuCodes(tx: Prisma.TransactionClient, codes: string[]) {
    const rows = await tx.adminMenu.findMany({
      where: { code: { in: codes }, status: 'active' },
      select: { code: true },
    });
    const valid = new Set(rows.map((r) => r.code));
    const bad = codes.filter((c) => !valid.has(c));
    if (bad.length) throw new BadRequestException(`未登记的菜单节点: ${bad.join(',')}`);
    return rows;
  }

  async createRole(
    actor: { username: string },
    input: { code: string; name: string; remark?: string; menuCodes: string[] },
  ) {
    const code = input.code.trim();
    if (!/^[a-z0-9-]{2,40}$/.test(code))
      throw new BadRequestException('角色编码仅限小写字母/数字/连字符，2-40 位');
    if (ROLE_TEMPLATES.some((t) => t.code === code) || code === SUPER_ROLE_CODE)
      throw new BadRequestException('该角色编码为内置保留');
    const created = await this.db.$transaction(async (tx) => {
      const exists = await tx.adminRole.findUnique({ where: { code } });
      if (exists) throw new BadRequestException('角色编码已存在');
      const menus = await this.assertMenuCodes(tx, [...new Set(input.menuCodes)]);
      const role = await tx.adminRole.create({
        data: { code, name: input.name.trim(), remark: input.remark ?? '', seeded: true, menusMigrated: true },
      });
      if (menus.length) {
        const ids = (
          await tx.adminMenu.findMany({
            where: { code: { in: menus.map((m) => m.code) } },
            select: { id: true },
          })
        ).map((m) => m.id);
        await tx.adminRoleMenu.createMany({
          data: ids.map((menuId) => ({ roleId: role.id, menuId })),
        });
      }
      await this.bumpVersion(tx);
      await this.audit(tx, {
        operator: actor.username, action: 'rbac.role.create', entityType: 'admin-role',
        entityId: role.id, after: { code, name: input.name, menuCodes: input.menuCodes },
      });
      return role;
    });
    this.cache.clear();
    return created;
  }

  async updateRole(
    actor: { username: string },
    roleId: string,
    input: { name?: string; remark?: string; status?: 'active' | 'disabled'; menuCodes?: string[] },
  ) {
    const before = await this.db.adminRole.findUnique({ where: { id: roleId } });
    if (!before) throw new BadRequestException('角色不存在');
    if (before.builtin) throw new ForbiddenException('内置超级管理员不可编辑');
    await this.db.$transaction(async (tx) => {
      await this.lockSuperGuard(tx);
      let menuCodesBefore: string[] | undefined;
      if (input.menuCodes) {
        await this.assertMenuCodes(tx, [...new Set(input.menuCodes)]);
        const oldRows = await tx.adminRoleMenu.findMany({
          where: { roleId },
          include: { menu: { select: { code: true } } },
        });
        menuCodesBefore = oldRows.map((r) => r.menu.code);
      }
      await tx.adminRole.update({
        where: { id: roleId },
        data: {
          menusMigrated: true,
          ...(input.name ? { name: input.name.trim() } : {}),
          ...(input.remark !== undefined ? { remark: input.remark } : {}),
          ...(input.status ? { status: input.status } : {}),
        },
      });
      if (input.menuCodes) {
        const menus = await tx.adminMenu.findMany({
          where: { code: { in: [...new Set(input.menuCodes)] } },
          select: { id: true },
        });
        await tx.adminRoleMenu.deleteMany({ where: { roleId } });
        if (menus.length)
          await tx.adminRoleMenu.createMany({
            data: menus.map((m) => ({ roleId, menuId: m.id })),
          });
      }
      await this.bumpVersion(tx);
      await this.audit(tx, {
        operator: actor.username, action: 'rbac.role.update', entityType: 'admin-role',
        entityId: roleId,
        before: { name: before.name, status: before.status, menuCodes: menuCodesBefore },
        after: input,
      });
    });
    this.cache.clear();
  }

  async deleteRole(actor: { username: string }, roleId: string) {
    await this.db.$transaction(async (tx) => {
      await this.lockSuperGuard(tx);
      const role = await tx.adminRole.findUnique({
        where: { id: roleId }, include: { _count: { select: { accounts: true } } },
      });
      if (!role) throw new BadRequestException('角色不存在');
      if (role.builtin) throw new ForbiddenException('内置超级管理员不可删除');
      if (role._count.accounts > 0)
        throw new BadRequestException(`仍有 ${role._count.accounts} 条账号授权引用该角色，先撤权再删除`);
      await tx.adminRoleMenu.deleteMany({ where: { roleId } });
      await tx.adminRole.delete({ where: { id: roleId } });
      await this.bumpVersion(tx);
      await this.audit(tx, {
        operator: actor.username, action: 'rbac.role.delete', entityType: 'admin-role',
        entityId: roleId, before: { code: role.code, name: role.name },
      });
    });
    this.cache.clear();
  }

  /** 权限目录（type=2 按钮行，只读展示） */
  listPermissions() {
    return this.db.adminMenu.findMany({
      where: { type: 2, status: 'active' },
      orderBy: [{ orderNum: 'asc' }],
    });
  }

  /** 授权审计 */
  listRbacAudit(page = 1, pageSize = 50) {
    return this.db.auditLog.findMany({
      where: { OR: [{ action: { startsWith: 'rbac.' } }, { entityType: 'sensitive-access' }] },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
  }

  /** 指定账号的有效权限预览 */
  async previewAccount(accountId: string) {
    const account = await this.db.adminAccount.findUnique({ where: { id: accountId } });
    if (!account) throw new BadRequestException('账号不存在');
    return this.buildMeResponse(account);
  }
}
