import { productImageUrl, productImageView } from './product-image';
import { BusinessService } from '../business/business.service';
import { PrismaService } from '../database/prisma.service';

const image = 'https://static.buchuqin.com/app/product/test.webp';
const thumb = (size: number) =>
  `${image}?imageMogr2/thumbnail/${size}x${size}%3E`;

describe('IKTH9Q 商品图片响应分档（不连接数据库）', () => {
  it.each([160, 240, 800] as const)(
    '生成%s像素地址，重复转换不累积参数',
    (size) => {
      expect(productImageUrl(image, size)).toBe(thumb(size));
      expect(productImageUrl(productImageUrl(image, size), size)).toBe(
        thumb(size),
      );
      expect(productImageUrl(thumb(240), size)).toBe(thumb(size));
    },
  );

  it('保留已有参数编码及锚点', () => {
    expect(productImageUrl(`${image}?v=a%20b#preview`, 160)).toBe(
      `${image}?v=a%20b&imageMogr2/thumbnail/160x160%3E#preview`,
    );
  });

  it.each([
    '',
    null,
    undefined,
    '/uploads/a.webp',
    'data:image/png;base64,AA',
    'https://example.com/app/product/a.webp',
    'https://static.buchuqin.com.evil.test/app/product/a.webp',
    'https://static.buchuqin.com/app/wechat-group/qr.png',
    'https://static.buchuqin.com/app/banner/a.webp',
    `${image}?q-sign-algorithm=sha1&q-signature=abc`,
    `${image}?imageMogr2/thumbnail/600x600/quality/80`,
    `${image}?watermark/1/image/test`,
  ])('不改变非目标或签名/特殊处理地址：%s', (source) => {
    expect(productImageUrl(source, 240)).toBe(source);
  });

  it('图片视图创建副本，保留原商品及轮播数组', () => {
    const product = { image, images: [image], price: 199 };
    const result = productImageView(product, 800);
    expect(result).toEqual({
      image: thumb(800),
      images: [thumb(800)],
      price: 199,
    });
    expect(product).toEqual({ image, images: [image], price: 199 });
  });

  it('商品列表240、详情800，成本字段继续脱敏', () => {
    const service = new BusinessService({} as PrismaService);
    const product = {
      image,
      images: [image],
      price: 100,
      originalPrice: 200,
      weight: 1,
      costPrice: 33,
      localPurchasePrice: 33,
    };
    const list = service['productView'](product);
    const detail = service['productView'](product, true);
    expect(list.image).toBe(thumb(240));
    expect(detail.images).toEqual([thumb(800)]);
    expect(detail.costPrice).toBeUndefined();
    expect(detail.localPurchasePrice).toBeUndefined();
    expect(product.image).toBe(image);
  });

  it('历史订单无成本字段也缩小图片，不修改原始快照和凭证', () => {
    const service = new BusinessService({} as PrismaService);
    const source = {
      items: [{ product: { image, price: 100, images: [image] }, quantity: 2 }],
      status: 'paid',
      createdAt: new Date(),
      timeline: [],
      package: { proof: { images: [image] } },
    };
    const result = service['orderView'](source);
    expect(result.items[0].product.image).toBe(thumb(160));
    expect(result.package.proof.images).toEqual([image]);
    expect(source.items[0].product.image).toBe(image);
    const withCost = service['orderView']({
      ...source,
      items: [
        {
          product: { image, unitGrossCost: 55, costSource: 'LOCAL' },
          quantity: 1,
        },
      ],
    });
    expect(withCost.items[0].product.unitGrossCost).toBeUndefined();
    expect(withCost.items[0].product.costSource).toBeUndefined();
  });

  it('购物车和结算返回160，但创建订单写入原图，金额不变', async () => {
    const cart = {
      items: [{ product: { image, images: [image], price: 100 }, quantity: 2 }],
      productAmount: 200,
      totalQuantity: 2,
      deliveryThreshold: 0,
    };
    let persisted: Record<string, any> | undefined;
    const db = {
      $transaction: async (work: (tx: unknown) => unknown) =>
        work({
          order: {
            create: async ({ data }: { data: Record<string, any> }) => {
              persisted = data;
              return { ...data, id: 'order' };
            },
          },
        }),
    };
    const service = new BusinessService(db as unknown as PrismaService);
    jest.spyOn(service as any, 'cartData').mockResolvedValue(cart);
    jest.spyOn(service as any, 'validateQuote').mockResolvedValue({
      cart,
      address: { campusId: 'campus', buildingName: '6栋', room: '603' },
    });
    jest.spyOn(service as any, 'deliveryFeeFor').mockResolvedValue(400);
    jest.spyOn(service as any, 'managerTipFor').mockResolvedValue(undefined);
    const dto = { addressId: 'address', deliveryMode: 'instant' } as const;
    expect((await service.cart('user')).items[0].product.image).toBe(
      thumb(160),
    );
    const quote = await service.checkout('user', 'campus', dto);
    expect(quote.items[0].product.image).toBe(thumb(160));
    expect(quote.payableAmount).toBe(600);
    const created = await service.createOrder('user', 'campus', dto);
    expect(persisted?.items[0].product.image).toBe(image);
    expect(persisted?.items[0].product.images).toEqual([image]);
    expect(created.items[0].product.image).toBe(thumb(160));
    expect(cart.items[0].product.image).toBe(image);
  });
});
