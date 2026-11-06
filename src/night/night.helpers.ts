/**
 * 楼栋夜宵店（IKSW1F）纯函数工具：场次窗口判定 / 营业日归属 / 单号生成。
 * 独立成模块便于单测；时间判定一律服务端上海时区口径（与白天业务
 * business.service.beijingMinutes 同源规则），不依赖部署机本地时区。
 */

/** HH:mm → 当日分钟数；非法格式返回 null。 */
export function hhmmToMinutes(s?: string | null): number | null {
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h > 23 || mm > 59) return null;
  return h * 60 + mm;
}

/** 北京时间当前时刻 → 当日分钟数（跨零点场次与打烊窗共用口径）。 */
export function beijingMinutes(now = new Date()): number {
  const hm = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(now);
  const [h, m] = hm.split(':').map(Number);
  return (h % 24) * 60 + m;
}

/** 北京时间 YYYY-MM-DD（营业日归属基础）。 */
export function beijingDate(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
  }).format(now);
}

/**
 * 夜宵场次窗口判定：start < end = 当日窗（如 22:00-23:59）；start > end =
 * 跨零点窗（如 23:00-02:00，命中 = now>=start || now<end）；start === end =
 * 非法配置（配置侧已拒，判定侧恒 false 兜底）。
 */
export function inNightWindow(
  nightStartAt?: string | null,
  nightEndAt?: string | null,
  now = new Date(),
): boolean {
  const s = hhmmToMinutes(nightStartAt);
  const e = hhmmToMinutes(nightEndAt);
  if (s === null || e === null || s === e) return false;
  const nowMin = beijingMinutes(now);
  return s < e ? nowMin >= s && nowMin < e : nowMin >= s || nowMin < e;
}

/**
 * 营业日归属（跨零点归前一晚）：场次默认 23:00 开始、凌晨结束——北京
 * 时间 06:00 前下的单归属前一日（10-25 23:00~26 02:00 为同一场次的
 * PRD 口径）；06:00 起视为新一天（白天兜底时段不存在夜宵单，该分界
 * 只影响脏数据展示）。
 */
export function nightBusinessDate(now = new Date(), start?: string | null, end?: string | null): string {
  const d = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
  }).format(now);
  const boundary = nightDayBoundary(start, end);
  if (beijingMinutes(now) >= boundary) return d;
  const prev = new Date(now.getTime() - 24 * 3600 * 1000);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
  }).format(prev);
}

/** Business day rolls over at the configured overnight closing time. */
export function nightDayBoundary(start?: string | null, end?: string | null): number {
  if (start === undefined && end === undefined) return 360; // legacy caller fallback
  const s = hhmmToMinutes(start), e = hhmmToMinutes(end);
  return s !== null && e !== null && s > e ? e : 0;
}

export function nightDayStart(day: string, start?: string | null, end?: string | null) {
  return new Date(new Date(`${day}T00:00:00+08:00`).getTime() + nightDayBoundary(start, end) * 60000);
}

/** YX 前缀夜宵订单号：时间戳 + 随机后缀（同毫秒并发防撞，约束唯一兜底）。 */
export function nightOrderNo(): string {
  return `YX${Date.now()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

/** ND 前缀押金支付商户单号（payments.notify 按前缀路由夜宵押金通道）。 */
export function nightDepositTradeNo(): string {
  return `ND${Date.now()}${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

/** 押金 500 元档：给定余额的下一档目标（分）。 */
export function nextDepositTier(deposit: number): number {
  return (Math.floor(deposit / 50000) + 1) * 50000;
}

/** 佣金：券后基数 × 万分比比例，四舍五入到分（PRD 6.6 以分为单位）。 */
export function commissionOf(base: number, rate: number): number {
  return Math.round((base * rate) / 10000);
}
