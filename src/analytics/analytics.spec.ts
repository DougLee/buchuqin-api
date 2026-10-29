import { AnalyticsController } from './analytics.controller';

/** 静默口径（IKRGLV）：异常路径都返回 ok——埋点永不影响客户端。
 *  事件白名单/targetId 截断/批量上限由 DTO 装饰器+全局 ValidationPipe
 *  运行时保证（与 controller 同文件维护），此处覆盖服务端落库行为。 */
describe('AnalyticsController (IKRGLV)', () => {
  const makeController = (opts?: {
    user?: { campusId: string } | null;
    dbError?: boolean;
  }) => {
    const findUnique = jest
      .fn()
      .mockResolvedValue(
        opts?.user === undefined ? { campusId: 'c1' } : opts.user,
      );
    const createMany = opts?.dbError
      ? jest.fn().mockRejectedValue(new Error('db down'))
      : jest
          .fn()
          .mockImplementation(async (args: { data: unknown[] }) => ({
            count: args.data.length,
          }));
    const controller = new AnalyticsController({
      user: { findUnique },
      userEvent: { createMany },
    } as never);
    return { controller, createMany };
  };

  const req = { user: { id: 'u1' } } as never;

  it('批量落库：campusId 取用户档案、条数透传 createMany', async () => {
    const { controller, createMany } = makeController({
      user: { campusId: 'campus-a' },
    });
    const r = await controller.track(req, {
      events: [
        { event: 'product_view', targetId: 'p1' },
        { event: 'search', targetId: 'x'.repeat(100) },
      ],
    } as never);
    expect(r).toEqual({ ok: true, saved: 2 });
    const arg = createMany.mock.calls[0][0] as {
      data: Array<Record<string, unknown>>;
    };
    expect(arg.data).toHaveLength(2);
    expect(arg.data[0]).toMatchObject({
      userId: 'u1',
      campusId: 'campus-a',
      event: 'product_view',
    });
    // targetId 服务端截断到 64
    expect((arg.data[1].targetId as string).length).toBe(64);
  });

  it('用户档案缺失：静默丢事件不抛错', async () => {
    const { controller, createMany } = makeController({ user: null });
    const r = await controller.track(req, {
      events: [{ event: 'page_view' }],
    } as never);
    expect(r).toEqual({ ok: true, saved: 0 });
    expect(createMany).not.toHaveBeenCalled();
  });

  it('落库异常：静默返回 ok（fire-and-forget 红线）', async () => {
    const { controller } = makeController({ dbError: true });
    const r = await controller.track(req, {
      events: [{ event: 'page_view' }],
    } as never);
    expect(r).toEqual({ ok: true, saved: 0 });
  });
});
