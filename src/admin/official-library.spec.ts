import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { BusinessService } from '../business/business.service';
import { AdminService } from './admin.service';
import { OFFICIAL_CAMPUS_ID } from '../common/campus';

/**
 * 官方商品库 + 校区导入（IKAJSM/IKAJSO，2026-08-24 道哥决策版）：
 * - hq 建档/改档落 campus-official 伪校区；同码可与校区商品并存（条码唯一改校区维度）
 * - 校区 import：官方资料落地，售价起步官方价、初始下架零库存；
 *   重复导入跳过、条码撞本校区自建商品跳过
 * - 官方库改动 → 校区列表亮「上游已更新」→ pull-upstream 只同步资料，
 *   本地售价/上下架/库存不动，拉完角标清零
 * - 禁自建/禁总部导入是 controller 守卫（业务规则），权限矩阵不动，
 *   各自的 ForbiddenException 分支由 hq-multicampus / rbac 套件风格覆盖
 */
describe('official product library & campus import (IKAJSM/IKAJSO)', () => {
  const db = new PrismaService();
  const business = new BusinessService(db);
  const service = new AdminService(db, business);
  const CAMPUS_A = 'campus-hbut';
  const tag = `offlib-${Date.now()}`;
  const officialIds: string[] = [];
  const localIds: string[] = [];
  let CAMPUS_B = '';

  beforeAll(async () => {
    CAMPUS_B = (
      await service.createCampus(
        {
          name: '官方库测试大学',
          shortName: '官方库',
          warehouseName: '官方库测试仓',
        },
        'spec-offlib',
      )
    ).id;
  });

  afterAll(async () => {
    await db.auditLog.deleteMany({
      where: { entityId: { in: [...officialIds, ...localIds, CAMPUS_B] } },
    });
    await db.product.deleteMany({
      where: { id: { in: [...officialIds, ...localIds] } },
    });
    await db.campus.deleteMany({ where: { id: CAMPUS_B } });
    await db.$disconnect();
  });

  it('hq 在官方库建档（campus-official），同码可与校区商品并存', async () => {
    const created = await service.createProduct(
      {
        barcode: '6901234500001',
        name: `${tag}-官方薯片`,
        categoryId: 'snack',
        price: 500,
        originalPrice: 600,
        stock: 0,
        subtitle: '官方库测试品',
        tag: '新品',
      },
      'spec-hq',
      OFFICIAL_CAMPUS_ID,
    );
    officialIds.push(created.id);
    expect(created.campusId).toBe(OFFICIAL_CAMPUS_ID);
    // B 校可同码自建（历史商品）：条码唯一只到校区维度（A 校留给导入测试）
    const local = await db.product.create({
      data: {
        campusId: CAMPUS_B,
        barcode: '6901234500001',
        name: `${tag}-校区同码老品`,
        categoryId: 'snack',
        subtitle: '',
        price: 999,
        originalPrice: 999,
        stock: 5,
        tag: '',
        image: '',
        weight: 0,
        status: 'on-sale',
      },
    });
    localIds.push(local.id);
    // 官方库列表不做售罄映射（库存归校区管）
    const officialList = (await service.products(OFFICIAL_CAMPUS_ID)) as Array<{
      id: string;
      status: string;
      upstreamChanged: boolean;
    }>;
    const row = officialList.find((x) => x.id === created.id);
    expect(row?.status).toBe('on-sale');
    expect(row?.upstreamChanged).toBe(false);
  });

  it('校区导入官方商品：资料落地、下架零库存、重复导入跳过', async () => {
    const result = await service.importProducts(
      officialIds,
      'spec-importer',
      CAMPUS_A,
    );
    expect(result.importedCount).toBe(1);
    expect(result.skipped).toHaveLength(0);
    const local = await db.product.findFirst({
      where: { sourceProductId: officialIds[0], campusId: CAMPUS_A },
    });
    expect(local).toBeTruthy();
    localIds.push(local!.id);
    expect(local!.name).toContain('官方薯片');
    expect(local!.price).toBe(500);
    expect(local!.stock).toBe(0);
    expect(local!.status).toBe('off-sale');
    expect(local!.sourceSyncedAt).toBeTruthy();
    // 再导一次：幂等跳过
    const again = await service.importProducts(
      officialIds,
      'spec-importer',
      CAMPUS_A,
    );
    expect(again.importedCount).toBe(0);
    expect(again.skipped[0]?.reason).toContain('已导入过');
    // 官方库中不存在的 id：说明原因
    const ghost = await service.importProducts(
      ['not-exists-id'],
      'spec-importer',
      CAMPUS_A,
    );
    expect(ghost.importedCount).toBe(0);
    expect(ghost.skipped[0]?.reason).toContain('不存在');
  });

  it('官方库改动亮「上游已更新」；pull-upstream 同步资料不动本地三权', async () => {
    // 上游改名改划线价（updatedAt 自动前移）
    await service.updateProduct(
      officialIds[0],
      { name: `${tag}-官方薯片改`, originalPrice: 800, subtitle: '上游改版' },
      'spec-hq',
      OFFICIAL_CAMPUS_ID,
    );
    const localId = localIds[1];
    const list = (await service.products(CAMPUS_A)) as Array<{
      id: string;
      name: string;
      upstreamChanged: boolean;
    }>;
    const row = list.find((x) => x.id === localId);
    expect(row?.upstreamChanged).toBe(true);
    // 本地先行改价/上架/备货（校区三权：售价/上下架/库存）
    await db.product.update({
      where: { id: localId },
      data: { price: 350, status: 'on-sale', stock: 8 },
    });
    const pulled = await service.pullUpstream(
      localId,
      'spec-importer',
      CAMPUS_A,
    );
    expect(pulled.name).toContain('官方薯片改');
    expect(pulled.originalPrice).toBe(800);
    expect(pulled.price).toBe(350);
    expect(pulled.status).toBe('on-sale');
    expect(pulled.stock).toBe(8);
    // 角标清零
    const after = (await service.products(CAMPUS_A)) as Array<{
      id: string;
      upstreamChanged: boolean;
    }>;
    expect(after.find((x) => x.id === localId)?.upstreamChanged).toBe(false);
    // 自建商品无来源，拒绝拉取（老品在 B 校）
    await expect(
      service.pullUpstream(localIds[0], 'spec-importer', CAMPUS_B),
    ).rejects.toThrow('自建商品无官方库来源');
  });

  it('条码撞本校区自建商品：导入跳过并说明原因', async () => {
    const created = await service.createProduct(
      {
        barcode: '6901234500002',
        name: `${tag}-官方饮料`,
        categoryId: 'snack',
        price: 300,
        originalPrice: 300,
        stock: 0,
      },
      'spec-hq',
      OFFICIAL_CAMPUS_ID,
    );
    officialIds.push(created.id);
    // 同校区已有同码自建商品
    const local = await db.product.create({
      data: {
        campusId: CAMPUS_A,
        barcode: '6901234500002',
        name: `${tag}-校区自建饮料`,
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
    localIds.push(local.id);
    const result = await service.importProducts(
      [created.id],
      'spec-importer',
      CAMPUS_A,
    );
    expect(result.importedCount).toBe(0);
    expect(result.skipped[0]?.reason).toContain('冲突');
  });

  it('条码查询：本校区优先，未录入时命中官方库（IKAJSO 导入入口）', async () => {
    const hit = (await service.lookupBarcode(
      '6901234500001',
      CAMPUS_A,
    )) as { found: boolean; source: string; product: { name: string } };
    expect(hit.found).toBe(true);
    expect(hit.source).toBe('product-database');
    // B 校无 ...0002（官方饮料只有官方库行 + A 校自建）→ 命中官方库
    const fromOfficial = (await service.lookupBarcode(
      '6901234500002',
      CAMPUS_B,
    )) as { found: boolean; source: string; product: { name: string } };
    expect(fromOfficial.source).toBe('official-library');
    // 未知条码：回落公共条码库/人工录入，found=false
    const manual = (await service.lookupBarcode(
      '6901234599999',
      CAMPUS_B,
    )) as { found: boolean; source: string };
    expect(manual.found).toBe(false);
    expect(manual.source).toBe('manual');
  });

  it('校区隔离不变：官方库行不进任一校区商品列表与用户端', async () => {
    const listA = (await service.products(CAMPUS_A)) as Array<{
      id: string;
      campusId: string;
    }>;
    expect(listA.every((x) => x.campusId === CAMPUS_A)).toBe(true);
    const listB = (await service.products(CAMPUS_B)) as Array<{
      id: string;
      campusId: string;
    }>;
    expect(listB.every((x) => x.campusId === CAMPUS_B)).toBe(true);
    // 用户端首页商品流不含官方库行（hotProducts 按 campusId 过滤，结构性隔离）
    const home = (await business.home(CAMPUS_B)) as {
      hotProducts: Array<{ id: string }>;
    };
    expect(
      home.hotProducts.every((x) => !officialIds.includes(x.id)),
    ).toBe(true);
  });

  it('官方库行不可被当校区改档：updateProduct 按校区过滤天然隔离', async () => {
    await expect(
      service.updateProduct(
        officialIds[0],
        { price: 1 },
        'spec-campus-admin',
        CAMPUS_A,
      ),
    ).rejects.toThrow('商品不存在');
    // hq（official 视角）可正常改官方库行
    const updated = await service.updateProduct(
      officialIds[0],
      { price: 520 },
      'spec-hq',
      OFFICIAL_CAMPUS_ID,
    );
    expect(updated.price).toBe(520);
    // 官方库重复条码建档仍被拒（同库内去重）
    await expect(
      service.createProduct(
        {
          barcode: '6901234500001',
          name: `${tag}-官方重复`,
          categoryId: 'snack',
          price: 100,
          originalPrice: 100,
          stock: 0,
        },
        'spec-hq',
        OFFICIAL_CAMPUS_ID,
      ),
    ).rejects.toThrow('该条码已录入商品库');
  });
});
