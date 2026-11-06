import { BadRequestException, HttpException, Logger, NotFoundException } from '@nestjs/common';
import { NightDepositRefund } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../database/prisma.service';
import { PaymentsService, WechatRefundOutcomeUnknownError } from '../payments/payments.service';
import { parsePagination } from '../common/pagination';
import { NightInventoryService } from './night-inventory.service';

const pending = ['requested', 'submitting', 'processing', 'unknown'];

/** 外部退押不持有数据库锁；持久化申请在整个未知窗口内预留额度。 */
export class NightDepositRefundService {
  private readonly logger = new Logger(NightDepositRefundService.name);
  constructor(private readonly db: PrismaService, private readonly payments: PaymentsService, private readonly inventory: NightInventoryService) {}

  async request(operatorId: string, storeId: string, input: { requestId: string; amount?: number; reason?: string }) {
    if (!/^[a-zA-Z0-9_-]{8,80}$/.test(input.requestId ?? '')) throw new BadRequestException('请提供有效的退押申请编号');
    const rows = await this.db.$transaction(async tx => {
      const store = await this.inventory.lockStore(tx, storeId);
      const existing = await tx.nightDepositRefund.findMany({ where: { storeId, requestId: input.requestId } });
      if (existing.length && input.amount !== undefined && existing.reduce((s, r) => s + r.amount, 0) !== input.amount) throw new BadRequestException('申请编号已使用，请核对原申请金额');
      const failed = existing.filter(r => r.status === 'failed');
      if (existing.length && !failed.length) return existing;
      const another = await tx.nightDepositRefund.count({ where: { storeId, requestId: { not: input.requestId }, status: { in: pending } } });
      if (another) throw new BadRequestException('已有退押处理中，请先核对原申请');
      const quota = await this.inventory.summary(storeId, tx);
      if (quota.usedQuota - quota.depositRefundReservedValue > 0) throw new BadRequestException('尚有库存、在途备货或待审核损耗占用，请先完成清算');
      const openOrders = await tx.nightOrder.count({ where: { storeId, OR: [{ status: { in: ['pending-payment', 'pending-accept', 'delivering', 'delivered', 'cancelling', 'exception'] } }, { afterSaleStatus: { in: ['requested', 'refund-processing'] } }] } });
      if (openOrders) throw new BadRequestException('尚有未完成订单或售后，请先完成清算');
      const amount = existing.length ? failed.reduce((s, r) => s + r.amount, 0) : input.amount ?? store.deposit;
      if (!Number.isSafeInteger(amount) || amount <= 0 || amount > store.deposit - quota.depositRefundReservedValue) throw new BadRequestException('退款金额超出可退押金余额');
      if (existing.length) {
        await tx.nightDepositRefund.updateMany({ where: { id: { in: failed.map(r => r.id) }, status: 'failed' }, data: { status: 'requested', attempts: 0, leaseUntil: null, errorMessage: '' } });
        return tx.nightDepositRefund.findMany({ where: { storeId, requestId: input.requestId } });
      }
      const deposits = await tx.nightDepositTxn.findMany({ where: { storeId, type: 'deposit', payOrderNo: { not: null } }, orderBy: { createdAt: 'asc' } });
      const prior = await tx.nightDepositTxn.groupBy({ by: ['payOrderNo'], where: { storeId, type: 'refund' }, _sum: { amount: true } });
      const refunded = new Map(prior.map(r => [r.payOrderNo, r._sum.amount ?? 0]));
      const seen = new Set<string>();
      const result: NightDepositRefund[] = [];
      let remaining = amount;
      for (const deposit of deposits) {
        if (!remaining) break;
        if (!deposit.payOrderNo || seen.has(deposit.payOrderNo)) continue;
        seen.add(deposit.payOrderNo);
        const available = deposit.amount - (refunded.get(deposit.payOrderNo) ?? 0);
        if (available <= 0) continue;
        const part = Math.min(available, remaining);
        const original = await tx.nightDepositOrder.findUnique({ where: { outTradeNo: deposit.payOrderNo } });
        const suffix = createHash('sha256').update(`${storeId}:${input.requestId}:${deposit.payOrderNo}`).digest('hex').slice(0, 40);
        result.push(await tx.nightDepositRefund.create({ data: { storeId, requestId: input.requestId, payOrderNo: deposit.payOrderNo, outRefundNo: `NDR${suffix}`, originalAmount: deposit.amount, amount: part, payMerchantId: original?.payMerchantId, operatorId, reason: input.reason?.trim().slice(0, 200) || '夜宵店清算退押' } }));
        remaining -= part;
      }
      if (remaining) throw new BadRequestException('原缴款可退金额不足，请核对押金流水，不能改用其他账户退还');
      await tx.auditLog.create({ data: { campusId: store.campusId, operator: operatorId, action: 'night.deposit.refund.request', entityType: 'nightStore', entityId: storeId, after: { requestId: input.requestId, amount } } });
      return result;
    }, { timeout: 20000 });
    for (const row of rows.slice(0, 3)) { if (row.status === 'requested') await this.submit(row.id); else if (pending.includes(row.status)) await this.reconcile(row.id); }
    return this.view(storeId, input.requestId);
  }

