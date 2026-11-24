import 'reflect-metadata';
import { NotificationsService } from './notifications.service';
import type { PrismaService } from '../database/prisma.service';

/** 楼长交接提醒双通道路由（IKXOTD）：服务号优先（绑定表+垫片），
 *  失败/未绑定回退订阅消息；组织未配 gzh 时维持现状。 */
describe('楼长推送服务号通道（IKXOTD）', () => {
  const makeDb = (gzhReady: boolean) => {
    const orgRow = gzhReady
      ? {
          id: 'org-x',
          name: '测试组织',
          shortName: '测试',
          wxAppId: 'wx-user-app',
          wxSecret: 'sec-user',
          deliveryWxAppId: 'wx-delivery-app',
          deliveryWxSecret: 'sec-dl',
          deliveryNotifyTemplateId: 'tmpl-delivery',
          gzhAppId: 'wx-gzh-app',
          gzhSecret: 'sec-gzh',
          gzhToken: 'tok',
          gzhTemplateId: 'tmpl-gzh',
        }
      : {
          id: 'org-x',
          name: '测试组织',
          shortName: '测试',
          wxAppId: 'wx-user-app',
          wxSecret: 'sec-user',
          deliveryWxAppId: 'wx-delivery-app',
          deliveryWxSecret: 'sec-dl',
          deliveryNotifyTemplateId: 'tmpl-delivery',
          gzhAppId: null,
          gzhSecret: null,
          gzhToken: null,
          gzhTemplateId: null,
        };
    return {
      order: {
        findUnique: jest.fn().mockResolvedValue({
          campusId: 'campus-1',
          address: { buildingId: 'b1', buildingName: '学子楼', room: '302' },
          orderNo: 'BCQTEST01',
          payableAmount: 1800,
        }),
      },
      campus: { findUnique: jest.fn().mockResolvedValue({ organizationId: 'org-x' }) },
      organization: { findUnique: jest.fn().mockResolvedValue(orgRow) },
      staff: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'm1', openid: 'oSub', gzhOpenid: 'oLegacy' },
        ]),
        update: jest.fn().mockResolvedValue({}),
      },
    } as unknown as PrismaService;
  };

  const makeService = (db: PrismaService) => new NotificationsService(db);

  const runArrive = async (svc: NotificationsService) =>
    svc.notifyManagerOnArrive('order-1');

  it('有服务号绑定：走服务号模板，不发订阅消息', async () => {
    const db = makeDb(true);
    const svc = makeService(db);
    const resolve = jest
      .spyOn(svc as unknown as { resolveStaffGzhOpenid: jest.Mock }, 'resolveStaffGzhOpenid')
      .mockResolvedValue('oBinding');
    const gzh = jest
      .spyOn(svc as unknown as { sendGzhTemplate: jest.Mock }, 'sendGzhTemplate')
      .mockResolvedValue(undefined);
    const sub = jest
      .spyOn(svc as unknown as { sendStaffSubscribe: jest.Mock }, 'sendStaffSubscribe')
      .mockResolvedValue('ok');
    await runArrive(svc);
    expect(resolve).toHaveBeenCalledWith('m1', 'wx-gzh-app', 'oLegacy');
    expect(gzh).toHaveBeenCalledWith(
      'oBinding',
      expect.objectContaining({
        character_string2: { value: 'BCQTEST01' },
        thing4: { value: '学子楼 302' },
      }),
      expect.objectContaining({ appId: 'wx-gzh-app' }),
      'wx-delivery-app',
    );
    expect(sub).not.toHaveBeenCalled();
  });

  it('无绑定：回退订阅消息（现状行为）', async () => {
    const db = makeDb(true);
    const svc = makeService(db);
    jest
      .spyOn(svc as unknown as { resolveStaffGzhOpenid: jest.Mock }, 'resolveStaffGzhOpenid')
      .mockResolvedValue(null);
    const gzh = jest
      .spyOn(svc as unknown as { sendGzhTemplate: jest.Mock }, 'sendGzhTemplate')
      .mockResolvedValue(undefined);
    const sub = jest
      .spyOn(svc as unknown as { sendStaffSubscribe: jest.Mock }, 'sendStaffSubscribe')
      .mockResolvedValue('ok');
    await runArrive(svc);
    expect(gzh).not.toHaveBeenCalled();
    expect(sub).toHaveBeenCalledWith('m1', 'oSub', expect.anything(), expect.anything());
  });

  it('服务号发送失败：warn 后订阅消息兜底', async () => {
    const db = makeDb(true);
    const svc = makeService(db);
    jest
      .spyOn(svc as unknown as { resolveStaffGzhOpenid: jest.Mock }, 'resolveStaffGzhOpenid')
      .mockResolvedValue('oBinding');
    jest
      .spyOn(svc as unknown as { sendGzhTemplate: jest.Mock }, 'sendGzhTemplate')
      .mockRejectedValue(new Error('43004 非关注用户'));
    const sub = jest
      .spyOn(svc as unknown as { sendStaffSubscribe: jest.Mock }, 'sendStaffSubscribe')
      .mockResolvedValue('ok');
    await runArrive(svc);
    expect(sub).toHaveBeenCalled();
  });

  it('组织未配 gzh 四项：不查绑定，直接订阅消息（现状零变化）', async () => {
    const db = makeDb(false);
    const svc = makeService(db);
    const resolve = jest
      .spyOn(svc as unknown as { resolveStaffGzhOpenid: jest.Mock }, 'resolveStaffGzhOpenid');
    const sub = jest
      .spyOn(svc as unknown as { sendStaffSubscribe: jest.Mock }, 'sendStaffSubscribe')
      .mockResolvedValue('ok');
    await runArrive(svc);
    expect(resolve).not.toHaveBeenCalled();
    expect(sub).toHaveBeenCalled();
  });
});
