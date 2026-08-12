import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MockStore } from '../mock/mock.store';

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
}

@Injectable()
export class FulfillmentService {
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
        online: true,
      },
      'fulltime-rider': {
        id: 'staff-rider-001',
        name: '周航',
        role,
        roleText: '全职配送员',
        staffNo: 'RD-HBUT-012',
        building: '湖北工业大学',
        online: true,
      },
      'parttime-rider': {
        id: 'staff-rider-002',
        name: '林可',
        role,
        roleText: '兼职配送员',
        staffNo: 'PT-HBUT-028',
        building: '湖北工业大学',
        online: false,
      },
    };
    return profiles[role];
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
    payload: Record<string, unknown> = {},
  ): FulfillmentTask {
    const order = this.store.orders.find(
      (item) => `task-${role}-${item.id}` === id,
    );
    if (!order) throw new NotFoundException('履约任务不存在');
    const actionMap: Record<string, { status: string; text: string }> =
      role === 'building-manager'
        ? {
            receive: { status: 'last-mile', text: '楼长已接货' },
            delivered: { status: 'completed', text: '已送达寝室' },
            absent: { status: 'exception', text: '用户不在，暂存楼长处' },
            refused: { status: 'exception', text: '用户拒收，待带回仓库' },
          }
        : {
            accept: { status: 'paid', text: '配送员已接单' },
            pickup: { status: 'first-mile', text: '已扫码取货' },
            arrive: { status: 'last-mile', text: '已到楼下，等待楼长交接' },
            transfer: { status: 'exception', text: '转单申请处理中' },
          };
    const next = actionMap[action];
    if (!next) throw new BadRequestException('不支持的履约操作');
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
    return [
      {
        id: 'leave-001',
        startAt: '2026-08-16 08:00',
        endAt: '2026-08-16 22:30',
        reason: '参加学院活动',
        status: 'approved',
        statusText: '已批准',
      },
      {
        id: 'dispatch-001',
        building: '西区 7 栋',
        startAt: '2026-08-14 18:00',
        endAt: '2026-08-14 22:30',
        reward: 28,
        status: 'invited',
        statusText: '待接受调配',
      },
    ];
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
    };
  }
}
