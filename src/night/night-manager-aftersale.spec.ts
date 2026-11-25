import 'reflect-metadata';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { NightOrderService } from './night-order.service';
import type { PrismaService } from '../database/prisma.service';
import type { PaymentsService } from '../payments/payments.service';

/** 楼长售后处理（IKXW9K）：列表/同意/拒绝/转交/超时升级 + 申请推送触发。 */

const MANAGER = 'mgr-1';
const INTERN = 'mgr-intern';
const STORE_ID = 'store-1';
const ORDER_ID = 'no-1';
const AFTER_SALE_ENTRY = {
  key: 'after-sale',
  title: '用户申请售后',
  description: '商品破损：薯片压碎了',
  images: ['https://x/1.jpg'],
  productIds: ['p1'],
  requestedAmount: 1099,
  requestedItems: [{ productId: 'p1', name: '薯片', quantity: 1 }],
  time: '2026-11-24T12:00:00.000Z',
};

const makeDb = (over: Record<string, unknown> = {}) => {
  const staffRow = (id: string) =>
    id === INTERN
      ? { id, role: 'intern-building-manager', status: 'online' }
      : { id, role: 'building-manager', status: 'online' };
  const db: Record<string, unknown> = {
    staff: {
      findUnique: jest.fn().mockImplementation(({ where }) =>
        Promise.resolve(
          where.id === MANAGER || where.id === INTERN
            ? staffRow(where.id)
            : where.id === 'mgr-gone'
              ? { id: 'mgr-gone', role: 'building-manager', status: 'deleted' }
              : null,
        ),
      ),
      findMany: jest.fn().mockResolvedValue([]),
    },
    adminAccount: { findMany: jest.fn().mockResolvedValue([]) },
    nightStore: {
      findFirst: jest.fn().mockResolvedValue({ id: STORE_ID, campusId: 'campus-1', managerStaffId: MANAGER }),
      findUnique: jest.fn().mockResolvedValue({ id: STORE_ID, campusId: 'campus-1', managerStaffId: MANAGER }),
    },
    nightOrder: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue({
        id: ORDER_ID, storeId: STORE_ID, afterSaleStatus: 'requested',
        timeline: [AFTER_SALE_ENTRY],
      }),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(2),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
    },
    $queryRaw: jest.fn().mockResolvedValue([{ id: STORE_ID }]),
    ...over,
  };
  db.$transaction = jest.fn().mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(db));
  return db as unknown as PrismaService;
};

const makeService = (db: PrismaService) =>
  new NightOrderService(db, {
    applyWechatRefund: jest.fn(),
    registerNightPaymentHandler: jest.fn(),
  } as unknown as PaymentsService);

