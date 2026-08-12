import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MockStore } from '../mock/mock.store';
import type { LeaveRequestDto, TaskActionDto } from './dto';

export type StaffRole =
  'building-manager' | 'fulltime-rider' | 'parttime-rider';
export interface FulfillmentTask {
  id: string;
  orderId: string;
  packageNo: string;
  status: string;
  statusText: string;
  building: string;
  floor: number;
  room: string;
  itemCount: number;
  weight: number;
  mode: string;
  modeText: string;
  deadline: string;
  warehouse: string;
  commission: number;
  items: Array<{ name: string; quantity: number; image: string }>;
  timeline: Array<{
    key: string;
    title: string;
    description: string;
    done: boolean;
    time?: string;
  }>;
  availableActions: string[];
}

@Injectable()
export class FulfillmentService {
  private staffStatuses = new Map<string, 'online' | 'paused' | 'offline'>();
  private leaveRecords = [
    {
      id: 'leave-001',
      staffId: 'staff-bm-001',
      startAt: '2026-08-16 08:00',
      endAt: '2026-08-16 22:30',
      reason: '参加学院活动',
      status: 'approved',
      statusText: '已批准',
    },
  ];
  private dispatchInvitations = [
    {
      id: 'dispatch-001',
      staffId: 'staff-bm-001',
      building: '西区 7 栋',
      startAt: '2026-08-14 18:00',
      endAt: '2026-08-14 22:30',
      reward: 28,
      status: 'invited',
      statusText: '待接受调配',
    },
  ];
  constructor(private readonly store: MockStore) {}

  profile(role: StaffRole = 'building-manager') {
    const profiles = {
      'building-manager': {
        id: 'staff-bm-001',
        name: '陈晨',
        role,
        roleText: '西区 5 栋楼长',
        staffNo: 'BM-HBUT-005',
        building: '西区 5 栋',
        online: this.status('staff-bm-001') === 'online',
      },
      'fulltime-rider': {
        id: 'staff-rider-001',
        name: '周航',
        role,
        roleText: '全职配送员',
        staffNo: 'RD-HBUT-012',
        building: '湖北工业大学',
        online: this.status('staff-rider-001') === 'online',
      },
      'parttime-rider': {
        id: 'staff-rider-002',
        name: '林可',
        role,
        roleText: '兼职配送员',
        staffNo: 'PT-HBUT-028',
        building: '湖北工业大学',
        online: this.status('staff-rider-002') === 'online',
      },
    };
    return profiles[role];
  }
  private status(staffId: string) {
    return (
      this.staffStatuses.get(staffId) ??
      (staffId === 'staff-rider-002' ? 'offline' : 'online')
    );
  }
  updateStatus(role: StaffRole, status: 'online' | 'paused' | 'offline') {
    const profile = this.profile(role);
    this.staffStatuses.set(profile.id, status);
    return { ...profile, online: status === 'online', status };
  }
  currentShift(role: StaffRole) {
    return {
      id: `shift-${role}-20260812`,
      status: this.profile(role).online ? 'working' : 'not-started',
      role,
      serviceArea: this.profile(role).building,
      startAt: '2026-08-12T08:00:00+08:00',
      endAt: '2026-08-12T22:30:00+08:00',
    };
  }
  checkIn(role: StaffRole) {
    this.updateStatus(role, 'online');
    return {
      ...this.currentShift(role),
      status: 'working',
      checkedInAt: new Date().toISOString(),
    };
  }
  checkOut(role: StaffRole) {
    this.updateStatus(role, 'offline');
    return {
      ...this.currentShift(role),
      status: 'completed',
      checkedOutAt: new Date().toISOString(),
    };
  }

  dashboard(role: StaffRole) {
    const tasks = this.tasks(role);
    const active = tasks.filter(
      (item) => !['completed', 'cancelled'].includes(item.status),
    );
    return {
      profile: this.profile(role),
      stats:
        role === 'building-manager'
          ? {
              pending: active.length,
              completed: 18,
              income: 42.6,
              onTimeRate: 96,
            }
          : {
              pending: active.length,
              completed: 12,
              income: 36.8,
              averageMinutes: 24,
            },
      announcement:
        role === 'building-manager'
          ? '14:30 有 2 个包裹即将到楼，请准备接货'
          : '湖工大校园仓当前有 3 个待配送任务',
      tasks: active.slice(0, 4),
    };
  }

  tasks(role: StaffRole, status?: string): FulfillmentTask[] {
    return this.store.orders
      .filter((order) => order.status !== 'pending-payment')
      .map((order) => this.toTask(order, role))
      .filter((task) => !status || status === 'all' || task.status === status);
  }

  task(role: StaffRole, id: string): FulfillmentTask {
    const task = this.tasks(role).find((item) => item.id === id);
    if (!task) throw new NotFoundException('履约任务不存在');
    return task;
  }

