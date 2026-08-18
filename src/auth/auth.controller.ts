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
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtService } from '@nestjs/jwt';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { IsOptional, IsString, Matches, MinLength } from 'class-validator';
import { SetMetadata } from '@nestjs/common';
import { compare } from 'bcryptjs';
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

class AdminLoginDto {
  @IsString()
  username!: string;
  @IsString()
  @MinLength(1)
  password!: string;
}

class WechatLoginDto {
  // wx.login 返回的临时登录凭证 code。
  @IsString()
  code!: string;
  // 发起登录的小程序 appid（双小程序各自一对凭证，后端按 appid 路由 secret）。
  @IsString()
  @IsOptional()
  appid?: string;
}

class PhoneDto {
  // TODO(IK8W5H)：真实实现应传小程序手机号授权码（getPhoneNumber code），
  // 由后端调微信 phonenumber.getPhoneNumber 解密；本批演示通道直接传号绑定。
  @Matches(/^1\d{10}$/, { message: '手机号格式不正确' })
  phone!: string;
}

/** 员工微信绑定（IK8W5Q）：首次登录用工号+姓名换绑 openid。
 *  姓名双因子是 MVP 折衷（无短信/邮箱校验通道），防纯工号枚举绑定。 */
class StaffBindDto {
  @IsString()
  code!: string;
  @IsString()
  staffNo!: string;
  @IsString()
  name!: string;
  @IsString()
  @IsOptional()
  appid?: string;
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

