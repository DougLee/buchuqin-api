/**
 * 支付落账钩子（IKY6QE，道哥 2026-11-26）：BusinessService 与 PaymentsService
 * 之间用 setter 注入解耦（payments → business 已有依赖，反向注入会成环）。
 * 由 PaymentsService 在构造时 registerPayHooks(this)；单测直接 new
 * BusinessService 时不注册 → 无钩子路径（不查微信、不通知关单）。
 */
export interface OrderPayHooks {
  /**
   * 关单前向微信查单：回调丢失/延迟时订单可能其实已支付。
   * 返回 true = 该单实际已支付（已落账，调用方不得关单）；
   * 返回 false = 确认未支付，可以关单。
   * 查不清（微信异常/超时）应抛错，调用方本轮不关该单、下一轮重试。
   */
  settleBeforeClose(order: {
    id: string;
    userId: string;
    orderNo: string;
    campusId: string;
  }): Promise<boolean>;
  /**
   * 订单关闭（超时/用户取消）后通知微信关闭对应微信订单，阻止之后的付款。
   * 尽力而为：失败不阻塞业务，由对账与晚到支付自动退款兜底。
   */
  closeWechatOrder(order: {
    orderNo: string;
    campusId: string;
  }): Promise<void>;
}
