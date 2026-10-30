import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AdminService } from '../admin/admin.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  markTimelineStep,
  ORDER_STATUS_TEXT,
} from '../common/order-state';
import {
  campusOrganizationId,
  campusStaffDelivery,
} from '../common/organization';
import { CommissionService } from '../commission/commission.service';
import type { LeaveRequestDto, TaskActionDto } from './dto';

export type StaffRole =
  | 'building-manager'
  | 'intern-building-manager'
  | 'fulltime-rider'
  | 'parttime-rider';
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
  /** 道哥 2026-09-09：配送中（first-mile，骑手出发）也通知楼长——双时点提醒 */
  notifyManagerDepart: boolean;
  campusId: string;
  address: unknown;
}

@Injectable()
export class FulfillmentService {
  constructor(
    private readonly db: PrismaService,
    // IKKTTP 楼长作战地图：复用后台整栋三色格/寝室详情逻辑（AdminService 在
    // AppModule providers，注入无环；Optional 兼容既有单测直接 new 的用法）
    @Optional() private readonly admin?: AdminService,
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
    // IKP34J：服务号关注引导二维码按校区组织下发（组织未配/无归属=空串，
    // 前端隐藏入口）；仅配送端需要，用户端 gzh 引导不在本 issue 范围
    const organizationId = await campusOrganizationId(this.db, s.campusId);
    const org = organizationId
      ? await this.db.organization.findUnique({
          where: { id: organizationId },
          select: { gzhQrcodeUrl: true },
        })
      : null;
    return {
      ...rest,
      gzhQrcodeUrl: org?.gzhQrcodeUrl ?? '',
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
  /** 骑手/楼长自助改号（IKP0AP）：履约端 token 即本人凭证（controller auth()
   *  已锁 staffId=req.user.id），只更新 phone；格式校验在 UpdateProfileDto。
   *  返回最新档案，前端直接回显。 */
  async updateProfile(staffId: string, d: { phone?: string }) {
    if (d.phone !== undefined)
      await this.db.staff.update({
        where: { id: staffId },
        data: { phone: d.phone },
      });
    return this.profile(staffId);
  }
  /** 一键获取本机手机号并落档（道哥 2026-10-20 自助改号增强）：wx
   *  getPhoneNumber code → 组织履约凭证换手机号 → 直写本人 phone。
   *  push 未注入（部分单测）或微信侧失败抛错，前端引导手输兜底。 */
  async updateProfilePhoneByWechat(staffId: string, code: string) {
    if (!this.push)
      throw new BadRequestException('手机号获取通道未启用');
    const s = await this.profile(staffId);
    let phone: string;
    try {
      phone = await this.push.fetchDeliveryPhoneNumber(s.campusId, code);
    } catch (e) {
      throw new BadRequestException(
        e instanceof Error ? e.message : '获取手机号失败，请手动输入',
      );
    }
    await this.db.staff.update({
      where: { id: staffId },
      data: { phone },
    });
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
        // IKKTTP 首页金额四联（楼长推广激励看板）
        todayGmv: performance.todayGmv,
        todayIncome: performance.todayIncome,
        monthGmv: performance.monthGmv,
      },
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
    // 推广订单金额（IKIRO6）：归属订单中完成单的实付合计——今日/本月两个口径，
    // 激励看板（督促按单推广），与佣金体系无关。
    const monthStart = startOfToday;
    monthStart.setDate(1);
    const inMonth = (x: (typeof completed)[number]) =>
      (deliveredAt(x)?.getTime() ?? 0) >= monthStart.getTime();
    const gmvOf = (list: Array<{ payableAmount: number }>) =>
      list.reduce((sum, x) => sum + Number(x.payableAmount ?? 0), 0);
    const rate = (n: number, d: number) =>
      d ? Number(((n / d) * 100).toFixed(1)) : 0;
    // 收入口径统一（IK8W5L）：本月 Commission 记录合计（含负向调整），不再按单数×常量估算。
    const period = new Date().toISOString().slice(0, 7);
    const incomeAgg = await this.db.commission.aggregate({
      where: { staffId, period },
      _sum: { amount: true },
    });
    // IKKTTP 今日收入：今日落账的 Commission 合计（含负向调整），与本月口径同源
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const todayIncomeAgg = await this.db.commission.aggregate({
      where: { staffId, createdAt: { gte: dayStart } },
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
      // IKIRO6：推广订单金额（分）——今日/本月（送达时间口径，与 completed 一致）
      todayGmv: gmvOf(completedToday),
      monthGmv: gmvOf(completed.filter(inMonth)),
      monthOrders: completed.filter(inMonth).length,
      income: incomeAgg._sum.amount ?? 0,
      // IKKTTP 首页金额四联：今日/本月 × 销售额/收入（income=本月佣金合计）
      todayIncome: todayIncomeAgg._sum.amount ?? 0,
      onTimeRate: rate(onTime.length, completed.length),
      proofRate: rate(withProof.length, completed.length),
      exceptionRate: rate(
        mine.filter((x) => x.status === 'exception').length,
        mine.length,
      ),
    };
  }
  /** 订单归属：楼长（含实习）按楼栋（IKAFP4 读写一致；道哥 2026-10-30
   *  实习楼长同正式楼长只看本楼栋，不再全量），配送员按校园全量。 */
  private attributedOrders<T extends { address: unknown }>(
    staff: { role: string; buildingId: string | null; building: string },
    orders: T[],
  ): T[] {
    return ['building-manager', 'intern-building-manager'].includes(staff.role)
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
  async tasks(staffId: string, status?: string, buildingId?: string) {
    const staff = await this.profile(staffId);
    // IKKRMV：后台员工配送（staff_delivery）组织的校区不进骑手任务列表
    // ——订单出库后不进骑手任务池（不入池不通知），配送与送达由后台订单
    // 动作（staff-deliver/staff-complete）推进；rider_delivery 校区不变。
    if (await campusStaffDelivery(this.db, staff.campusId)) return [];
    const manager = ['building-manager', 'intern-building-manager'].includes(
      staff.role,
    );
    const orders = this.attributedOrders(
      staff,
      (
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
        })),
    )
      .filter(
        (order) =>
          !manager ||
          (order.package as JsonMap | null)?.lastMileMode !==
          'customer-pickup',
      )
      .filter((o) => {
        // IKRMQF（道哥 2026-10-30）：楼栋筛选——骑手看板按地址快照 buildingId 精确过滤
        if (!buildingId) return true;
        const a = o.address as JsonMap | null;
        return String(a?.buildingId ?? '') === buildingId;
      });
    // 提成展示口径统一（IK8W5L）：已生成的 Commission 记录优先，未送达单按规则预览。
    const riderIds = [
      ...new Set(
        orders
          .map((o) => o.riderId)
          .filter((v): v is string => Boolean(v)),
      ),
    ];
    // IKQFG4：提成预览改校区配送费直取（规则表废弃），不再 loadRules
    const [campusFees, records, riders] = await Promise.all([
      this.db.campus.findUnique({
        where: { id: staff.campusId },
        select: { deliveryFeeInstant: true, deliveryFeeScheduled: true },
      }),
      this.db.commission.findMany({
        where: { staffId, orderId: { in: orders.map((o) => o.id) } },
      }),
      // 骑手信息（IKP0AP）：楼长/骑手任务卡带配送员姓名+电话，一条 in 批查防 N+1
      riderIds.length
        ? this.db.staff.findMany({
            where: { id: { in: riderIds } },
            select: { id: true, name: true, phone: true },
          })
        : Promise.resolve(
            [] as Array<{ id: string; name: string; phone: string }>,
          ),
    ]);
    const commissionByOrder = new Map(
      records.map((r) => [r.orderId, r.amount]),
    );
    const riderById = new Map(
      riders.map((r) => [r.id, { name: r.name, phone: r.phone }]),
    );
    const buildingGenderById = await this.buildingGenderByOrder(orders);
    const result = orders.map((o) =>
      this.toTask(
        o as unknown as JsonMap,
        staff.role as StaffRole,
        staff.id,
        commissionByOrder,
        campusFees ?? { deliveryFeeInstant: 0, deliveryFeeScheduled: 0 },
        staff.campusWarehouseName,
        riderById,
        buildingGenderById,
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
   * IKKRMV：staff_delivery 组织的校区抢单池恒空（不入池；出库侧亦不派单
   * 通知，见 NotificationsService.notifyRidersOnFirstMile）。
   */
  async availableTasks(staffId: string, buildingId?: string) {
    const staff = await this.profile(staffId);
    if (await campusStaffDelivery(this.db, staff.campusId)) return [];
    const orders = await this.db.order.findMany({
      where: {
        campusId: staff.campusId,
        status: 'waiting-first-mile',
        riderId: null,
        // IKRMQF（道哥 2026-10-30）：抢单池楼栋筛选——骑手按楼栋抢
        ...(buildingId
          ? {
              address: {
                path: ['buildingId'],
                equals: buildingId,
              },
            }
          : {}),
      },
      orderBy: { createdAt: 'asc' },
    });
    const campusFees = await this.db.campus.findUnique({
      where: { id: staff.campusId },
      select: { deliveryFeeInstant: true, deliveryFeeScheduled: true },
    });
    const buildingGenderById = await this.buildingGenderByOrder(orders);
    return orders.map((o) =>
      this.toTask(
        o as unknown as JsonMap,
        staff.role as StaffRole,
        staff.id,
        undefined,
        campusFees ?? { deliveryFeeInstant: 0, deliveryFeeScheduled: 0 },
        staff.campusWarehouseName,
        undefined,
        buildingGenderById,
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
    // IKKRMV：staff_delivery 校区订单无骑手任务——任务列表/抢单池已空，
    // 池外直调动作（accept/depart/…）同样拒绝；配送与送达由后台订单动作
    // 推进。动作按校区过滤（下方 order 查询限本校区），校区级检查即订单级。
    if (await campusStaffDelivery(this.db, staff.campusId))
      throw new BadRequestException(
        '该校区为后台员工配送模式，骑手端无配送任务',
      );
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
        const manager = [
          'building-manager',
          'intern-building-manager',
        ].includes(staff.role);
        const packageSnapshot = (order.package as JsonMap | null) ?? {};
        const customerPickup =
          packageSnapshot.lastMileMode === 'customer-pickup';
        // IKAFP4：楼长动作校验楼栋归属——列表过滤只是展示口径，
        // 这里堵住直调接口对他楼订单 receive/delivered 的横向越权。
        if (manager && !this.isOwnBuilding(staff, order.address as JsonMap))
          throw new ForbiddenException('非本楼订单，无权操作');
        // IKRQFK（道哥 2026-10-30 拍板方案一）：转单即释放回抢单池——
        // 原实现转 exception「转单申请处理中」且 riderId 残留，无审批流、
        // 无重新派单入口，其他骑手永远看不到（实测范佳柱不可见），单卡死。
        // 新语义：清归属 + 回 waiting-first-mile 待接单，其他骑手立即可抢；
        // 配送中/待交接转单=货回仓语义（末端节点回退为未完成）。
        if (action === 'transfer') {
          if (manager) throw new BadRequestException('楼长任务无需转单');
          if (order.riderId !== staffId)
            throw new BadRequestException('仅可转单自己接取的任务');
          if (
            !['waiting-first-mile', 'first-mile', 'waiting-handover'].includes(
              order.status,
            )
          )
            throw new BadRequestException(
              `当前订单状态为「${order.statusText}」，不能转单`,
            );
          const timeline = ((order.timeline as JsonMap[]) ?? []).map((step) =>
            [
              'first-mile',
              'waiting-handover',
              'ready-to-deliver',
              'last-mile',
            ].includes(step.key)
              ? { ...step, done: false, time: undefined }
              : step,
          );
          const released = await tx.order.updateMany({
            where: { id: order.id, status: order.status, riderId: staffId },
            data: {
              status: 'waiting-first-mile',
              riderId: null,
              statusText: ORDER_STATUS_TEXT['waiting-first-mile'],
              timeline: timeline as unknown as Prisma.InputJsonValue,
            },
          });
          if (!released.count)
            throw new BadRequestException('订单状态已变化，请刷新');
          return null; // 回池不重发派单通知（推送时点在出库，超本改动范围）
        }
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
              ...(customerPickup
                ? {
                    delivered: {
                      status: 'delivered',
                      text: '已送到楼下，待用户确认',
                      from: ['first-mile'],
                    },
                  }
                : {}),
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
        if (
          action === 'delivered' &&
          customerPickup &&
          !payload.images?.length
        )
          throw new BadRequestException('用户楼下取货必须上传送达凭证照片');
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
          notifyManagerDepart: action === 'depart',
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
      // 道哥 2026-09-09：配送中（骑手出发）也通知楼长——提前准备接货，
      // 与「到楼下」构成双时点提醒（fire-and-forget 静默）
      if (pushDone.notifyManagerDepart)
        void this.push?.notifyManagersOnDepart(pushDone.orderId);
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
      select: { notifyQuota: true, notifyQuotaFailedAt: true, gzhOpenid: true },
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
      // IKI3ZP：服务号绑定状态——骑手端据此展示「关注服务号」引导
      gzhBound: !!s.gzhOpenid,
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

  /** IKRMQF（道哥 2026-10-30）：任务看板楼栋筛选——骑手所在校区在职楼栋 */
  async campusBuildings(campusId: string) {
    return this.db.building.findMany({
      where: { campusId, status: 'active' },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }
  /** IKRMQF：楼栋性别批查——任务卡显示男寝/女寝徽标（按地址快照 buildingId
   *  实时查楼栋表，存量单快照无 gender 也能显示当前归属） */
  private async buildingGenderByOrder(
    orders: Array<{ address?: unknown }>,
  ): Promise<Map<string, string>> {
    const ids = [
      ...new Set(
        orders
          .map((o) => String((o.address as JsonMap | null)?.buildingId ?? ""))
          .filter(Boolean),
      ),
    ];
    if (!ids.length) return new Map();
    const rows = await this.db.building.findMany({
      where: { id: { in: ids } },
      select: { id: true, gender: true },
    });
    return new Map(rows.map((r) => [r.id, r.gender]));
  }

  private toTask(
    order: JsonMap,
    role: StaffRole,
    viewerId?: string,
    commissionByOrder?: Map<string, number>,
    /** IKQFG4：提成预览改校区配送费直取（规则表废弃） */
    campusFees?: { deliveryFeeInstant: number; deliveryFeeScheduled: number },
    /** 任务所属校区仓库名（2026-10-19 道哥：多组织后硬编码「湖工大校园仓」
     *  串味——武工院楼长任务卡显示湖工大仓库。profile 的 campusWarehouseName
     *  早已接口化（IKAJT4），此处补齐同源取值。 */
    warehouseName?: string,
    /** 骑手信息表（IKP0AP）：staffId → {name, phone}，tasks() 一条 in 批查预载；
     *  未传/未接单/抢单池（riderId 恒空）时 rider 为 null。 */
    riderById?: Map<string, { name: string; phone: string }>,
    /** IKRMQF：楼栋性别表 buildingId → male/female/mixed，任务卡性别徽标 */
    buildingGenderById?: Map<string, string>,
  ) {
    const a = order.address as JsonMap,
      items = order.items as JsonMap[],
      manager = ['building-manager', 'intern-building-manager'].includes(role);
    const pkg = order.package as JsonMap | null;
    // 12 态状态机的任务视图（IK93GQ）：
    // available 仅保留给无归属的待一级配送单（waiting-first-mile/paid/picking）。
    let status: string, statusText: string;
    if (['completed', 'delivered'].includes(order.status)) {
      status = 'completed';
      statusText =
        order.status === 'delivered'
          ? pkg?.lastMileMode === 'customer-pickup'
            ? '已送到楼下，待用户确认'
            : '已送达，待确认收货'
          : '已完成';
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
      // IKRMQF：楼栋性别（male/female/mixed）——配送端显示男寝/女寝徽标
      buildingGender: a.buildingId
        ? (buildingGenderById?.get(String(a.buildingId)) ?? "mixed")
        : "mixed",
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
      lastMileMode:
        pkg?.lastMileMode === 'customer-pickup'
          ? 'customer-pickup'
          : 'building-manager',
      // IKI7LZ：deadline（estimatedArrival 纯时段文案跨天歧义）退出骑手端，
      // 改展示「下单时间（北京时间）」——客观数据零歧义
      orderedAt: (() => {
        const t = new Date(
          (order.paidAt ?? order.createdAt ?? new Date()).getTime() +
            8 * 3600_000,
        );
        const iso = t.toISOString();
        // 道哥 2026-09-24：带年份（YYYY-MM-DD HH:mm）
        return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
      })(),
      warehouse: warehouseName ?? '',
      // 骑手联系信息（IKP0AP）：任务卡展示接单配送员姓名+电话（交接场景楼长
      // 可直接联系骑手）；未接单/抢单池为 null。
      rider: order.riderId
        ? (riderById?.get(String(order.riderId)) ?? null)
        : null,
      // 金额口径（IK8W5L→IKQFG4）：Commission 记录优先，未送达按校区
      // 配送费直取预览（即时达/预约达），与送达落账同源（单位:分）。
      commission:
        commissionByOrder?.get(String(order.id)) ??
        (order.deliveryMode === 'scheduled'
          ? (campusFees?.deliveryFeeScheduled ?? 0)
          : (campusFees?.deliveryFeeInstant ?? 0)),
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
        pkg?.lastMileMode,
      ),
    };
  }
  private actions(
    role: StaffRole,
    status: string,
    riderId?: string | null,
    viewerId?: string,
    handedOver = false,
    lastMileMode?: string,
  ) {
    if (['building-manager', 'intern-building-manager'].includes(role)) {
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
    if (status === 'first-mile')
      return lastMileMode === 'customer-pickup'
        ? ['delivered', 'transfer']
        : ['arrive', 'transfer'];
    if (status === 'waiting-handover') {
      if (!(viewerId && riderId === viewerId)) return [];
      // IKA57T：已交接（凭证已传）就不再显示「拍照交接」，避免看起来卡死。
      return handedOver ? [] : ['handover', 'transfer'];
    }
    if (status === 'last-mile')
      return viewerId && riderId === viewerId ? ['handover'] : [];
    return [];
  }
  /** IKKTTP 楼长作战地图：整栋三色格（按楼长绑定楼栋） */
  async battleMap(staffId: string) {
    const staff = await this.db.staff.findUnique({ where: { id: staffId } });
    if (!staff?.buildingId)
      throw new NotFoundException('未绑定楼栋（作战地图仅楼长可用）');
    if (!this.admin) throw new Error('AdminService 未注入');
    return this.admin.battleMapBuilding(staff.campusId, staff.buildingId);
  }
  /** IKKTTP 楼长作战地图：寝室详情（校验归属楼长绑定楼栋） */
  async battleMapRoom(staffId: string, roomId: string) {
    const staff = await this.db.staff.findUnique({ where: { id: staffId } });
    if (!staff?.buildingId)
      throw new NotFoundException('未绑定楼栋（作战地图仅楼长可用）');
    const room = await this.db.room.findUnique({ where: { id: roomId } });
    if (!room || room.buildingId !== staff.buildingId)
      throw new NotFoundException('寝室不存在');
    if (!this.admin) throw new Error('AdminService 未注入');
    return this.admin.battleMapRoom(staff.campusId, roomId);
  }

}
