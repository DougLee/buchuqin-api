import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
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
/** 渠道推送上下文（IK8W5M）：事务内赋值、提交后发送。 */
interface PushContext {
  orderId: string;
  userId: string;
  orderNo: string;
  status: string;
  statusText: string;
  payableAmount: number;
  notifyManager: boolean;
  campusId: string;
  address: unknown;
}

@Injectable()
export class FulfillmentService {
  constructor(
    private readonly db: PrismaService,
    private readonly commissionService: CommissionService = new CommissionService(
      db,
    ),
    // 渠道推送（IK8W5M）：可选注入——测试不传时跳过推送。
    @Optional() private readonly push?: NotificationsService,
  ) {}

  async profile(staffId: string) {
    const s = await this.db.staff.findUnique({
      where: { id: staffId },
      // IKAJT4：顶部校区信息接口化——归属校区名/仓名随档案下发
      include: { campus: { select: { name: true, warehouseName: true } } },
    });
    if (!s) throw new NotFoundException('履约人员不存在');
    const { campus, ...rest } = s;
    return {
      ...rest,
      campusName: campus?.name ?? '',
      campusWarehouseName: campus?.warehouseName ?? '',
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
      const proof = (order.package as JsonMap | null)?.proof as
        JsonMap | undefined;
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
  /** 订单归属：楼长按楼栋（IKAFP4 读写一致），配送员按校园全量。 */
  private attributedOrders<T extends { address: unknown }>(
    staff: { role: string; buildingId: string | null; building: string },
    orders: T[],
  ): T[] {
    return staff.role === 'building-manager'
      ? orders.filter((x) =>
          this.isOwnBuilding(staff, x.address as JsonMap),
        )
      : orders;
  }
  /** 同楼判定（IKAFP4）：buildingId 为准（快照含真实 id，改名不影响归属）；
   *  无 buildingId 的历史快照回退楼栋名比对，保证旧单仍可见。 */
  private isOwnBuilding(
    staff: { buildingId: string | null; building: string },
    address: JsonMap,
  ): boolean {
    if (address.buildingId != null)
      return String(address.buildingId) === String(staff.buildingId);
    return String(address.buildingName) === staff.building;
  }
  async tasks(staffId: string, status?: string) {
    const staff = await this.profile(staffId);
    const manager = staff.role === 'building-manager';
    const orders = this.attributedOrders(
      staff,
      await this.db.order.findMany({
        where: {
          campusId: staff.campusId,
          status: { notIn: ['pending-payment', 'cancelled', 'refunded'] },
          // 骑手视图：已被其他配送员接走的单不再出现在任务池。
          ...(!manager
            ? { OR: [{ riderId: null }, { riderId: staffId }] }
            : {}),
        },
        orderBy: { createdAt: 'desc' },
      }),
    );
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
    // 返回值 = 渠道推送上下文（IK8W5M）：事务提交后 fire-and-forget；accept 不改状态返回 null。
    const pushDone = await this.db.$transaction(
      async (tx): Promise<PushContext | null> => {
        const order = await tx.order.findFirst({
          where: { id: orderId, campusId: staff.campusId },
        });
        if (!order) throw new NotFoundException('履约任务不存在');
        const manager = staff.role === 'building-manager';
        // IKAFP4：楼长动作校验楼栋归属——列表过滤只是展示口径，
        // 这里堵住直调接口对他楼订单 receive/delivered 的横向越权。
        if (manager && !this.isOwnBuilding(staff, order.address as JsonMap))
          throw new ForbiddenException('非本楼订单，无权操作');
        // 动作迁移表（12 态状态机，迁移表全文见 src/common/order-state.ts，IK93GQ）：
        // v1 履约简化（IKA0UM，2026-08-20）：去掉扫码取货/配送单——骑手 accept 抢单
        // 只写归属不改状态，depart 按钮直接进 first-mile（配送中），无 pickup 动作；
        // 交接（IKA0UP）改为拍照凭证，不再扫寝室二维码。
        // 旧机兼容：first-mile 仍可 receive、last-mile 仍可 handover。
        const maps: Record<
          string,
          { status: string; text: string; from: string[] }
        > = manager
          ? {
              receive: {
                status: 'last-mile',
                text: '楼长已接货，待送到寝室',
                from: ['waiting-handover', 'first-mile', 'last-mile'],
              },
              // IKA580：去「开始送往寝室」——接货后直接「已送到寝室」。
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
                from: ['waiting-first-mile'],
              },
              depart: {
                status: 'first-mile',
                text: '配送中，骑手已出发',
                from: ['waiting-first-mile'],
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
                from: ['waiting-first-mile', 'first-mile', 'waiting-handover'],
              },
            };
        const next = maps[action];
        if (!next || !next.from.includes(order.status))
          // IKA0UO 状态机断链提示：未出库的单给出具体缺口，其余报当前状态。
          throw new BadRequestException(
            ['paid', 'picking'].includes(order.status)
              ? '订单尚未出库，请先在管理后台完成出库'
              : `当前订单状态为「${order.statusText}」，不能执行此操作`,
          );
        // 配送员动作仅限接单人本人操作（accept 通过下方条件更新抢归属）。
        if (!manager && order.riderId && order.riderId !== staffId)
          throw new BadRequestException('任务已被其他配送员接取');
        // 交接凭证（IKA0UP）：拍照上传取代扫寝室二维码，至少 1 张。
        if (action === 'handover' && !payload.images?.length)
          throw new BadRequestException('请拍摄交接凭证照片');
        // 送达凭证（IKA580）：弹窗确认，凭证照片或备注二选一即可
        // （用户不在放某地等场景以备注留证，定位尽力而为不强求）。
        if (
          action === 'delivered' &&
          !payload.images?.length &&
          !payload.reason
        )
          throw new BadRequestException('请上传送达凭证或填写备注');
        // 进入目标状态时点亮对应 timeline 节点（楼下待交接节点由 arrive 写入）。
        const timeline = markTimelineStep(order.timeline, next.status);
        // delivered 时把送达凭证（照片/定位/坐标/备注）写入包裹信息，供绩效凭证完整率统计；
        // handover（IKA0UP）把交接照片凭证写入包裹信息（1 分钟复用由客户端实现）。
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
                    remark: payload.reason ?? '',
                    time: new Date().toISOString(),
                  },
                } as Prisma.InputJsonValue,
              }
            : action === 'handover'
              ? {
                  package: {
                    ...((order.package as JsonMap | null) ?? {}),
                    handoverProof: {
                      images: payload.images ?? [],
                      time: new Date().toISOString(),
                    },
                  } as Prisma.InputJsonValue,
                }
              : {};
        if (action === 'accept' || action === 'grab') {
          // 抢单互斥：riderId 为空才允许写入归属，并发的第二个 accept/grab count=0 失败。
          // 仅已出库（waiting-first-mile）可接单——未出库单先走后台出库（IKA0UO 断链修复）。
          const won = await tx.order.updateMany({
            where: {
              id: order.id,
              riderId: null,
              status: 'waiting-first-mile',
            },
            data: { riderId: staffId, statusText: '配送员已接单' },
          });
          if (!won.count)
            throw new BadRequestException('任务已被其他配送员接取');
          return null;
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
            timeline: timeline,
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
        // 渠道推送上下文（IK8W5M）：事务提交后 fire-and-forget，不进事务。
        return {
          orderId: order.id,
          userId: order.userId,
          orderNo: order.orderNo,
          status: next.status,
          statusText: next.text,
          payableAmount: order.payableAmount,
          notifyManager: action === 'arrive',
          campusId: staff.campusId,
          address: order.address,
        };
      },
    );
    // 渠道推送：一级配送中/即将到楼/已送达 订阅消息（已送达带短信兜底）；
    // arrive（即将到楼）同步企微通知楼长（env 门控，未配置静默跳过）。
    if (pushDone) {
      void this.push?.orderStatusPush({
        id: pushDone.orderId,
        userId: pushDone.userId,
        orderNo: pushDone.orderNo,
        status: pushDone.status,
        statusText: pushDone.statusText,
        payableAmount: pushDone.payableAmount,
      });
      if (pushDone.notifyManager) {
        const addr = pushDone.address as JsonMap;
        // 2026-09-09：企微通道接收人角色与订阅消息对齐（含实习楼长）。
        const manager = await this.db.staff.findFirst({
          where: {
            campusId: pushDone.campusId,
            role: { in: ['building-manager', 'intern-building-manager'] },
            status: { not: 'deleted' },
            OR: [
              { buildingId: String(addr?.buildingId ?? '') },
              { building: String(addr?.buildingName ?? '') },
            ],
          },
        });
        if (manager)
          void this.push?.wecomToStaff(
            manager.staffNo,
            `订单 ${pushDone.orderNo} 已到楼下，请准备交接`,
          );
        // IKDQP9：到楼待交接 → 订阅消息通知该楼栋楼长（含全部匹配楼长；
        // 上面 wecomToStaff 仅企微单通道，此处为微信订阅消息主通道）
        void this.push?.notifyManagerOnArrive(pushDone.orderId);
      }
    }
    return this.task(staffId, id);
  }
  /**
   * 订阅消息额度上报/查询（IKDQP9，一法两用）：count>0 为授权上报（+N，
   * 上限 10 防脏数据），count=0 为纯查询。返回水位与当日失败标记——
   * 骑手端据此决定静默攒几条 & 是否显示低水位提示条。
   */
  async grantNotifyQuota(staffId: string, count: number) {
    const safe = Math.min(10, Math.max(0, Math.floor(Number(count) || 0)));
    if (safe > 0)
      await this.db.staff.update({
        where: { id: staffId },
        data: { notifyQuota: { increment: safe } },
      });
    const s = await this.db.staff.findUniqueOrThrow({
      where: { id: staffId },
      select: { notifyQuota: true, notifyQuotaFailedAt: true },
    });
    // 北京时间今天 0 点（容器 UTC，+8 偏移后取当日零点）
    const cnMidnight = new Date(Date.now() + 8 * 3600_000);
    cnMidnight.setUTCHours(0, 0, 0, 0);
    return {
      quota: s.notifyQuota,
      lowWater: s.notifyQuota < 5,
      failedToday:
        !!s.notifyQuotaFailedAt &&
        s.notifyQuotaFailedAt.getTime() >= cnMidnight.getTime(),
    };
  }
  async leave(staffId: string) {
    return this.db.leaveRequest.findMany({
      where: { staffId },
      orderBy: { createdAt: 'desc' },
    });
  }
  /** 可选代班楼长列表（IKA57Y）：同校园楼长（排除自己），请假「自己调配」时选。 */
  async managers(staffId: string) {
    const me = await this.db.staff.findUnique({ where: { id: staffId } });
    if (!me) throw new NotFoundException('员工不存在');
    return this.db.staff.findMany({
      // 角色键为 building-manager（Staff.role 字典），冒烟曾误写 manager 致空列表
      where: {
        campusId: me.campusId,
        role: 'building-manager',
        id: { not: staffId },
      },
      orderBy: [{ building: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, building: true },
    });
  }
  async createLeave(staffId: string, dto: LeaveRequestDto) {
    if (new Date(dto.startAt).getTime() <= Date.now() + 7200000)
      throw new BadRequestException('请假需至少提前 2 小时提交');
    // IKA57Y：自己调配必须指定代班楼长（同校园、在职楼长，且不能是自己）
    let substitute: { id: string; name: string } | null = null;
    if ((dto.dispatchMode ?? 'platform') === 'self') {
      if (!dto.substituteStaffId)
        throw new BadRequestException('自己调配需选择代班楼长');
      const candidate = await this.db.staff.findUnique({
        where: { id: dto.substituteStaffId },
      });
      const me = await this.db.staff.findUnique({ where: { id: staffId } });
      if (!candidate || candidate.role !== 'building-manager')
        throw new BadRequestException('代班对象不存在或不是楼长');
      if (candidate.campusId !== me?.campusId)
        throw new BadRequestException('代班楼长必须为同校园员工');
      if (candidate.id === staffId)
        throw new BadRequestException('不能选择自己作为代班楼长');
      substitute = { id: candidate.id, name: candidate.name };
    }
    return this.db.leaveRequest.create({
      data: {
        staffId,
        startAt: new Date(dto.startAt),
        endAt: new Date(dto.endAt),
        reason: dto.reason,
        // IK9U4B：调配方式随请假单落库，后台审核按此核对派单策略
        dispatchMode: dto.dispatchMode ?? 'platform',
        // IKA57Y：代班楼长 id + 姓名快照（人员改名后请假单仍可核对）
        substituteStaffId: substitute?.id,
        substituteName: substitute?.name,
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
   * 底薪口径（IKDOIU）：校区维度后台配置（Campus.buildingManagerBaseSalary，
   * 分，0=无底薪），与月度账单 BmBill/settlements 同源——原硬编码 50000 退役。
   */
  async commissions(staffId: string, month?: string) {
    const s = await this.profile(staffId);
    const period = month ?? new Date().toISOString().slice(0, 7);
    const { records, commissionTotal, adjustment } =
      await this.commissionService.monthly(staffId, period);
    const campus = await this.db.campus.findUnique({
      where: { id: s.campusId },
      select: { buildingManagerBaseSalary: true },
    });
    const base =
      s.role === 'building-manager' ? campus?.buildingManagerBaseSalary ?? 0 : 0;
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
      statusText =
        order.status === 'delivered' ? '已送达，待确认收货' : '已完成';
    } else if (['exception', 'after-sales'].includes(order.status)) {
      status = 'exception';
      statusText = '异常处理中';
    } else if (manager) {
      // IKAFP5：楼长专属任务视图，与履约端楼长五 tab 一一对应——
      // 待接货(waiting-handover)/待送到寝室(last-mile)/待到楼(其余在途)；
      // completed/exception 由上方公共分支先判，不再混进 waiting。
      if (order.status === 'last-mile') {
        status = 'delivering';
        statusText = '待送到寝室';
      } else if (order.status === 'waiting-handover') {
        status = 'waiting';
        statusText = '待接货';
      } else {
        status = 'incoming';
        statusText = '待到楼';
      }
    } else if (order.status === 'last-mile') {
      // 旧机残留（arrive 直达 last-mile 且未交接）仍归骑手待交接。
      status = 'waiting';
      statusText = '待交接';
    } else if (order.status === 'waiting-handover') {
      status = 'waiting';
      // IKA57T：交接完成后不再回显「待交接」——按交接凭证切换文案，
      // 骑手动作清空（IKA0UP 交接只改文案不改状态，靠此标记推进视图）。
      statusText = pkg?.handoverProof ? '已交接，待楼长接货' : '待交接';
    } else if (order.status === 'first-mile') {
      status = 'delivering';
      statusText = '配送中';
    } else if (order.riderId) {
      status = 'delivering';
      statusText = '已接单，待出发';
    } else {
      status = 'available';
      statusText = '待接单';
    }
    return {
      id: `task-${role}-${order.id}`,
      orderId: order.id,
      // IKA57O：对外统一展示订单号，配送单号仅内部保留
      orderNo: order.orderNo,
      packageNo: pkg?.id ?? `PKG-${order.orderNo.slice(-8)}`,
      status,
      statusText,
      building: String(a.buildingName),
      floor: Number(a.floor),
      room: String(a.room),
      // 收件人联系渠道（IK9AWW）：配送员「用户不在」时可直接拨打；
      // 展示端做脱敏，拨号需真实号。隐私升级（虚拟中转号）后续评估。
      recipientName: String(a.contactName ?? ''),
      recipientPhone: String(a.phone ?? ''),
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
          ? (bestMatch(rules, dimsOfOrder(order))?.price ??
            COMMISSION_PER_ORDER)
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
        Boolean(pkg?.handoverProof),
      ),
    };
  }
  private actions(
    role: StaffRole,
    status: string,
    riderId?: string | null,
    viewerId?: string,
    handedOver = false,
  ) {
    if (role === 'building-manager') {
      if (status === 'waiting-handover') return ['receive'];
      // IKA580：接货后直达「已送到寝室」（去 start-delivery），异常分支保留。
      if (status === 'last-mile') return ['delivered', 'absent'];
      return [];
    }
    // 骑手动作仅认已出库的单（IKA0UM 简化：无扫码取货，depart 直接配送中）。
    if (status === 'waiting-first-mile') {
      // 无归属单只能抢（accept/grab）；本人已抢到的单才能出发/转单。
      if (!riderId) return ['accept'];
      if (viewerId && riderId !== viewerId) return [];
      return ['depart', 'transfer'];
    }
    if (status === 'first-mile') return ['arrive', 'transfer'];
    if (status === 'waiting-handover') {
      if (!(viewerId && riderId === viewerId)) return [];
      // IKA57T：已交接（凭证已传）就不再显示「拍照交接」，避免看起来卡死。
      return handedOver ? [] : ['handover', 'transfer'];
    }
    if (status === 'last-mile')
      return viewerId && riderId === viewerId ? ['handover'] : [];
    return [];
  }
}
