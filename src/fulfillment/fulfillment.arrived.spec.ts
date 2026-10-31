import { BadRequestException, ConflictException } from '@nestjs/common';
import { FulfillmentService } from './fulfillment.service';

/**
 * IKRSIY（#109/#111 已到店）单元测试：arrived 推进的动作表/扫码端点。
 * 全程 stub db，不落真库（集成口径见 fulfillment.service.spec.ts）。
 */
describe('FulfillmentService IKRSIY 到店确认（arrived）', () => {
  const staffRow = {
    id: 'rider-1',
    campusId: 'campus-1',
    name: '骑手一',
    role: 'fulltime-rider',
    roleText: '全职配送员',
    staffNo: 'R001',
    building: '东区 1 栋',
    buildingId: 'b-1',
    status: 'online',
    onTimeRate: 100,
    income: 0,
    proofRate: null,
    phone: '',
    campus: { name: '测试大学', warehouseName: '测试仓' },
  };
  const baseOrder = () => ({
    id: 'o1',
    orderNo: 'BCQ20261030001',
    campusId: 'campus-1',
    userId: 'u1',
    status: 'waiting-first-mile',
    statusText: '已出库，待配送员接单',
    riderId: 'rider-1',
    timeline: [
      {
        key: 'paid',
        title: '支付成功',
        description: '',
        done: true,
        time: 't1',
      },
      {
        key: 'picking',
        title: '仓库出库',
        description: '',
        done: true,
        time: 't2',
      },
      { key: 'first-mile', title: '送往楼下', description: '', done: false },
      {
        key: 'waiting-handover',
        title: '楼下待交接',
        description: '',
        done: false,
      },
      {
        key: 'ready-to-deliver',
        title: '待送到寝室',
        description: '',
        done: false,
      },
      {
        key: 'last-mile',
        title: '送到寝室',
        description: '东区 1 栋 101',
        done: false,
      },
    ],
    package: null,
    address: {
      buildingName: '东区 1 栋',
      buildingId: 'b-1',
      floor: 1,
      room: '101',
      contactName: '张同学',
      phone: '13800001234',
    },
    items: [{ product: { name: '可乐', weight: 0.5 }, quantity: 1 }],
    totalQuantity: 1,
    deliveryMode: 'instant',
    payableAmount: 500,
    paidAt: new Date(),
    createdAt: new Date(),
  });
  type Row = Omit<ReturnType<typeof baseOrder>, 'riderId'> & {
    riderId: string | null;
  } & Record<string, unknown>;
  let row: Row;
  let lastUpdate:
    | { where: Record<string, unknown>; data: Record<string, unknown> }
    | undefined;
  const dbStub: Record<string, unknown> = {
    staff: {
      findUnique: () => Promise.resolve(staffRow),
      findMany: () => Promise.resolve([staffRow]),
      // arrive 提交后的到楼企微通知查楼长——桩返回 null 走「无楼长」静默分支
      findFirst: () => Promise.resolve(null),
    },
    campus: { findUnique: () => Promise.resolve(null) },
    building: { findMany: () => Promise.resolve([]) },
    commission: { findMany: () => Promise.resolve([]) },
    order: {
      findFirst: (args: {
        where: { orderNo?: string; id?: string; campusId: string };
      }) => {
        const w = args.where;
        const matched =
          (w.id === undefined || w.id === row.id) &&
          (w.orderNo === undefined || w.orderNo === row.orderNo) &&
          (w.campusId === undefined || w.campusId === row.campusId);
        return matched ? { ...row } : null;
      },
      findMany: () => Promise.resolve([{ ...row }]),
      updateMany: (args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        lastUpdate = args;
        // 模拟条件更新：where 带旧状态/归属，不匹配即 count=0（并发竞争）
        if (
          (args.where.status !== undefined &&
            args.where.status !== row.status) ||
          (args.where.riderId !== undefined &&
            args.where.riderId !== row.riderId)
        )
          return Promise.resolve({ count: 0 });
        Object.assign(row, args.data);
        return Promise.resolve({ count: 1 });
      },
    },
    $transaction: (fn: (tx: never) => unknown) =>
      Promise.resolve(fn(dbStub as never)),
  };
  const service = new FulfillmentService(dbStub as never);
  const actions = (
    status: string,
    riderId?: string | null,
    viewerId?: string,
  ): string[] =>
    (
      service as unknown as {
        actions: (
          role: string,
          status: string,
          riderId?: string | null,
          viewerId?: string,
        ) => string[];
      }
    ).actions('fulltime-rider', status, riderId, viewerId);

  beforeEach(() => {
    row = baseOrder();
    lastUpdate = undefined;
  });

  it('actions：waiting-first-mile 可用动作=arrive/transfer（道哥 2026-10-31 流程定稿：到店必经，无 depart 跳过通道）', () => {
    expect(actions('waiting-first-mile', 'rider-1', 'rider-1')).toEqual([
      'arrive',
      'transfer',
    ]);
    expect(actions('waiting-first-mile', null)).toEqual(['accept']);
  });

  it('actions：arrived 仅可 depart，转单不可（IKRQR7 门槛维持）', () => {
    expect(actions('arrived', 'rider-1', 'rider-1')).toEqual(['depart']);
    expect(actions('arrived', 'rider-1', 'other')).toEqual([]);
    // first-mile 的 arrive（到楼下）语义不受影响
    expect(actions('first-mile', 'rider-1', 'rider-1')).toEqual([
      'arrive',
      'transfer',
    ]);
  });

  it('scanArrive：waiting-first-mile + 本人接单 → arrived，条件更新带旧状态', async () => {
    const out = await service.scanArrive('rider-1', 'BCQ20261030001');
    expect(out).toEqual({
      orderId: 'o1',
      orderNo: 'BCQ20261030001',
      status: 'arrived',
      statusText: '配送员已到店',
    });
    expect(lastUpdate?.where).toMatchObject({
      id: 'o1',
      status: 'waiting-first-mile',
      riderId: 'rider-1',
    });
    expect(row.status).toBe('arrived');
    // timeline 不被补录兜底污染（末节点「送到寝室」不得有 time）
    expect(
      (row.timeline as Array<{ key: string; time?: string }>).find(
        (s) => s.key === 'last-mile',
      )?.time,
    ).toBeUndefined();
  });

  it('scanArrive：状态已被推进（重复扫/与按钮竞速）→ 409', async () => {
    row.status = 'first-mile';
    await expect(
      service.scanArrive('rider-1', 'BCQ20261030001'),
    ).rejects.toThrow(ConflictException);
  });

  it('scanArrive：未接单/他人接单 → 400 引导先接单', async () => {
    row.riderId = null;
    await expect(
      service.scanArrive('rider-1', 'BCQ20261030001'),
    ).rejects.toThrow(BadRequestException);
  });

  it('scanArrive：订单号不存在 → 404；空号 → 400', async () => {
    row.orderNo = 'OTHER';
    await expect(
      service.scanArrive('rider-1', 'BCQ20261030001'),
    ).rejects.toThrow('订单不存在');
    await expect(service.scanArrive('rider-1', '')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('动作 arrive（手动按钮）：waiting-first-mile → arrived（与扫码同语义）', async () => {
    const task = await service.updateTask(
      'rider-1',
      'task-fulltime-rider-o1',
      'arrive',
    );
    expect(row.status).toBe('arrived');
    expect(row.statusText).toBe('配送员已到店');
    expect(task.status).toBe('delivering');
    expect(task.statusText).toBe('已到店，待出发');
    expect(task.availableActions).toEqual(['depart']);
  });

  it('depart：arrived 也可出发（到店不强制）', async () => {
    row.status = 'arrived';
    row.statusText = '配送员已到店';
    await service.updateTask('rider-1', 'task-fulltime-rider-o1', 'depart');
    expect(row.status).toBe('first-mile');
    expect(row.statusText).toBe('配送中，骑手已出发');
  });

  it('transfer：arrived 不可转单（IKRQR7）', async () => {
    row.status = 'arrived';
    row.statusText = '配送员已到店';
    await expect(
      service.updateTask('rider-1', 'task-fulltime-rider-o1', 'transfer'),
    ).rejects.toThrow('不能转单');
    expect(row.status).toBe('arrived');
  });
});
