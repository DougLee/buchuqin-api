import type { Prisma } from '@prisma/client';

/**
 * 订单状态机（PRD §11.1，12 态）（IK93GQ）。
 *
 * 迁移表（--动作(操作角色)-->）：
 *   pending-payment  --pay(用户/支付回调)-->                paid
 *   paid             --advance(admin：开始拣货)-->          picking
 *   picking          --advance(admin：拣货完成)-->          waiting-first-mile（待一级配送，骑手可抢）
 *   waiting-first-mile --accept/grab(骑手抢单，写 riderId，状态不变)--> waiting-first-mile
 *   waiting-first-mile --pickup(骑手扫码取货，package.status=picked)--> waiting-first-mile
 *   waiting-first-mile --depart(骑手出发)-->                first-mile（一级配送中）
 *   first-mile       --arrive(骑手到楼下)-->                waiting-handover（楼下待交接）
 *   waiting-handover --receive(楼长接货)-->                 last-mile（二级配送中）
 *   last-mile        --start-delivery(楼长开始上楼)-->      last-mile
 *   last-mile        --delivered(楼长送达+凭证)-->          delivered（已送达）
 *   delivered        --confirm-receipt(用户确认收货)-->     completed（已完成）
 *
 * 旁路/终态：
 *   pending-payment --cancel(用户)/超时关单(懒执行+Cron)-->  cancelled
 *   paid            --cancel(用户，自动退款)-->              cancelled
 *   waiting-first-mile/first-mile/waiting-handover/last-mile
 *                   --transfer(骑手转单)/absent(用户不在)/refused(拒收)/mark-exception(admin)--> exception
 *   delivered/completed --售后审核通过(admin)-->            refunded
 *
 * 历史单兼容（旧 9 态语义并入新机）：
 *   paid/picking 仍可 accept/pickup（pickup 后统一落入 waiting-first-mile）；
 *   first-mile 仍可 receive（旧机 arrive 直达 last-mile 的单）。
 *
 * timeline 节点（新单 5 步，约定：进入某状态时把对应节点置 done）：
 *   paid(支付成功) / picking(仓库拣货) / first-mile(送往楼下)
 *   / waiting-handover(楼下待交接) / last-mile(送到寝室)
 *   stepKeyForStatus：waiting-first-mile→picking（拣货完成）、delivered→last-mile（送达兜底）。
 */
export const ORDER_STATUSES = [
  'pending-payment',
  'paid',
  'picking',
  'waiting-first-mile',
  'first-mile',
  'waiting-handover',
  'last-mile',
  'delivered',
  'completed',
  'cancelled',
  'exception',
  'refunded',
] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** 状态的标准中文文案（写库 statusText 的默认口径）。 */
export const ORDER_STATUS_TEXT: Record<OrderStatus, string> = {
  'pending-payment': '等待支付',
  paid: '仓库正在接单',
  picking: '仓库正在拣货',
  'waiting-first-mile': '拣货完成，待配送员接单',
  'first-mile': '配送员送往楼下',
  'waiting-handover': '已到楼下，等待楼长交接',
  'last-mile': '楼长送往寝室',
  delivered: '已送达寝室',
  completed: '已确认收货',
  cancelled: '订单已取消',
  exception: '履约异常，客服处理中',
  refunded: '已退款',
};

/** 用户端列表/详情的聚合阶段（前端 tab 映射用）。 */
const PHASE_BY_STATUS: Record<string, 'payment' | 'fulfillment' | 'done' | 'exception'> =
  {
    'pending-payment': 'payment',
    paid: 'fulfillment',
    picking: 'fulfillment',
    'waiting-first-mile': 'fulfillment',
    'first-mile': 'fulfillment',
    'waiting-handover': 'fulfillment',
    'last-mile': 'fulfillment',
    delivered: 'fulfillment',
    completed: 'done',
    cancelled: 'done',
    refunded: 'done',
    exception: 'exception',
    'after-sales': 'exception',
  };
export function statusPhase(status: string) {
  return PHASE_BY_STATUS[status] ?? 'done';
}

/** 用户端"进行中"tab 的状态集合（含已送达待确认收货的 delivered）。 */
export const DELIVERING_STATUSES = [
  'paid',
  'picking',
  'waiting-first-mile',
  'first-mile',
  'waiting-handover',
  'last-mile',
  'delivered',
];

/** 进入该状态时应置 done 的 timeline 节点 key（无对应节点则为 null）。 */
export function stepKeyForStatus(status: string): string | null {
  switch (status) {
    case 'paid':
      return 'paid';
    case 'picking':
    case 'waiting-first-mile':
      // waiting-first-mile = 拣货完成待接，推进到的是拣货节点。
      return 'picking';
    case 'first-mile':
      return 'first-mile';
    case 'waiting-handover':
      return 'waiting-handover';
    case 'last-mile':
    case 'delivered':
      return 'last-mile';
    default:
      return null;
  }
}

export interface TimelineStepShape {
  key: string;
  title: string;
  description: string;
  done: boolean;
}
/** 新订单的标准 timeline（5 节点，含"楼下待交接"）。 */
export function buildOrderTimeline(buildingRoom: string): TimelineStepShape[] {
  return [
    {
      key: 'paid',
      title: '支付成功',
      description: '订单将进入校园仓',
      done: false,
    },
    { key: 'picking', title: '仓库拣货', description: '预计 10 分钟完成', done: false },
    {
      key: 'first-mile',
      title: '送往楼下',
      description: '配送员取货后展示',
      done: false,
    },
    {
      key: 'waiting-handover',
      title: '楼下待交接',
      description: '配送员到达楼下，等待楼长交接',
      done: false,
    },
    {
      key: 'last-mile',
      title: '送到寝室',
      description: buildingRoom,
      done: false,
    },
  ];
}
const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
/** 把进入 status 对应的 timeline 节点置 done（幂等：已 done 的节点不覆盖时间；历史 timeline 缺节点时跳过）。 */
export function markTimelineStep(
  timeline: unknown,
  status: string,
): Prisma.InputJsonValue {
  const steps = Array.isArray(timeline)
    ? timeline.map((x) => ({ ...(x as Record<string, unknown>) }))
    : [];
  const key = stepKeyForStatus(status);
  const step = key ? steps.find((x) => x.key === key) : undefined;
  if (step && !step.done) {
    step.done = true;
    step.time = new Date().toISOString();
  }
  return json(steps);
}
