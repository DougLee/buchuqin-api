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

/**
 * 平台商品目录（IKKRMW，ADR-0001 决策 3）：
 * - Product.catalogScope 逻辑标记：campus-official 伪校区行='platform'（解绑
 *   过渡标记，物理迁移留 IKKRMX），组织校区行='campus'；现有按 campusId 维度
 *   的查询语义零改动（旧 view=official 路径兼容）；
 * - /admin/platform-products 端点族：原官方库的语义别名（复用官方库 service），
 *   registry 登记「平台商品目录」菜单，平台级能力（PLATFORM_PATTERNS）；
 * - 导入副本保护：副本以 sourceProductId 保留来源；平台行停用/调价不连坐
 *   组织校区已有行（上层永不自动覆盖下层经营字段：售价/库存/状态）。
 */
describe('platform product catalog (IKKRMW / ADR-0001)', () => {
  const db = new PrismaService();
  const business = new BusinessService(db);
  const service = new AdminService(db, business);
  const rbac = new RbacService(db);
  const controller = new AdminController(service, rbac);
  const CAMPUS_A = 'campus-hbut';
  const tag = `platcat-${Date.now()}`;
  const BARCODE_A = `69${String(Date.now()).slice(-10)}1`;
  const BARCODE_B = `69${String(Date.now()).slice(-10)}2`;
  const platformIds: string[] = [];
  const campusRowIds: string[] = [];

  afterAll(async () => {
    await db.auditLog.deleteMany({
      where: { entityId: { in: [...platformIds, ...campusRowIds] } },
    });
    await db.product.deleteMany({
      where: { id: { in: [...platformIds, ...campusRowIds] } },
    });
    await db.$disconnect();
  });

  it('迁移标记：campus-official 行全部 catalogScope=platform，真实校区行=campus', async () => {
    // 存量官方库行（seed 模板+历史建档）全部打平台标记，无漏网
    const strayOfficial = await db.product.findFirst({
      where: { campusId: OFFICIAL_CAMPUS_ID, catalogScope: { not: 'platform' } },
      select: { id: true },
    });
    expect(strayOfficial).toBeNull();
    // 校区行（含各校自建/导入副本）保持缺省 'campus'，零改动
    const strayCampus = await db.product.findFirst({
      where: {
        campusId: { not: OFFICIAL_CAMPUS_ID },
        catalogScope: { not: 'campus' },
      },
      select: { id: true },
    });
    expect(strayCampus).toBeNull();
  });

  it('POST/GET 平台目录端点：建档落 platform 标记；列表只回平台行（分页/关键词/类目）', async () => {
    const created = await controller.createPlatformProduct(specReq('admin'), {
      barcode: BARCODE_A,
      name: `${tag}-平台薯片`,
      categoryId: 'snack',
      price: 500,
      originalPrice: 600,
      stock: 0,
      subtitle: '平台目录测试品',
      tag: '新品',
    });
    const rowA = created.data;
    expect(rowA.campusId).toBe(OFFICIAL_CAMPUS_ID);
    expect(rowA.catalogScope).toBe('platform');
    // IKC1AB：平台目录建档默认「不可售」，核对后放行
    expect(rowA.status).toBe('off-sale');
    platformIds.push(rowA.id);

    const rowB = await service.createProduct(
      {
        barcode: BARCODE_B,
        name: `${tag}-平台饮料`,
        categoryId: 'drink',
        price: 300,
        originalPrice: 300,
        stock: 0,
      },
      'spec-hq',
      OFFICIAL_CAMPUS_ID,
    );
    expect(rowB.catalogScope).toBe('platform');
    platformIds.push(rowB.id);

    // 对照组：校区行不进平台目录
    const campusRow = await db.product.create({
      data: {
        campusId: CAMPUS_A,
        barcode: null,
        name: `${tag}-校区自建对照`,
        categoryId: 'snack',
        subtitle: '',
        price: 100,
        originalPrice: 100,
        stock: 3,
        tag: '',
        image: '',
        weight: 0,
        status: 'on-sale',
      },
    });
    campusRowIds.push(campusRow.id);

    const res = await controller.platformProducts('1', '20', tag);
    const list = res.data as {
      items: Array<{ id: string; campusId: string }>;
      total: number;
    };
    expect(list.total).toBe(2);
    expect(list.items.map((x) => x.id).sort()).toEqual(
      [...platformIds].sort(),
    );
    expect(list.items.every((x) => x.campusId === OFFICIAL_CAMPUS_ID)).toBe(
      true,
    );

    // 类目过滤：只回 drink 行
    const drinks = await controller.platformProducts(
      '1',
      '20',
      tag,
      undefined,
      'drink',
    );
    expect(
      (drinks.data as { items: Array<{ id: string }> }).items.map(
        (x) => x.id,
      ),
    ).toEqual([rowB.id]);
    // 分页包裹：total=过滤后命中数，页大小生效
    const paged = await controller.platformProducts('1', '1', tag);
    expect((paged.data as { total: number }).total).toBe(2);
    expect((paged.data as { items: unknown[] }).items).toHaveLength(1);

    // 旧路径兼容：view=official 数据面（无 catalogScope 过滤）含平台行
    const legacy = (await service.products(OFFICIAL_CAMPUS_ID)) as Array<{
      id: string;
    }>;
    expect(legacy.some((x) => x.id === rowA.id)).toBe(true);
  });

  it('PATCH 平台目录端点：改平台行；校区行按作用域 404；库存字段须盘点权限', async () => {
    const patched = await controller.updatePlatformProduct(
      specReq('admin'),
      platformIds[0],
      { subtitle: '平台目录改', price: 520 },
    );
    expect(patched.data.subtitle).toBe('平台目录改');
    expect(patched.data.price).toBe(520);
    // 校区行不可经平台端点改动（service 按 campusId 过滤，天然隔离）
    await expect(
      controller.updatePlatformProduct(specReq('admin'), campusRowIds[0], {
        subtitle: 'x',
      }),
    ).rejects.toThrow(NotFoundException);
    // 库存字段防御性同构（与旧 PATCH /admin/products/:id 同口径）：
    // 无盘点权限的上下文被拒（财务模板不含 inventory.adjust）
    await expect(
      controller.updatePlatformProduct(specReq('finance'), platformIds[0], {
        stock: 5,
      }),
    ).rejects.toThrow(ForbiddenException);
  });

  it('导入副本：来源保留（sourceProductId）+ 副本=campus 行；伪校区不可作导入目标', async () => {
    await service.updateProduct(
      platformIds[0],
      { status: 'on-sale' },
      'spec-hq',
      OFFICIAL_CAMPUS_ID,
    );
    const result = await service.importProducts(
      [platformIds[0]],
      'spec-importer',
      CAMPUS_A,
    );
    expect(result.importedCount).toBe(1);
    expect(result.skipped).toHaveLength(0);
    const copy = await db.product.findFirstOrThrow({
      where: { sourceProductId: platformIds[0], campusId: CAMPUS_A },
    });
    campusRowIds.push(copy.id);
    // 验收「保留来源」：副本行钉死来源关系；导入初始下架，校区自管
    expect(copy.sourceProductId).toBe(platformIds[0]);
    expect(copy.catalogScope).toBe('campus');
    expect(copy.status).toBe('off-sale');
    // 最小校验：平台目录行是导入「源」不是「目标」
    await expect(
      service.importProducts([platformIds[1]], 'spec-importer', OFFICIAL_CAMPUS_ID),
    ).rejects.toThrow(BadRequestException);
  });

  it('平台行停用不连坐校区副本：状态/售价/库存/存在性不受影响（ADR-0001 决策 3）', async () => {
    // 校区副本先上架备货（校区三权：售价/上下架/库存）
    await db.product.update({
      where: { id: campusRowIds[1] },
      data: { status: 'on-sale', stock: 8, price: 450 },
    });
    // 平台行停用（回收）
    const disabled = await controller.updatePlatformProduct(
      specReq('admin'),
      platformIds[0],
      { status: 'off-sale' },
    );
    expect(disabled.data.status).toBe('off-sale');
    const copy = await db.product.findUniqueOrThrow({
      where: { id: campusRowIds[1] },
    });
    expect(copy.status).toBe('on-sale');
    expect(copy.price).toBe(450);
    expect(copy.stock).toBe(8);
    // 平台行调价也不自动覆盖校区售价（上层只产生「待同步」，永不自动覆盖）
    await controller.updatePlatformProduct(specReq('admin'), platformIds[0], {
      price: 4321,
    });
    const copyAgain = await db.product.findUniqueOrThrow({
      where: { id: campusRowIds[1] },
    });
    expect(copyAgain.price).toBe(450);
    expect(copyAgain.status).toBe('on-sale');
  });

  it('registry/判权：platform-products 菜单登记；平台级能力校区级不可授予', () => {
    const node = MENU_NODES.find((n) => n.code === 'platform-products');
    expect(node).toBeDefined();
    expect(node!.type).toBe(1);
    expect(node!.name).toBe('平台商品目录');
    expect(node!.perms).toEqual(['GET /admin/platform-products']);
    const btn = MENU_NODES.find((n) => n.code === 'platform-products.write');
    expect(btn).toBeDefined();
    expect(btn!.perms).toEqual([
      'POST /admin/platform-products',
      'PATCH /admin/platform-products/:id',
    ]);
    for (const p of [
      'GET /admin/platform-products',
      'POST /admin/platform-products',
      'PATCH /admin/platform-products/:id',
    ])
      expect(PLATFORM_PATTERNS).toContain(p);
    // 超管通配放行
    expect(rbac.allow(legacyRbacCtx('admin'), 'GET', '/admin/platform-products')).toBe(
      true,
    );
    expect(rbac.allow(legacyRbacCtx('admin'), 'POST', '/admin/platform-products')).toBe(
      true,
    );
    // 旧五角色模板未登记该菜单 → 默认拒绝
    for (const role of ['hq', 'operations', 'warehouse', 'finance'])
      expect(
        rbac.allow(legacyRbacCtx(role), 'GET', '/admin/platform-products'),
      ).toBe(false);
    // PLATFORM_PATTERNS 兜底：即便校区级被误授该模式，仍拒；平台级授予放行
    const mixed: RbacContext = {
      accountId: 'spec-mixed',
      username: 'mixed',
      nickname: 'mixed',
      campusId: CAMPUS_A,
      platform: false,
      super: false,
      campuses: [CAMPUS_A],
      patterns: new Set([
        'GET /admin/platform-products',
        'POST /admin/platform-products',
      ]),
      platformPatterns: new Set(),
      menuCodes: new Set(),
    };
    expect(rbac.allow(mixed, 'GET', '/admin/platform-products')).toBe(false);
    expect(rbac.allow(mixed, 'POST', '/admin/platform-products')).toBe(false);
    mixed.platform = true;
    mixed.platformPatterns = new Set(['GET /admin/platform-products']);
    expect(rbac.allow(mixed, 'GET', '/admin/platform-products')).toBe(true);
    expect(rbac.allow(mixed, 'POST', '/admin/platform-products')).toBe(false);
  });
});