  updateTask(
    role: StaffRole,
    id: string,
    action: string,
    payload: TaskActionDto = {},
  ): FulfillmentTask {
    const order = this.store.orders.find(
      (item) => `task-${role}-${item.id}` === id,
    );
    if (!order) throw new NotFoundException('履约任务不存在');
    const actionMap: Record<
      string,
      { status: string; text: string; from: string[] }
    > =
      role === 'building-manager'
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
              status: 'paid',
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
    const next = actionMap[action];
    if (!next) throw new BadRequestException('不支持的履约操作');
    if (!next.from.includes(order.status))
      throw new BadRequestException(
        `订单状态 ${order.status} 不允许执行 ${action}`,
      );
    if (action === 'pickup' && !payload.packageCode)
      throw new BadRequestException('扫码取货必须提交包裹码');
    if (action === 'handover' && !payload.handoverCode)
      throw new BadRequestException('楼下交接必须提交交接码');
    if (action === 'delivered') {
      const images = payload.images;
      const location = payload.location;
      if (!Array.isArray(images) || !images.length || !location)
        throw new BadRequestException('送达凭证需包含至少 1 张照片和楼层定位');
      order.timeline.at(-1)!.done = true;
      order.timeline.at(-1)!.time = new Date().toISOString();
    }
    order.status = next.status;
    order.statusText = next.text;
    return this.toTask(order, role);
  }

  leave() {
    return [...this.leaveRecords, ...this.dispatchInvitations];
  }
  createLeave(staffId: string, dto: LeaveRequestDto) {
    if (new Date(dto.startAt) <= new Date(Date.now() + 2 * 60 * 60 * 1000))
      throw new BadRequestException('请假需至少提前 2 小时提交');
    const record = {
      id: `leave-${Date.now()}`,
      staffId,
      ...dto,
      status: 'pending',
      statusText: '待审核',
    };
    this.leaveRecords.unshift(record);
    return record;
  }
  cancelLeave(staffId: string, id: string) {
    const item = this.leaveRecords.find(
      (record) => record.id === id && record.staffId === staffId,
    );
    if (!item) throw new NotFoundException('请假记录不存在');
    if (item.status !== 'pending')
      throw new BadRequestException('仅待审核请假可撤销');
    item.status = 'cancelled';
    item.statusText = '已撤销';
    return item;
  }
  dispatchInvites(staffId: string, status?: string) {
    return this.dispatchInvitations.filter(
      (item) => item.staffId === staffId && (!status || item.status === status),
    );
  }
  respondDispatch(staffId: string, id: string, accepted: boolean) {
    const item = this.dispatchInvitations.find(
      (record) => record.id === id && record.staffId === staffId,
    );
    if (!item) throw new NotFoundException('调配邀请不存在');
    if (item.status !== 'invited')
      throw new BadRequestException('调配邀请已处理');
    item.status = accepted ? 'accepted' : 'rejected';
    item.statusText = accepted ? '已接受调配' : '已拒绝';
    return item;
  }

  commissions(role: StaffRole) {
    return {
      month: '2026-08',
      baseSalary: role === 'building-manager' ? 500 : 0,
      deliveryIncome: 326.8,
      adjustment: -8.5,
      payable: role === 'building-manager' ? 818.3 : 326.8,
      records: this.store.orders.slice(0, 5).map((order, index) => ({
        id: `commission-${index + 1}`,
        orderNo: order.orderNo,
        building: '西区 5 栋',
        amount: [3.2, 4.5, 2.8, 5.1, 3.6][index],
        createdAt: order.createdAt,
        status: 'pending',
      })),
    };
  }

  private toTask(
    order: (typeof this.store.orders)[number],
    role: StaffRole,
  ): FulfillmentTask {
    const isManager = role === 'building-manager';
    const status = isManager
      ? order.status === 'completed'
        ? 'completed'
        : order.status === 'last-mile'
          ? 'delivering'
          : 'waiting'
      : order.status === 'completed'
        ? 'completed'
        : order.status === 'first-mile'
          ? 'delivering'
          : 'available';
    return {
      id: `task-${role}-${order.id}`,
      orderId: order.id,
      packageNo: `PKG-${order.orderNo.slice(-8)}`,
      status,
      statusText: isManager
        ? status === 'waiting'
          ? '待下楼接货'
          : status === 'delivering'
            ? '配送到寝'
            : '已完成'
        : status === 'available'
          ? role === 'parttime-rider'
            ? '可抢单'
            : '待接单'
          : status === 'delivering'
            ? '配送中'
            : '已完成',
      building: String(order.address.buildingName),
      floor: Number(order.address.floor),
      room: String(order.address.room),
      itemCount: order.totalQuantity,
      weight: Number(
        order.items
          .reduce((sum, item) => sum + item.product.weight * item.quantity, 0)
          .toFixed(2),
      ),
      mode: order.deliveryMode,
      modeText: order.deliveryMode === 'instant' ? '立即配送' : '2 小时送到',
      deadline: order.estimatedArrival,
      warehouse: this.store.campus.warehouseName,
      commission: Number((2.2 + Number(order.address.floor) * 0.35).toFixed(2)),
      items: order.items.map((item) => ({
        name: item.product.name,
        quantity: item.quantity,
        image: item.product.image,
      })),
      timeline: order.timeline.map((step) => ({ ...step })),
      availableActions: this.availableActions(role, order.status),
    };
  }
  private availableActions(role: StaffRole, status: string) {
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
