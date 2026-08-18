import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsString } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { USER_ROLES_KEY, UserRoleGuard } from '../auth/user-role.guard';
import type { AuthRequest } from '../auth/jwt-auth.guard';
import { ok } from '../common/api-response';
import { PaymentsService } from './payments.service';

class PrepayDto {
  @IsString()
  orderId!: string;
}

@ApiTags('支付')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly service: PaymentsService) {}

  @Post('wechat/prepay')
  @UseGuards(JwtAuthGuard, UserRoleGuard)
  @SetMetadata(USER_ROLES_KEY, ['user'])
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      '微信小程序预下单（未配置 WX_* 商户参数时返回 { mock: true }，走 /orders/:id/pay 演示通道）',
  })
  async prepay(@Req() req: AuthRequest, @Body() body: PrepayDto) {
    return ok(await this.service.prepay(req.user.id, body.orderId));
  }

  // 微信服务器回调：公网公开不走 JWT；响应体按微信规范裸返回 { code, message }。
  @Post('wechat/notify')
  @HttpCode(200)
  @ApiOperation({ summary: '微信支付回调（验签占位 + 幂等处理）' })
  async notify(@Body() body: Record<string, unknown>) {
    return this.service.notify(body);
  }

  @Get(':orderId/status')
  @UseGuards(JwtAuthGuard, UserRoleGuard)
  @SetMetadata(USER_ROLES_KEY, ['user'])
  @ApiBearerAuth()
  @ApiOperation({ summary: '订单支付状态查询（前端轮询支付结果）' })
  async status(@Req() req: AuthRequest, @Param('orderId') orderId: string) {
    return ok(await this.service.status(req.user.id, orderId));
  }
}
