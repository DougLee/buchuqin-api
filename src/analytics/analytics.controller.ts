import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { AuthRequest } from '../auth/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { USER_ROLES_KEY, UserRoleGuard } from '../auth/user-role.guard';
import { PrismaService } from '../database/prisma.service';

/**
 * 用户行为埋点（IKRGLV MVP）：转化漏斗+商品热度。
 * 设计红线：fire-and-forget——接口只落库不返回明细，客户端静默调用，
 * 任何失败不影响用户操作。userId/campusId 服务端从 token 取，不信客户端。
 */

/// 事件白名单（IKRGLV 首批）：新增事件在此登记，防任意写入
const TRACK_EVENTS = [
  'page_view',
  'product_view',
  'search',
  'add_cart',
  'share',
] as const;

class TrackEventDto {
  @IsIn(TRACK_EVENTS, { message: '未登记的事件类型' })
  event!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64, { message: 'targetId 过长' })
  targetId?: string;

  /** 非敏感维度（页面/数量等）；禁止放手机号等敏感字段（上报侧约定） */
  @IsOptional()
  @IsObject()
  @MaxLength(512, { message: 'meta 过大' })
  meta?: Record<string, unknown>;
}

class TrackBatchDto {
  @ArrayMaxSize(50, { message: '单次最多 50 条' })
  @ValidateNested({ each: true })
  @Type(() => TrackEventDto)
  events!: TrackEventDto[];
}

@ApiTags('行为埋点')
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly db: PrismaService) {}

  @Post('events')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, UserRoleGuard)
  @SetMetadata(USER_ROLES_KEY, ['user'])
  @ApiBearerAuth()
  @ApiOperation({ summary: '行为事件批量上报（静默调用，永远返回成功）' })
  async track(@Req() req: AuthRequest, @Body() body: TrackBatchDto) {
    const userId = req.user.id;
    // campusId 从用户档案取（token 里可能带旧值，以库为准；取不到丢事件不报错）
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: { campusId: true },
    });
    if (!user || !body.events?.length) return { ok: true, saved: 0 };
    try {
      const result = await this.db.userEvent.createMany({
        data: body.events.map((e) => ({
          userId,
          campusId: user.campusId,
          event: e.event,
          targetId: (e.targetId ?? '').slice(0, 64),
          meta: (e.meta ?? undefined) as never,
        })),
      });
      return { ok: true, saved: result.count };
    } catch {
      // 埋点永不抛错：落库失败静默（客户端本就 fire-and-forget 不重试）
      return { ok: true, saved: 0 };
    }
  }
}