describe('楼长售后处理（IKXW9K）', () => {
  describe('角色与归属门槛', () => {
    it('实习楼长同意/拒绝均被拒（仅可转交）', async () => {
      const svc = makeService(makeDb());
      await expect(svc.managerApproveAfterSale(INTERN, ORDER_ID)).rejects.toThrow(ForbiddenException);
      await expect(svc.managerRejectAfterSale(INTERN, ORDER_ID, '理由')).rejects.toThrow(ForbiddenException);
    });

    it('已删除员工被拒', async () => {
      const svc = makeService(makeDb());
      await expect(svc.managerApproveAfterSale('mgr-gone', ORDER_ID)).rejects.toThrow(ForbiddenException);
    });

    it('非本店订单 404', async () => {
      const db = makeDb();
      (db.nightOrder.findUnique as jest.Mock).mockResolvedValue({ storeId: 'other-store', afterSaleStatus: 'requested', timeline: [] });
      const svc = makeService(db);
      await expect(svc.managerApproveAfterSale(MANAGER, ORDER_ID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('managerApproveAfterSale', () => {
    it('走退款机：kind=admin / restock=false / 金额取自申请负载 / 操作人=楼长', async () => {
      const db = makeDb();
      const svc = makeService(db);
      const request = jest.fn().mockResolvedValue({ totalAmount: 1099, status: 'processing' });
      (svc as unknown as { refunds: { request: jest.Mock } }).refunds = { request };
      const res = await svc.managerApproveAfterSale(MANAGER, ORDER_ID);
      expect(request).toHaveBeenCalledWith(ORDER_ID, {
        kind: 'admin',
        operatorId: MANAGER,
        productAmount: 1099,
        restock: false,
        reason: '楼长同意售后退款',
      });
      expect(res).toMatchObject({ id: ORDER_ID, afterSaleStatus: 'refund-processing' });
    });

    it('状态已变化（非 requested）拒绝重复同意', async () => {
      const db = makeDb();
      (db.nightOrder.findUnique as jest.Mock).mockResolvedValue({ storeId: STORE_ID, afterSaleStatus: 'refund-processing', timeline: [] });
      const svc = makeService(db);
      await expect(svc.managerApproveAfterSale(MANAGER, ORDER_ID)).rejects.toThrow(BadRequestException);
    });

    it('同步退款成功返回 resolved，同步退款失败抛出 BadRequestException', async () => {
      const db = makeDb();
      const svc = makeService(db);
      (svc as unknown as { refunds: { request: jest.Mock } }).refunds = {
        request: jest.fn().mockResolvedValue({ totalAmount: 1099, status: 'succeeded' }),
      };
      const okRes = await svc.managerApproveAfterSale(MANAGER, ORDER_ID);
      expect(okRes).toMatchObject({ id: ORDER_ID, afterSaleStatus: 'resolved' });

      (svc as unknown as { refunds: { request: jest.Mock } }).refunds = {
        request: jest.fn().mockResolvedValue({ totalAmount: 1099, status: 'failed', errorMessage: '微信余额不足' }),
      };
      await expect(svc.managerApproveAfterSale(MANAGER, ORDER_ID)).rejects.toThrow('微信余额不足');
    });
  });

  describe('managerRejectAfterSale', () => {
    it('复用后台驳回逻辑（operatorId=楼长）', async () => {
      const db = makeDb();
      const svc = makeService(db);
      const reject = jest.spyOn(svc as unknown as { rejectAfterSale: jest.Mock }, 'rejectAfterSale').mockResolvedValue({});
      const res = await svc.managerRejectAfterSale(MANAGER, ORDER_ID, '商品已核对无破损');
      expect(reject).toHaveBeenCalledWith(MANAGER, ORDER_ID, '商品已核对无破损');
      expect(res).toEqual({ id: ORDER_ID, afterSaleStatus: 'rejected' });
    });
  });

  describe('managerEscalateAfterSale', () => {
    it('转交：timeline 打标 + 审计留痕，状态不变', async () => {
      const db = makeDb();
      const svc = makeService(db);
      const res = await svc.managerEscalateAfterSale(INTERN, ORDER_ID);
      expect(res).toEqual({ id: ORDER_ID, escalated: true });
      const arg = (db.nightOrder.update as jest.Mock).mock.calls[0][0];
      expect(arg.data.timeline.at(-1).key).toBe('after-sale-escalated');
      expect(arg.data.afterSaleStatus).toBeUndefined();
      expect(db.auditLog.create).toHaveBeenCalled();
    });

    it('已转交过：幂等返回，不重复打标', async () => {
      const db = makeDb();
      (db.nightOrder.findUnique as jest.Mock).mockResolvedValue({
        storeId: STORE_ID, afterSaleStatus: 'requested',
        timeline: [AFTER_SALE_ENTRY, { key: 'after-sale-escalated', title: '已转交平台处理', time: '2026-11-24T13:00:00Z' }],
      });
      const svc = makeService(db);
      const res = await svc.managerEscalateAfterSale(INTERN, ORDER_ID);
      expect(res).toEqual({ id: ORDER_ID, escalated: true });
      expect(db.nightOrder.update).not.toHaveBeenCalled();
    });
  });

  describe('managerAfterSales 列表', () => {
    it('pending 查 requested、handled 查终态+有退款', async () => {
      const db = makeDb();
      const svc = makeService(db);
      await svc.managerAfterSales(MANAGER, 'pending');
      expect(db.nightOrder.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { storeId: STORE_ID, afterSaleStatus: 'requested' },
      }));
      await svc.managerAfterSales(MANAGER, 'handled');
      expect(db.nightOrder.findMany).toHaveBeenLastCalledWith(expect.objectContaining({
        where: {
          storeId: STORE_ID,
          OR: [{ afterSaleStatus: { in: ['resolved', 'rejected', 'withdrawn'] } }, { refund: { isNot: null } }],
        },
      }));
    });

    it('列表项负载拆解：类型/描述分离、金额与图片透出；整单无 requestedAmount 时回退实付商品额并透出 escalated', async () => {
      const db = makeDb();
      (db.nightOrder.findMany as jest.Mock).mockResolvedValue([
        {
          id: ORDER_ID, orderNo: 'NX001', productAmount: 2099, couponDiscount: 0, payableAmount: 2099, status: 'completed',
          statusText: '已完成', afterSaleStatus: 'requested', createdAt: '2026-11-24T10:00:00Z',
          address: { contactName: '小明', buildingName: '学子楼', room: '302' },
          timeline: [AFTER_SALE_ENTRY],
          refund: null,
        },
        {
          id: 'no-2', orderNo: 'NX002', productAmount: 1800, couponDiscount: 300, payableAmount: 1500, status: 'completed',
          statusText: '已完成', afterSaleStatus: 'requested', createdAt: '2026-11-24T11:00:00Z',
          address: { contactName: '小红', buildingName: '学子楼', room: '405' },
          timeline: [
            { key: 'after-sale', title: '用户申请售后', description: '缺货：没收到', time: '2026-11-24T12:00:00.000Z' },
            { key: 'after-sale-escalated', title: '已转交平台处理', time: '2026-11-24T13:00:00.000Z' },
          ],
          refund: null,
        },
      ]);
      const svc = makeService(db);
      const items = await svc.managerAfterSales(MANAGER, 'pending');
      expect(items[0]).toMatchObject({
        orderNo: 'NX001',
        type: '商品破损',
        description: '薯片压碎了',
        images: ['https://x/1.jpg'],
        requestedAmount: 1099,
        escalated: false,
        contactName: '小明',
      });
      expect(items[1]).toMatchObject({
        orderNo: 'NX002',
        requestedAmount: 1500,
        escalated: true,
      });
    });
  });

  describe('escalateOverdueAfterSales 超时升级', () => {
    it('仅升级超 24h 且未打标的单', async () => {
      const db = makeDb();
      const old = Date.now() - 25 * 60 * 60 * 1000;
      const recent = Date.now() - 2 * 60 * 60 * 1000;
      const oldTimeline = [{ ...AFTER_SALE_ENTRY, time: new Date(old).toISOString() }];
      (db.nightOrder.findMany as jest.Mock).mockResolvedValue([
        { id: 'old-1', storeId: STORE_ID, timeline: oldTimeline },
        { id: 'recent-1', storeId: STORE_ID, timeline: [{ ...AFTER_SALE_ENTRY, time: new Date(recent).toISOString() }] },
        { id: 'marked-1', storeId: STORE_ID, timeline: [AFTER_SALE_ENTRY, { key: 'after-sale-escalated', title: '已转交平台处理', time: 'x' }] },
      ]);
      (db.nightOrder.findUnique as jest.Mock).mockResolvedValue({ afterSaleStatus: 'requested', timeline: oldTimeline });
      const svc = makeService(db);
      const n = await svc.escalateOverdueAfterSales(50);
      expect(n).toBe(1);
      expect(db.nightOrder.update).toHaveBeenCalledTimes(1);
      expect((db.nightOrder.update as jest.Mock).mock.calls[0][0].where.id).toBe('old-1');
    });
  });

  describe('applyAfterSale 推送触发', () => {
    it('申请成功后 fire-and-forget 通知楼长', async () => {
      const notify = jest.fn().mockResolvedValue(undefined);
      const db = makeDb();
      (db.nightOrder.findFirst as jest.Mock).mockResolvedValue({
        id: ORDER_ID, userId: 'u1', status: 'completed', afterSaleStatus: null,
        completedAt: new Date(), paidAt: new Date(),
        payableAmount: 2099, deliveryFee: 0,
        items: [{ nightProductId: 'p1', name: '薯片', price: 1099, quantity: 1 }],
        timeline: [],
      });
      const svc = makeService(db);
      (svc as unknown as { push: unknown }).push = { notifyNightManagerAfterSale: notify };
      await svc.applyAfterSale('u1', ORDER_ID, { type: 'damaged', description: '薯片压碎了请退款' });
      expect(notify).toHaveBeenCalledWith(ORDER_ID);
    });
  });

  describe('adminOrdersPage 售后处理人与转交置顶', () => {
    it('拒绝单解析楼长处理人，转交单透出 afterSaleEscalated 并置顶', async () => {
      const db = makeDb();
      const base = {
        storeId: STORE_ID, userId: 'u1', status: 'completed', statusText: '已完成',
        businessDate: '2026-11-25', items: [], productAmount: 1000, deliveryFee: 0,
        couponDiscount: 0, payableAmount: 1000, address: {}, createdAt: new Date(),
        paidAt: new Date(), acceptedAt: null, deliveredAt: null, completedAt: new Date(),
        cancelReason: null, refund: null, store: { id: STORE_ID, building: { name: '1栋' } },
        user: { id: 'u1', nickname: '小王', phone: '13800000000' },
      };
      (db.nightOrder.findMany as jest.Mock).mockResolvedValue([
        { ...base, id: 'o-normal', orderNo: 'YX1', afterSaleStatus: 'requested', timeline: [{ ...AFTER_SALE_ENTRY, time: new Date().toISOString() }] },
        { ...base, id: 'o-escalated', orderNo: 'YX2', afterSaleStatus: 'requested', timeline: [{ ...AFTER_SALE_ENTRY, time: new Date().toISOString() }, { key: 'after-sale-escalated', title: '已转交平台处理', time: new Date().toISOString() }] },
        { ...base, id: 'o-rejected', orderNo: 'YX3', afterSaleStatus: 'rejected', timeline: [AFTER_SALE_ENTRY, { key: 'after-sale-review', title: '售后审核未通过', description: '无破损', operatorId: MANAGER, time: new Date().toISOString() }] },
      ]);
      (db.nightOrder.count as jest.Mock).mockResolvedValue(3);
      (db.staff.findMany as jest.Mock).mockResolvedValue([{ id: MANAGER, name: '张三' }]);
      const svc = makeService(db);
      const page = await svc.adminOrdersPage('campus-1', { afterSaleStatus: 'requested' });
      expect(page.items[0]).toMatchObject({ id: 'o-escalated', afterSaleEscalated: true });
      const rejected = page.items.find((x: { id: string }) => x.id === 'o-rejected');
      expect(rejected).toMatchObject({ afterSaleOperatorName: '楼长 张三' });
    });
  });
});
