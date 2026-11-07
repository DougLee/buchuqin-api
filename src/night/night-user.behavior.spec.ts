import { NightUserService } from './night-user.service';
import { PrismaService } from '../database/prisma.service';
import { NightOrderService } from './night-order.service';

describe('夜宵用户商品展示契约', () => {
  it('商品详情输出夜宵主档的多图介绍，不泄露采购成本和库位', async () => {
    const catalog = { id: 'catalog', name: '茶', image: '/tea.jpg', images: ['/tea.jpg', '/back.jpg'], description: '茶饮介绍', subtitle: '无糖', price: 800, originalPrice: 900, categoryId: 'drinks', category: { name: '饮品' }, retailUnit: '瓶', nightBarcode: '123', costPrice: 300, location: 'A1' };
    const db = { promotion: { findMany: jest.fn().mockResolvedValue([]) }, nightStore: { findFirst: jest.fn().mockResolvedValue({ id: 'store' }) }, nightProduct: { findMany: jest.fn().mockResolvedValue([{ id: 'item', catalogProductId: 'catalog', stock: 0, catalogProduct: catalog }]) } };
    const service = new NightUserService(db as unknown as PrismaService, {} as NightOrderService);
    const [item] = await service.storeProducts('campus', 'store');
    expect(item).toMatchObject({ images: catalog.images, description: '茶饮介绍', originalPrice: 900, price: 800, soldOut: true });
    expect(item).not.toHaveProperty('costPrice');
    expect(item).not.toHaveProperty('location');
  });

  it('其他校区店铺不能读取商品', async () => {
    const db = { promotion: { findMany: jest.fn().mockResolvedValue([]) }, nightStore: { findFirst: jest.fn().mockResolvedValue(null) }, nightProduct: { findMany: jest.fn() } };
    const service = new NightUserService(db as unknown as PrismaService, {} as NightOrderService);
    await expect(service.storeProducts('foreign', 'store')).rejects.toThrow('夜宵店不存在');
    expect(db.nightProduct.findMany).not.toHaveBeenCalled();
  });
});