  async view(storeId: string, requestId: string) {
    const rows = await this.db.nightDepositRefund.findMany({ where: { storeId, requestId }, orderBy: { createdAt: 'asc' } });
    if (!rows.length) throw new NotFoundException('退押申请不存在');
    const sum = (statuses: string[]) => rows.filter(r => statuses.includes(r.status)).reduce((s, r) => s + r.amount, 0);
    return { requestId, requested: rows.reduce((s, r) => s + r.amount, 0), refunded: sum(['succeeded']), pending: sum(pending), failed: sum(['failed']), deposit: (await this.db.nightStore.findUniqueOrThrow({ where: { id: storeId } })).deposit, createdAt: rows[0].createdAt, allocations: rows.map(r => ({ id: r.id, payOrderNo: r.payOrderNo, amount: r.amount, status: r.status, errorMessage: r.errorMessage, completedAt: r.completedAt, outRefundNo: r.outRefundNo })) };
  }

  private async submit(id: string) {
    const claimed = await this.db.nightDepositRefund.updateMany({ where: { id, status: 'requested' }, data: { status: 'submitting', attempts: { increment: 1 }, leaseUntil: new Date(Date.now() + 30000) } });
    if (!claimed.count) return;
    const row = await this.db.nightDepositRefund.findUniqueOrThrow({ where: { id }, include: { store: { select: { campusId: true } } } });
    let result: { status?: string; refundId?: string };
    try { result = await this.payments.applyWechatRefund(row.payOrderNo, row.originalAmount, row.amount, row.outRefundNo, row.reason, row.store.campusId, row.payMerchantId ?? undefined); }
    catch (error) {
      const definite = !(error instanceof WechatRefundOutcomeUnknownError) && error instanceof HttpException && (error.getStatus() < 500 || error.getStatus() === 501 || error.message.startsWith('微信退款失败：'));
      await this.mark(id, definite && row.attempts === 1 ? 'failed' : 'unknown', error instanceof Error ? error.message : '退款结果待核对');
      return;
    }
    await this.handle(id, result);
  }

  private async mark(id: string, status: string, message: string, gatewayRefundId?: string) {
    await this.db.nightDepositRefund.updateMany({ where: { id, status: { in: pending } }, data: { status, errorMessage: message.slice(0, 200), leaseUntil: null, ...(gatewayRefundId ? { gatewayRefundId } : {}) } });
  }

