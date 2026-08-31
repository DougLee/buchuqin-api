import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  NotFoundException,
  Patch,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtService } from '@nestjs/jwt';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { SetMetadata } from '@nestjs/common';
import { compare, hash } from 'bcryptjs';
import { ok } from '../common/api-response';
import { ADMIN_CAMPUS_ID } from '../common/campus';
import { PrismaService } from '../database/prisma.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { USER_ROLES_KEY, UserRoleGuard } from './user-role.guard';
import type { AuthRequest, AuthUser } from './jwt-auth.guard';
import { BusinessService } from '../business/business.service';

class AdminLoginDto {
  @IsString()
  username!: string;
  @IsString()
  @MinLength(1)
  password!: string;
}

class ChangePasswordDto {
  @IsString()
  oldPassword!: string;
  @IsString()
  @MinLength(8, { message: '新密码至少 8 位' })
  newPassword!: string;
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
  // IK9SO4：button open-type="getPhoneNumber" 下发的动态令牌，
  // 后端调微信 getuserphonenumber 换真实号码（优先通道）。
  @IsOptional()
  @IsString()
  code?: string;
  // 直传号码为兼容通道（演示/回调失败兜底），二选一。
  @IsOptional()
  @Matches(/^1\d{10}$/, { message: '手机号格式不正确' })
  phone?: string;
}

