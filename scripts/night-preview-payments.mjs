import { createRequire } from 'node:module';

// Preloaded exclusively by the local preview runner. No production controller or flag
// can expose fake callbacks; this replaces only the external gateway boundary.
const database = new URL(process.env.DATABASE_URL || '');
if (process.env.NODE_ENV !== 'test' || !database.pathname.endsWith('_spec') || database.searchParams.get('schema') !== 'night_stock_preview_20261106' || process.env.NIGHT_LOCAL_GATEWAY !== '1') throw new Error('模拟支付只允许本机独立夜宵预览');
const require = createRequire(import.meta.url);
const { PaymentsService } = require('../dist/src/payments/payments.service.js');
const assertCampus = campusId => { if (campusId !== 'night-preview-campus') throw new Error('模拟渠道不处理其他校区'); };
PaymentsService.prototype.nightPrepay = async function(input) {
  assertCampus(input.campusId);
  if (!/^(YX|ND)/.test(input.outTradeNo) || !Number.isSafeInteger(input.amount) || input.amount <= 0) throw new Error('模拟预支付参数不合法');
  return { appId: 'LOCAL_PREVIEW_ONLY', timeStamp: String(Math.floor(Date.now() / 1000)), nonceStr: 'LOCAL_PREVIEW_ONLY', package: 'prepay_id=LOCAL_PREVIEW_ONLY', signType: 'RSA', paySign: 'LOCAL_PREVIEW_ONLY' };
};
PaymentsService.prototype.nightTradeState = async function(_orderNo, campusId) { assertCampus(campusId); return { tradeState: 'NOTPAY' }; };
PaymentsService.prototype.applyWechatRefund = async function(_orderNo, _total, _amount, refundNo, _reason, campusId) { assertCampus(campusId); return { refundId: 'LOCAL_' + refundNo, status: 'SUCCESS' }; };
PaymentsService.prototype.queryWechatRefund = async function(refundNo, campusId) { assertCampus(campusId); return { refundId: 'LOCAL_' + refundNo, status: 'SUCCESS' }; };
console.log('【本机模拟渠道】预支付/退款不连接微信、不产生真实扣款；回调由本机确认脚本驱动。');
