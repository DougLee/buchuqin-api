/**
 * 列表统一分页（IK8W5X）：
 * 所有列表端点接受 ?page=1&pageSize=20（pageSize 上限 100），
 * 响应统一包裹 { items, page, pageSize, total }；items 内部结构与过滤参数不变。
 */
export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export interface PagedResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

/** 解析分页参数：非法/越界值回退默认，pageSize 封顶 100。 */
export function parsePagination(
  page?: string,
  pageSize?: string,
): { page: number; pageSize: number } {
  const p = Math.max(1, Math.floor(Number(page) || 1));
  const size = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.floor(Number(pageSize) || DEFAULT_PAGE_SIZE)),
  );
  return { page: p, pageSize: size };
}

/** 关键词过滤跳过的噪声字段：id 外键、二进制/日志大对象等。 */
const KEYWORD_EXCLUDED_KEYS = new Set([
  'id',
  'campusId',
  'productId',
  'categoryId',
  'userId',
  'orderId',
  'buildingId',
  'staffId',
  'floor',
  'qrToken',
  'passwordHash',
  'before',
  'after',
  'images',
  'timeline',
  'items',
]);

/**
 * 通用关键词过滤（IK8W5X keyword 契约收尾）：对列表行做浅层字段匹配，
 * 嵌套对象（订单 address、请假 staff 等）下钻一层。小写包含即命中。
 */
export function filterByKeyword<T>(items: T[], keyword?: string): T[] {
  const q = (keyword ?? '').trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => keywordHaystack(item, 0).includes(q));
}

function keywordHaystack(value: unknown, depth: number): string {
  if (value == null) return '';
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return String(value).toLowerCase();
  if (depth >= 1 || Array.isArray(value) || typeof value !== 'object')
    return '';
  return Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !KEYWORD_EXCLUDED_KEYS.has(key))
    .map(([, v]) => keywordHaystack(v, depth + 1))
    .join(' ');
}

/** 内存分页包裹（列表数据量 MVP 级，service 层过滤/映射保持不变）；
 *  传 keyword 时先做通用关键词过滤再分页（total 为过滤后命中数）。 */
export function paginate<T>(
  items: T[],
  page?: string,
  pageSize?: string,
  keyword?: string,
): PagedResult<T> {
  const { page: p, pageSize: size } = parsePagination(page, pageSize);
  const filtered = filterByKeyword(items, keyword);
  return {
    items: filtered.slice((p - 1) * size, p * size),
    page: p,
    pageSize: size,
    total: filtered.length,
  };
}
