import {
  DELIVERING_STATUSES,
  markTimelineStep,
  ORDER_STATUSES,
  ORDER_STATUS_TEXT,
  statusPhase,
  stepKeyForStatus,
} from './order-state';

/** IKRSIY（#109/#111 已到店）：arrived 状态接入状态机的口径单测。 */
describe('order-state IKRSIY arrived（已到店）', () => {
  it('ORDER_STATUSES：arrived 插在 waiting-first-mile 与 first-mile 之间', () => {
    const i = ORDER_STATUSES.indexOf('arrived');
    expect(i).toBeGreaterThan(-1);
    expect(ORDER_STATUSES[i - 1]).toBe('waiting-first-mile');
    expect(ORDER_STATUSES[i + 1]).toBe('first-mile');
  });

  it('中文文案 / 用户端阶段 / 进行中集合', () => {
    expect(ORDER_STATUS_TEXT.arrived).toBe('配送员已到店');
    expect(statusPhase('arrived')).toBe('fulfillment');
    expect(DELIVERING_STATUSES).toContain('arrived');
  });

  it('stepKeyForStatus(arrived)=picking：timeline 幂等空转，不误写末节点时间', () => {
    expect(stepKeyForStatus('arrived')).toBe('picking');
    const timeline = [
      {
        key: 'paid',
        title: '支付成功',
        description: '订单将进入校园仓',
        done: true,
        time: '2026-10-30T02:00:00.000Z',
      },
      {
        key: 'picking',
        title: '仓库出库',
        description: '拣货出库后等待配送',
        done: true,
        time: '2026-10-30T02:10:00.000Z',
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
        description: '西区 5 栋 502',
        done: false,
      },
    ];
    const out = markTimelineStep(timeline, 'arrived') as unknown as Array<{
      key: string;
      done: boolean;
      time?: string;
    }>;
    // 全部节点原样——尤其末节点（送到寝室）不得被补录兜底写上时间，
    // 否则绩效 deliveredAt 回退口径会把到店时刻当送达时间。
    expect(out.map((s) => [s.key, s.done, s.time ?? null])).toEqual(
      timeline.map((s) => [
        s.key,
        s.done,
        (s as { time?: string }).time ?? null,
      ]),
    );
  });
});
