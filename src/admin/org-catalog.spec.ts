import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { BusinessService } from '../business/business.service';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { RbacService } from './rbac/rbac.service';
import type { RbacContext } from './rbac/rbac.service';
import { MENU_NODES } from './rbac/registry';
import { PLATFORM_PATTERNS } from './rbac/access-policy';
import { legacyRbacCtx, specReq } from './rbac/spec-fixtures';
import { OFFICIAL_CAMPUS_ID } from '../common/campus';
import type { AuthRequest } from '../auth/jwt-auth.guard';

/**
 * 组织商品目录（IKKRMX，ADR-0001 决策 4）：
 * - 组织目录行=organizationId 非空且 catalogScope='org' 的 Product 行（复用
 *   校区模型不建新表——行物理上仍落 campus-official 伪校区，平台/官方库视角
 *   查询一律 organizationId IS NULL 排除，存量官方库导入链路零改动）；
 * - /admin/org-products 端点族：组织目录 CRUD（组织供货价=price、组织进货价
 *   =costPrice、采购来源=supplyMode）+ 组织目录→组织内校区导入（副本行
 *   orgCatalogId 指回组织目录行，三层来源链 platform←org←campus）；
 * - 数据边界：平台账号 ?organizationId 必填 / 组织级账号恒本组织（显式传参
 *   越组织 403）/ 校区级 403；行级隔离越组织 404。
 * 双组织 fixture：org-a（存量基线，campus-hbut 归属）vs 组织 B（本 spec 自建）。
 */
