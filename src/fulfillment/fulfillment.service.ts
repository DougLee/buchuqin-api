import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import type { LeaveRequestDto, TaskActionDto } from './dto';

export type StaffRole =
  'building-manager' | 'fulltime-rider' | 'parttime-rider';
type JsonMap = Record<string, any>;

/** 简化提成规则：固定 3 元/单（完整规则快照见 IK8W5L）。 */
export const COMMISSION_PER_ORDER = 3;

@Injectable()
export class FulfillmentService {
  constructor(private readonly db: PrismaService) {}

  async profile(staffId: string) {
    const s = await this.db.staff.findUnique({ where: { id: staffId } });
    if (!s) throw new NotFoundException('履约人员不存在');
    return {
      ...s,
      onTimeRate: Number(s.onTimeRate),
      proofRate: s.proofRate == null ? null : Number(s.proofRate),
      income: Number(s.income),
      online: s.status === 'online',
    };
  }
  async updateStatus(staffId: string, status: 'online' | 'paused' | 'offline') {
    await this.db.staff.update({ where: { id: staffId }, data: { status } });
    return this.profile(staffId);
  }
  async currentShift(staffId: string) {
    const s = await this.profile(staffId);
    return {
      id: `shift-${s.id}-${new Date().toISOString().slice(0, 10)}`,
      status: s.online ? 'working' : 'not-started',
      role: s.role,
      serviceArea: s.building,
      startAt: '08:00',
      endAt: '22:30',
    };
  }
  async checkIn(staffId: string) {
    await this.updateStatus(staffId, 'online');
    return {
      ...(await this.currentShift(staffId)),
      status: 'working',
      checkedInAt: new Date().toISOString(),
    };
  }
  async checkOut(staffId: string) {
    await this.updateStatus(staffId, 'offline');
    return {
      ...(await this.currentShift(staffId)),
      status: 'completed',
      checkedOutAt: new Date().toISOString(),
    };
  }

