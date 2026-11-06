import { call, state, save, q } from './http.mjs';
state.coupons ||= {};
for (const businessType of ['day', 'night']) {
  if (!state.coupons[businessType]) {
    const coupon = await call('/api/v1/admin/coupons' + q(state.campusId), 'POST', { name: '验收' + businessType + '券20261107', amount: 100, threshold: 500, total: 10, kind: 'platform', businessType, trigger: 'manual', perUserLimit: 5 });
    state.coupons[businessType] = coupon.id; save();
  }
}
console.log('Day/night coupon definitions created through campus admin API.');
