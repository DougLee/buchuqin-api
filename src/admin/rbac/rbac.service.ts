import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma, AdminAccount } from '@prisma/client';
import { hash } from 'bcryptjs';
import { PrismaService } from '../../database/prisma.service';
import {
  PERMISSIONS,
  PERMISSION_CODES,
  ROLE_TEMPLATES,
  SUPER_ROLE_CODE,
  LEGACY_ROLE_MAP,
  type PermScope,
} from './registry';

/** 请求级 RBAC 上下文（AdminAuthGuard 注入 request.rbac） */
export interface RbacContext {
  accountId: string;
  username: string;
  nickname: string;
  /** 当前运营校区上下文（token campusId） */
  campusId: string;
  /** 是否持有平台级授权（跨校区数据视角） */
  platform: boolean;
  /** 是否超级管理员（通配全量权限） */
  super: boolean;
  /** 校区级授权覆盖的校区（切换校区候选集） */
  campuses: string[];
  /** 当前上下文生效的权限码集合 */
  permissions: Set<string>;
}

interface CacheEntry {
  ctx: Omit<RbacContext, 'permissions'> & { permissions: Set<string> };
  expiresAt: number;
}

/** 超管保护/账号变更的串行化锁键（pg_advisory_xact_lock） */
const SUPER_GUARD_LOCK = 728281001;

@Injectable()
export class RbacService implements OnModuleInit {
  private readonly logger = new Logger(RbacService.name);
  /** 有效权限缓存：key = accountId|sv|rbacVersion|campusId；任何授权变更 bump version 即全量失效 */
  private readonly cache = new Map<string, CacheEntry>();
  private static readonly TTL_MS = 15_000;

  constructor(private readonly db: PrismaService) {}

  /* ==================== 启动同步：权限登记 → 数据库 ==================== */

  /**
   * 幂等启动同步（goal：权限点由开发在代码登记并同步到数据库）：
   * 1) 权限码 upsert（新增/改名，永不删除——历史角色关联不悬空）；
   * 2) 内置超管 + 迁移模板角色 upsert；模板未灌注（seeded=false）时灌注权限集；
   * 3) 旧静态角色账号迁移：AdminAccountRole 零行且 role 为五旧角色 → 按对照灌绑定。
   * 全程事务；有任何实际变更才 bump 全局版本。
   */
  async onModuleInit() {
    try {
      await this.syncRegistry();
    } catch (e) {
      // 同步失败不阻断启动（首次部署表未建等），但必须显式记录
      this.logger.error(`RBAC registry sync failed: ${String(e)}`);
    }
  }

