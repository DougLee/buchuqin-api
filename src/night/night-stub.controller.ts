import { Controller, Get, Req, SetMetadata, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, type AuthRequest } from '../auth/jwt-auth.guard';
import { USER_ROLES_KEY, UserRoleGuard } from '../auth/user-role.guard';
import { ok } from '../common/api-response';
import { PrismaService } from '../database/prisma.service';

/**
 * 夜宵入口桩接口（IKW3E7，道哥 2026-11-17 拍板）：生产 main 暂不整体
 * 部署 night-store 后端，但新版本小程序（3.1.0+）首页链路必调
 * GET /night/entry，缺路由 404 会打崩首页。本桩按 NightEntry 完整契约
 * 恒返「夜宵关闭」全关态——客户端 business 层仅消费 inNightSession，
 * false 即纯白天渲染、零夜宵痕迹；线上旧版本不调 /night/*，零影响。
 *
 * ⚠️ 替换约定：night-store 分支正式上生产时删除本文件与 app.module
 * 注册项，由真实 NightModule 接管（届时合并冲突按此口径解）。
 */

/** 北京时间当天分钟数（0~1439），与真实实现口径一致。 */
function beijingMinutes(now = new Date()): number {
  const b = new Date(now.getTime() + 8 * 3600_000);
  return b.getUTCHours() * 60 + b.getUTCMinutes();
}

@ApiTags('用户端-夜宵店（桩）')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, UserRoleGuard)
@SetMetadata(USER_ROLES_KEY, ['user'])
@Controller('night')
export class NightStubController {
  constructor(private readonly db: PrismaService) {}

  @Get('entry')
  @ApiOperation({ summary: '夜宵入口（桩：恒返夜宵关闭全关态）' })
  async entry(@Req() req: AuthRequest) {
    const campusId = req.user.campusId;
    const campus = await this.db.campus.findUnique({
      where: { id: campusId },
      select: { id: true, name: true },
    });
    return ok({
      campusId,
      campusName: campus?.name ?? '',
      nightEnabled: false,
      nightStartAt: null,
      nightEndAt: null,
      nightDeliveryFee: 0,
      dayClosed: false,
      inWindow: false,
      inNightSession: false,
      nowMinutes: beijingMinutes(),
    });
  }
}