  private async handle(id: string, result: { status?: string; refundId?: string }) {
    if (result.status !== 'SUCCESS' || !result.refundId) { await this.mark(id, ['CLOSED', 'ABNORMAL'].includes(result.status ?? '') ? 'failed' : result.status === 'PROCESSING' ? 'processing' : 'unknown', '退押尚未确认到账，等待核对', result.refundId); return; }
    try {
      await this.db.$transaction(async tx => {
        const raw = await tx.nightDepositRefund.findUniqueOrThrow({ where: { id } });
        const store = await this.inventory.lockStore(tx, raw.storeId);
        const current = await tx.nightDepositRefund.findUniqueOrThrow({ where: { id } });
        if (current.status === 'succeeded') return;
        if (!pending.includes(current.status)) return;
        if (store.deposit < current.amount) throw new BadRequestException('押金余额异常，保留原申请待核对');
        const deposit = store.deposit - current.amount;
        await tx.nightStore.update({ where: { id: store.id }, data: { deposit, ...(deposit < 50000 ? { status: 'closed', closedAt: new Date() } : {}) } });
        await tx.nightDepositTxn.create({ data: { id: `refund-${current.id}`, storeId: store.id, type: 'refund', amount: current.amount, payOrderNo: current.payOrderNo, operatorId: current.operatorId, remark: `退押 ${current.requestId} / ${current.outRefundNo}` } });
        await tx.nightDepositRefund.update({ where: { id }, data: { status: 'succeeded', gatewayRefundId: result.refundId, completedAt: new Date(), errorMessage: '', leaseUntil: null } });
        await tx.auditLog.create({ data: { campusId: store.campusId, operator: current.operatorId, action: 'night.deposit.refund.confirm', entityType: 'nightStore', entityId: store.id, before: { deposit: store.deposit }, after: { deposit, refundId: id, amount: current.amount } } });
      }, { timeout: 20000 });
    } catch (error) { this.logger.warn(`退押业务结算待重试：${id}`); await this.mark(id, 'processing', error instanceof Error ? error.message : '资金已返回，业务待结算', result.refundId); }
  }

  private async reconcile(id: string) {
    const row = await this.db.nightDepositRefund.findUniqueOrThrow({ where: { id }, include: { store: { select: { campusId: true } } } });
    if (!pending.includes(row.status) || (row.leaseUntil && row.leaseUntil > new Date())) return;
    if (row.status === 'requested') return this.submit(id);
    try {
      const result = await this.payments.queryWechatRefund(row.outRefundNo, row.store.campusId, { preserveUnknown: true, expectedMerchantId: row.payMerchantId ?? undefined });
      if (result.status === 'NOTFOUND') {
        if (!row.gatewayRefundId && Date.now() - row.createdAt.getTime() >= 60000) {
          const won = await this.db.nightDepositRefund.updateMany({ where: { id, status: row.status, updatedAt: row.updatedAt }, data: { status: 'requested', leaseUntil: null } });
          if (won.count) await this.submit(id);
        } else await this.mark(id, 'unknown', '暂未查到退款记录，原申请仍保留');
      } else await this.handle(id, result);
    } catch { await this.mark(id, 'unknown', '退押查单暂不可用，系统将继续核对'); }
  }

  async sync(storeId: string, requestId: string) {
    const rows = await this.db.nightDepositRefund.findMany({ where: { storeId, requestId }, select: { id: true } });
    if (!rows.length) throw new NotFoundException('退押申请不存在');
    for (const row of rows) await this.reconcile(row.id);
    return this.view(storeId, requestId);
  }

  async reconcileDue(limit = 50) {
    const rows = await this.db.nightDepositRefund.findMany({ where: { status: { in: pending }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] }, orderBy: { updatedAt: 'asc' }, take: limit, select: { id: true } });
    for (const row of rows) await this.reconcile(row.id);
    return rows.length;
  }

  async history(storeId: string, page?: string, pageSize?: string) {
    const p = parsePagination(page, pageSize);
    const rows = await this.db.nightDepositRefund.groupBy({ by: ['requestId'], where: { storeId }, _max: { createdAt: true }, orderBy: { _max: { createdAt: 'desc' } }, skip: (p.page - 1) * p.pageSize, take: p.pageSize });
    const count = await this.db.nightDepositRefund.groupBy({ by: ['requestId'], where: { storeId } });
    return { items: await Promise.all(rows.map(r => this.view(storeId, r.requestId))), total: count.length, page: p.page, pageSize: p.pageSize };
  }
}
