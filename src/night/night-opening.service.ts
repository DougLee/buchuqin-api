import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { NightInventoryService } from './night-inventory.service';
import { inNightWindow } from './night.helpers';

type Db = PrismaService | Prisma.TransactionClient;
type Hours = { nightEnabled: boolean; nightStartAt: string | null; nightEndAt: string | null };

/** 用户入口、开店和提交订单共享同一营业许可；不以白天闭店作为本楼夜店的前提。 */
export async function nightOpeningAllowed(db: Db, store: { id: string; managerStaffId: string | null; campusId?: string }, campus: Hours, now = new Date()): Promise<boolean> {
  if (!campus.nightEnabled || !store.managerStaffId) return false;
  const manager = await db.staff.findUnique({ where: { id: store.managerStaffId }, select: { role: true, status: true, campusId: true } });
  if (!manager || manager.role !== 'building-manager' || manager.status === 'deleted' || (store.campusId && manager.campusId !== store.campusId)) return false;
  if (inNightWindow(campus.nightStartAt, campus.nightEndAt, now)) return true;
  return !!await db.nightOpeningRequest.findFirst({ where: { storeId: store.id, managerStaffId: store.managerStaffId, status: 'approved', startAt: { lte: now }, endAt: { gt: now } }, select: { id: true } });
}

@Injectable()
export class NightOpeningService {
  constructor(private readonly db: PrismaService, private readonly inventory: NightInventoryService) {}

  async request(staffId: string, body: { requestId: string; startAt: string; endAt: string; reason: string }) {
    const initial = await this.inventory.myStore(staffId);
    const startAt = new Date(body.startAt), endAt = new Date(body.endAt);
    if (!body.reason.trim() || !Number.isFinite(startAt.getTime()) || !Number.isFinite(endAt.getTime()) || endAt <= startAt || endAt <= new Date() || endAt.getTime() - startAt.getTime() > 86400000)
      throw new BadRequestException('请填写原因和有效营业时段，单次不超过24小时');
    return this.db.$transaction(async tx => {
      const store = await this.inventory.lockStore(tx, initial.id, staffId);
      const staff = await tx.staff.findUnique({ where: { id: staffId } });
      if (staff?.role !== 'building-manager' || staff.status === 'deleted' || staff.campusId !== store.campusId) throw new ForbiddenException('仅本店正式楼长可申请临时营业');
      await this.inventory.assertCampusEnabled(store.campusId, tx);
      if (store.status === 'suspended') throw new BadRequestException('店铺已被平台停业');
      const old = await tx.nightOpeningRequest.findUnique({ where: { storeId_requestId: { storeId: store.id, requestId: body.requestId } } });
      if (old) {
        if (old.managerStaffId !== staffId || +old.startAt !== +startAt || +old.endAt !== +endAt || old.reason !== body.reason.trim()) throw new BadRequestException('重复申请内容不一致');
        return old;
      }
      await tx.nightOpeningRequest.updateMany({ where: { storeId: store.id, status: 'pending', endAt: { lte: new Date() } }, data: { status: 'rejected', reviewReason: '申请时段已过期' } });
      if (await tx.nightOpeningRequest.count({ where: { storeId: store.id, status: 'pending' } })) throw new BadRequestException('已有待审核申请，请等待校区处理');
      const row = await tx.nightOpeningRequest.create({ data: { storeId: store.id, managerStaffId: staffId, requestId: body.requestId, startAt, endAt, reason: body.reason.trim() } });
      await this.inventory.audit(tx, staffId, 'night.opening.request', store.id, row.id, { startAt, endAt, reason: body.reason.trim() });
      return row;
    });
  }

  async listStaff(staffId: string) {
    const store = await this.inventory.myStore(staffId);
    return this.db.nightOpeningRequest.findMany({ where: { storeId: store.id, managerStaffId: staffId }, orderBy: { createdAt: 'desc' }, take: 20 });
  }

  async listCampus(campusId: string, status = 'pending') {
    if (!['all', 'pending', 'approved', 'rejected'].includes(status)) throw new BadRequestException('审核状态无效');
    const rows = await this.db.nightOpeningRequest.findMany({ where: { store: { campusId }, ...(status === 'all' ? {} : { status }) }, include: { store: { include: { building: true, managerStaff: { select: { id: true, name: true } } } } }, orderBy: { createdAt: 'desc' } });
    return rows.map(({ store, ...row }) => ({ ...row, buildingName: store.building.name, managerName: store.managerStaff?.id === row.managerStaffId ? store.managerStaff.name : '原经营者' }));
  }

  async storeOf(id: string) {
    const row = await this.db.nightOpeningRequest.findUnique({ where: { id }, select: { storeId: true } });
    if (!row) throw new NotFoundException('营业申请不存在');
    return row.storeId;
  }

  async review(operator: string, id: string, approved: boolean, reason: string) {
    if (!reason.trim()) throw new BadRequestException('请填写审核说明');
    const storeId = await this.storeOf(id);
    return this.db.$transaction(async tx => {
      const store = await this.inventory.lockStore(tx, storeId);
      const row = await tx.nightOpeningRequest.findUniqueOrThrow({ where: { id } });
      const status = approved ? 'approved' : 'rejected';
      if (row.status === status) return row;
      if (row.status !== 'pending') throw new BadRequestException('申请已处理');
      if (approved) {
        await this.inventory.assertCampusEnabled(store.campusId, tx);
        const staff = await tx.staff.findUnique({ where: { id: row.managerStaffId } });
        if (store.managerStaffId !== row.managerStaffId || staff?.role !== 'building-manager' || staff.status === 'deleted' || staff.campusId !== store.campusId || store.status === 'suspended') throw new BadRequestException('经营资格已变化，不能批准');
        if (row.endAt <= new Date()) throw new BadRequestException('申请时段已过期，请驳回后重新申请');
      }
      const after = await tx.nightOpeningRequest.update({ where: { id }, data: { status, reviewReason: reason.trim(), reviewedBy: operator, reviewedAt: new Date() } });
      await this.inventory.audit(tx, operator, 'night.opening.review', storeId, id, { approved, reason });
      return after;
    });
  }

  /** 批量扫描只停新单，不触碰任何存量订单。请求侧仍实时校验，不依赖定时器准点。 */
  async closeExpired() {
    let cursor: string | undefined;
    while (true) {
      const rows = await this.db.nightStore.findMany({ where: { status: { in: ['open', 'paused'] } }, include: { campus: true }, orderBy: { id: 'asc' }, take: 100, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}) });
      if (!rows.length) return;
      for (const row of rows) {
        await this.db.$transaction(async tx => {
          const store = await this.inventory.lockStore(tx, row.id);
          const campus = await tx.campus.findUniqueOrThrow({ where: { id: store.campusId } });
          if (['open', 'paused'].includes(store.status) && !await nightOpeningAllowed(tx, store, campus)) {
            await tx.nightStore.update({ where: { id: store.id }, data: { status: 'closed', closedAt: new Date() } });
            await this.inventory.audit(tx, 'system', 'night.store.expired-close', store.id, store.id, { reason: '营业许可或营业时段已结束' });
          }
        });
      }
      cursor = rows[rows.length - 1].id;
    }
  }
}
