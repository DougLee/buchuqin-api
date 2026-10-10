import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../database/prisma.service';
import { BusinessService } from '../business/business.service';
import { RbacService } from '../admin/rbac/rbac.service';
import { AuthController } from './auth.controller';
import {
  campusOrganizationId,
  resolveOrganizationByAppId,
} from '../common/organization';

/**
 * 组织身份与用户隔离（IKKRMO / ADR-0001）：
 * - AppID → 组织解析：命中 Organization.wxAppId 限定组织校区集合；未命中
 *   （组织 A 未登记 wxAppId 的现状）→ null 走 env 单组织兼容路径，行为不变；
 * - 注册/分享落校区/切换校区：跨组织校区 400/403 拒绝；
 * - 校区列表（campusOptions）/切校区（switchUserCampus）：按用户当前校区
 *   推导组织归属限定集合，不接受客户端传组织参数；
 * - 员工端（staff-bind/静默登录）：登录小程序组织与员工校区组织不符即拒。
 * 双组织 fixture：orgB（登记 wxAppId）× org-a（现网存量，未登记）+
 * 无组织归属校区（兼容路径）。
 */
describe('organization identity (IKKRMO / ADR-0001)', () => {
  const db = new PrismaService();
  const business = new BusinessService(db);
  const controller = new AuthController(
    new JwtService({ secret: 'test-secret' }),
    db,
    business,
    new RbacService(db),
  );
  const tag = `ikkrmo-${Date.now()}`;
  const ORG_B_ID = `org-specb-${tag}`;
  const ORG_B_APPID = `wx-specb-user-${tag}`;
  const STAFF_B_APPID = `wx-specb-staff-${tag}`;
  const COMPAT_APPID = `wx-specb-compat-${tag}`;
  const CAMPUS_B1 = `campus-specb1-${tag}`;
  const CAMPUS_B2 = `campus-specb2-${tag}`;
  const CAMPUS_X = `campus-specx-${tag}`;
  const STAFF_NO_B = `staff-specb-${tag}`;
  const STAFF_NO_A = `staff-speca-${tag}`;
  const userIds: string[] = [];
  const staffIds: string[] = [];

  const WX_ENV_KEYS = [
    'WX_APPID',
    'WX_SECRET',
    'WX_APPID_USER',
    'WX_SECRET_USER',
    'WX_APPID_DELIVERY',
    'WX_SECRET_DELIVERY',
  ] as const;
  const hadEnv = Object.fromEntries(WX_ENV_KEYS.map((k) => [k, process.env[k]]));

  /** mock code2session：按 openid 回包（无 unionid，避开员工 unionId 补录链路） */
  const mockCode2Session = (openid: string) =>
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ openid })));

  beforeAll(async () => {
    await db.organization.create({
      data: {
        id: ORG_B_ID,
        name: '规格组织B',
        shortName: '规格B',
        wxAppId: ORG_B_APPID,
      },
    });
    for (const [id, name] of [
      [CAMPUS_B1, '规格B一大学'],
      [CAMPUS_B2, '规格B二大学'],
    ] as const) {
      await db.campus.create({
        data: {
          id,
          name,
          shortName: name,
          warehouseName: `${name}仓`,
          organizationId: ORG_B_ID,
        },
      });
    }
    // 无组织归属校区：模拟组织身份未启用前的存量形态（兼容路径）
    await db.campus.create({
      data: {
        id: CAMPUS_X,
        name: '规格无组织大学',
        shortName: '规格无组织',
        warehouseName: '规格无组织仓',
      },
    });
    for (const [campusId, staffNo, name, openid] of [
      [CAMPUS_B2, `staff-specb2-${tag}`, '规格骑手B2', `openid-staffb2-${tag}`],
      [CAMPUS_B1, STAFF_NO_B, '规格骑手B', null],
      ['campus-hbut', STAFF_NO_A, '规格骑手A', null],
      ['campus-hbut', `staff-speca2-${tag}`, '规格骑手A2', `openid-staffa2-${tag}`],
    ] as const) {
      staffIds.push(
        (
          await db.staff.create({
            data: {
              campusId,
              staffNo,
              name,
              role: 'rider',
              roleText: '骑手',
              building: '规格楼',
              openid,
              onTimeRate: '100.00',
              income: 0,
            },
          })
        ).id,
      );
    }
    // 预置「脏数据」老用户：openid 属组织 B 小程序、人却落在组织 A 校区
    userIds.push(
      (
        await db.user.create({
          data: {
            campusId: 'campus-hbut',
            nickname: '规格跨组织老用户',
            phone: '',
            role: 'user',
            openid: `openid-crossold-${tag}`,
          },
        })
      ).id,
    );
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    for (const [key, value] of Object.entries(hadEnv))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await db.userCoupon.deleteMany({ where: { userId: { in: userIds } } });
    await db.cartItem.deleteMany({ where: { userId: { in: userIds } } });
    await db.address.deleteMany({ where: { userId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.staff.deleteMany({ where: { id: { in: staffIds } } });
    await db.campus.deleteMany({
      where: { id: { in: [CAMPUS_B1, CAMPUS_B2, CAMPUS_X] } },
    });
    await db.organization.deleteMany({ where: { id: ORG_B_ID } });
    await db.$disconnect();
  });

  describe('resolveOrganizationByAppId：AppID → 组织解析', () => {
    it('命中 Organization.wxAppId 返回该组织（不含敏感凭据）', async () => {
      const org = await resolveOrganizationByAppId(db, ORG_B_APPID);
      expect(org).toMatchObject({ id: ORG_B_ID, name: '规格组织B' });
      expect(Object.keys(org!)).not.toContain('wxSecret');
    });

    it('未登记的 AppID（组织 A 现状 env WX_APPID_USER）返回 null=兼容路径', async () => {
      expect(await resolveOrganizationByAppId(db, 'wx-never-registered')).toBeNull();
    });

    it('空值返回 null（不误伤未配置部署）', async () => {
      expect(await resolveOrganizationByAppId(db, undefined)).toBeNull();
      expect(await resolveOrganizationByAppId(db, '  ')).toBeNull();
    });

    it('campusOrganizationId：校区 → 组织归属（无归属/不存在=null）', async () => {
      expect(await campusOrganizationId(db, CAMPUS_B1)).toBe(ORG_B_ID);
      expect(await campusOrganizationId(db, CAMPUS_X)).toBeNull();
      expect(await campusOrganizationId(db, `no-such-${tag}`)).toBeNull();
    });
  });

  describe('用户端 wechat-login：组织内注册/落校区', () => {
    beforeAll(() => {
      process.env.WX_APPID_USER = ORG_B_APPID;
      process.env.WX_SECRET_USER = 'spec-secret';
    });

    it('组织小程序新用户自然流量：fallback 落该组织最早开放校区', async () => {
      mockCode2Session(`openid-b-fallback-${tag}`);
      const result = (await controller.wechatLogin({
        code: 'spec-code',
        appid: ORG_B_APPID,
      })) as { data: { token: string; isNewUser?: boolean; user: { campusId: string } } };
      userIds.push(jwtSubject(result));
      expect(result.data.isNewUser).toBe(true);
      expect(result.data.user.campusId).toBe(CAMPUS_B1);
    });

    it('组织小程序新用户 + 分享本组织校区：采纳分享校区', async () => {
      mockCode2Session(`openid-b-shared-${tag}`);
      const result = (await controller.wechatLogin({
        code: 'spec-code',
        appid: ORG_B_APPID,
        campusId: CAMPUS_B2,
      })) as { data: { token: string; user: { campusId: string } } };
      userIds.push(jwtSubject(result));
      expect(result.data.user.campusId).toBe(CAMPUS_B2);
    });

    it('组织小程序新用户 + 分享它组织校区（campus-hbut 属 org-a）：400 拒绝且不建档', async () => {
      mockCode2Session(`openid-b-cross-${tag}`);
      await expect(
        controller.wechatLogin({
          code: 'spec-code',
          appid: ORG_B_APPID,
          campusId: 'campus-hbut',
        }),
      ).rejects.toThrow(
        new BadRequestException('分享校区不属于当前小程序所在组织'),
      );
      expect(
        await db.user.findUnique({
          where: { openid: `openid-b-cross-${tag}` },
        }),
      ).toBeNull();
    });

    it('组织小程序新用户 + 分享不存在的校区：静默忽略 fallback 本组织校区', async () => {
      mockCode2Session(`openid-b-nosuch-${tag}`);
      const result = (await controller.wechatLogin({
        code: 'spec-code',
        appid: ORG_B_APPID,
        campusId: `no-such-${tag}`,
      })) as { data: { token: string; user: { campusId: string } } };
      userIds.push(jwtSubject(result));
      expect(result.data.user.campusId).toBe(CAMPUS_B1);
    });

    it('老用户校区与登录组织不符（脏数据）：403 拒绝登录', async () => {
      mockCode2Session(`openid-crossold-${tag}`);
      await expect(
        controller.wechatLogin({ code: 'spec-code', appid: ORG_B_APPID }),
      ).rejects.toThrow(
        new ForbiddenException('该账号不属于当前小程序所在组织'),
      );
    });

    it('未登记 AppID（兼容路径）：fallback 全局最早真实校区，行为与现状一致', async () => {
      process.env.WX_APPID = COMPAT_APPID;
      process.env.WX_SECRET = 'spec-secret';
      mockCode2Session(`openid-compat-${tag}`);
      const earliest = await db.campus.findFirst({
        where: { type: 'campus', status: 'active' },
        orderBy: { createdAt: 'asc' },
      });
      const result = (await controller.wechatLogin({
        code: 'spec-code',
        appid: COMPAT_APPID,
      })) as { data: { token: string; isNewUser?: boolean; user: { campusId: string } } };
      userIds.push(jwtSubject(result));
      expect(result.data.isNewUser).toBe(true);
      expect(earliest).not.toBeNull();
      // 兼容路径无组织边界：落全局最早真实校区（不因组织 B 存在而改变口径）
      expect(result.data.user.campusId).toBe(earliest!.id);
      expect([CAMPUS_B1, CAMPUS_B2]).not.toContain(result.data.user.campusId);
    });
  });

  describe('campusOptions / switchUserCampus：组织内校区集合', () => {
    it('组织 B 用户：校区列表只见本组织开放校区', async () => {
      const options = await business.campusOptions(CAMPUS_B1);
      const ids = options.map((c) => c.id);
      expect(ids).toContain(CAMPUS_B1);
      expect(ids).toContain(CAMPUS_B2);
      expect(ids).not.toContain('campus-hbut');
      expect(ids).not.toContain(CAMPUS_X);
    });

    it('组织 A 用户（campus-hbut→org-a）：看不到组织 B 校区（隔离生效）', async () => {
      const options = await business.campusOptions('campus-hbut');
      const ids = options.map((c) => c.id);
      expect(ids).toContain('campus-hbut');
      expect(ids).not.toContain(CAMPUS_B1);
      expect(ids).not.toContain(CAMPUS_B2);
    });

    it('无组织归属校区用户：不加限定=兼容全量（组织 B/组织 A/自身校区均可见）', async () => {
      const options = await business.campusOptions(CAMPUS_X);
      const ids = options.map((c) => c.id);
      expect(ids).toContain(CAMPUS_B1);
      expect(ids).toContain('campus-hbut');
      expect(ids).toContain(CAMPUS_X);
    });

    it('无参调用（旧签名兼容）：全量开放校区', async () => {
      const options = await business.campusOptions();
      expect(options.some((c) => c.id === CAMPUS_B1)).toBe(true);
      expect(options.some((c) => c.id === CAMPUS_X)).toBe(true);
    });

    it('组织 B 用户切本组织校区：成功', async () => {
      const user = await db.user.create({
        data: {
          campusId: CAMPUS_B1,
          nickname: '规格切校区B',
          phone: '',
          role: 'user',
        },
      });
      userIds.push(user.id);
      const after = await business.switchUserCampus(user.id, CAMPUS_B2);
      expect(after.campusId).toBe(CAMPUS_B2);
    });

    it('组织 B 用户切它组织校区（campus-hbut 属 org-a）：400 拒绝', async () => {
      const user = await db.user.create({
        data: {
          campusId: CAMPUS_B1,
          nickname: '规格切跨组织B',
          phone: '',
          role: 'user',
        },
      });
      userIds.push(user.id);
      await expect(
        business.switchUserCampus(user.id, 'campus-hbut'),
      ).rejects.toThrow(
        new BadRequestException('该校区不属于当前小程序所在组织'),
      );
      // 未切换成功：仍在原校区
      expect(
        (await db.user.findUniqueOrThrow({ where: { id: user.id } })).campusId,
      ).toBe(CAMPUS_B1);
    });

    it('组织 A 用户切组织 B 校区：400 拒绝（隔离双向）', async () => {
      const user = await db.user.create({
        data: {
          campusId: 'campus-hbut',
          nickname: '规格切跨组织A',
          phone: '',
          role: 'user',
        },
      });
      userIds.push(user.id);
      await expect(
        business.switchUserCampus(user.id, CAMPUS_B1),
      ).rejects.toThrow(
        new BadRequestException('该校区不属于当前小程序所在组织'),
      );
    });

    it('无组织归属用户（兼容路径）：切换不受组织限制', async () => {
      const user = await db.user.create({
        data: {
          campusId: CAMPUS_X,
          nickname: '规格切校区兼容',
          phone: '',
          role: 'user',
        },
      });
      userIds.push(user.id);
      const after = await business.switchUserCampus(user.id, CAMPUS_B2);
      expect(after.campusId).toBe(CAMPUS_B2);
    });

    it('切到当前校区幂等：直接返回不触发组织校验异常', async () => {
      const user = await db.user.create({
        data: {
          campusId: CAMPUS_B1,
          nickname: '规格切校区幂等',
          phone: '',
          role: 'user',
        },
      });
      userIds.push(user.id);
      const after = await business.switchUserCampus(user.id, CAMPUS_B1);
      expect(after.campusId).toBe(CAMPUS_B1);
    });
  });

  describe('员工端 staff-bind / 静默登录：组织校验', () => {
    beforeAll(async () => {
      // 员工端换用组织 B 的履约 AppID（同一组织登记另一小程序）
      await db.organization.update({
        where: { id: ORG_B_ID },
        data: { wxAppId: STAFF_B_APPID },
      });
      process.env.WX_APPID_DELIVERY = STAFF_B_APPID;
      process.env.WX_SECRET_DELIVERY = 'spec-secret';
    });

    it('组织 B 履约小程序绑定本组织员工：成功', async () => {
      mockCode2Session(`openid-bindb-${tag}`);
      const result = (await controller.staffBind({
        code: 'spec-code',
        staffNo: STAFF_NO_B,
        name: '规格骑手B',
        appid: STAFF_B_APPID,
      })) as { data: { user: { campusId: string } } };
      expect(result.data.user.campusId).toBe(CAMPUS_B1);
      expect(
        (
          await db.staff.findUniqueOrThrow({ where: { staffNo: STAFF_NO_B } })
        ).openid,
      ).toBe(`openid-bindb-${tag}`);
    });

    it('组织 B 履约小程序绑定它组织员工（campus-hbut 属 org-a）：400 拒绝', async () => {
      mockCode2Session(`openid-binda-${tag}`);
      await expect(
        controller.staffBind({
          code: 'spec-code',
          staffNo: STAFF_NO_A,
          name: '规格骑手A',
          appid: STAFF_B_APPID,
        }),
      ).rejects.toThrow(
        new BadRequestException('该工号不属于当前小程序所在组织'),
      );
    });

    it('组织 B 履约小程序静默登录本组织员工：成功且校区正确', async () => {
      mockCode2Session(`openid-staffb2-${tag}`);
      const result = (await controller.wechatLogin({
        code: 'spec-code',
        appid: STAFF_B_APPID,
      })) as { data: { user: { campusId: string } } };
      expect(result.data.user.campusId).toBe(CAMPUS_B2);
    });

    it('组织 B 履约小程序静默登录它组织员工：403 拒绝', async () => {
      mockCode2Session(`openid-staffa2-${tag}`);
      await expect(
        controller.wechatLogin({ code: 'spec-code', appid: STAFF_B_APPID }),
      ).rejects.toThrow(
        new ForbiddenException('该账号不属于当前小程序所在组织'),
      );
    });
  });

  /** 从 wechatLogin 响应 token 解出 userId（登记清理用）。 */
  function jwtSubject(result: { data: { token?: string } }): string {
    const claims = new JwtService({ secret: 'test-secret' }).verify<{
      id: string;
    }>(result.data.token!);
    return claims.id;
  }
});
