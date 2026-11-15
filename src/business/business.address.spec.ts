import { PrismaService } from '../database/prisma.service';
import { BusinessService } from './business.service';

/**
 * 地址楼栋重绑（IKVDHS，2026-11-11 道哥）：编辑地址带 buildingName 必须
 * 同步重绑 buildingId——历史 bug 只写名字快照、id 停在原楼栋，夜宵店按 id
 * 定楼即「显示东五、实指西5」。同名重存也重绑，历史错位行重新保存即自愈。
 * 创建地址楼栋名查不到直接拒绝，不再把名字字符串当 id 落库。
 */
describe('address building rebind (IKVDHS)', () => {
  const db = new PrismaService();
  const service = new BusinessService(db);
  const tag = `addrb-${Date.now()}`;
  const CAMPUS = `campus-${tag}`;
  const USER = `user-${tag}`;
  const EAST = `bld-east-${tag}`; // 东五（chen 店所在形态）
  const WEST = `bld-west-${tag}`; // 西5
  const ADDR = `addr-${tag}`;

  beforeAll(async () => {
    await db.campus.create({
      data: {
        id: CAMPUS,
        name: '重绑测试校园',
        shortName: '重绑',
        warehouseName: '重绑仓',
      } as any,
    });
    await db.user.create({
      data: {
        id: USER,
        openid: `openid-${tag}`,
        nickname: '重绑测试用户',
        phone: `139${String(Date.now()).slice(-8)}`,
        campusId: CAMPUS,
      } as any,
    });
    await db.building.create({
      data: { id: EAST, campusId: CAMPUS, name: '东五' } as any,
    });
    await db.building.create({
      data: { id: WEST, campusId: CAMPUS, name: '西5' } as any,
    });
    // 复刻 TEST 库真实错位形态：名字快照「东五」/ buildingId 停在西5
    await db.address.create({
      data: {
        id: ADDR,
        userId: USER,
        campusId: CAMPUS,
        campusName: '重绑测试校园',
        buildingId: WEST,
        buildingName: '东五',
        floor: 2,
        room: '201',
        contactName: '测试联系人',
        phone: '13800000000',
        isDefault: true,
      } as any,
    });
  });

  afterAll(async () => {
    await db.address.deleteMany({ where: { userId: USER } });
    await db.building.deleteMany({ where: { campusId: CAMPUS } });
    await db.user.deleteMany({ where: { id: USER } });
    await db.campus.deleteMany({ where: { id: CAMPUS } });
    await db.$disconnect();
  });

  it('编辑换楼栋：名字快照与 buildingId 同源更新', async () => {
    const updated = await service.updateAddress(USER, CAMPUS, ADDR, {
      buildingName: '东五',
    });
    expect(updated.buildingName).toBe('东五');
    expect(updated.buildingId).toBe(EAST); // 不再停在原楼栋 WEST
  });

  it('同名重存也重绑：历史错位行（名东五/id西5）保存一次即自愈', async () => {
    await db.address.update({
      where: { id: ADDR },
      data: { buildingId: WEST },
    });
    const updated = await service.updateAddress(USER, CAMPUS, ADDR, {
      buildingName: '东五',
      room: '201',
    });
    expect(updated.buildingId).toBe(EAST);
  });

  it('编辑不带楼栋名：buildingId 不动', async () => {
    await db.address.update({
      where: { id: ADDR },
      data: { buildingId: WEST },
    });
    const updated = await service.updateAddress(USER, CAMPUS, ADDR, {
      room: '202',
    });
    expect(updated.room).toBe('202');
    expect(updated.buildingId).toBe(WEST);
  });

  it('编辑到不存在的楼栋名：400 拒绝', async () => {
    await expect(
      service.updateAddress(USER, CAMPUS, ADDR, {
        buildingName: '不存在的楼',
      }),
    ).rejects.toThrow('楼栋不存在');
  });

  it('新建地址：id 与名字同源写入；楼栋名查不到拒绝落库', async () => {
    const created = await service.addAddress(USER, CAMPUS, {
      buildingName: '西5',
      floor: 1,
      room: '101',
      contactName: '测试联系人',
      phone: '13800000001',
    });
    expect(created.buildingName).toBe('西5');
    expect(created.buildingId).toBe(WEST);
    await expect(
      service.addAddress(USER, CAMPUS, {
        buildingName: '幽灵楼',
        floor: 1,
        room: '102',
        contactName: '测试联系人',
        phone: '13800000002',
      }),
    ).rejects.toThrow('楼栋不存在');
  });
});