describe('org product catalog (IKKRMX / ADR-0001)', () => {
  const db = new PrismaService();
  const business = new BusinessService(db);
  const service = new AdminService(db, business);
  const rbac = new RbacService(db);
  const controller = new AdminController(service, rbac);
  const ts = String(Date.now());
  const ORG_A = 'org-a';
  const ORG_B = `orgspecx${ts}`;
  const CAMPUS_B = `campus-spec-x1-${ts}`;
  const CAMPUS_A = 'campus-hbut';
  const tag = `orgcat-${ts}`;
  const BARCODE_A = `86${String(Date.now()).slice(-10)}1`;
  const BARCODE_B = `86${String(Date.now()).slice(-10)}2`;
  const orgRowIds: string[] = [];
  const campusCopyIds: string[] = [];

  /** 组织级账号请求夹具（org-b 固定组织，落点 CAMPUS_B） */
  const orgBReq = (query: Record<string, string> = {}): AuthRequest =>
    ({
      rbac: {
        accountId: `spec-orgb-${ts}`,
        username: 'orgb',
        nickname: '组织B管理员',
        campusId: CAMPUS_B,
        platform: false,
        super: false,
        campuses: [CAMPUS_B],
        patterns: new Set<string>(),
        platformPatterns: new Set<string>(),
        menuCodes: new Set(['org-products']),
        orgLevel: 'org',
        organizationId: ORG_B,
      } satisfies RbacContext,
      query,
      user: { id: `spec-orgb-${ts}`, campusId: CAMPUS_B },
    }) as unknown as AuthRequest;

  beforeAll(async () => {
    await db.organization.create({
      data: { id: ORG_B, name: '目录测试组织B', shortName: 'B' },
    });
    await db.campus.create({
      data: {
        id: CAMPUS_B,
        name: '目录测试大学一号',
        shortName: '目录测试',
        warehouseName: '目录测试大学一号仓',
        organizationId: ORG_B,
      },
    });
  });

  afterAll(async () => {
    // 校区副本按 orgCatalogId 归集（含幂等跳过的既有行），组织行按 id 删
    const copies = await db.product.findMany({
      where: { orgCatalogId: { in: orgRowIds } },
      select: { id: true },
    });
    await db.auditLog.deleteMany({
      where: {
        entityId: { in: [...orgRowIds, ...copies.map((c) => c.id)] },
      },
    });
    await db.product.deleteMany({
      where: { id: { in: [...orgRowIds, ...copies.map((c) => c.id)] } },
    });
    await db.campus.deleteMany({ where: { id: CAMPUS_B } });
    await db.organization.deleteMany({ where: { id: ORG_B } });
    await db.$disconnect();
  });

  /* ==================== 建档：组织目录行口径 + supplyMode 校验 ==================== */

  it('POST 组织目录建档（平台账号代组织 A）：org 行口径+默认平台供货+默认不可售', async () => {
    const created = await controller.createOrgProduct(
      specReq('admin'),
      {
        barcode: BARCODE_A,
        name: `${tag}-组织A薯片`,
        categoryId: 'snack',
        price: 420,
        originalPrice: 500,
        stock: 0,
        subtitle: '组织目录测试品',
        tag: '新品',
      },
      ORG_A,
    );
    const row = created.data;
    // 复用校区模型不建新表：行落伪校区，归属按 organizationId+catalogScope 圈定
    expect(row.campusId).toBe(OFFICIAL_CAMPUS_ID);
    expect(row.catalogScope).toBe('org');
    expect(row.organizationId).toBe(ORG_A);
    // 组织层经营字段：组织供货价=price；采购来源缺省=平台供货
    expect(row.price).toBe(420);
    expect(row.supplyMode).toBe('platform');
    // IKC1AB 同口径：目录行默认不可售，核对放行后才能导入校区
    expect(row.status).toBe('off-sale');
    expect(row.stock).toBe(0);
    orgRowIds.push(row.id);

    // 自主采购缺组织进货价 → 拒（成本口径必须明确）
    await expect(
      controller.createOrgProduct(
        specReq('admin'),
        {
          name: `${tag}-无进货价`,
          categoryId: 'snack',
          price: 100,
          stock: 0,
          supplyMode: 'local',
        },
        ORG_A,
      ),
    ).rejects.toThrow('自主采购商品必须填写组织进货价');

    // 自主采购带进货价 → 落 local + 组织进货价
    const local = await controller.createOrgProduct(
      specReq('admin'),
      {
        barcode: BARCODE_B,
        name: `${tag}-组织A自采饮料`,
        categoryId: 'drink',
        price: 260,
        stock: 0,
        supplyMode: 'local',
        costPrice: 200,
      },
      ORG_A,
    );
    expect(local.data.supplyMode).toBe('local');
    expect(local.data.costPrice).toBe(200);
    orgRowIds.push(local.data.id);
  });

  it('组织 B 建档（组织级账号免传 organizationId=本组织）', async () => {
    const row = await controller.createOrgProduct(orgBReq(), {
      name: `${tag}-组织B零食`,
      categoryId: 'snack',
      price: 300,
      stock: 0,
    });
    expect(row.data.organizationId).toBe(ORG_B);
    expect(row.data.catalogScope).toBe('org');
    orgRowIds.push(row.data.id);
  });

  /* ==================== 数据边界：组织 B 隔离 ==================== */

  it('GET 列表：组织 A/组织 B 互不可见；组织级显式传参越组织 403', async () => {
    const listA = await controller.orgProducts(
      specReq('admin'),
      '1',
      '20',
      tag,
      undefined,
      undefined,
      ORG_A,
    );
    const itemsA = (
      listA.data as { items: Array<{ id: string; organizationId: string }> }
    ).items;
    expect(itemsA.length).toBe(2);
    expect(itemsA.every((x) => x.organizationId === ORG_A)).toBe(true);

    // 组织级账号免传=本组织：只见组织 B 行
    const listB = await controller.orgProducts(orgBReq(), '1', '20', tag);
    const itemsB = (listB.data as { items: Array<{ id: string }> }).items;
    expect(itemsB.map((x) => x.id)).toEqual([orgRowIds[2]]);

    // 组织级显式传别人的组织 → 403（防串目录）
    await expect(
      controller.orgProducts(
        orgBReq({ organizationId: ORG_A }),
        '1',
        '20',
        tag,
      ),
    ).rejects.toThrow(ForbiddenException);

    // 校区级账号：403（组织目录非校区能力）
    await expect(
      controller.orgProducts(specReq('operations'), '1', '20', tag),
    ).rejects.toThrow(ForbiddenException);

    // 平台账号缺 ?organizationId → 400；组织不存在 → 400
    await expect(
      controller.orgProducts(specReq('admin'), '1', '20', tag),
    ).rejects.toThrow(BadRequestException);
    await expect(
      controller.orgProducts(
        specReq('admin'),
        '1',
        '20',
        tag,
        undefined,
        undefined,
        `org-x-${ts}`,
      ),
    ).rejects.toThrow('组织不存在');
  });

  it('PATCH：改组织供货价/放行；切自主采购须带进货价；越组织行 404', async () => {
    const patched = await controller.updateOrgProduct(
      specReq('admin'),
      orgRowIds[0],
      { price: 450, subtitle: '组织目录改' },
      ORG_A,
    );
    expect(patched.data.price).toBe(450);
    expect(patched.data.subtitle).toBe('组织目录改');

    // 切换采购来源为自主采购，未带组织进货价 → 拒
    await expect(
      controller.updateOrgProduct(
        specReq('admin'),
        orgRowIds[0],
        { supplyMode: 'local' },
        ORG_A,
      ),
    ).rejects.toThrow('自主采购商品必须填写组织进货价');
    const switched = await controller.updateOrgProduct(
      specReq('admin'),
      orgRowIds[0],
      { supplyMode: 'local', costPrice: 380 },
      ORG_A,
    );
    expect(switched.data.supplyMode).toBe('local');
    expect(switched.data.costPrice).toBe(380);

    // 放行（导入前置）
    const onSale = await controller.updateOrgProduct(
      specReq('admin'),
      orgRowIds[0],
      { status: 'on-sale' },
      ORG_A,
    );
    expect(onSale.data.status).toBe('on-sale');

    // 组织 B 账号 PATCH 组织 A 的行 → 404（行级隔离，不泄露存在性）
    await expect(
      controller.updateOrgProduct(orgBReq(), orgRowIds[0], { price: 1 }),
    ).rejects.toThrow(NotFoundException);

    // 组织目录行不维护库存（防御性同构）
    await expect(
      controller.updateOrgProduct(
        specReq('admin'),
        orgRowIds[0],
        { stock: 5 },
        ORG_A,
      ),
    ).rejects.toThrow('组织目录行不维护库存');
  });

  /* ==================== 导入：orgCatalogId 来源链 + 校区自管 ==================== */

  it('导入组织目录→组织内校区：副本 orgCatalogId 指回+校区行口径+初始下架零库存', async () => {
    const result = await controller.importOrgProduct(
      specReq('admin'),
      orgRowIds[0],
      { campusId: CAMPUS_A },
      ORG_A,
    );
    expect(result.data.imported).toBe(true);
    expect(result.data.campusProductId).toBeTruthy();
    const copy = await db.product.findUniqueOrThrow({
      where: { id: result.data.campusProductId as string },
    });
    campusCopyIds.push(copy.id);
    // 三层来源链 platform←org←campus：副本指回组织目录行；无平台直连
    expect(copy.campusId).toBe(CAMPUS_A);
    expect(copy.orgCatalogId).toBe(orgRowIds[0]);
    expect(copy.catalogScope).toBe('campus');
    expect(copy.organizationId).toBeNull();
    expect(copy.sourceProductId).toBeNull();
    // 校区三权自管：导入初始下架+零库存；售价起步=组织供货价（可改）
    expect(copy.status).toBe('off-sale');
    expect(copy.stock).toBe(0);
    expect(copy.price).toBe(450);
    // 校区从组织获得供货（非校区自主采购）
    expect(copy.procurementMode).toBe('HQ');

    // 幂等：同 orgCatalogId 重复导入跳过
    const again = await controller.importOrgProduct(
      specReq('admin'),
      orgRowIds[0],
      { campusId: CAMPUS_A },
      ORG_A,
    );
    expect(again.data.imported).toBe(false);
    expect(again.data.reason).toContain('已导入过');

    // 越组织校区导入 → 403（组织 A 的目录不可导入组织 B 的校区）
    await expect(
      controller.importOrgProduct(
        specReq('admin'),
        orgRowIds[0],
        { campusId: CAMPUS_B },
        ORG_A,
      ),
    ).rejects.toThrow(ForbiddenException);
    // 未放行的组织行不可导入（IKC1AB 双保险同口径）
    await expect(
      controller.importOrgProduct(
        specReq('admin'),
        orgRowIds[1],
        { campusId: CAMPUS_A },
        ORG_A,
      ),
    ).rejects.toThrow('仅放行');
    // 组织 B 账号导入组织 A 的行 → 404（行级隔离）
    await expect(
      controller.importOrgProduct(orgBReq(), orgRowIds[0], {
        campusId: CAMPUS_B,
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('组织行停用不连坐校区副本：副本售价/状态/库存不受影响', async () => {
    await db.product.update({
      where: { id: campusCopyIds[0] },
      data: { status: 'on-sale', stock: 6, price: 480 },
    });
    await controller.updateOrgProduct(
      specReq('admin'),
      orgRowIds[0],
      { status: 'off-sale', price: 999 },
      ORG_A,
    );
    const copy = await db.product.findUniqueOrThrow({
      where: { id: campusCopyIds[0] },
    });
    expect(copy.status).toBe('on-sale');
    expect(copy.price).toBe(480);
    expect(copy.stock).toBe(6);
  });

  /* ==================== 平台视角隔离：伪校区上的组织行不泄漏 ==================== */

  it('平台/官方库视角查询排除组织目录行（legacy view=official / platform-products / PATCH / 订货池）', async () => {
    // 旧官方库视图（无 catalogScope 过滤的 products()）不含组织行
    const legacy = (await service.products(OFFICIAL_CAMPUS_ID)) as Array<{
      id: string;
    }>;
    expect(legacy.some((x) => orgRowIds.includes(x.id))).toBe(false);
    // 平台目录端点数据面同样不含
    const platform = await service.platformProducts();
    expect(platform.some((x) => orgRowIds.includes(x.id))).toBe(false);
    // 平台端点 PATCH 组织行 → 404（越层保护）
    await expect(
      service.updateProduct(
        orgRowIds[0],
        { subtitle: 'x' },
        'spec-hq',
        OFFICIAL_CAMPUS_ID,
      ),
    ).rejects.toThrow(NotFoundException);
    // 存量回归锚点：真实校区行/平台行不受组织行影响（catalogScope 口径不变）
    const stray = await db.product.findFirst({
      where: { organizationId: { not: null }, catalogScope: { not: 'org' } },
      select: { id: true },
    });
    expect(stray).toBeNull();
  });

  /* ==================== registry / 判权 ==================== */

  it('registry 登记「组织商品」菜单；PLATFORM_PATTERNS 收口校区级授予', () => {
    const node = MENU_NODES.find((n) => n.code === 'org-products');
    expect(node).toBeDefined();
    expect(node!.type).toBe(1);
    expect(node!.name).toBe('组织商品');
    expect(node!.perms).toEqual(['GET /admin/org-products']);
    const btn = MENU_NODES.find((n) => n.code === 'org-products.write');
    expect(btn).toBeDefined();
    expect(btn!.perms).toEqual([
      'POST /admin/org-products',
      'PATCH /admin/org-products/:id',
      'POST /admin/org-products/:id/import',
    ]);
    for (const p of [
      'GET /admin/org-products',
      'POST /admin/org-products',
      'PATCH /admin/org-products/:id',
      'POST /admin/org-products/:id/import',
    ])
      expect(PLATFORM_PATTERNS).toContain(p);
    // 超管通配放行
    for (const [m, p] of [
      ['GET', '/admin/org-products'],
      ['POST', '/admin/org-products'],
      ['PATCH', '/admin/org-products/p1'],
      ['POST', '/admin/org-products/p1/import'],
    ] as const)
      expect(rbac.allow(legacyRbacCtx('admin'), m, p)).toBe(true);
    // 校区级授权集（非平台级授予）即便误授该模式也拒（PLATFORM_PATTERNS 兜底）
    const campusGrant: RbacContext = {
      accountId: 'spec-campus-grant',
      username: 'campus',
      nickname: 'campus',
      campusId: CAMPUS_A,
      platform: false,
      super: false,
      campuses: [CAMPUS_A],
      patterns: new Set([
        'GET /admin/org-products',
        'POST /admin/org-products',
      ]),
      platformPatterns: new Set(),
      menuCodes: new Set(),
    };
    expect(rbac.allow(campusGrant, 'GET', '/admin/org-products')).toBe(false);
    expect(rbac.allow(campusGrant, 'POST', '/admin/org-products')).toBe(false);
    // 平台级授予（org-admin 预设按平台 scope 授予的口径）放行
    const platformGrant: RbacContext = {
      ...campusGrant,
      patterns: new Set(['GET /admin/org-products']),
      platformPatterns: new Set(['GET /admin/org-products']),
    };
    expect(rbac.allow(platformGrant, 'GET', '/admin/org-products')).toBe(true);
    expect(rbac.allow(platformGrant, 'POST', '/admin/org-products')).toBe(
      false,
    );
    // 旧五角色模板未登记该菜单 → 默认拒绝
    for (const role of ['hq', 'operations', 'warehouse', 'finance'])
      expect(
        rbac.allow(legacyRbacCtx(role), 'GET', '/admin/org-products'),
      ).toBe(false);
  });
});
