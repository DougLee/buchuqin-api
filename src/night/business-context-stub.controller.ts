import {
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, type AuthRequest } from '../auth/jwt-auth.guard';
import { UseGuards } from '@nestjs/common';
import { ok } from '../common/api-response';
import { PrismaService } from '../database/prisma.service';

/**
 * 履约工作台上下文桩接口（IKW3H9，道哥 2026-11-17 拍板，同 IKW3E7 口径）：
 * 新配送端 3.1.0 开屏必调 GET /fulfillment/business-context 判定工作台
 * 模式（白天/夜宵/休息），生产 main 无此路由 → 404 打崩开屏。本桩按
 * NightRiderService.businessContext() 契约逐字段对齐，夜宵侧恒关——
 * canSwitchWorkspace/nightEnabled/hasNightStore/hasNightHistory 全 false，
 * mode 忠实复刻白天闭店判定（manualClosed + 打烊窗，跨零点/相等=不打烊），
 * 桩环境下骑手拿到纯白天工作台、零夜宵痕迹。线上正式版不含此调用，零影响。
 *
 * ⚠️ 替换约定：night-store 分支正式上生产时删除本文件与 app.module
 * 注册项（与 NightStubController 一并），由真实实现接管。
 */

/** 与 main FulfillmentController.auth() 同一白名单（IKEAGE 四角色）。 */
const FULFILLMENT_ROLES = [
  'building-manager',
  'intern-building-manager',
  'fulltime-rider',
  'parttime-rider',
];

/** 北京时间当天分钟数（0~1439），与真实实现口径一致。 */
function beijingMinutes(now = new Date()): number {
  const b = new Date(now.getTime() + 8 * 3600_000);
  return b.getUTCHours() * 60 + b.getUTCMinutes();
}

/** HH:mm → 分钟；非法/空返 null。 */
function hhmmToMinutes(v?: string | null): number | null {
  if (!v) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 打烊窗判定（复刻 night.helpers.inNightWindow）：相等=不打烊，支持跨零点。 */
export function inCloseWindow(
  start?: string | null,
  end?: string | null,
  now = new Date(),
): boolean {
  const s = hhmmToMinutes(start);
  const e = hhmmToMinutes(end);
  if (s === null || e === null || s === e) return false;
  const n = beijingMinutes(now);
  return s < e ? n >= s && n < e : n >= s || n < e;
}

@ApiTags('履约端-工作台上下文（桩）')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('fulfillment')
export class BusinessContextStubController {
  constructor(private readonly db: PrismaService) {}

  @Get('business-context')
  @ApiOperation({ summary: '工作台上下文（桩：恒返夜宵关闭，白天/休息照实判）' })
  async businessContext(@Req() req: AuthRequest) {
    if (!FULFILLMENT_ROLES.includes(req.user.role))
      throw new ForbiddenException('无履约端权限');
    const staffId = req.user.id;
    const staff = await this.db.staff.findUnique({
      where: { id: staffId },
      select: {
        id: true,
        role: true,
        campus: {
          select: {
            name: true,
            manualClosed: true,
            closeStart: true,
            closeEnd: true,
          },
        },
      },
    });
    if (!staff) throw new NotFoundException('员工不存在');
    const dayClosed =
      staff.campus.manualClosed ||
      inCloseWindow(staff.campus.closeStart, staff.campus.closeEnd);
    return ok({
      staffId: staff.id,
      staffRole: staff.role,
      // 工作台手动切换仅向已绑定夜宵店的正式楼长开放——桩环境恒无
      canSwitchWorkspace: false,
      nightEnabled: false,
      hasNightHistory: false,
      mode: !dayClosed ? 'day' : 'rest',
      hasNightStore: false,
      campusName: staff.campus.name,
      nightStartAt: null,
      nightEndAt: null,
      reason: dayClosed ? '当前已休息' : '',
    });
  }
}
