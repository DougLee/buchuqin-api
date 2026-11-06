import { inNightWindow, nightBusinessDate, nightDayStart } from './night.helpers';
describe('夜宵配置时区与营业日', () => {
  it('凌晨归配置场次日前一晚，不写死06:00', () => {
    const morning = new Date('2026-11-07T07:30:00+08:00');
    expect(nightBusinessDate(morning, '22:00', '08:00')).toBe('2026-11-06');
    expect(nightBusinessDate(morning, '22:00', '02:00')).toBe('2026-11-07');
    expect(nightBusinessDate(new Date('2026-11-07T01:30:00+08:00'), '00:00', '23:59')).toBe('2026-11-07');
    expect(nightDayStart('2026-11-01', '22:00', '08:00').toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });
  it('跨月午夜、开始包含结束不含，且不依赖服务器本地时区', () => {
    expect(nightBusinessDate(new Date('2026-12-01T01:00:00+08:00'), '22:00', '02:00')).toBe('2026-11-30');
    expect(inNightWindow('22:00', '02:00', new Date('2026-11-06T22:00:00+08:00'))).toBe(true);
    expect(inNightWindow('22:00', '02:00', new Date('2026-11-07T02:00:00+08:00'))).toBe(false);
    expect(inNightWindow('22:00', '22:00')).toBe(false);
  });
});
