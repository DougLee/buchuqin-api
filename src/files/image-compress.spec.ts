import sharp from 'sharp';
import { compressUploadImage } from './image-compress';

/** 生成测试 PNG：3000x2000 实心渐变（有细节可压） */
async function makePng(width = 3000, height = 2000): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 120, g: 160, b: 90 },
    },
  })
    .png()
    .toBuffer();
}

describe('上传图片压缩（道哥 2026-11-02）', () => {
  it('PNG 大图：转 WebP + 长边压到 1600 内 + 体积显著变小', async () => {
    const png = await makePng();
    const out = await compressUploadImage(png, 'image/png', 'app/product');
    expect(out).not.toBeNull();
    expect(out!.ext).toBe('.webp');
    expect(out!.mimetype).toBe('image/webp');
    expect(out!.buffer.length).toBeLessThan(png.length);
    const meta = await sharp(out!.buffer).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(1600);
  });

  it('小图不放大：200x150 输入保持原尺寸', async () => {
    const small = await makePng(200, 150);
    const out = await compressUploadImage(small, 'image/png', 'app/product');
    expect(out).not.toBeNull();
    const meta = await sharp(out!.buffer).metadata();
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(150);
  });

  it('GIF 豁免：跳过压缩（动图转码丢动画）', async () => {
    const out = await compressUploadImage(
      Buffer.from('fake-gif'),
      'image/gif',
      'app/banner',
    );
    expect(out).toBeNull();
  });

  it('群码目录豁免：wechat-group 识别保真不压缩', async () => {
    const png = await makePng();
    const out = await compressUploadImage(png, 'image/png', 'app/wechat-group');
    expect(out).toBeNull();
  });

  it('小 WebP 豁免：<200KB 已优化图重压无收益', async () => {
    const tinyWebp = await sharp(await makePng(200, 150))
      .webp({ quality: 80 })
      .toBuffer();
    const out = await compressUploadImage(
      tinyWebp,
      'image/webp',
      'app/product',
    );
    expect(out).toBeNull();
  });

  it('损坏图 fail-open：返回 null 原样上传不阻塞', async () => {
    const out = await compressUploadImage(
      Buffer.from('not-an-image'),
      'image/png',
      'app/product',
    );
    expect(out).toBeNull();
  });
});
