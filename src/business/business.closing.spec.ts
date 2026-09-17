import type { Prisma } from '@prisma/client';
import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { BusinessService } from './business.service';

/**
 * 打烊停单集成测试（IKGI1C）：手动闭店开关/每日打烊窗（跨零点）在
 * 加购（setCartItem/updateCart）与结算链路（checkout → validateQuote）
 * 的服务端硬拦，以及 C 端 campus 出口的 closedNow/closedReason 字段。
 * 独立 fixture，afterAll 清理。
 */
describe('closing hours hard-block (IKGI1C)', () => {
  const db = new PrismaService();
  const service = new BusinessService(db);
  const CAMPUS = 'campus-closing-spec';
  const USER = 'user-closing-spec';
  const CAT = 'cat-closing-spec';
  const SKU = 'sku-closing-spec';
  const ADDR = 'addr-closing-spec';
  const json = (value: unknown) =>
    JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

  /** 北京时间当前 HH:mm → 当日分钟（与 service 判定同口径）。 */
  const beijingMinutes = (now = new Date()): number => {
    const hm = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Shanghai',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(now);
    const [h, m] = hm.split(':').map(Number);
    return (h % 24) * 60 + m;
  };
  /** 分钟 → HH:mm（≥1440 取模，覆盖「次日」窗端点）。 */
  const hhmm = (min: number) =>
    `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(
      min % 60,
    ).padStart(2, '0')}`;
  /** 关窗（closeStart === closeEnd = 不打烊），各用例先归位再自设窗口。 */
  const openAllDay = () =>
    db.campus.update({
      where: { id: CAMPUS },
      data: { closeStart: '00:00', closeEnd: '00:00', manualClosed: false },
    });
  /** 覆盖当前北京时刻的窗（多数情况下为跨零点窗）：start = now+2h，
   *  end = now+1h——除 22:00–23:00 段外恒有 start > end（跨零点分支），
   *  且任意时刻必命中（start < end 时 now 落在 [start, end) 内）。 */
  const windowCoveringNow = () => {
    const m = beijingMinutes();
    return { closeStart: hhmm(m + 120), closeEnd: hhmm(m + 60) };
  };

  beforeAll(async () => {
    await db.campus.create({
      data: {
        id: CAMPUS,
        name: '打烊停单测试校园',
        shortName: '打烊',
        warehouseName: '打烊仓',
        // 初始即关窗，避免默认 22:00–08:00 窗在夜里跑测试时误拦
        closeStart: '00:00',
        closeEnd: '00:00',
      } as any,
    });
    await db.user.create({
      data: {
        id: USER,
        openid: 'openid-closing-spec',
        nickname: '打烊测试用户',
        phone: '13800000021',
        campusId: CAMPUS,
      } as any,
    });
    await db.category.create({
      data: { id: CAT, name: '打烊停单测试分类' } as any,
    });
    await db.product.create({
      data: {
        id: SKU,
        campusId: CAMPUS,
        categoryId: CAT,
        name: '打烊测试可乐',
        subtitle: 'spec',
        price: 2000,
        originalPrice: 2500,
        stock: 50,
        tag: 'spec',
        image: '',
        weight: 0.5,
      } as any,
    });
    await db.address.create({
      data: {
        id: ADDR,
        userId: USER,
        campusId: CAMPUS,
        campusName: '打烊停单测试校园',
        buildingId: 'building-closing-spec',
        buildingName: '测试楼',
        floor: 1,
        room: '101',
        contactName: 'spec',
        phone: '13800000022',
        isDefault: true,
      } as any,
    });
  });

  afterAll(async () => {
    await db.cartItem.deleteMany({ where: { userId: USER } });
    await db.address.deleteMany({ where: { id: ADDR } });
    await db.product.deleteMany({ where: { id: SKU } });
    await db.category.deleteMany({ where: { id: CAT } });
    await db.user.deleteMany({ where: { id: USER } });
    await db.campus.deleteMany({ where: { id: CAMPUS } });
    await db.$disconnect();
  });

  it('manualClosed=true：加购/整单保存/结算全链被拒，文案「商家已休息」', async () => {
    await openAllDay();
    await db.campus.update({
      where: { id: CAMPUS },
      data: { manualClosed: true },
    });
    await expect(service.setCartItem(USER, SKU, 1)).rejects.toThrow(
      new BadRequestException('商家已休息，暂停接单'),
    );
    await expect(
      service.updateCart(USER, {
        items: [{ productId: SKU, quantity: 1 }],
      } as any),
    ).rejects.toThrow('商家已休息，暂停接单');
    // 结算链路（checkout → validateQuote，createOrder 同源）同样拦
    await expect(
      service.checkout(USER, CAMPUS, {
        addressId: ADDR,
        deliveryMode: 'instant',
      } as any),
    ).rejects.toThrow('商家已休息，暂停接单');
    // 判定优先级：手动开关压过时间窗文案
    await db.campus.update({
      where: { id: CAMPUS },
      data: windowCoveringNow(),
    });
    await expect(service.setCartItem(USER, SKU, 1)).rejects.toThrow(
      '商家已休息，暂停接单',
    );
    await db.campus.update({
      where: { id: CAMPUS },
      data: { manualClosed: false },
    });
  });

  it('时间窗命中（跨零点）：加购与结算被拒，文案含恢复时间「恢复接单」', async () => {
    const win = windowCoveringNow();
    await db.campus.update({ where: { id: CAMPUS }, data: win });
    await expect(service.setCartItem(USER, SKU, 1)).rejects.toThrow(
      `已打烊，${win.closeEnd} 恢复接单`,
    );
    await expect(
      service.checkout(USER, CAMPUS, {
        addressId: ADDR,
        deliveryMode: 'instant',
      } as any),
    ).rejects.toThrow('恢复接单');
    await openAllDay();
  });

  it('窗外（closeStart === closeEnd 不打烊）：加购与结算正常放行', async () => {
    await openAllDay();
    await expect(service.setCartItem(USER, SKU, 1)).resolves.toBeTruthy();
    const quote = await service.checkout(USER, CAMPUS, {
      addressId: ADDR,
      deliveryMode: 'instant',
    } as any);
    expect(quote.items).toHaveLength(1);
    await service.setCartItem(USER, SKU, 0); // 清行，不影响后续用例
  });

  it('campus 出口挂 closedNow/closedReason：manual 优先 → window → 未打烊', async () => {
    // 手动开关优先
    await openAllDay();
    await db.campus.update({
      where: { id: CAMPUS },
      data: { manualClosed: true },
    });
    let view = (await service.campus(CAMPUS)) as any;
    expect(view.closedNow).toBe(true);
    expect(view.closedReason).toBe('manual');
    // 时间窗命中
    await db.campus.update({
      where: { id: CAMPUS },
      data: { manualClosed: false, ...windowCoveringNow() },
    });
    view = (await service.campus(CAMPUS)) as any;
    expect(view.closedNow).toBe(true);
    expect(view.closedReason).toBe('window');
    // 未打烊：三原字段 + closedNow/closedReason 形态
    await openAllDay();
    view = (await service.campus(CAMPUS)) as any;
    expect(view.closedNow).toBe(false);
    expect(view.closedReason).toBeNull();
    expect(view.closeStart).toBe('00:00');
    expect(view.closeEnd).toBe('00:00');
    expect(view.manualClosed).toBe(false);
  });
});
