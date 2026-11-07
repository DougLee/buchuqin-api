import { purchaseWindowStart } from './purchase-window';
describe('中国时区购买周期', () => {
  it('周一零点按中国时区而不是UTC换周', () => {
    expect(purchaseWindowStart('weekly', new Date('2026-11-08T16:00:00Z')).toISOString()).toBe('2026-11-08T16:00:00.000Z');
    expect(purchaseWindowStart('weekly', new Date('2026-11-08T15:59:59Z')).toISOString()).toBe('2026-11-01T16:00:00.000Z');
  });
  it('月首及终身窗口', () => {
    expect(purchaseWindowStart('monthly', new Date('2026-10-31T16:00:00Z')).toISOString()).toBe('2026-10-31T16:00:00.000Z');
    expect(purchaseWindowStart('once').getTime()).toBe(0);
  });
});
