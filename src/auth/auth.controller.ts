import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtService } from '@nestjs/jwt';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { IsString, Matches } from 'class-validator';
import { SetMetadata } from '@nestjs/common';
import { ok } from '../common/api-response';
import { ADMIN_CAMPUS_ID } from '../common/campus';
import { PrismaService } from '../database/prisma.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { USER_ROLES_KEY, UserRoleGuard } from './user-role.guard';
import type { AuthRequest, AuthUser } from './jwt-auth.guard';

const IDENTITIES = [
  'user',
  'building-manager',
  'fulltime-rider',
  'parttime-rider',
  'admin',
] as const;

/** 后台角色别名（IK8W5W）：admin 系细分岗位，token 不挂 Staff 记录，id 用 {role}-001 占位。 */
const ADMIN_ROLE_ALIASES: Record<string, string> = {
  operations: '平台运营',
  warehouse: '仓储管理',
  finance: '财务管理',
};

class TestLoginDto {
  // 支持 identity 角色别名，也支持具体 staffNo / staff id（演示后台增删的账号）。
  @IsString()
  identity!: string;
}

class WechatLoginDto {
  // wx.login 返回的临时登录凭证 code。
  @IsString()
  code!: string;
}

class PhoneDto {
  // TODO(IK8W5H)：真实实现应传小程序手机号授权码（getPhoneNumber code），
  // 由后端调微信 phonenumber.getPhoneNumber 解密；本批演示通道直接传号绑定。
  @Matches(/^1\d{10}$/, { message: '手机号格式不正确' })
  phone!: string;
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
  // 演示通道收敛：按 IP 限流，防枚举 staffNo 遍历登录
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: '联调测试账号登录（生产环境关闭）' })
  async login(@Body() body: TestLoginDto) {
    if (
      process.env.NODE_ENV === 'production' &&
      process.env.ALLOW_TEST_LOGIN !== 'true'
    )
      throw new NotFoundException();
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
        campusId: ADMIN_CAMPUS_ID,
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
    // 后台角色别名（IK8W5W）：各发对应 role 的 token，campusId 固定管理端默认校园。
    if (body.identity in ADMIN_ROLE_ALIASES) {
      const claims: AuthUser = {
        id: `${body.identity}-001`,
        campusId: ADMIN_CAMPUS_ID,
        role: body.identity as AuthUser['role'],
      };
      return ok({
        token: this.jwt.sign(claims),
        user: {
          ...claims,
          nickname: ADMIN_ROLE_ALIASES[body.identity],
          phone: '',
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

  /** 微信登录环境是否已配置（WX_APPID/WX_SECRET 齐备）。 */
  private wechatConfigured() {
    return Boolean(process.env.WX_APPID && process.env.WX_SECRET);
  }

  @Post('wechat-login')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: '微信小程序登录（wx.code2Session，未配置 WX_* 时返回 501）' })
  async wechatLogin(@Body() body: WechatLoginDto) {
    // env 门控：未配置微信凭证直接 501，不回退 test-login 演示通道。
    if (!this.wechatConfigured())
      throw new HttpException('微信登录未配置', HttpStatus.NOT_IMPLEMENTED);
    if (!body.code?.trim())
      throw new BadRequestException('缺少微信登录凭证 code');
    let session: { openid?: string; unionid?: string; errcode?: number; errmsg?: string };
    try {
      const response = await fetch(
        `https://api.weixin.qq.com/sns/jscode2session?appid=${encodeURIComponent(
          process.env.WX_APPID!,
        )}&secret=${encodeURIComponent(process.env.WX_SECRET!)}&js_code=${encodeURIComponent(
          body.code.trim(),
        )}&grant_type=authorization_code`,
        { signal: AbortSignal.timeout(5000) },
      );
      session = (await response.json()) as typeof session;
    } catch {
      throw new HttpException('微信登录服务暂不可用', HttpStatus.BAD_GATEWAY);
    }
    if (!session.openid || session.errcode)
      throw new BadRequestException(
        `微信登录失败：${session.errmsg ?? '未返回 openid'}`,
      );
    // 首次登录创建用户：昵称"微信用户"、手机号空（后续 POST /auth/phone 绑定），
    // campusId 取默认校园（第一个 campus）。
    let user = await this.db.user.findUnique({
      where: { openid: session.openid },
    });
    if (!user) {
      const campus =
        (await this.db.campus.findFirst({ orderBy: { createdAt: 'asc' } })) ??
        null;
      user = await this.db.user.create({
        data: {
          campusId: campus?.id ?? ADMIN_CAMPUS_ID,
          nickname: '微信用户',
          phone: '',
          role: 'user',
          openid: session.openid,
        },
      });
    }
    const claims: AuthUser = {
      id: user.id,
      campusId: user.campusId,
      role: 'user',
    };
    return ok({
      token: this.jwt.sign(claims),
      user: {
        ...claims,
        nickname: user.nickname,
        phone: user.phone,
        avatar: user.avatar,
      },
    });
  }

  @Post('phone')
  @UseGuards(JwtAuthGuard, UserRoleGuard)
  @SetMetadata(USER_ROLES_KEY, ['user'])
  @ApiBearerAuth()
  @ApiOperation({ summary: '绑定手机号（简化版：直接传号；真实实现见 PhoneDto TODO）' })
  async bindPhone(@Req() req: AuthRequest, @Body() body: PhoneDto) {
    // service 层防御性复核：绕过管道的调用也不允许脏号落库。
    if (!/^1\d{10}$/.test(body.phone ?? ''))
      throw new BadRequestException('手机号格式不正确');
    const user = await this.db.user.findUnique({
      where: { id: req.user.id },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('用户不存在');
    const after = await this.db.user.update({
      where: { id: req.user.id },
      data: { phone: body.phone },
    });
    return ok({ id: after.id, phone: after.phone }, '手机号已绑定');
  }
}
