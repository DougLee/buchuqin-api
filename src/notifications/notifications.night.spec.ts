import { NotificationsService } from './notifications.service';
import type { PrismaService } from '../database/prisma.service';

describe('140夜宵微信通知（离线网关，不发送真实消息）', () => {
  const oldFetch = global.fetch;
  const paidTemplate = process.env.WX_TMPL_PAID, deliveredTemplate = process.env.WX_TMPL_DELIVERED;
  const sent: Array<Record<string, unknown>> = [];
  const row = { items: [{ name: '本楼柠檬茶', quantity: 1 }], address: { buildingName: '9栋', room: '101' }, createdAt: new Date(), paidAt: new Date() };
  const db = {
    nightOrder: { findFirst: jest.fn().mockResolvedValue({ store: { campusId: 'campus' } }), findUnique: jest.fn().mockResolvedValue(row) },
    order: { findFirst: jest.fn(), findUnique: jest.fn() },
    campus: { findUnique: jest.fn().mockResolvedValue({ organizationId: 'org-night' }) },
    organization: { findUnique: jest.fn().mockResolvedValue({ id: 'org-night', name: '夜宵测试', shortName: '夜宵', wxAppId: 'user-app', wxSecret: 'user-secret', deliveryWxAppId: 'delivery-app', deliveryWxSecret: 'delivery-secret', deliveryNotifyTemplateId: 'manager-template' }) },
    user: { findUnique: jest.fn().mockResolvedValue({ openid: 'test-user-openid' }) },
    staff: { findUnique: jest.fn().mockResolvedValue({ id: 'manager', openid: 'test-manager-openid', status: 'online' }), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  beforeEach(() => {
    sent.length = 0; jest.clearAllMocks(); process.env.WX_TMPL_PAID = 'paid-template'; process.env.WX_TMPL_DELIVERED = 'delivered-template';
    global.fetch = jest.fn(async (url, options) => {
      if (String(url).includes('stable_token')) return new Response(JSON.stringify({ access_token: 'offline-token', expires_in: 7200 }));
      sent.push(JSON.parse(String(options?.body))); return new Response(JSON.stringify({ errcode: 0 }));
    }) as typeof fetch;
  });
  afterAll(() => { global.fetch = oldFetch; if (paidTemplate === undefined) delete process.env.WX_TMPL_PAID; else process.env.WX_TMPL_PAID = paidTemplate; if (deliveredTemplate === undefined) delete process.env.WX_TMPL_DELIVERED; else process.env.WX_TMPL_DELIVERED = deliveredTemplate; });
  it.each(['paid', 'delivered'])('用户%s消息读取夜单及夜单所属组织，点开进入夜单详情', async status => {
    const service = new NotificationsService(db as unknown as PrismaService);
    await service.orderStatusPush({ id: 'night-order', userId: 'buyer', orderNo: 'YX-test', status, statusText: status, payableAmount: 600, businessType: 'night' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ touser: 'test-user-openid', page: 'pages/night/order-detail?id=night-order', template_id: status === 'paid' ? 'paid-template' : 'delivered-template' });
    expect(JSON.stringify(sent[0].data)).toContain('本楼柠檬茶');
    expect(db.order.findUnique).not.toHaveBeenCalled(); expect(db.order.findFirst).not.toHaveBeenCalled();
  });
  it('楼长新单通知走履约AppID且直达本单详情', async () => {
    const service = new NotificationsService(db as unknown as PrismaService);
    await service.notifyNightManagerNewOrder({ orderId: 'night-order', staffId: 'manager', campusId: 'campus', orderNo: 'YX-test', amountFen: 600, buildingName: '9栋' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ touser: 'test-manager-openid', template_id: 'manager-template', page: 'pages/night/order-detail?id=night-order' });
  });

  it('IKY6QE：双渠道并行——服务号与订阅消息都发，互不吞并', async () => {
    const gzhDb = {
      ...db,
      organization: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'org-night', name: '夜宵测试', shortName: '夜宵',
          wxAppId: 'user-app', wxSecret: 'user-secret',
          deliveryWxAppId: 'delivery-app', deliveryWxSecret: 'delivery-secret',
          deliveryNotifyTemplateId: 'manager-template',
          gzhAppId: 'gzh-app', gzhSecret: 'gzh-secret', gzhToken: 'tok', gzhTemplateId: 'gzh-template',
        }),
      },
      staff: {
        findUnique: jest.fn().mockResolvedValue({ id: 'manager', openid: 'test-manager-openid', status: 'online', gzhOpenid: 'gzh-manager-openid' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      staffGzhBinding: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const service = new NotificationsService(gzhDb as unknown as PrismaService);
    await service.notifyNightManagerNewOrder({ orderId: 'night-order', staffId: 'manager', campusId: 'campus', orderNo: 'YX-test', amountFen: 600, buildingName: '9栋' });
    // 服务号模板消息（垫片 openid）与小程序订阅消息各发一条
    const gzhSend = sent.find(s => s.touser === 'gzh-manager-openid');
    const subSend = sent.find(s => s.touser === 'test-manager-openid');
    expect(gzhSend).toMatchObject({ template_id: 'gzh-template' });
    expect(JSON.stringify(gzhSend)).toContain('YX-test');
    expect(subSend).toMatchObject({ template_id: 'manager-template', page: 'pages/night/order-detail?id=night-order' });
  });

  it('IKY6QE：服务号发送失败不影响订阅消息（独立告警）', async () => {
    const gzhDb = {
      ...db,
      organization: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'org-night', name: '夜宵测试', shortName: '夜宵',
          wxAppId: 'user-app', wxSecret: 'user-secret',
          deliveryWxAppId: 'delivery-app', deliveryWxSecret: 'delivery-secret',
          deliveryNotifyTemplateId: 'manager-template',
          gzhAppId: 'gzh-app', gzhSecret: 'gzh-secret', gzhToken: 'tok', gzhTemplateId: 'gzh-template',
        }),
      },
      staff: {
        findUnique: jest.fn().mockResolvedValue({ id: 'manager', openid: 'test-manager-openid', status: 'online', gzhOpenid: 'gzh-manager-openid' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      staffGzhBinding: { findUnique: jest.fn().mockResolvedValue({ gzhOpenid: 'gzh-manager-openid' }) },
    };
    const service = new NotificationsService(gzhDb as unknown as PrismaService);
    let call = 0;
    global.fetch = jest.fn(async (url, options) => {
      if (String(url).includes('stable_token')) return new Response(JSON.stringify({ access_token: 'offline-token', expires_in: 7200 }));
      call++;
      if (call === 1) return new Response(JSON.stringify({ errcode: 40003, errmsg: 'invalid openid' }));
      sent.push(JSON.parse(String(options?.body))); return new Response(JSON.stringify({ errcode: 0 }));
    }) as typeof fetch;
    await service.notifyNightManagerNewOrder({ orderId: 'night-order', staffId: 'manager', campusId: 'campus', orderNo: 'YX-test', amountFen: 600, buildingName: '9栋' });
    // 服务号失败（call 1），订阅消息照发（call 2）
    expect(subscribe(sent)).toBe(true);
    function subscribe(list: Array<Record<string, unknown>>) {
      return list.some(s => s.touser === 'test-manager-openid');
    }
  });
});
