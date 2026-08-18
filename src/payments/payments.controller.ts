import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  SetMetadata,
  UseGuards,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsString } from 'class-validator';
import type { Request } from 'express';
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
    summary: '微信小程序预下单（未配置商户参数返回 501，ADR-0004 后无演示通道）',
  })
  async prepay(@Req() req: AuthRequest, @Body() body: PrepayDto) {
    return ok(await this.service.prepay(req.user.id, body.orderId));
  }

  // 微信服务器回调：公网公开不走 JWT；响应体按微信规范裸返回 { code, message }。
  // 验签必须拿原始请求体（main.ts rawBody:true），JSON 再序列化字节序会变。
  @Post('wechat/notify')
  @HttpCode(200)
  @ApiOperation({ summary: '微信支付回调（平台证书验签 + 幂等处理）' })
  async notify(
    @Req() req: RawBodyRequest<Request>,
    @Headers() headers: Record<string, string | string[] | undefined>,
    @Body() body: Record<string, unknown>,
  ) {
    return this.service.notify(
      headers,
      req.rawBody?.toString('utf8') ?? '',
      body,
    );
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
