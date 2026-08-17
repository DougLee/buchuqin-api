import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { markTimelineStep } from '../common/order-state';
import {
  bestMatch,
  COMMISSION_PER_ORDER,
  CommissionService,
  dimsOfOrder,
} from '../commission/commission.service';
import type { LeaveRequestDto, TaskActionDto } from './dto';

export type StaffRole =
  'building-manager' | 'fulltime-rider' | 'parttime-rider';
type JsonMap = Record<string, any>;

@Injectable()
export class FulfillmentService {
  constructor(
    private readonly db: PrismaService,
    private readonly commissionService: CommissionService = new CommissionService(db),
  ) {}

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
    // 送达时间优先取送达凭证时间（delivered 动作写入），历史单回退 timeline 末节点。
    const deliveredAt = (order: (typeof orders)[number]) => {
      const proof = (order.package as JsonMap | null)?.proof as JsonMap | undefined;
      const time = proof?.time ?? (order.timeline as JsonMap[]).at(-1)?.time;
      return time ? new Date(String(time)) : null;
    };
    // delivered（已送达待确认）计入完成口径。
    const completed = mine.filter((x) =>
      ['delivered', 'completed'].includes(x.status),
    );
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
    // 收入口径统一（IK8W5L）：本月 Commission 记录合计（含负向调整），不再按单数×常量估算。
    const period = new Date().toISOString().slice(0, 7);
    const incomeAgg = await this.db.commission.aggregate({
      where: { staffId, period },
      _sum: { amount: true },
    });
    return {
      period: 'today',
      pending: mine.filter((x) =>
        [
          'paid',
          'picking',
          'waiting-first-mile',
          'first-mile',
          'waiting-handover',
          'last-mile',
        ].includes(x.status),
      ).length,
      completed: completedToday.length,
      completedTotal: completed.length,
      income: incomeAgg._sum.amount ?? 0,
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
    // 提成展示口径统一（IK8W5L）：已生成的 Commission 记录优先，未送达单按规则预览。
    const [rules, records] = await Promise.all([
      this.commissionService.loadRules(this.db, staff.campusId),
      this.db.commission.findMany({
        where: { staffId, orderId: { in: orders.map((o) => o.id) } },
      }),
    ]);
    const commissionByOrder = new Map(
      records.map((r) => [r.orderId, r.amount]),
    );
    const result = orders.map((o) =>
      this.toTask(
        o as unknown as JsonMap,
        staff.role as StaffRole,
        staff.id,
        commissionByOrder,
        rules,
      ),
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
  /**
   * 抢单池（IK8W5U）：本校园"待一级配送"且无归属（riderId 为空）的任务。
   * 骑手角色视图；老单优先。grab 与 accept 同互斥（updateTask 内条件更新抢归属）。
   */
  async availableTasks(staffId: string) {
    const staff = await this.profile(staffId);
    const orders = await this.db.order.findMany({
      where: {
        campusId: staff.campusId,
        status: 'waiting-first-mile',
        riderId: null,
      },
      orderBy: { createdAt: 'asc' },
    });
    const rules = await this.commissionService.loadRules(
      this.db,
      staff.campusId,
    );
    return orders.map((o) =>
      this.toTask(
        o as unknown as JsonMap,
        staff.role as StaffRole,
        staff.id,
        undefined,
        rules,
      ),
    );
  }
  async updateTask(
    staffId: string,
    id: string,
    rawAction: string,
    payload: TaskActionDto = {},
  ) {
    // grab（抢单池，IK8W5U）与 accept 同语义：条件更新抢归属互斥。
    const action = rawAction === 'grab' ? 'accept' : rawAction;
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
      // 动作迁移表（12 态状态机，迁移表全文见 src/common/order-state.ts，IK93GQ）：
      // accept 抢单只写归属不改状态；pickup 取货后停留 waiting-first-mile（package=picked）；
      // depart 后=first-mile，arrive 后=waiting-handover，receive 后=last-mile，
      // delivered 与 completed 分离（用户 confirm-receipt 才终态完成）。
      // 旧机兼容：paid/picking 仍可 accept/pickup（并入 waiting-first-mile）、
      // first-mile 仍可 receive、last-mile 仍可 handover。
      const maps: Record<
        string,
        { status: string; text: string; from: string[] }
      > = manager
        ? {
            receive: {
              status: 'last-mile',
              text: '楼长已接货',
              from: ['waiting-handover', 'first-mile', 'last-mile'],
            },
            'start-delivery': {
              status: 'last-mile',
              text: '楼长送往寝室',
              from: ['last-mile'],
            },
            delivered: {
              status: 'delivered',
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
              from: ['waiting-first-mile', 'paid', 'picking'],
            },
            pickup: {
              status: 'waiting-first-mile',
              text: '已扫码取货，待出发',
              from: ['waiting-first-mile', 'paid', 'picking'],
            },
            depart: {
              status: 'first-mile',
              text: '已从校园仓出发',
              from: ['waiting-first-mile', 'paid', 'picking'],
            },
            arrive: {
              status: 'waiting-handover',
              text: '已到楼下，等待楼长交接',
              from: ['first-mile'],
            },
            handover: {
              status: order.status,
              text: '已与楼长完成交接',
              from: ['waiting-handover', 'last-mile'],
            },
            transfer: {
              status: 'exception',
              text: '转单申请处理中',
              from: [
                'waiting-first-mile',
                'first-mile',
                'waiting-handover',
                'paid',
                'picking',
              ],
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
      // 出发前置校验：必须先扫码取货（package.status=picked；无包裹信息的旧单放行）。
      if (action === 'depart') {
        const pkg = order.package as JsonMap | null;
        if (pkg && pkg.status !== 'picked')
          throw new BadRequestException('请先扫码取货再出发');
      }
      // 进入目标状态时点亮对应 timeline 节点（楼下待交接节点由 arrive 写入）。
      const timeline = markTimelineStep(order.timeline, next.status);
      // delivered 时把送达凭证（照片/定位/坐标）写入包裹信息，供绩效凭证完整率统计；
      // pickup 时把包裹标记为已取货（depart 的前置条件）。
      const packageUpdate =
        action === 'delivered'
          ? {
              package: {
                ...((order.package as JsonMap | null) ?? {}),
                status: 'delivered',
                proof: {
                  images: payload.images ?? [],
                  location: payload.location ?? '',
                  latitude: payload.latitude ?? null,
                  longitude: payload.longitude ?? null,
                  time: new Date().toISOString(),
                },
              } as Prisma.InputJsonValue,
            }
          : action === 'pickup'
            ? {
                package: {
                  ...((order.package as JsonMap | null) ?? {}),
                  status: 'picked',
                } as Prisma.InputJsonValue,
              }
            : {};
      if (action === 'accept' || action === 'grab') {
        // 抢单互斥：riderId 为空才允许写入归属，并发的第二个 accept/grab count=0 失败。
        const won = await tx.order.updateMany({
          where: {
            id: order.id,
            riderId: null,
            status: { in: ['waiting-first-mile', 'paid', 'picking'] },
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
      // 送达即时生成提成快照（IK8W5L）：同一事务内按四维规则生成 Commission 记录。
      if (action === 'delivered')
        await this.commissionService.recordForDelivered(tx, {
          ...order,
          status: next.status,
        });
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
  /**
   * 我的提成（IK8W5L）：统一从 Commission 记录读取（month=YYYY-MM，缺省当月）。
   * 底薪口径：楼长 500/月，骑手 0（月度账单 BmBill 同口径）。
   */
  async commissions(staffId: string, month?: string) {
    const s = await this.profile(staffId);
    const period = month ?? new Date().toISOString().slice(0, 7);
    const { records, commissionTotal, adjustment } =
      await this.commissionService.monthly(staffId, period);
    // 楼长底薪 500 元 = 50000 分（IK8W5K，金额单位:分）。
    const base = s.role === 'building-manager' ? 50000 : 0;
    return {
      month: period,
      baseSalary: base,
      deliveryIncome: commissionTotal,
      adjustment,
      payable: base + commissionTotal + adjustment,
      records: records.map((x) => ({
        id: x.id,
        orderNo: x.order.orderNo,
        building: String((x.order.address as JsonMap).buildingName ?? ''),
        amount: Number(x.amount),
        status: x.status,
        fallback: x.fallback,
        remark: x.remark,
        createdAt: x.createdAt.toISOString(),
      })),
    };
  }

  private toTask(
    order: JsonMap,
    role: StaffRole,
    viewerId?: string,
    commissionByOrder?: Map<string, number>,
    rules?: Array<Parameters<typeof bestMatch>[0][number]>,
  ) {
    const a = order.address as JsonMap,
      items = order.items as JsonMap[],
      manager = role === 'building-manager';
    const pkg = order.package as JsonMap | null;
    // 12 态状态机的任务视图（IK93GQ）：
    // available 仅保留给无归属的待一级配送单（waiting-first-mile/paid/picking）。
    let status: string, statusText: string;
    if (['completed', 'delivered'].includes(order.status)) {
      status = 'completed';
      statusText = order.status === 'delivered' ? '已送达，待确认收货' : '已完成';
    } else if (['exception', 'after-sales'].includes(order.status)) {
      status = 'exception';
      statusText = '异常处理中';
    } else if (manager) {
      if (order.status === 'last-mile') {
        status = 'delivering';
        statusText = '配送中';
      } else if (order.status === 'waiting-handover') {
        status = 'waiting';
        statusText = '待下楼接货';
      } else {
        status = 'waiting';
        statusText = '待到楼';
      }
    } else if (order.status === 'last-mile') {
      // 旧机残留（arrive 直达 last-mile 且未交接）仍归骑手待交接。
      status = 'waiting';
      statusText = '待交接';
    } else if (order.status === 'waiting-handover') {
      status = 'waiting';
      statusText = '待交接';
    } else if (order.status === 'first-mile') {
      status = 'delivering';
      statusText = '配送中';
    } else if (order.riderId) {
      status = 'delivering';
      statusText = pkg?.status === 'picked' ? '已取货，待出发' : '已接单，待取货';
    } else {
      status = 'available';
      statusText = '待接单';
    }
    return {
      id: `task-${role}-${order.id}`,
      orderId: order.id,
      packageNo: pkg?.id ?? `PKG-${order.orderNo.slice(-8)}`,
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
      // 金额口径统一（IK8W5L）：Commission 记录优先，未送达按规则预览，兜底常量（单位:分）。
      commission:
        commissionByOrder?.get(String(order.id)) ??
        (rules
          ? (bestMatch(rules, dimsOfOrder(order))?.price ?? COMMISSION_PER_ORDER)
          : COMMISSION_PER_ORDER),
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
        pkg?.status === 'picked',
      ),
    };
  }
  private actions(
    role: StaffRole,
    status: string,
    riderId?: string | null,
    viewerId?: string,
    picked = false,
  ) {
    if (role === 'building-manager') {
      if (status === 'waiting-handover') return ['receive'];
      if (status === 'last-mile')
        return ['start-delivery', 'delivered', 'absent'];
      return [];
    }
    if (['waiting-first-mile', 'paid', 'picking'].includes(status)) {
      // 无归属单只能抢（accept/grab）；本人已抢到的单才能取货/出发/转单。
      if (!riderId) return ['accept'];
      if (viewerId && riderId !== viewerId) return [];
      return picked ? ['depart', 'transfer'] : ['pickup', 'transfer'];
    }
    if (status === 'first-mile') return ['arrive', 'transfer'];
    if (status === 'waiting-handover')
      return viewerId && riderId === viewerId ? ['handover', 'transfer'] : [];
    if (status === 'last-mile')
      return viewerId && riderId === viewerId ? ['handover'] : [];
    return [];
  }
}
