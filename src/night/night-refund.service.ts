import { BadRequestException, HttpException, Logger, NotFoundException } from '@nestjs/common';
import { NightRefund, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { PaymentsService, WechatRefundOutcomeUnknownError } from '../payments/payments.service';
import { NightInventoryService } from './night-inventory.service';

type Finalize = (tx: Prisma.TransactionClient, request: NightRefund) => Promise<void>;
type Request = { kind: 'cancel' | 'admin'; operatorId: string; productAmount?: number; refundDeliveryFee?: boolean; restock?: boolean; reason: string };
const pending = ['requested', 'submitting', 'processing', 'unknown'];

/** Durable refund intent. Gateway acceptance never substitutes for confirmed refund success. */
export class NightRefundService {
  private readonly logger = new Logger(NightRefundService.name);
  constructor(private readonly db: PrismaService, private readonly payments: PaymentsService, private readonly inventory: NightInventoryService, private readonly finalize: Finalize) {}

  async request(orderId: string, input: Request) {
    const raw = await this.db.nightOrder.findUnique({ where: { id: orderId } });
    if (!raw) throw new NotFoundException('订单不存在');
    const request = await this.db.$transaction(async tx => {
      const store = await this.inventory.lockStore(tx, raw.storeId);
      const order = await tx.nightOrder.findUniqueOrThrow({ where: { id: orderId } });
      if (!order.paidAt) throw new BadRequestException('订单未支付，无需退款');
      const productPaid = order.productAmount - order.couponDiscount;
      const productAmount = input.kind === 'cancel' ? productPaid : input.productAmount ?? productPaid;
      const deliveryFeeAmount = input.kind === 'cancel' || input.refundDeliveryFee ? order.deliveryFee : 0;
      const restock = input.kind === 'cancel' || input.restock !== false;
      const fullProductRefund = input.kind === 'cancel' || input.productAmount === undefined || (productAmount > 0 && productAmount === productPaid);
      const totalAmount = productAmount + deliveryFeeAmount;
      if (!Number.isInteger(productAmount) || productAmount < 0 || productAmount > productPaid || totalAmount < 0 || (totalAmount === 0 && !fullProductRefund) || totalAmount > order.payableAmount) throw new BadRequestException('退款金额不合法或超过原实付金额');
      if (restock && !fullProductRefund) throw new BadRequestException('部分商品或仅配送费退款不能自动回库');
      const old = await tx.nightRefund.findUnique({ where: { orderId } });
      if (old) {
        if (old.kind !== input.kind || old.productAmount !== productAmount || old.deliveryFeeAmount !== deliveryFeeAmount || old.restock !== restock || old.fullProductRefund !== fullProductRefund) throw new BadRequestException('该订单已有退款申请，请按原申请核对；一期每单仅一次退款');
        if (old.status !== 'failed') return old;
      } else if ((order.timeline as Array<{key?: string}>).some(step => step.key === 'refund')) throw new BadRequestException('该订单已有历史退款记录，请核对原退款');
      if (['cancelled', 'refunded', 'pending-payment'].includes(order.status)) throw new BadRequestException('订单当前状态不可退款');
      if (order.status === 'exception' && totalAmount !== order.payableAmount) throw new BadRequestException('关闭后晚到账的异常订单须整单原路退回');
      if (input.kind === 'cancel' && order.status !== 'pending-accept') throw new BadRequestException('楼长已接单，请联系客服处理售后');
      const historic = (order.items as Array<{inventoryValue?: number;price:number;quantity:number}>).reduce((sum, line) => sum + (line.inventoryValue ?? line.price * line.quantity), 0);
      const heldValue = restock && !order.inventoryRestocked && order.quotaHeld === 0 ? historic : 0;
      if (heldValue > (await this.inventory.summary(store.id, tx)).usableQuota) throw new BadRequestException('退货入库超出押金额度，请先补缴押金');
      const reason = input.reason.trim().slice(0, 200);
      if (!reason) throw new BadRequestException('请填写退款原因');
      const data = { status: 'requested', heldValue, reason, errorMessage: '', leaseUntil: null, attempts: 0, originalStatus: order.status, originalAfterSaleStatus: order.afterSaleStatus };
      const request = old ? await tx.nightRefund.update({ where: { id: old.id }, data }) : await tx.nightRefund.create({ data: {
        ...data, orderId, storeId: order.storeId, outRefundNo: `NR${order.id}`, kind: input.kind, originalStatus: order.status, originalAfterSaleStatus: order.afterSaleStatus, productAmount, deliveryFeeAmount, totalAmount, restock, fullProductRefund, operatorId: input.operatorId,
      } });
      const changed = await tx.nightOrder.updateMany({ where: { id: orderId, status: order.status, afterSaleStatus: order.afterSaleStatus }, data: {
        afterSaleStatus: 'refund-processing', ...(input.kind === 'cancel' ? { status: 'cancelling', statusText: '退款处理中', cancelReason: reason } : {}),
      } });
      if (!changed.count) throw new BadRequestException('订单状态已变化，请刷新后重新确认');
      await tx.auditLog.create({ data: { campusId: store.campusId, operator: input.operatorId, action: 'night.refund.request', entityType: 'night-order', entityId: order.id, after: { refundId: request.id, totalAmount, restock } } });
      return request;
    }, { timeout: 20000 });
    if (request.status === 'requested') await this.submit(request.id);
    else if (pending.includes(request.status)) await this.reconcile(request.id);
    return this.db.nightRefund.findUniqueOrThrow({ where: { id: request.id } });
  }

  private async submit(id: string) {
    const claimed = await this.db.nightRefund.updateMany({ where: { id, status: 'requested' }, data: { status: 'submitting', leaseUntil: new Date(Date.now() + 30000), attempts: { increment: 1 } } });
    if (!claimed.count) return;
    const request = await this.db.nightRefund.findUniqueOrThrow({ where: { id }, include: { order: { select: { orderNo: true, payableAmount: true, payMerchantId: true } }, store: { select: { campusId: true } } } });
    if (request.totalAmount === 0) { await this.handleResult(id, { status: 'SUCCESS', refundId: 'NO_CHARGE' }); return; }
    let result: { refundId: string; status: string };
    try {
      result = await this.payments.applyWechatRefund(request.order.orderNo, request.order.payableAmount, request.totalAmount, request.outRefundNo, request.reason, request.store.campusId, request.order.payMerchantId ?? undefined);
    } catch (error) {
      const definite = !(error instanceof WechatRefundOutcomeUnknownError) && error instanceof HttpException && (error.getStatus() < 500 || error.getStatus() === 501 || error.message.startsWith('微信退款失败：'));
      if (definite && request.attempts === 1) await this.fail(id, error.message);
      else await this.markPending(id, 'unknown', '退款结果待核对，请勿重复退款');
      return;
    }
    await this.handleResult(id, result);
  }

  private async handleResult(id: string, result: { status?: string; refundId?: string }) {
    if (result.status === 'SUCCESS' && result.refundId) {
      try {
        await this.db.$transaction(async tx => {
          const raw = await tx.nightRefund.findUniqueOrThrow({ where: { id } });
          await this.inventory.lockStore(tx, raw.storeId);
          const current = await tx.nightRefund.findUniqueOrThrow({ where: { id } });
          if (current.status === 'succeeded') return;
          await this.finalize(tx, current);
          await tx.nightRefund.update({ where: { id }, data: { status: 'succeeded', gatewayRefundId: result.refundId, heldValue: 0, leaseUntil: null, errorMessage: '', completedAt: new Date() } });
        }, { timeout: 20000 });
      } catch (error) {
        // Money may already have arrived. Keep the durable intent and retry domain settlement.
        this.logger.warn(`退款业务结算待重试：${id} ${error instanceof Error ? error.message : 'unknown'}`);
        await this.markPending(id, 'processing', '资金状态已返回，业务结算待重试', result.refundId);
      }
    } else if (result.status === 'CLOSED' || result.status === 'ABNORMAL') await this.fail(id, '微信退款未完成，请核对后重试');
    else await this.markPending(id, result.status === 'PROCESSING' ? 'processing' : 'unknown', result.status === 'PROCESSING' ? '微信退款处理中' : '退款结果待核对', result.refundId);
  }

  private async markPending(id: string, status: string, errorMessage: string, gatewayRefundId?: string) {
    await this.db.nightRefund.updateMany({ where: { id, status: { in: pending } }, data: { status, errorMessage, leaseUntil: null, ...(gatewayRefundId ? { gatewayRefundId } : {}) } });
  }
  private async fail(id: string, errorMessage: string) {
    await this.db.$transaction(async tx => {
      const request = await tx.nightRefund.findUniqueOrThrow({ where: { id } });
      await this.inventory.lockStore(tx, request.storeId);
      const current = await tx.nightRefund.findUniqueOrThrow({ where: { id } });
      if (current.status === 'succeeded') return;
      await tx.nightRefund.update({ where: { id }, data: { status: 'failed', heldValue: 0, errorMessage: errorMessage.slice(0, 200), leaseUntil: null } });
      await tx.nightOrder.update({ where: { id: request.orderId }, data: { status: request.originalStatus, statusText: request.originalStatus === 'pending-accept' ? '待接单' : request.originalStatus === 'completed' ? '已完成' : request.originalStatus === 'delivering' ? '配送中' : '退款未完成', afterSaleStatus: request.originalAfterSaleStatus } });
    }, { timeout: 20000 });
  }

  async reconcile(id: string) {
    const request = await this.db.nightRefund.findUnique({ where: { id }, include: { store: { select: { campusId: true } }, order: { select: { payMerchantId: true } } } });
    if (!request || !pending.includes(request.status)) return;
    if (request.leaseUntil && request.leaseUntil > new Date()) return;
    if (request.status === 'requested') { await this.submit(id); return; }
    try {
      const result = await this.payments.queryWechatRefund(request.outRefundNo, request.store.campusId, { preserveUnknown: true, expectedMerchantId: request.order.payMerchantId ?? undefined });
      if (result.status === 'NOTFOUND') {
        // 404 does not prove money was rejected. Recover a crash before send by
        // replaying the SAME gateway id after a grace period, keeping all holds.
        if (!request.gatewayRefundId && Date.now() - request.createdAt.getTime() >= 60000) {
          const claimed = await this.db.nightRefund.updateMany({ where: { id, status: request.status, updatedAt: request.updatedAt }, data: { status: 'requested', leaseUntil: null } });
          if (claimed.count) await this.submit(id);
        } else {
          await this.markPending(id, 'unknown', '暂未查到退款记录，原申请仍保留，系统将继续核对');
          if (!request.gatewayRefundId) await this.db.nightRefund.updateMany({ where: { id, status: 'unknown' }, data: { leaseUntil: new Date(request.createdAt.getTime() + 60000) } });
        }
        return;
      }
      await this.handleResult(id, result);
    }
    catch { await this.markPending(id, 'unknown', '退款查单暂不可用，系统将继续核对'); }
  }
  async reconcileDue(limit = 50) {
    const requests = await this.db.nightRefund.findMany({ where: { status: { in: pending }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] }, select: { id: true }, orderBy: { updatedAt: 'asc' }, take: limit });
    for (const request of requests) await this.reconcile(request.id);
    return requests.length;
  }
}
