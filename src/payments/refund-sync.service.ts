import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AdminService } from '../admin/admin.service';

/** 微信退款回调之外的定时兜底，确保丢回调或进程重启后仍能收敛到终态。 */
@Injectable()
export class RefundSyncService {
  private readonly logger = new Logger(RefundSyncService.name);

  constructor(private readonly admin: AdminService) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async reconcile() {
    const count = await this.admin.syncOutstandingRefunds();
    if (count) this.logger.log(`退款自动查单完成 count=${count}`);
  }
}
