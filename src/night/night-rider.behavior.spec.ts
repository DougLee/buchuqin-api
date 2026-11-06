import { NightRiderService } from './night-rider.service';
import { NightOrderService } from './night-order.service';
import { PrismaService } from '../database/prisma.service';
import { PaymentsService } from '../payments/payments.service';

describe('配送端夜宵经营边界（内存测试，不连接数据库）', () => {
  const campus = {
    name: '测试校区',
    closeStart: '00:00',
    closeEnd: '00:00',
    manualClosed: false,
    nightEnabled: true,
    nightStartAt: '23:00',
    nightEndAt: '02:00',
  };
  const staff = {
    id: 'staff',
    campusId: 'campus',
    role: 'building-manager',
    campus,
  };
  const store = {
    id: 'store',
    campusId: 'campus',
    managerStaffId: 'staff',
    deposit: 50000,
    campus,
  };
  const mocked = () => {
    const db = {
      staff: { findUnique: jest.fn().mockResolvedValue(staff) },
      nightStore: {
        findFirst: jest.fn().mockResolvedValue(store),
        findUnique: jest.fn().mockResolvedValue(store),
      },
      nightProduct: {
        findMany: jest.fn(),
        update: jest.fn(),
        upsert: jest.fn(),
      },
      product: { findMany: jest.fn().mockResolvedValue([{ id: 'a' }]) },
      nightStockOrder: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      $queryRaw: jest.fn(),
      $transaction: jest.fn(),
    };
    db.$transaction.mockImplementation((work) => work(db));
    return db;
  };
  afterEach(() => jest.useRealTimers());

  it('押金档位由服务端校验，选择1500元档只收当前余额到目标档的差额', async () => {
    const db = {
      nightStore: { findUnique: jest.fn().mockResolvedValue(store) },
      $queryRaw: jest.fn(),
      $transaction: jest.fn(),
      nightDepositRefund: { count: jest.fn().mockResolvedValue(0) },
      nightDepositOrder: {
        findFirst: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn(),
        create: jest
          .fn()
          .mockImplementation(({ data }) => ({ ...data, id: 'intent' })),
      },
    };
    db.$transaction.mockImplementation(work => work(db));
    const payments = {
      registerNightPaymentHandler: jest.fn(),
      nightPrepay: jest.fn().mockResolvedValue({}),
    };
    const service = new NightOrderService(
      db as unknown as PrismaService,
      payments as unknown as PaymentsService,
    );
    const result = await service.initiateDepositPay(
      'store',
      'campus',
      'openid',
      'delivery-app',
      150000,
    );
    expect(result.amount).toBe(100000);
    expect(payments.nightPrepay.mock.calls[0][0].payerAppId).toBe(
      'delivery-app',
    );
    await expect(
      service.initiateDepositPay(
        'store',
        'campus',
        'openid',
        'delivery-app',
        70000,
      ),
    ).rejects.toThrow('500 元押金档位');
    expect(payments.nightPrepay).toHaveBeenCalledTimes(1);
  });

  it('白天、夜宵和空档状态互斥，跨午夜夜宵正常展示', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-11-06T16:30:00Z'));
    const db = mocked();
    const service = new NightRiderService(
      db as unknown as PrismaService,
      {} as NightOrderService,
    );
    expect((await service.businessContext('staff')).mode).toBe('day');
    db.staff.findUnique.mockResolvedValue({
      ...staff,
      campus: { ...campus, manualClosed: true },
    });
    expect((await service.businessContext('staff')).mode).toBe('night');
    jest.setSystemTime(new Date('2026-11-06T12:00:00Z'));
    expect((await service.businessContext('staff')).mode).toBe('rest');
  });

  it('未绑定夜宵店的员工在白天闭店后只能休息', async () => {
    const db = mocked();
    db.staff.findUnique.mockResolvedValue({
      ...staff,
      campus: { ...campus, manualClosed: true },
    });
    db.nightStore.findFirst.mockResolvedValue(null);
    const service = new NightRiderService(
      db as unknown as PrismaService,
      {} as NightOrderService,
    );
    expect((await service.businessContext('staff')).mode).toBe('rest');
  });

  it.each(['building-manager', 'intern-building-manager', 'fulltime-rider', 'parttime-rider'])('切换资格由服务端员工角色与绑定决定：%s', async (role) => {
    const db = mocked();
    db.staff.findUnique.mockResolvedValue({ ...staff, role });
    const service = new NightRiderService(db as unknown as PrismaService, {} as NightOrderService);
    expect(await service.businessContext('staff')).toMatchObject({ staffId: staff.id, staffRole: role, canSwitchWorkspace: role === 'building-manager' });
    if (!role.includes('manager')) expect(db.nightStore.findFirst).not.toHaveBeenCalled();
    db.nightStore.findFirst.mockResolvedValue(null);
    expect((await service.businessContext('staff')).canSwitchWorkspace).toBe(false);
  });

  it('送达原子完成并保存照片；售后进行中不提前解冻佣金', async () => {
    const db = {
      $queryRaw: jest.fn(),
      nightStore: { findUnique: jest.fn().mockResolvedValue(store) },
      nightOrder: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'order',
          storeId: 'store',
          managerStaffId: 'staff',
          status: 'delivering',
          timeline: [],
          userId: 'user',
          orderNo: 'YX1',
          afterSaleStatus: 'requested',
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      nightCommissionTxn: { updateMany: jest.fn() },
      notification: { create: jest.fn() },
      $transaction: jest.fn(),
    };
    db.$transaction.mockImplementation((work) => work(db));
    const service = new NightOrderService(
      db as unknown as PrismaService,
      { registerNightPaymentHandler: jest.fn() } as unknown as PaymentsService,
    );
    await service.deliverOrder('staff', 'store', 'order', {
      images: ['https://example.com/proof.jpg'],
    });
    const data = db.nightOrder.updateMany.mock.calls[0][0].data;
    expect(data.status).toBe('completed');
    expect(data.completedAt).toBeInstanceOf(Date);
    expect(data.timeline[0].proof.images).toEqual([
      'https://example.com/proof.jpg',
    ]);
    expect(db.nightCommissionTxn.updateMany).not.toHaveBeenCalled();
    await expect(
      service.deliverOrder('other', 'store', 'order', {
        images: ['https://example.com/proof.jpg'],
      }),
    ).rejects.toThrow('经营资格已变化');
  });
});
