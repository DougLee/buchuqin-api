import { PrismaService } from '../database/prisma.service';
import { BusinessService } from '../business/business.service';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { RbacService } from './rbac/rbac.service';
import { specReq } from './rbac/spec-fixtures';

/**
 * IKKRMZ：有剩余库存禁止切换采购来源（ADR-0001 决策 4，方案 a）。
 *
 * 验收口径：
 * - 有剩余库存（stock>0）时切换 procurementMode → 400，文案带剩余件数并
 *   指路清零路径（盘点/出库）；盘点归零后同一切换放行；
 * - null→值 是历史数据首次认领来源，不是切换，有存量也放行（before 为
 *   null 在专项审计里可区分认领与切换）；
 * - 切换留痕：专项审计 action=product.procurement-switch 落操作人+切换
 *   前后来源（procurementMode）+成本依据（localPurchasePrice/costPrice/
 *   wholesalePrice）与切换时库存，通用 product.update 全行快照并存；
 * - LOCAL 未填进货价仍被既有校验拦（成本口径必须明确，与库存限制正交）。
 *
 * 切换唯一入口=updateProduct（PATCH /admin/products/:id、/price、
 * /admin/platform-products/:id 三个端点同源）；其余写 procurementMode 的
 * 路径均为新建行初始值或 null→HQ 到货认领（restock 验收显式拒 LOCAL 行），
 * 不存在存量切换语义。组织目录行走 supplyMode（与校区行正交，行不记库存）。
 */
