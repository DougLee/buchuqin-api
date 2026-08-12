import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtService } from '@nestjs/jwt';
import { IsOptional, IsString } from 'class-validator';
import { ok } from '../common/api-response';
import { JwtAuthGuard } from './jwt-auth.guard';
import type { AuthRequest } from './jwt-auth.guard';
class MockLoginDto {
  @IsOptional() @IsString() code?: string;
}
@ApiTags('认证')
@Controller('auth')
export class AuthController {
  constructor(private readonly jwt: JwtService) {}
  @Post('mock-login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mock 微信登录' })
  login(@Body() body: MockLoginDto) {
    const fulfillment = body.code?.includes('fulfillment');
    const user = {
      id: fulfillment ? 'staff-bm-001' : 'user-001',
      campusId: 'campus-hbut',
      role: fulfillment ? ('building-manager' as const) : ('user' as const),
    };
    return ok({
      token: this.jwt.sign(user),
      user: {
        ...user,
        nickname: fulfillment ? '陈晨' : '湖工大小橙',
        phone: fulfillment ? '139****0518' : '138****2026',
        avatar: '',
      },
    });
  }
  @Get('profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  profile(@Req() req: AuthRequest) {
    return ok({
      ...req.user,
      nickname: '湖工大小橙',
      phone: '138****2026',
      defaultAddressId: 'address-001',
    });
  }
}
