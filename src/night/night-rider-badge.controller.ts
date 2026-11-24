import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { StaffIdentityGuard } from '../auth/staff-identity.guard';
import type { AuthRequest } from '../auth/jwt-auth.guard';
import { ok, type ApiResponse } from '../common/api-response';
import { PrismaService } from '../database/prisma.service';
import { NightRiderService } from './night-rider.service';

/**
 * 首页夜宵角标专用 dashboard（道哥 2026-11-24 拍板 A 方案）：
 * 3.1.5 起首页 load() 无条件拉 /night-rider/night/dashboard 取待接单角标，
 * 但原端点在 NightRiderController 类级 NightRiderAccessGuard 之后——
 * 未开通夜宵校区的骑手 403「本校区未开通夜宵服务」、已开通校区的骑手被
 * auth() 403「仅楼长可访问夜宵店功能」，request 层全局 toast 每次登录/
 * 回前台都弹（前端 .catch 想静默被击穿）。
 * 本控制器接管同路径（app.module 注册顺序在本控制器之前）：非楼长系 /
 * 未开通校区一律返回全零空工作台（角标=0，页面永不弹错），楼长系且校区
 * 开通才进原 service（楼长未绑店仍是原 404「尚未绑定…」静默口径）。
 */
@ApiTags('楼长端-夜宵店')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, StaffIdentityGuard)
@Controller('night-rider')
export class NightRiderBadgeController {
  constructor(
    private readonly db: PrismaService,
    private readonly service: NightRiderService,
  ) {}

  /** 全零空工作台：形状对齐楼长端 dashboard（types.NightDashboard），角标读 pendingOrders=0。 */
  private static emptyDashboard() {
    return {
      reservedValue: 0,
      frozenValue: 0,
      usedQuota: 0,
      usableQuota: 0,
      store: { id: '', status: 'closed', buildingName: '', commissionRate: 0 },
      campus: { nightEnabled: false, nightStartAt: null, nightEndAt: null },
      inWindow: false,
      deposit: 0,
      gapToNextTier: 0,
      pendingOrders: 0,
      todayOrders: 0,
      todaySales: 0,
      todayIncome: 0,
      monthSales: 0,
      monthIncome: 0,
      stockValue: 0,
      commission: { estimated: 0, pending: 0, settled: 0 },
      deliveryFee: { estimated: 0, pending: 0, settled: 0 },
    };
  }

  @Get('night/dashboard')
  async dashboard(@Req() r: AuthRequest): Promise<ApiResponse<unknown>> {
    const user = r.user;
    if (!['building-manager', 'intern-building-manager'].includes(user.role))
      return ok(NightRiderBadgeController.emptyDashboard());
    const campus = await this.db.campus.findUnique({
      where: { id: user.campusId },
      select: { nightEnabled: true },
    });
    if (!campus?.nightEnabled)
      return ok(NightRiderBadgeController.emptyDashboard());
    return ok(await this.service.dashboard(user.id));
  }
}
