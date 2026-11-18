import { BusinessService } from './business.service';
import { PrismaService } from '../database/prisma.service';

describe('用户站内消息渠道隔离', () => {
  const fixture = () => {
    const rows = [
      { id: 'day', userId: 'buyer', businessType: 'day', read: false, createdAt: new Date() },
      { id: 'night', userId: 'buyer', businessType: 'night', read: false, createdAt: new Date() },
      { id: 'foreign', userId: 'other', businessType: 'night', read: false, createdAt: new Date() },
    ];
    const matches = (row: any, where: any) => Object.entries(where).every(([key, value]) => row[key] === value);
    const db = { notification: {
      findMany: jest.fn(async ({ where }) => rows.filter(row => matches(row, where))),
      updateMany: jest.fn(async ({ where, data }) => { rows.filter(row => matches(row, where)).forEach(row => Object.assign(row, data)); return { count: 1 }; }),
      groupBy: jest.fn().mockResolvedValue([]),
    } };
    return { rows, service: new BusinessService(db as unknown as PrismaService) };
  };
  it('白天和夜宵分别返回当前用户消息，非法渠道不能回退到所有消息', async () => {
    const { service } = fixture();
    expect((await service.notifications('buyer', 'night')).map(row => row.id)).toEqual(['night']);
    expect((await service.notifications('buyer', 'day')).map(row => row.id)).toEqual(['day']);
    await expect(service.notifications('buyer', 'invalid')).rejects.toThrow('业务类型');
  });
  it('全部已读只修改所选渠道，保留其他渠道和其他用户未读', async () => {
    const { service, rows } = fixture();
    await service.readAllNotifications('buyer', undefined, 'night');
    expect(rows.map(row => [row.id, row.read])).toEqual([['day', false], ['night', true], ['foreign', false]]);
  });
});
