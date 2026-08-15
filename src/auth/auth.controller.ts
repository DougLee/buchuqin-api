import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtService } from '@nestjs/jwt';
import { IsIn, IsString } from 'class-validator';
import { ok } from '../common/api-response';
import { PrismaService } from '../database/prisma.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import type { AuthRequest, AuthUser } from './jwt-auth.guard';

const IDENTITIES = [
  'user',
  'building-manager',
  'fulltime-rider',
  'parttime-rider',
  'admin',
] as const;

class TestLoginDto {
  // 支持 identity 角色别名，也支持具体 staffNo / staff id（演示后台增删的账号）。
  @IsString()
  identity!: string;
}

@ApiTags('认证')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly jwt: JwtService,
    private readonly db: PrismaService,
  ) {}

  @Post('test-login')
  @HttpCode(200)
  @ApiOperation({ summary: '联调测试账号登录（生产环境关闭）' })
  async login(@Body() body: TestLoginDto) {
    if (process.env.NODE_ENV === 'production') throw new NotFoundException();
    if (body.identity === 'user') {
      const user = await this.db.user.findUniqueOrThrow({
        where: { id: 'user-001' },
      });
      const claims: AuthUser = {
        id: user.id,
        campusId: user.campusId,
        role: 'user',
      };
      return ok({ token: this.jwt.sign(claims), user });
    }
    if (body.identity === 'admin') {
      const claims: AuthUser = {
        id: 'admin-001',
        campusId: 'campus-hbut',
        role: 'admin',
      };
      return ok({
        token: this.jwt.sign(claims),
        user: {
          ...claims,
          nickname: '平台管理员',
          phone: '027****8899',
          avatar: '',
        },
      });
    }
    const staff = IDENTITIES.includes(
      body.identity as (typeof IDENTITIES)[number],
    )
      ? await this.db.staff.findFirstOrThrow({
          where: {
            role: body.identity,
            status: { not: 'deleted' },
          },
        })
      : await this.db.staff.findFirst({
          where: {
            OR: [{ staffNo: body.identity }, { id: body.identity }],
            status: { not: 'deleted' },
          },
        });
    if (!staff) throw new NotFoundException('测试账号不存在');
    const claims: AuthUser = {
      id: staff.id,
      campusId: staff.campusId,
      role: staff.role as AuthUser['role'],
    };
    return ok({
      token: this.jwt.sign(claims),
      user: { ...claims, nickname: staff.name, phone: '', avatar: '' },
    });
  }

  @Get('profile')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  async profile(@Req() req: AuthRequest) {
    if (req.user.role === 'user') {
      const user = await this.db.user.findUniqueOrThrow({
        where: { id: req.user.id },
        include: { addresses: true },
      });
      return ok({
        ...req.user,
        nickname: user.nickname,
        phone: user.phone,
        avatar: user.avatar,
        defaultAddressId: user.addresses.find((a) => a.isDefault)?.id ?? null,
      });
    }
    const staff = await this.db.staff.findUnique({
      where: { id: req.user.id },
    });
    return ok(
      staff
        ? { ...req.user, nickname: staff.name, phone: '' }
        : { ...req.user, nickname: '平台管理员', phone: '' },
    );
  }
}
