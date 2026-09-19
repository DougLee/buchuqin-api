import COS from 'cos-nodejs-sdk-v5';

// 腾讯 COS 客户端（与 files.controller 同款惰性初始化：模块求值早于 .env 加载）
let cosClient: COS | null = null;
const getCos = () => {
  cosClient ??= new COS({
    SecretId: process.env.COS_SECRET_ID ?? '',
    SecretKey: process.env.COS_SECRET_KEY ?? '',
  });
  return cosClient;
};

/**
 * COS 私有读对象的临时签名 URL（RBAC V1 敏感附件访问策略）：
 * 身份证照片等敏感附件不再走公开直链——列表/详情只回对象键或原 URL，
 * 展示时经本函数换取带签名的短时效 URL（默认 5 分钟），读取前已由
 * 业务端点完成权限与数据范围校验。
 * COS 未配置时原样返回（本地/测试环境无桶，不阻塞链路）。
 */
export function presignCosUrl(urlOrKey: string, expiresSeconds = 300): string {
  if (!urlOrKey) return urlOrKey;
  const bucket = process.env.COS_BUCKET ?? '';
  const region = process.env.COS_REGION ?? '';
  if (!bucket || !region) return urlOrKey;
  // 取 URL path 为对象键（兼容完整公网 URL / 裸 key 两种入参）
  let key = urlOrKey;
  try {
    if (/^https?:\/\//.test(urlOrKey)) {
      key = decodeURIComponent(new URL(urlOrKey).pathname.replace(/^\//, ''));
    }
  } catch {
    return urlOrKey;
  }
  try {
    return getCos().getObjectUrl({
      Bucket: bucket,
      Region: region,
      Key: key,
      Sign: true,
      Method: 'GET',
      Expires: expiresSeconds,
    } as never) as unknown as string;
  } catch {
    return urlOrKey;
  }
}
