import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { NotificationsService } from './notifications.service';
import type { PrismaService } from '../database/prisma.service';

/**
 * 服务号绑定（IKXLV5）：一人多组织——绑定按「员工 × 来源服务号」维度存
 * StaffGzhBinding；关注/取关事件按来源精确增删；派单按组织查绑定。
 */

const sha1 = (token: string, timestamp: string, nonce: string) =>
  createHash('sha1').update([token, timestamp, nonce].sort().join('')).digest('hex');

const ENV = { ...process.env };

describe('服务号绑定一人多组织（IKXLV5）', () => {
  beforeEach(() => {
    process.env.WX_GZH_TOKEN = 'tok-env';
    process.env.WX_GZH_APPID = 'wx-env-gzh';
    process.env.WX_GZH_SECRET = 'sec-env';
  });
  afterEach(() => {
    process.env = { ...ENV };
    jest.restoreAllMocks();
  });

  const makeService = (db: Record<string, unknown>) =>
    new NotificationsService(db as unknown as PrismaService);

  describe('organizationIdByGzhAppId', () => {
    it('组织行登记的 gzhAppId 直查命中', async () => {
      const db = {
        organization: {
          findFirst: jest.fn().mockResolvedValue({ id: 'org-xiaoman' }),
        },
      };
      const svc = makeService(db);
      await expect(
        svc['organizationIdByGzhAppId']('wx-xiaoman-gzh'),
      ).resolves.toBe('org-xiaoman');
    });

    it('org-a 的 env 服务号（组织行无登记）按 env 值对上', async () => {
      const db = {
        organization: { findFirst: jest.fn().mockResolvedValue(null) },
      };
      const svc = makeService(db);
      await expect(
        svc['organizationIdByGzhAppId']('wx-env-gzh'),
      ).resolves.toBe('org-a');
    });

    it('未知来源服务号返回 null（只验签不绑定）', async () => {
      const db = {
        organization: { findFirst: jest.fn().mockResolvedValue(null) },
      };
      const svc = makeService(db);
      await expect(
        svc['organizationIdByGzhAppId']('wx-stranger'),
      ).resolves.toBeNull();
    });
  });

  describe('resolveStaffGzhOpenid', () => {
    it('绑定表优先，命中返回绑定 openid', async () => {
      const db = {
        staffGzhBinding: {
          findUnique: jest.fn().mockResolvedValue({ gzhOpenid: 'obinding' }),
        },
      };
      const svc = makeService(db);
      await expect(
        svc['resolveStaffGzhOpenid']('s1', 'wx-x', 'olegacy'),
      ).resolves.toBe('obinding');
    });

    it('无绑定行回读旧列垫片（org-a 存量兼容）', async () => {
      const db = {
        staffGzhBinding: { findUnique: jest.fn().mockResolvedValue(null) },
      };
      const svc = makeService(db);
      await expect(
        svc['resolveStaffGzhOpenid']('s1', 'wx-x', 'olegacy'),
      ).resolves.toBe('olegacy');
    });

    it('两者皆无返回 null（调用方走订阅消息回退）', async () => {
      const db = {
        staffGzhBinding: { findUnique: jest.fn().mockResolvedValue(null) },
      };
      const svc = makeService(db);
      await expect(
        svc['resolveStaffGzhOpenid']('s1', 'wx-x', null),
      ).resolves.toBeNull();
    });
  });

  describe('upsertStaffGzhBinding', () => {
    it('upsert 绑定表 + 同步旧列兼容写', async () => {
      const upsert = jest.fn().mockResolvedValue({});
      const staffUpdate = jest.fn().mockResolvedValue({});
      const db = {
        staffGzhBinding: { upsert },
        staff: { update: staffUpdate },
      };
      const svc = makeService(db);
      await svc['upsertStaffGzhBinding']('s1', 'wx-x', 'oid', 'union-1');
      expect(upsert).toHaveBeenCalledWith({
        where: { staffId_gzhAppId: { staffId: 's1', gzhAppId: 'wx-x' } },
        create: { staffId: 's1', gzhAppId: 'wx-x', gzhOpenid: 'oid', unionId: 'union-1' },
        update: { gzhOpenid: 'oid', unionId: 'union-1' },
      });
      expect(staffUpdate).toHaveBeenCalledWith({
        where: { id: 's1' },
        data: { gzhOpenid: 'oid' },
      });
    });
  });

  describe('handleGzhCallback 关注事件', () => {
    const callback = async (
      svc: NotificationsService,
      db: Record<string, unknown>,
      event: string,
      openid: string,
    ) =>
      svc.handleGzhCallback(
        { signature: sha1('tok-env', '1700000000', 'nonce'), timestamp: '1700000000', nonce: 'nonce' },
        `<xml><ToUserName><![CDATA[gh]]></ToUserName><FromUserName><![CDATA[${openid}]]></FromUserName><CreateTime>1700000000</CreateTime><MsgType><![CDATA[event]]></MsgType><Event><![CDATA[${event}]]></Event></xml>`,
      );

    const baseDb = () => ({
      organization: { findFirst: jest.fn().mockResolvedValue({ id: 'org-xiaoman' }) },
      staff: {
        findFirst: jest.fn().mockResolvedValue({ id: 'xm001' }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      staffGzhBinding: {
        upsert: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    });

    beforeEach(() => {
      jest.spyOn(global, 'fetch').mockImplementation((input) => {
        const url = String(input);
        const payload = url.includes('/user/info')
          ? { unionid: 'union-XM' }
          : { access_token: 'token-1', expires_in: 7200 };
        return Promise.resolve(
          new Response(JSON.stringify(payload), { status: 200 }),
        );
      });
    });

    it('关注：按来源服务号解析组织，组织内按 unionid 匹配员工并 upsert 绑定', async () => {
      const db = baseDb();
      const svc = makeService(db);
      const reply = await callback(svc, db, 'subscribe', 'oXMPush');
      expect(reply).toBe('success');
      const where = db.staff.findFirst.mock.calls[0][0].where;
      expect(where).toEqual({
        unionId: 'union-XM',
        campus: { organizationId: 'org-xiaoman' },
      });
      expect(db.staffGzhBinding.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { staffId_gzhAppId: { staffId: 'xm001', gzhAppId: 'wx-env-gzh' } },
        }),
      );
    });

    it('匹配不到员工：不写绑定，照常回 success（微信不重试）', async () => {
      const db = baseDb();
      db.staff.findFirst.mockResolvedValue(null);
      const svc = makeService(db);
      expect(await callback(svc, db, 'subscribe', 'oStranger')).toBe('success');
      expect(db.staffGzhBinding.upsert).not.toHaveBeenCalled();
    });

    it('取关：按 (gzhAppId, openid) 精确删除本组织绑定', async () => {
      const db = baseDb();
      const svc = makeService(db);
      await callback(svc, db, 'unsubscribe', 'oXMPush');
      expect(db.staffGzhBinding.deleteMany).toHaveBeenCalledWith({
        where: { gzhAppId: 'wx-env-gzh', gzhOpenid: 'oXMPush' },
      });
    });
  });
});