  async syncRegistry(): Promise<void> {
    let changed = false;
    await this.db.$transaction(async (tx) => {
      await tx.rbacState.upsert({
        where: { id: 'global' },
        update: {},
        create: { id: 'global', version: 0 },
      });
      // 1) 权限登记
      for (const [i, p] of PERMISSIONS.entries()) {
        const row = await tx.adminPermission.findUnique({ where: { code: p.code } });
        if (!row) {
          await tx.adminPermission.create({
            data: { code: p.code, name: p.name, group: p.group, scope: p.scope, sort: i, remark: p.remark ?? '' },
          });
          changed = true;
        } else if (
          row.name !== p.name || row.group !== p.group ||
          row.scope !== p.scope || row.remark !== (p.remark ?? '')
        ) {
          await tx.adminPermission.update({
            where: { id: row.id },
            data: { name: p.name, group: p.group, scope: p.scope, remark: p.remark ?? '', sort: i },
          });
          changed = true;
        }
      }
      // 2) 内置超管（通配，无权限行）
      const superRole = await tx.adminRole.upsert({
        where: { code: SUPER_ROLE_CODE },
        update: {},
        create: {
          code: SUPER_ROLE_CODE, name: '超级管理员', remark: '内置：全部权限（通配），不可编辑/删除',
          builtin: true, seeded: true, status: 'active',
        },
      });
      if (superRole.status !== 'active') {
        await tx.adminRole.update({ where: { id: superRole.id }, data: { status: 'active' } });
        changed = true;
      }
      // 3) 迁移模板角色：存在则只对齐名称；未灌注则一次性灌注
      for (const t of ROLE_TEMPLATES) {
        const role = await tx.adminRole.upsert({
          where: { code: t.code },
          update: { name: t.name, remark: t.remark },
          create: { code: t.code, name: t.name, remark: t.remark, seeded: false },
        });
        if (role.seeded) continue;
        const codes = [...t.platformPermissions, ...t.campusPermissions];
        const perms = await tx.adminPermission.findMany({
          where: { code: { in: codes } },
          select: { id: true, code: true },
        });
        const found = new Set(perms.map((p) => p.code));
        const missing = codes.filter((c) => !found.has(c));
        if (missing.length)
          throw new Error(`模板 ${t.code} 引用未登记权限: ${missing.join(',')}`);
        await tx.adminRolePermission.deleteMany({ where: { roleId: role.id } });
        await tx.adminRolePermission.createMany({
          data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })),
        });
        await tx.adminRole.update({ where: { id: role.id }, data: { seeded: true } });
        changed = true;
      }
      // 4) 旧账号迁移（幂等：只处理零绑定的旧角色账号）
      const legacyAccounts = await tx.adminAccount.findMany({
        where: { rbacRoles: { none: {} }, role: { in: Object.keys(LEGACY_ROLE_MAP) } },
        include: { accesses: { select: { campusId: true } } },
      });
      const campusIds = (await tx.campus.findMany({ select: { id: true } })).map((c) => c.id);
      const campusSet = new Set(campusIds);
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
            .filter((c) => campusSet.has(c));
          if (!targets.length) {
            this.logger.warn(
              `账号 ${acc.username}（${acc.role}）无可落地校区，迁移跳过——请超管在账号管理补授权`,
            );
            continue;
          }
          await tx.adminAccountRole.createMany({
            data: targets.map((c) => ({
              accountId: acc.id, roleId: role.id, scope: 'campus', campusId: c, grantedBy: 'migration',
            })),
          });
        }
        changed = true;
        this.logger.log(`账号 ${acc.username} 已迁移绑定角色 ${plan.template}`);
      }
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
    return s?.version ?? 0;
  }

  /** 校区 id 集缓存（campus 参数合法性校验用；短 TTL） */
  private campusSetCache: { ids: Set<string>; expiresAt: number } | null = null;
  async knownCampusIds(): Promise<Set<string>> {
    if (this.campusSetCache && this.campusSetCache.expiresAt > Date.now())
      return this.campusSetCache.ids;
    const ids = new Set((await this.db.campus.findMany({ select: { id: true } })).map((c) => c.id));
    this.campusSetCache = { ids, expiresAt: Date.now() + 15_000 };
    return ids;
  }

  /* ==================== 有效权限读取 ==================== */

  /**
   * 账号在指定上下文校区的有效权限（授权读取失败默认拒绝——异常直接上抛）。
   * 规则：
   * - 平台级授权：贡献角色全部权限码（平台功能码 + 跨校区业务码）；
   * - 校区级授权：仅当校区=上下文校区时贡献「校区业务码」（平台功能码不因校区授权获得）；
   * - 超管角色：通配全量。
   */
  async getEffective(account: AdminAccount): Promise<RbacContext> {
    const version = await this.currentVersion();
    const key = `${account.id}|${account.sessionVersion}|${version}|${account.campusId}`;
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.ctx as RbacContext;

    const grants = await this.db.adminAccountRole.findMany({
      where: { accountId: account.id },
      include: {
        role: { include: { permissions: { include: { permission: true } } } },
      },
    });
    const platformScopePerms = new Set<string>();
    const campusScopePermsByCampus = new Map<string, Set<string>>();
    const campusGrantIds = new Set<string>();
    let platform = false;
    let superAdmin = false;
    for (const g of grants) {
      if (g.role.status !== 'active') continue;
      if (g.role.code === SUPER_ROLE_CODE) {
        platform = true;
        superAdmin = true;
        continue; // 通配：不进集合，单独判定
      }
      const codes = new Set(g.role.permissions.map((p) => p.permission.code));
      if (g.scope === 'platform') {
        platform = true;
        codes.forEach((c) => platformScopePerms.add(c));
      } else if (g.campusId) {
        campusGrantIds.add(g.campusId);
        const bucket = campusScopePermsByCampus.get(g.campusId) ?? new Set<string>();
        // 校区级授权只贡献校区业务码（平台功能码不因校区授权获得）
        for (const p of g.role.permissions) {
          if (p.permission.scope === 'campus') bucket.add(p.permission.code);
        }
        campusScopePermsByCampus.set(g.campusId, bucket);
        void codes;
      }
    }
    const permissions = new Set(platformScopePerms);
    const ctxPerms = campusScopePermsByCampus.get(account.campusId);
    if (ctxPerms) ctxPerms.forEach((c) => permissions.add(c));

    const ctx: RbacContext = {
      accountId: account.id,
      username: account.username,
      nickname: account.nickname || account.username,
      campusId: account.campusId,
      platform,
      super: superAdmin,
      campuses: [...campusGrantIds],
      permissions,
    };
    this.cache.set(key, { ctx, expiresAt: Date.now() + RbacService.TTL_MS });
    return ctx;
  }

  /** 权限判定（超管通配） */
  has(ctx: RbacContext, code: string): boolean {
    if (ctx.super) return true;
    return ctx.permissions.has(code);
  }

  /** 数据范围：目标校区上是否持有某权限（平台级=任意校区；校区级=目标校区授权） */
  async canOnCampus(
    ctx: RbacContext,
    code: string,
    targetCampusId: string,
  ): Promise<boolean> {
    if (ctx.super) return true;
    // 上下文校区命中（getEffective 已算出上下文并集）
    if (ctx.campusId === targetCampusId && ctx.permissions.has(code)) return true;
    if (!ctx.platform) return false;
    // 平台级授权：验证码确为平台授予（区分：平台功能码或平台级业务码）
    const grants = await this.db.adminAccountRole.findMany({
      where: { accountId: ctx.accountId, scope: 'platform' },
      include: { role: { include: { permissions: { select: { permission: { select: { code: true } } } } } } },
    });
    for (const g of grants) {
      if (g.role.status !== 'active') continue;
      if (g.role.code === SUPER_ROLE_CODE) return true;
      if (g.role.permissions.some((p) => p.permission.code === code)) return true;
    }
    return false;
  }

  /* ==================== 上下文与账号能力面 ==================== */

  /** GET /admin/rbac/me：账号上下文（角色来源+权限清单+可切校区） */
  async buildMeResponse(account: AdminAccount) {
    const ctx = await this.getEffective(account);
    const grants = await this.db.adminAccountRole.findMany({
      where: { accountId: account.id },
      include: { role: true },
      orderBy: { createdAt: 'asc' },
    });
    const permDefs = await this.db.adminPermission.findMany({ orderBy: [{ group: 'asc' }, { sort: 'asc' }] });
    const scopeOf = new Map(permDefs.map((p) => [p.code, p.scope as PermScope]));
    const held = [...ctx.permissions]
      .sort()
      .map((code) => ({ code, scope: scopeOf.get(code) ?? 'campus' }));
    return {
      account: {
        id: account.id, username: account.username, nickname: account.nickname,
        status: account.status, campusId: account.campusId,
      },
      platform: ctx.platform,
      super: ctx.super,
      contextCampusId: ctx.campusId,
      roles: grants.map((g) => ({
        id: g.role.id, code: g.role.code, name: g.role.name,
        scope: g.scope as PermScope, campusId: g.campusId,
        status: g.role.status, builtin: g.role.builtin,
      })),
      permissions: ctx.super ? [{ code: '*', scope: 'platform' as PermScope }] : held,
      /** 切换校区候选集：校区级授权校区；超管=全部校区；纯平台级（总部长）=空（跨校区视角） */
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

  /** 敏感访问留痕（身份证/明文手机号等读取）——非事务场景（读接口）单独落 */
  async auditSensitiveAccess(
    operator: string, action: string, entityId: string, campusId: string,
  ) {
    try {
      await this.db.auditLog.create({
        data: { campusId, operator, action, entityType: 'sensitive-access', entityId },
      });
    } catch (e) {
      this.logger.warn(`敏感访问审计写入失败 ${action}/${entityId}: ${String(e)}`);
    }
  }

  /* ==================== 超管保护 ==================== */

  /** 平台级超管有效授权数（active 账号 × active super 角色）；advisory lock 下调用 */
  private async countActiveSupers(tx: Prisma.TransactionClient): Promise<number> {
    const rows = await tx.adminAccountRole.count({
      where: {
        scope: 'platform',
        role: { code: SUPER_ROLE_CODE, status: 'active' },
        account: { status: 'active' },
      },
    });
    return rows;
  }

  private async lockSuperGuard(tx: Prisma.TransactionClient) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SUPER_GUARD_LOCK})`;
  }

  /* ==================== 账号-角色授权管理（仅超管） ==================== */

  /**
   * 全量重设账号授权（UI：按校区分配多角色/撤权）。
   * 事务：校验角色与校区 → 重建绑定 → 审计 before/after → bump 账号会话版本（旧缓存即失效）。
   */
  async setAccountRoles(
    actor: { id: string; username: string },
    accountId: string,
    grants: { roleCode: string; scope: 'platform' | 'campus'; campusId?: string | null }[],
  ) {
    const before = await this.db.adminAccountRole.findMany({
      where: { accountId },
      include: { role: { select: { code: true } } },
    });
    const after = await this.db.$transaction(async (tx) => {
      await this.lockSuperGuard(tx);
      const account = await tx.adminAccount.findUnique({ where: { id: accountId } });
      if (!account) throw new BadRequestException('账号不存在');
      // 校验入参
      for (const g of grants) {
        if (g.scope !== 'platform' && g.scope !== 'campus')
          throw new BadRequestException('授权范围只允许 platform/campus');
        if (g.scope === 'campus' && !g.campusId)
          throw new BadRequestException('校区级授权必须指定校区');
        const role = await tx.adminRole.findUnique({ where: { code: g.roleCode } });
        if (!role) throw new BadRequestException(`角色不存在: ${g.roleCode}`);
        if (g.scope === 'campus') {
          const campus = await tx.campus.findUnique({ where: { id: g.campusId! } });
          if (!campus) throw new BadRequestException(`校区不存在: ${g.campusId}`);
        }
      }
      // 同一账号同一角色至多一条（重设语义：后声明的覆盖先声明的范围）
      const seen = new Map<string, { roleCode: string; scope: 'platform' | 'campus'; campusId?: string | null }>();
      for (const g of grants) {
        const role = await tx.adminRole.findUniqueOrThrow({ where: { code: g.roleCode }, select: { id: true } });
        seen.set(`${g.roleCode}#${g.scope === 'campus' ? g.campusId : 'platform'}`, g);
        void role;
      }
      // 超管保护：重设后必须仍保留 ≥1 个有效的平台级超管授权
      const keepsSuper = grants.some((g) => g.roleCode === SUPER_ROLE_CODE && g.scope === 'platform');
      const isSuperAccount = before.some(
        (b) => b.role.code === SUPER_ROLE_CODE && b.scope === 'platform',
      );
      if (isSuperAccount && !keepsSuper) {
        const others = await this.countActiveSupers(tx);
        // others 计入本账号当前绑定；若本账号是唯一超管且将被摘除 → 拒绝
        if (others <= 1)
          throw new ForbiddenException('必须保留至少一个有效的超级管理员');
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
      await tx.adminAccount.update({
        where: { id: accountId },
        data: { sessionVersion: { increment: 1 } },
      });
      await this.bumpVersion(tx);
      await this.audit(tx, {
        operator: actor.username, action: 'rbac.grant.set', entityType: 'admin-account',
        entityId: accountId, campusId: account.campusId,
        before: before.map((b) => ({ role: b.role.code, scope: b.scope, campusId: b.campusId })),
        after: grants,
      });
      return grants;
    });
    this.cache.clear();
    return after;
  }

  /* ==================== 账号状态/改密（会话版本 bump） ==================== */

  async setAccountStatus(
    actor: { username: string }, accountId: string, status: 'active' | 'disabled',
  ) {
    return this.db.$transaction(async (tx) => {
      await this.lockSuperGuard(tx);
      const account = await tx.adminAccount.findUnique({ where: { id: accountId } });
      if (!account) throw new BadRequestException('账号不存在');
      if (account.status === status) return { id: accountId, status };
      const isSuper = await tx.adminAccountRole.count({
        where: { accountId, scope: 'platform', role: { code: SUPER_ROLE_CODE } },
      });
      if (status === 'disabled' && isSuper > 0) {
        const others = await this.countActiveSupers(tx);
        if (others <= 1) throw new ForbiddenException('不能停用最后一个有效的超级管理员');
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
    }).then((r) => { this.cache.clear(); return r; });
  }

  /** 重置密码（超管操作）：明文入参 → bcrypt 落库 + bump 会话版本（该账号全部旧 token 失效）。 */
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

  /* ==================== 角色管理（仅超管） ==================== */

  listRoles() {
    return this.db.adminRole.findMany({
      orderBy: { createdAt: 'asc' },
      include: {
        _count: { select: { permissions: true, accounts: true } },
        permissions: { include: { permission: true }, orderBy: { permission: { sort: 'asc' } } },
      },
    });
  }

  async createRole(
    actor: { username: string },
    input: { code: string; name: string; remark?: string; permissionCodes: string[] },
  ) {
    const code = input.code.trim();
    if (!/^[a-z0-9-]{2,40}$/.test(code))
      throw new BadRequestException('角色编码仅限小写字母/数字/连字符，2-40 位');
    if (ROLE_TEMPLATES.some((t) => t.code === code) || code === SUPER_ROLE_CODE)
      throw new BadRequestException('该角色编码为内置保留');
    for (const c of input.permissionCodes)
      if (!PERMISSION_CODES.has(c)) throw new BadRequestException(`未登记的权限码: ${c}`);
    const created = await this.db.$transaction(async (tx) => {
      const exists = await tx.adminRole.findUnique({ where: { code } });
      if (exists) throw new BadRequestException('角色编码已存在');
      const role = await tx.adminRole.create({
        data: { code, name: input.name.trim(), remark: input.remark ?? '', seeded: true },
      });
      if (input.permissionCodes.length) {
        const perms = await tx.adminPermission.findMany({
          where: { code: { in: input.permissionCodes } },
        });
        await tx.adminRolePermission.createMany({
          data: perms.map((p) => ({ roleId: role.id, permissionId: p.id })),
        });
      }
      await this.bumpVersion(tx);
      await this.audit(tx, {
        operator: actor.username, action: 'rbac.role.create', entityType: 'admin-role',
        entityId: role.id, after: { code, name: input.name, permissions: input.permissionCodes },
      });
      return role;
    });
    this.cache.clear();
    return created;
  }

  async updateRole(
    actor: { username: string },
    roleId: string,
    input: { name?: string; remark?: string; status?: 'active' | 'disabled'; permissionCodes?: string[] },
  ) {
    const before = await this.db.adminRole.findUnique({
      where: { id: roleId },
      include: { permissions: { include: { permission: true } } },
    });
    if (!before) throw new BadRequestException('角色不存在');
    if (before.builtin)
      throw new ForbiddenException('内置超级管理员不可编辑');
    if (input.permissionCodes)
      for (const c of input.permissionCodes)
        if (!PERMISSION_CODES.has(c)) throw new BadRequestException(`未登记的权限码: ${c}`);
    await this.db.$transaction(async (tx) => {
      await this.lockSuperGuard(tx);
      if (input.status === 'disabled' && before.status === 'active') {
        // 停用角色可能摘掉唯一超管？超管是 builtin 角色，普通角色停用不影响 super 计数；跳过
      }
      await tx.adminRole.update({
        where: { id: roleId },
        data: {
          ...(input.name ? { name: input.name.trim() } : {}),
          ...(input.remark !== undefined ? { remark: input.remark } : {}),
          ...(input.status ? { status: input.status } : {}),
        },
      });
      if (input.permissionCodes) {
        const perms = await tx.adminPermission.findMany({
          where: { code: { in: input.permissionCodes } },
        });
        await tx.adminRolePermission.deleteMany({ where: { roleId } });
        if (perms.length)
          await tx.adminRolePermission.createMany({
            data: perms.map((p) => ({ roleId, permissionId: p.id })),
          });
      }
      await this.bumpVersion(tx);
      await this.audit(tx, {
        operator: actor.username, action: 'rbac.role.update', entityType: 'admin-role',
        entityId: roleId,
        before: {
          name: before.name, status: before.status,
          permissions: before.permissions.map((p) => p.permission.code),
        },
        after: input,
      });
    });
    this.cache.clear();
  }

  async deleteRole(actor: { username: string }, roleId: string) {
    const role = await this.db.adminRole.findUnique({
      where: { id: roleId },
      include: { _count: { select: { accounts: true } } },
    });
    if (!role) throw new BadRequestException('角色不存在');
    if (role.builtin) throw new ForbiddenException('内置超级管理员不可删除');
    if (role._count.accounts > 0)
      throw new BadRequestException(`仍有 ${role._count.accounts} 条账号授权引用该角色，先撤权再删除`);
    await this.db.$transaction(async (tx) => {
      await tx.adminRole.delete({ where: { id: roleId } });
      await this.bumpVersion(tx);
      await this.audit(tx, {
        operator: actor.username, action: 'rbac.role.delete', entityType: 'admin-role',
        entityId: roleId, before: { code: role.code, name: role.name },
      });
    });
    this.cache.clear();
  }

  /** 权限目录（只读） */
  listPermissions() {
    return this.db.adminPermission.findMany({
      orderBy: [{ group: 'asc' }, { sort: 'asc' }],
    });
  }

  /** 授权审计（rbac.* 动作 + 敏感访问） */
  listRbacAudit(page = 1, pageSize = 50) {
    return this.db.auditLog.findMany({
      where: { OR: [{ action: { startsWith: 'rbac.' } }, { entityType: 'sensitive-access' }] },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
  }

  /** 指定账号的有效权限预览（账号管理/审计页用；scope 需为平台或已授权校区） */
  async previewAccount(accountId: string) {
    const account = await this.db.adminAccount.findUnique({ where: { id: accountId } });
    if (!account) throw new BadRequestException('账号不存在');
    const me = await this.buildMeResponse(account);
    return me;
  }
}
