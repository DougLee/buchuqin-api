import sharp from 'sharp';

/**
 * 上传图片统一压缩（道哥 2026-11-02：COS 流量过高，上传即压）：
 * - 一律转 WebP q80 + 长边 1600 内（不放大），节省 70-90% 体积；
 * - EXIF 方向自动修正（rotate() 空参）；
 * - 豁免：GIF 动图（转码丢动画）、app/wechat-group（群码/客服码走
 *   show-menu-by-longpress 识别，保真优先）、小于 200KB 的既有 WebP
 *   （重压损质无收益）；
 * - fail-open：sharp 处理失败（损坏图/罕见格式）原样返回，不阻塞上传。
 * 返回 null 表示跳过压缩（调用方按原文件上传）。
 */
const WEBP_QUALITY = 80;
const MAX_EDGE = 1600;
const SKIP_WEBP_SMALLER_THAN = 200 * 1024;
/** 二维码等识别敏感目录：原样上传不压缩。 */
const SKIP_FOLDERS = new Set(['app/wechat-group']);

export interface CompressedImage {
  buffer: Buffer;
  /** 压缩后扩展名（恒 .webp；null=未压缩沿用原扩展名） */
  ext: string | null;
  mimetype: string;
}

export async function compressUploadImage(
  buffer: Buffer,
  mimetype: string,
  folder: string,
): Promise<CompressedImage | null> {
  if (mimetype === 'image/gif') return null;
  if (SKIP_FOLDERS.has(folder)) return null;
  if (mimetype === 'image/webp' && buffer.length < SKIP_WEBP_SMALLER_THAN)
    return null;
  try {
    const out = await sharp(buffer)
      .rotate()
      .resize({
        width: MAX_EDGE,
        height: MAX_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();
    // 极少数图压缩后反而更大（已是优化的 webp/png）——取小者
    if (out.length >= buffer.length) return null;
    return { buffer: out, ext: '.webp', mimetype: 'image/webp' };
  } catch {
    // fail-open：压不动就原样传
    return null;
  }
}