  /**
   * 后台账号密码登录（ADR-0004 / IK9JHP）：AdminAccount 表 + bcrypt 校验，
   * 取代 test-login 角色卡直通。统一 401 文案防账号枚举；按 IP 限流防爆破。
   */
  @Post('admin-login')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: '管理后台账号密码登录（AdminAccount + bcrypt）' })
  async adminLogin(@Body() body: AdminLoginDto) {
    const account = await this.db.adminAccount.findUnique({
      where: { username: body.username?.trim() ?? '' },
    });
    // 账号不存在与密码错误同文案同状态码，防枚举。
    const passwordOk = account
      ? await compare(body.password ?? '', account.passwordHash)
      : false;
    if (!account || !passwordOk)
      throw new UnauthorizedException('账号或密码不正确');
    const claims: AuthUser = {
      id: account.id,
      campusId: account.campusId,
      role: account.role as AuthUser['role'],
    };
    return ok({
      token: this.jwt.sign(claims),
      user: {
        ...claims,
        nickname: account.nickname || account.username,
        phone: '',
        avatar: '',
      },
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
    // 后台账号（admin/operations/warehouse/finance）来自 AdminAccount 表。
    if (
      ['admin', 'operations', 'warehouse', 'finance'].includes(req.user.role)
    ) {
      const account = await this.db.adminAccount.findUnique({
        where: { id: req.user.id },
      });
      return ok({
        ...req.user,
        nickname: account?.nickname || account?.username || '平台管理员',
        phone: '',
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

  /**
   * 双小程序凭证路由（IK8W5Q）：用户端/履约端各一对 appid+secret，
   * 客户端登录时带 appid 挑选对应凭证；未传 appid 用第一对配好的（兼容旧单对部署）。
   */
  private wechatCredentials(
    appid?: string,
  ): { appid: string; secret: string } | undefined {
    const pairs = [
      { appid: process.env.WX_APPID_USER, secret: process.env.WX_SECRET_USER },
      {
        appid: process.env.WX_APPID_DELIVERY,
        secret: process.env.WX_SECRET_DELIVERY,
      },
      { appid: process.env.WX_APPID, secret: process.env.WX_SECRET }, // 旧单对配置
    ].filter((p): p is { appid: string; secret: string } =>
      Boolean(p.appid && p.secret),
    );
    return appid ? pairs.find((p) => p.appid === appid) : pairs[0];
  }

  /** 微信登录环境是否已配置（任一对 WX_*_APPID/WX_*_SECRET 齐备）。 */
  private wechatConfigured() {
    return Boolean(this.wechatCredentials());
  }

  /** wx.code2session 换 openid（双小程序共用，凭证由 appid 路由） */
  private async code2Session(
    credentials: { appid: string; secret: string },
    code: string,
  ) {
    let session: {
      openid?: string;
      unionid?: string;
      errcode?: number;
      errmsg?: string;
    };
    try {
      const response = await fetch(
        `https://api.weixin.qq.com/sns/jscode2session?appid=${encodeURIComponent(
          credentials.appid,
        )}&secret=${encodeURIComponent(
          credentials.secret,
        )}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`,
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
    return session;
  }

  @Post('wechat-login')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: '微信小程序登录（wx.code2Session，未配置 WX_* 时返回 501）',
  })
  async wechatLogin(@Body() body: WechatLoginDto) {
    // env 门控：未配置微信凭证直接 501，不回退 test-login 演示通道。
    if (!this.wechatConfigured())
      throw new HttpException('微信登录未配置', HttpStatus.NOT_IMPLEMENTED);
    if (!body.code?.trim())
      throw new BadRequestException('缺少微信登录凭证 code');
    const credentials = this.wechatCredentials(body.appid?.trim());
    if (!credentials)
      throw new BadRequestException('该小程序未配置微信登录凭证');
    const session = await this.code2Session(credentials, body.code.trim());
    // 履约端小程序 → 员工通道：openid 必须已绑定 Staff，未绑定引导走 staff-bind
    if (credentials.appid === process.env.WX_APPID_DELIVERY) {
      const staff = await this.db.staff.findUnique({
        where: { openid: session.openid },
      });
      if (!staff || staff.status === 'deleted')
        throw new NotFoundException('该微信未绑定员工账号，请用工号绑定后登录');
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
    // 用户端小程序 → 买家通道：首次登录创建用户（昵称"微信用户"、手机号空，
    // 后续 POST /auth/phone 绑定），campusId 取默认校园（第一个 campus）。
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

  /** 员工微信绑定（IK8W5Q）：履约端小程序首次登录，工号+姓名换绑 openid 后直接下发 token */
  @Post('staff-bind')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({ summary: '员工绑定微信（工号+姓名换绑 openid，绑定即登录）' })
  async staffBind(@Body() body: StaffBindDto) {
    const credentials = this.wechatCredentials(
      body.appid?.trim() || process.env.WX_APPID_DELIVERY,
    );
    if (!credentials || credentials.appid !== process.env.WX_APPID_DELIVERY)
      throw new HttpException('员工微信登录未配置', HttpStatus.NOT_IMPLEMENTED);
    if (!body.code?.trim() || !body.staffNo?.trim() || !body.name?.trim())
      throw new BadRequestException('缺少微信凭证/工号/姓名');
    const session = await this.code2Session(credentials, body.code.trim());
    const staff = await this.db.staff.findUnique({
      where: { staffNo: body.staffNo.trim() },
    });
    if (!staff || staff.status === 'deleted')
      throw new NotFoundException('工号不存在');
    // 姓名双因子：防纯工号枚举绑定他人账号（换绑即覆盖旧 openid）
    if (staff.name !== body.name.trim())
      throw new BadRequestException('工号与姓名不匹配');
    const after = await this.db.staff.update({
      where: { id: staff.id },
      data: { openid: session.openid },
    });
    const claims: AuthUser = {
      id: after.id,
      campusId: after.campusId,
      role: after.role as AuthUser['role'],
    };
    return ok(
      {
        token: this.jwt.sign(claims),
        user: { ...claims, nickname: after.name, phone: '', avatar: '' },
      },
      '绑定成功',
    );
  }

  @Post('phone')
  @UseGuards(JwtAuthGuard, UserRoleGuard)
  @SetMetadata(USER_ROLES_KEY, ['user'])
  @ApiBearerAuth()
  @ApiOperation({
    summary: '绑定手机号（简化版：直接传号；真实实现见 PhoneDto TODO）',
  })
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
