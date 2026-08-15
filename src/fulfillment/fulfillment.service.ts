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
    const tasks = await this.tasks(staffId);
    const active = tasks.filter((x) => x.status !== 'completed');
    return {
      profile,
      stats: {
        pending: active.length,
        completed: profile.completedToday,
        income: profile.income,
        onTimeRate: profile.onTimeRate,
      },
      announcement:
        profile.role === 'building-manager'
          ? '有包裹即将到楼，请准备接货'
          : '校园仓有待配送任务',
      tasks: active.slice(0, 4),
    };
  }
  async tasks(staffId: string, status?: string) {
    const staff = await this.profile(staffId);
    const orders = await this.db.order.findMany({
      where: {
        campusId: staff.campusId,
        status: { notIn: ['pending-payment', 'cancelled', 'refunded'] },
      },
      orderBy: { createdAt: 'desc' },
    });
    const result = orders.map((o) =>
      this.toTask(o as unknown as JsonMap, staff.role as StaffRole),
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
    const order = await this.db.order.findFirst({
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
    if (action === 'pickup' && !payload.packageCode)
      throw new BadRequestException('请提交包裹码');
    if (action === 'handover' && !payload.handoverCode)
      throw new BadRequestException('请提交交接码');
    if (
      action === 'delivered' &&
      (!payload.images?.length || !payload.location)
    )
      throw new BadRequestException('请上传送达照片和定位');
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
    await this.db.order.update({
      where: { id: order.id },
      data: {
        status: next.status,
        statusText: next.text,
        timeline: timeline as Prisma.InputJsonValue,
      },
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
        id: `leave-${Date.now()}`,
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
      take: 5,
    });
    const base = s.role === 'building-manager' ? 500 : 0;
    return {
      month: new Date().toISOString().slice(0, 7),
      baseSalary: base,
      deliveryIncome: s.income,
      adjustment: 0,
      payable: base + s.income,
      records: orders.map((o, i) => ({
        id: `commission-${i + 1}`,
        orderNo: o.orderNo,
        building: s.building,
        amount: 3.2,
        createdAt: o.createdAt,
        status: 'pending',
      })),
    };
  }

  private toTask(order: JsonMap, role: StaffRole) {
    const a = order.address as JsonMap,
      items = order.items as JsonMap[],
      manager = role === 'building-manager';
    const status =
      order.status === 'completed'
        ? 'completed'
        : manager
          ? order.status === 'last-mile'
            ? 'delivering'
            : 'waiting'
          : order.status === 'first-mile'
            ? 'delivering'
            : 'available';
    return {
      id: `task-${role}-${order.id}`,
      orderId: order.id,
      packageNo:
        (order.package as JsonMap)?.id ?? `PKG-${order.orderNo.slice(-8)}`,
      status,
      statusText:
        status === 'completed'
          ? '已完成'
          : status === 'delivering'
            ? '配送中'
            : manager
              ? '待下楼接货'
              : '待接单',
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
      availableActions: this.actions(role, order.status),
    };
  }
  private actions(role: StaffRole, status: string) {
    if (role === 'building-manager') {
      if (status === 'first-mile') return ['receive'];
      if (status === 'last-mile')
        return ['start-delivery', 'delivered', 'absent'];
      return [];
    }
    if (['paid', 'picking'].includes(status))
      return ['accept', 'pickup', 'transfer'];
    if (status === 'first-mile') return ['depart', 'arrive', 'transfer'];
    if (status === 'last-mile') return ['handover'];
    return [];
  }
}