describe('IKKRMZ：有剩余库存禁止切换采购来源（ADR-0001 决策 4）', () => {
  const db = new PrismaService();
  const business = new BusinessService(db);
  const service = new AdminService(db, business);
  const rbac = new RbacService(db);
  const controller = new AdminController(service, rbac);
  const ts = String(Date.now());
  const tag = `psw-${ts}`;
  const CAMPUS = `campus-${tag}`;
  const CAT = `cat-${tag}`;
  const OPERATOR = `spec-${tag}`;
  /** 总部供货行，剩余库存 30 件（拦截主用例） */
  const P_STOCKED = `product-stocked-${tag}`;
  /** 零库存总部供货行（清零后可切 + LOCAL 漏价用例） */
  const P_ZERO = `product-zero-${tag}`;
  /** 历史数据行：procurementMode=null 且有库存（认领放行用例） */
  const P_LEGACY = `product-legacy-${tag}`;
  const productIds = [P_STOCKED, P_ZERO, P_LEGACY];

  beforeAll(async () => {
    await db.campus.create({
      data: {
        id: CAMPUS,
        name: '切换采购测试校园',
        shortName: '切换测试',
        warehouseName: '切换采购测试仓',
      } as never,
    });
    await db.category.create({
      data: { id: CAT, campusId: CAMPUS, name: '切换采购测试分类' } as never,
    });
    await db.product.create({
      data: {
        id: P_STOCKED,
        campusId: CAMPUS,
        categoryId: CAT,
        name: '切换测试-有库存行',
        subtitle: '',
        price: 600,
        originalPrice: 650,
        wholesalePrice: 500,
        costPrice: 300,
        procurementMode: 'HQ',
        stock: 30,
        tag: '',
        image: '',
        weight: 0,
      } as never,
    });
    await db.product.create({
      data: {
        id: P_ZERO,
        campusId: CAMPUS,
        categoryId: CAT,
        name: '切换测试-零库存行',
        subtitle: '',
        price: 200,
        originalPrice: 250,
        wholesalePrice: 0,
        costPrice: 0,
        procurementMode: 'HQ',
        stock: 0,
        tag: '',
        image: '',
        weight: 0,
      } as never,
    });
    await db.product.create({
      data: {
        id: P_LEGACY,
        campusId: CAMPUS,
        categoryId: CAT,
        name: '切换测试-历史未认领行',
        subtitle: '',
        price: 300,
        originalPrice: 350,
        procurementMode: null,
        stock: 5,
        tag: '',
        image: '',
        weight: 0,
      } as never,
    });
  });

  afterAll(async () => {
    // 盘点校准产生的 adjust 流水先清（外键引用商品行）
    await db.inventoryTxn.deleteMany({
      where: { productId: { in: productIds } },
    });
    await db.auditLog.deleteMany({
      where: { entityId: { in: productIds } },
    });
    await db.product.deleteMany({ where: { id: { in: productIds } } });
    await db.category.deleteMany({ where: { id: CAT } });
    await db.campus.deleteMany({ where: { id: CAMPUS } });
    await db.$disconnect();
  });

  it('有剩余库存切换 → 400 带剩余件数+清零指引；库存与来源原样不动', async () => {
    await expect(
      service.updateProduct(
        P_STOCKED,
        { procurementMode: 'LOCAL', localPurchasePrice: 120 },
        OPERATOR,
        CAMPUS,
      ),
    ).rejects.toThrow(
      '还有剩余库存 30 件，不能切换采购来源；请先清零库存（盘点/出库）后再切换',
    );
    const row = await db.product.findUniqueOrThrow({
      where: { id: P_STOCKED },
    });
    expect(row.procurementMode).toBe('HQ');
    expect(row.stock).toBe(30);
    // 不落切换专项审计（被拦截的尝试不产生切换流水）
    const trail = await db.auditLog.findFirst({
      where: { entityId: P_STOCKED, action: 'product.procurement-switch' },
    });
    expect(trail).toBeNull();
  });

  it('同一拦截经端点层透传（PATCH /admin/products/:id 本校区视角）', async () => {
    await expect(
      controller.updateProduct(
        specReq('admin'),
        P_STOCKED,
        { procurementMode: 'LOCAL', localPurchasePrice: 120 },
        'campus',
        CAMPUS,
      ),
    ).rejects.toThrow('还有剩余库存 30 件');
  });

  it('盘点归零后可切：HQ→LOCAL 落地新来源与进货价，LOCAL→HQ 反向同放行', async () => {
    // 盘点校准归零（IKD6FJ：提交实际清点数，系统自动算差额落账）
    await service.stocktake(
      { productId: P_STOCKED, countedQty: 0, reason: 'IKKRMZ spec 清零' },
      OPERATOR,
      CAMPUS,
    );
    const zeroed = await db.product.findUniqueOrThrow({
      where: { id: P_STOCKED },
    });
    expect(zeroed.stock).toBe(0);

    const switched = await service.updateProduct(
      P_STOCKED,
      { procurementMode: 'LOCAL', localPurchasePrice: 120 },
      OPERATOR,
      CAMPUS,
    );
    expect(switched.procurementMode).toBe('LOCAL');
    expect(switched.localPurchasePrice).toBe(120);

    // 反向切换同样只看库存（LOCAL→HQ，零库存放行；进货价留档不动）
    const back = await service.updateProduct(
      P_STOCKED,
      { procurementMode: 'HQ' },
      OPERATOR,
      CAMPUS,
    );
    expect(back.procurementMode).toBe('HQ');
  });

  it('切换留痕：product.procurement-switch 落操作人+前后来源+成本依据+库存', async () => {
    const trails = await db.auditLog.findMany({
      where: { entityId: P_STOCKED, action: 'product.procurement-switch' },
      orderBy: { createdAt: 'asc' },
    });
    // 上一用例两次成功切换（HQ→LOCAL→HQ）各留一条
    expect(trails.length).toBe(2);
    expect(trails[0].operator).toBe(OPERATOR);
    expect(trails[0].campusId).toBe(CAMPUS);
    expect(trails[0].before).toMatchObject({
      procurementMode: 'HQ',
      localPurchasePrice: null,
      costPrice: 300,
      wholesalePrice: 500,
      stock: 0,
    });
    expect(trails[0].after).toMatchObject({
      procurementMode: 'LOCAL',
      localPurchasePrice: 120,
      stock: 0,
    });
    expect(trails[1].before).toMatchObject({
      procurementMode: 'LOCAL',
      localPurchasePrice: 120,
    });
    expect(trails[1].after).toMatchObject({ procurementMode: 'HQ' });
    // 通用全行快照审计并存（字段级回查兜底）
    const generic = await db.auditLog.findFirst({
      where: { entityId: P_STOCKED, action: 'product.update' },
    });
    expect(generic).not.toBeNull();
  });

  it('历史数据 null→值 是认领不是切换：有存量放行，审计 before 为 null 可区分', async () => {
    const claimed = await service.updateProduct(
      P_LEGACY,
      { procurementMode: 'HQ' },
      OPERATOR,
      CAMPUS,
    );
    expect(claimed.procurementMode).toBe('HQ');
    expect(claimed.stock).toBe(5);
    const trail = await db.auditLog.findFirst({
      where: { entityId: P_LEGACY, action: 'product.procurement-switch' },
    });
    expect(trail).not.toBeNull();
    expect(trail!.before).toMatchObject({ procurementMode: null, stock: 5 });
    expect(trail!.after).toMatchObject({ procurementMode: 'HQ' });
  });

  it('LOCAL 未填进货价仍被既有校验拦（零库存也不放行）', async () => {
    await expect(
      service.updateProduct(
        P_ZERO,
        { procurementMode: 'LOCAL' },
        OPERATOR,
        CAMPUS,
      ),
    ).rejects.toThrow('本地采购商品必须填写进货价');
    expect(
      (await db.product.findUniqueOrThrow({ where: { id: P_ZERO } }))
        .procurementMode,
    ).toBe('HQ');
  });
});