  async dashboard(staffId: string) {
    const profile = await this.profile(staffId);
    const [performance, tasks] = await Promise.all([
      this.performance(staffId),
      this.tasks(staffId),
    ]);
    const active = tasks.filter((x) => x.status !== 'completed');
    return {
      profile,
      stats: {
        pending: active.length,
        completed: performance.completed,
        income: performance.income,
        onTimeRate: performance.onTimeRate,
      },
      announcement:
        profile.role === 'building-manager'
          ? '有包裹即将到楼，请准备接货'
          : '校园仓有待配送任务',
      tasks: active.slice(0, 4),
    };
  }
  /** 绩效从订单 timeline 真实计算，不再读 Staff 冗余字段。 */
  async performance(staffId: string) {
    const s = await this.profile(staffId);
    const orders = await this.db.order.findMany({
      where: {
        campusId: s.campusId,
        status: { notIn: ['pending-payment', 'cancelled', 'refunded'] },
      },
    });
    const mine = this.attributedOrders(s, orders);
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const deliveredAt = (order: (typeof orders)[number]) => {
      const time = (order.timeline as JsonMap[]).at(-1)?.time;
      return time ? new Date(String(time)) : null;
    };
    const completed = mine.filter((x) => x.status === 'completed');
    const completedToday = completed.filter(
      (x) => (deliveredAt(x)?.getTime() ?? 0) >= startOfToday.getTime(),
    );
    // 准时口径：送达时间与支付时间在同一天（MVP 简化，正式 SLA 见规则快照 IK8W5L）。
    const onTime = completed.filter((x) => {
      const time = deliveredAt(x);
      return (
        !!time && !!x.paidAt && time.toDateString() === x.paidAt.toDateString()
      );
    });
    const withProof = completed.filter((x) => {
      const proof = (x.package as JsonMap | null)?.proof as JsonMap | undefined;
      return Array.isArray(proof?.images) && proof.images.length > 0;
    });
    const rate = (n: number, d: number) =>
      d ? Number(((n / d) * 100).toFixed(1)) : 0;
    return {
      period: 'today',
      pending: mine.filter((x) =>
        ['paid', 'picking', 'first-mile', 'last-mile'].includes(x.status),
      ).length,
      completed: completedToday.length,
      completedTotal: completed.length,
      income: Number((completed.length * COMMISSION_PER_ORDER).toFixed(2)),
      onTimeRate: rate(onTime.length, completed.length),
      proofRate: rate(withProof.length, completed.length),
      exceptionRate: rate(
        mine.filter((x) => x.status === 'exception').length,
        mine.length,
      ),
    };
  }
  /** 订单归属：楼长按楼栋，配送员按校园全量。 */
  private attributedOrders<T extends { address: unknown }>(
    staff: { role: string; building: string },
    orders: T[],
  ): T[] {
    return staff.role === 'building-manager'
      ? orders.filter(
          (x) => String((x.address as JsonMap).buildingName) === staff.building,
        )
      : orders;
  }
  async tasks(staffId: string, status?: string) {
    const staff = await this.profile(staffId);
    const manager = staff.role === 'building-manager';
    const orders = await this.db.order.findMany({
      where: {
        campusId: staff.campusId,
        status: { notIn: ['pending-payment', 'cancelled', 'refunded'] },
        // 骑手视图：已被其他配送员接走的单不再出现在任务池。
        ...(!manager ? { OR: [{ riderId: null }, { riderId: staffId }] } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    const result = orders.map((o) =>
      this.toTask(o as unknown as JsonMap, staff.role as StaffRole, staff.id),
    );
    return result.filter(
      (x) => !status || status === 'all' || x.status === status,
    );
  }
  async task(staffId: string, id: string) {
    const task = (await this.tasks(staffId)).find((x) => x.id === id);
    if (!task) throw new NotFoundException('履约任务不存在');
    return task;
  }
  async updateTask(
    staffId: string,
    id: string,
    action: string,
    payload: TaskActionDto = {},
  ) {
    const staff = await this.profile(staffId);
    const prefix = `task-${staff.role}-`;
    if (!id.startsWith(prefix)) throw new NotFoundException('履约任务不存在');
    const orderId = id.slice(prefix.length);
    // 读改写整体放入事务：校验、timeline 拼装、条件更新要么全部生效要么全部回滚。
    await this.db.$transaction(async (tx) => {
      const order = await tx.order.findFirst({
        where: { id: orderId, campusId: staff.campusId },
      });
      if (!order) throw new NotFoundException('履约任务不存在');
      const manager = staff.role === 'building-manager';
      const maps: Record<
        string,
        { status: string; text: string; from: string[] }
      > = manager
        ? {
            receive: {
              status: 'last-mile',
              text: '楼长已接货',
              from: ['first-mile', 'last-mile'],
            },
            'start-delivery': {
              status: 'last-mile',
              text: '楼长送往寝室',
              from: ['last-mile'],
            },
            delivered: {
              status: 'completed',
              text: '已送达寝室',
              from: ['last-mile'],
            },
            absent: {
              status: 'exception',
              text: '用户不在，暂存楼长处',
              from: ['last-mile'],
            },
            refused: {
              status: 'exception',
              text: '用户拒收，待带回仓库',
              from: ['last-mile'],
            },
          }
        : {
            accept: {
              status: order.status,
              text: '配送员已接单',
              from: ['paid', 'picking'],
            },
            pickup: {
              status: 'first-mile',
              text: '已扫码取货',
              from: ['paid', 'picking'],
            },
            depart: {
              status: 'first-mile',
              text: '已从校园仓出发',
              from: ['first-mile'],
            },
            arrive: {
              status: 'last-mile',
              text: '已到楼下，等待楼长交接',
              from: ['first-mile'],
            },
            handover: {
              status: 'last-mile',
              text: '已与楼长完成交接',
              from: ['last-mile'],
            },
            transfer: {
              status: 'exception',
              text: '转单申请处理中',
              from: ['paid', 'picking', 'first-mile'],
            },
          };
      const next = maps[action];
      if (!next || !next.from.includes(order.status))
        throw new BadRequestException('当前状态不允许此操作');
      // 配送员动作仅限接单人本人操作（accept 通过下方条件更新抢归属）。
      if (!manager && order.riderId && order.riderId !== staffId)
        throw new BadRequestException('任务已被其他配送员接取');
      if (action === 'pickup' && !payload.packageCode)
        throw new BadRequestException('请提交包裹码');
      if (action === 'handover' && !payload.handoverCode)
        throw new BadRequestException('请提交交接码');
      if (
        action === 'delivered' &&
        (!payload.images?.length || !payload.location)
      )
        throw new BadRequestException('请上传送达照片和定位');
      // 取货扫码：校验真实包裹码（支付时生成的 package.id；历史单回退到展示包裹号）。
      if (action === 'pickup') {
        const pkg = order.package as JsonMap | null;
        const expected = String(pkg?.id ?? `PKG-${order.orderNo.slice(-8)}`);
        if (payload.packageCode!.trim() !== expected)
          throw new BadRequestException('包裹码不正确，请扫描包裹上的条码');
      }
      // 交接扫码：校验寝室 qrToken（以寝室门口二维码为准）。
      if (action === 'handover') {
        const addr = order.address as JsonMap;
        const building = await tx.building.findFirst({
          where: {
            campusId: staff.campusId,
            OR: [
              { id: String(addr.buildingId ?? '') },
              { name: String(addr.buildingName ?? '') },
            ],
          },
        });
        const room = building
          ? await tx.room.findFirst({
              where: {
                buildingId: building.id,
                floor: Number(addr.floor),
                roomNo: String(addr.room),
              },
            })
          : null;
        if (!room || payload.handoverCode!.trim() !== room.qrToken)
          throw new BadRequestException('交接码不正确，请扫描寝室门口二维码');
      }
      const timeline = (order.timeline as JsonMap[]).map((x) => ({ ...x }));
      const keyByStatus: Record<string, string> = {
        'first-mile': 'first-mile',
        'last-mile': 'last-mile',
        completed: 'completed',
      };
      const step = timeline.find((x) => x.key === keyByStatus[next.status]);
      if (step) {
        step.done = true;
        step.time = new Date().toISOString();
      }
      // delivered 时把送达凭证（照片/定位/坐标）写入包裹信息，供绩效凭证完整率统计。
      const packageUpdate =
        action === 'delivered'
          ? {
              package: {
                ...((order.package as JsonMap | null) ?? {}),
                proof: {
                  images: payload.images ?? [],
                  location: payload.location ?? '',
                  latitude: payload.latitude ?? null,
                  longitude: payload.longitude ?? null,
                  time: new Date().toISOString(),
                },
              } as Prisma.InputJsonValue,
            }
          : {};
      if (action === 'accept') {
        // 抢单互斥：riderId 为空才允许写入归属，并发的第二个 accept count=0 失败。
        const won = await tx.order.updateMany({
          where: {
            id: order.id,
            riderId: null,
            status: { in: ['paid', 'picking'] },
          },
          data: { riderId: staffId, statusText: '配送员已接单' },
        });
        if (!won.count) throw new BadRequestException('任务已被其他配送员接取');
        return;
      }
      // 状态条件更新：并发推进（双人操作/与后台同时改单）时仅一笔生效。
      const won = await tx.order.updateMany({
        where: {
          id: order.id,
          status: order.status,
          ...(manager ? {} : { riderId: staffId }),
        },
        data: {
          status: next.status,
          statusText: next.text,
          timeline: timeline as Prisma.InputJsonValue,
          ...packageUpdate,
        },
      });
      if (!won.count)
        throw new BadRequestException('任务状态已变化，请刷新后重试');
    });
    return this.task(staffId, id);
  }
  async leave(staffId: string) {
    return this.db.leaveRequest.findMany({
      where: { staffId },
      orderBy: { createdAt: 'desc' },
    });
  }
  async createLeave(staffId: string, dto: LeaveRequestDto) {
    if (new Date(dto.startAt).getTime() <= Date.now() + 7200000)
      throw new BadRequestException('请假需至少提前 2 小时提交');
    return this.db.leaveRequest.create({
      data: {
        staffId,
        startAt: new Date(dto.startAt),
        endAt: new Date(dto.endAt),
        reason: dto.reason,
        status: 'pending',
        statusText: '待审核',
      },
    });
  }
  async cancelLeave(staffId: string, id: string) {
    const x = await this.db.leaveRequest.findFirst({ where: { id, staffId } });
    if (!x) throw new NotFoundException('请假记录不存在');
    if (x.status !== 'pending')
      throw new BadRequestException('仅待审核请假可撤销');
    return this.db.leaveRequest.update({
      where: { id },
      data: { status: 'cancelled', statusText: '已撤销' },
    });
  }
  async dispatchInvites(staffId: string, status?: string) {
    return this.db.dispatchInvitation.findMany({
      where: { staffId, ...(status ? { status } : {}) },
    });
  }
  async respondDispatch(staffId: string, id: string, accepted: boolean) {
    const x = await this.db.dispatchInvitation.findFirst({
      where: { id, staffId },
    });
    if (!x) throw new NotFoundException('调配邀请不存在');
    if (x.status !== 'invited') throw new BadRequestException('调配邀请已处理');
    return this.db.dispatchInvitation.update({
      where: { id },
      data: {
        status: accepted ? 'accepted' : 'rejected',
        statusText: accepted ? '已接受调配' : '已拒绝',
      },
    });
  }
  async commissions(staffId: string) {
    const s = await this.profile(staffId);
    const orders = await this.db.order.findMany({
      where: { campusId: s.campusId, status: 'completed' },
      orderBy: { createdAt: 'desc' },
    });
    const mine = this.attributedOrders(s, orders);
    const base = s.role === 'building-manager' ? 500 : 0;
    const deliveryIncome = Number(
      (mine.length * COMMISSION_PER_ORDER).toFixed(2),
    );
    return {
      month: new Date().toISOString().slice(0, 7),
      baseSalary: base,
      deliveryIncome,
      adjustment: 0,
      payable: Number((base + deliveryIncome).toFixed(2)),
      records: mine.map((o) => ({
        id: `commission-${o.id}`,
        orderNo: o.orderNo,
        building: String((o.address as JsonMap).buildingName),
        amount: COMMISSION_PER_ORDER,
        createdAt: o.createdAt,
        status: 'pending',
      })),
    };
  }

  private toTask(order: JsonMap, role: StaffRole, viewerId?: string) {
    const a = order.address as JsonMap,
      items = order.items as JsonMap[],
      manager = role === 'building-manager';
    // 骑手视图映射修复：last-mile/exception/已被本人接走但未取货的单
    // 不得再显示为“待接单”（available 仅保留给无归属的 paid/picking 单）。
    let status: string, statusText: string;
    if (order.status === 'completed') {
      status = 'completed';
      statusText = '已完成';
    } else if (manager) {
      status = order.status === 'last-mile' ? 'delivering' : 'waiting';
      statusText = status === 'delivering' ? '配送中' : '待下楼接货';
    } else if (order.status === 'exception') {
      status = 'exception';
      statusText = '异常处理中';
    } else if (order.status === 'last-mile') {
      status = 'waiting';
      statusText = '待交接';
    } else if (order.status === 'first-mile') {
      status = 'delivering';
      statusText = '配送中';
    } else if (order.riderId) {
      status = 'delivering';
      statusText = '已接单，待取货';
    } else {
      status = 'available';
      statusText = '待接单';
    }
    return {
      id: `task-${role}-${order.id}`,
      orderId: order.id,
      packageNo:
        (order.package as JsonMap)?.id ?? `PKG-${order.orderNo.slice(-8)}`,
      status,
      statusText,
      building: String(a.buildingName),
      floor: Number(a.floor),
      room: String(a.room),
      itemCount: order.totalQuantity,
      weight: Number(
        items
          .reduce(
            (s: number, x: JsonMap) =>
              s + Number(x.product?.weight ?? x.weight ?? 0) * x.quantity,
            0,
          )
          .toFixed(2),
      ),
      mode: order.deliveryMode,
      modeText: order.deliveryMode === 'instant' ? '立即配送' : '预约配送',
      deadline: order.estimatedArrival,
      warehouse: '湖北工业大学校园仓',
      commission: Number((2.2 + Number(a.floor) * 0.35).toFixed(2)),
      items: items.map((x: JsonMap) => ({
        name: x.product?.name ?? x.name,
        quantity: x.quantity,
        image: x.product?.image ?? x.image,
      })),
      timeline: order.timeline,
      availableActions: this.actions(
        role,
        order.status,
        order.riderId as string | null,
        viewerId,
      ),
    };
  }
  private actions(
    role: StaffRole,
    status: string,
    riderId?: string | null,
    viewerId?: string,
  ) {
    if (role === 'building-manager') {
      if (status === 'first-mile') return ['receive'];
      if (status === 'last-mile')
        return ['start-delivery', 'delivered', 'absent'];
      return [];
    }
    if (['paid', 'picking'].includes(status)) {
      // 无归属单只能抢（accept）；本人已抢到的单才能取货/转单。
      return riderId ? ['pickup', 'transfer'] : ['accept'];
    }
    if (status === 'first-mile') return ['depart', 'arrive', 'transfer'];
    if (status === 'last-mile') return ['handover'];
    return [];
  }
}
