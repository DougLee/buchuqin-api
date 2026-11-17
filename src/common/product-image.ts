export type ProductImageSize = 160 | 240 | 800;

/** 仅转换公开商品图。保留原始URL编码，签名地址不追加参数以免验签失败。 */
export function productImageUrl<T extends string | null | undefined>(
  source: T,
  size: ProductImageSize,
): T {
  if (!source) return source;
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return source;
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'static.buchuqin.com' ||
    url.port ||
    url.username ||
    url.password ||
    !url.pathname.startsWith('/app/product/')
  )
    return source;
  for (const key of url.searchParams.keys()) {
    if (/^(q-|x-cos-|signature|sign$|token$)/i.test(key)) return source;
    // 非本工具生成的图片处理规则原样保留，避免覆盖裁剪、水印等效果。
    if (
      /^(imageMogr2|imageView2|watermark)/i.test(key) &&
      !/^imageMogr2\/thumbnail\/\d+x\d+>?$/.test(key)
    )
      return source;
  }
  const hashAt = source.indexOf('#');
  const hash = hashAt < 0 ? '' : source.slice(hashAt);
  const base = hashAt < 0 ? source : source.slice(0, hashAt);
  const queryAt = base.indexOf('?');
  const path = queryAt < 0 ? base : base.slice(0, queryAt);
  const query =
    queryAt < 0
      ? []
      : base
          .slice(queryAt + 1)
          .split('&')
          .filter(Boolean);
  const kept = query.filter((part) => {
    try {
      return !/^imageMogr2\/thumbnail\/\d+x\d+>?$/.test(
        decodeURIComponent(part.split('=')[0]),
      );
    } catch {
      return true;
    }
  });
  // %3E 是“仅缩小、不放大”，避免小原图在详情接口反而增大。
  return `${path}?${[...kept, `imageMogr2/thumbnail/${size}x${size}%3E`].join('&')}${hash}` as T;
}

/** 创建响应副本；不改变数据库对象、订单JSON及共享商品对象。 */
export function productImageView<
  T extends { image?: string; images?: unknown },
>(product: T, size: ProductImageSize): T {
  return {
    ...product,
    ...(typeof product.image === 'string'
      ? { image: productImageUrl(product.image, size) }
      : {}),
    ...(Array.isArray(product.images)
      ? {
          images: product.images.map((image: unknown) =>
            typeof image === 'string' ? productImageUrl(image, size) : image,
          ),
        }
      : {}),
  };
}