/** 用户资料自助修改（IK9ROG）：昵称/头像落库。 */
class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @Matches(/^.{1,12}$/, { message: '昵称为 1-12 个字符' })
  nickname?: string;

  @IsOptional()
  @IsString()
  @Matches(/^https?:\/\//, { message: '头像须为 http(s) 地址' })
  @MaxLength(500)
  avatar?: string;
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

/** 切换校区（IKAJT2）：目标校区 id；服务层校验开放状态并清跨校区数据。 */
class SelectCampusDto {
  @IsString()
  campusId!: string;
}

@ApiTags('认证')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly jwt: JwtService,
    private readonly db: PrismaService,
    private readonly business: BusinessService,
  ) {}


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

  /**
   * 后台账号自助改密（IK9KWO）：验旧密码 → 更新 hash。
   * 仅 AdminAccount 持有者可用（小程序用户/员工无密码体系）。
   */
  @Post('change-password')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '自助修改密码（需旧密码，仅后台账号）' })
  async changePassword(
    @Req() req: AuthRequest,
    @Body() body: ChangePasswordDto,
  ) {
    const account = await this.db.adminAccount.findUnique({
      where: { id: req.user.id },
    });
    if (!account)
      throw new BadRequestException('该账号类型不支持修改密码');
    if (!(await compare(body.oldPassword ?? '', account.passwordHash)))
      throw new UnauthorizedException('原密码不正确');
    await this.db.adminAccount.update({
      where: { id: account.id },
      data: { passwordHash: await hash(body.newPassword, 10) },
    });
    return ok({ id: account.id }, '密码已更新');
  }

  /** 用户资料自助修改（IK9ROG）：昵称/头像落库，DB 为准（前端本地 storage 仅展示加速）。 */
  @Patch('profile')
  @UseGuards(JwtAuthGuard, UserRoleGuard)
  @SetMetadata(USER_ROLES_KEY, ['user'])
  @ApiBearerAuth()
  async updateProfile(
    @Req() req: AuthRequest,
    @Body() body: UpdateProfileDto,
  ) {
    const data: { nickname?: string; avatar?: string } = {};
    if (body.nickname?.trim()) data.nickname = body.nickname.trim();
    if (body.avatar) data.avatar = body.avatar;
    if (!Object.keys(data).length)
      throw new BadRequestException('没有可更新的资料字段');
    const user = await this.db.user.update({
      where: { id: req.user.id },
      data,
    });
    return ok({ nickname: user.nickname, avatar: user.avatar }, '资料已更新');
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
    // 后台账号（hq/admin/operations/warehouse/finance）来自 AdminAccount 表。
    if (
      ['hq', 'admin', 'operations', 'warehouse', 'finance'].includes(
        req.user.role,
      )
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

  /**
   * 切换校区（IKAJT2 选校区/切换流程）：JWT 带 campusId claim，切换必须换发
   * token——返回体与登录一致，前端按登录同款落新会话。旧校区购物车清除、
   * 旧校区地址取消默认（行保留），商品/价格/门槛随新校区生效。
   */
  @Post('campuses/select')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: '切换我的校区（用户端，返回换发 token）' })
  async selectCampus(@Req() req: AuthRequest, @Body() body: SelectCampusDto) {
    if (req.user.role !== 'user')
      throw new ForbiddenException('仅用户端账号可切换校区');
    const user = await this.business.switchUserCampus(
      req.user.id,
      body.campusId.trim(),
    );
    const claims: AuthUser = {
      id: user.id,
      campusId: user.campusId,
      role: 'user',
    };
    return ok(
      {
        token: this.jwt.sign(claims),
        user: {
          ...claims,
          nickname: user.nickname,
          phone: user.phone,
          avatar: user.avatar,
        },
      },
      '校区已切换',
    );
  }

  /* ---------- 后台账号多校区切换（IKB3KG 方案A）：授权表内自选，换发 token ---------- */
  /** 我的可运营校区：授权表 ∪ 当前校区兜底；hq 跨校区视角返回空（前端不显示切换）。 */
  @Get('admin/campuses')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '我的可运营校区列表（后台账号）' })
  async adminCampuses(@Req() req: AuthRequest) {
    if (req.user.role === 'hq' || req.user.role === 'user') return ok([]);
    const rows = await this.db.adminCampusAccess.findMany({
      where: { accountId: req.user.id },
      select: { campusId: true },
    });
    const ids = [
      ...new Set([...rows.map((r) => r.campusId), req.user.campusId]),
    ];
    const campuses = await this.db.campus.findMany({
      where: { id: { in: ids }, status: 'active' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, name: true, shortName: true },
    });
    return ok(
      campuses.map((c) => ({ ...c, current: c.id === req.user.campusId })),
    );
  }

  /** 切换运营校区（镜像用户端 /auth/campuses/select）：校验授权表 →
   *  持久化 AdminAccount.campusId → 换发 campusId 口径 token。 */
  @Post('admin/campuses/select')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: '切换后台账号运营校区（校验授权，换发 token）' })
  async selectAdminCampus(
    @Req() req: AuthRequest,
    @Body() body: SelectCampusDto,
  ) {
    if (
      !['admin', 'operations', 'warehouse', 'finance'].includes(req.user.role)
    )
      throw new ForbiddenException('该账号不支持切换校区');
    const campusId = body.campusId.trim();
    const campus = await this.db.campus.findFirst({
      where: { id: campusId, status: 'active' },
    });
    if (!campus) throw new BadRequestException('目标校区不存在或未开放');
    if (campusId !== req.user.campusId) {
      const granted = await this.db.adminCampusAccess.findUnique({
        where: { accountId_campusId: { accountId: req.user.id, campusId } },
      });
      if (!granted)
        throw new ForbiddenException('未授权运营该校区，请联系总部开通');
      await this.db.adminAccount.update({
        where: { id: req.user.id },
        data: { campusId },
      });
    }
    const account = await this.db.adminAccount.findUniqueOrThrow({
      where: { id: req.user.id },
    });
    const claims: AuthUser = {
      id: account.id,
      campusId: account.campusId,
      role: account.role as AuthUser['role'],
    };
    return ok(
      {
        token: this.jwt.sign(claims),
        user: {
          ...claims,
          nickname: account.nickname || account.username,
          phone: '',
          avatar: '',
        },
      },
      '校区已切换',
    );
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

  /** 员工微信解绑（IKC4IN 追加）：「退出登录」的真语义——清 Staff.openid。
   *  只清前端 token 是假退出：openid 仍绑定时静默 wx.login 会立刻自动
   *  登回原账号。解绑后静默登录 404 → 走游客态/重新工号绑定。 */
  @Post('wechat-unbind')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @ApiOperation({ summary: '员工解绑微信（退出登录：清 openid，再登录需重新绑定）' })
  async wechatUnbind(@Req() req: AuthRequest) {
    const staff = await this.db.staff.findFirst({
      where: { id: req.user.id, status: { not: 'deleted' } },
    });
    if (!staff) throw new NotFoundException('员工不存在');
    await this.db.staff.update({
      where: { id: staff.id },
      data: { openid: null },
    });
    return ok({ unbound: true }, '已退出登录');
  }

  /** 用户端小程序 access_token 内存缓存（IK9SO4）：7200s 失效，提前 5 分钟刷新 */
  private userAccessToken?: { token: string; expiresAt: number };

  private async getUserAccessToken() {
    // 手机号解析只走用户端凭证（getPhoneNumber code 由用户端小程序下发）
    const credentials = this.wechatCredentials(process.env.WX_APPID_USER);
    if (!credentials || credentials.appid !== process.env.WX_APPID_USER)
      throw new HttpException('微信手机号服务未配置', HttpStatus.NOT_IMPLEMENTED);
    if (this.userAccessToken && this.userAccessToken.expiresAt > Date.now())
      return this.userAccessToken.token;
    let data: {
      access_token?: string;
      expires_in?: number;
      errcode?: number;
      errmsg?: string;
    };
    try {
      const response = await fetch(
        `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(
          credentials.appid,
        )}&secret=${encodeURIComponent(credentials.secret)}`,
        { signal: AbortSignal.timeout(5000) },
      );
      data = (await response.json()) as typeof data;
    } catch {
      throw new HttpException('微信服务暂不可用', HttpStatus.BAD_GATEWAY);
    }
    if (!data.access_token || data.errcode)
      throw new BadRequestException(
        `获取 access_token 失败：${data.errmsg ?? '微信未返回凭证'}`,
      );
    this.userAccessToken = {
      token: data.access_token,
      expiresAt: Date.now() + ((data.expires_in ?? 7200) - 300) * 1000,
    };
    return data.access_token;
  }

  /** getPhoneNumber 动态令牌换手机号（IK9SO4），取纯号码（无区号）。 */
  private async phoneFromWechatCode(code: string) {
    const accessToken = await this.getUserAccessToken();
    let data: {
      phone_info?: { purePhoneNumber?: string; phoneNumber?: string };
      errcode?: number;
      errmsg?: string;
    };
    try {
      const response = await fetch(
        `https://api.weixin.qq.com/wxa/business/getuserphonenumber?access_token=${encodeURIComponent(
          accessToken,
        )}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code }),
          signal: AbortSignal.timeout(5000),
        },
      );
      data = (await response.json()) as typeof data;
    } catch {
      throw new HttpException('微信服务暂不可用', HttpStatus.BAD_GATEWAY);
    }
    const phone = data.phone_info?.purePhoneNumber ?? data.phone_info?.phoneNumber;
    if (!phone || data.errcode)
      throw new BadRequestException(
        `手机号授权失败：${data.errmsg ?? '微信未返回手机号'}`,
      );
    return phone;
  }

  @Post('phone')
  @UseGuards(JwtAuthGuard, UserRoleGuard)
  @SetMetadata(USER_ROLES_KEY, ['user'])
  @ApiBearerAuth()
  @ApiOperation({
    summary: '绑定手机号（IK9SO4：优先微信授权码换号，直传号码兼容）',
  })
  async bindPhone(@Req() req: AuthRequest, @Body() body: PhoneDto) {
    // IK9SO4：授权码优先——号码由微信侧解析，不可伪造；
    // 无 code 时回退直传（演示通道），仍走格式复核。
    const phone = body.code?.trim()
      ? await this.phoneFromWechatCode(body.code.trim())
      : body.phone;
    // service 层防御性复核：绕过管道的调用也不允许脏号落库。
    if (!/^1\d{10}$/.test(phone ?? ''))
      throw new BadRequestException('手机号格式不正确');
    const user = await this.db.user.findUnique({
      where: { id: req.user.id },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('用户不存在');
    const after = await this.db.user.update({
      where: { id: req.user.id },
      // IKA090：落库用解析后的号码——授权码路径 body.phone 为 undefined，
      // 旧写法 data:{phone: body.phone} 被 Prisma 当「不更新」静默跳过，
      // 接口 201 成功但手机号永远存不上
      data: { phone },
    });
    return ok({ id: after.id, phone: after.phone }, '手机号已绑定');
  }
}
