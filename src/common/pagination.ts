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

/** 内存分页包裹（列表数据量 MVP 级，service 层过滤/映射保持不变）。 */
export function paginate<T>(
  items: T[],
  page?: string,
  pageSize?: string,
): PagedResult<T> {
  const { page: p, pageSize: size } = parsePagination(page, pageSize);
  return {
    items: items.slice((p - 1) * size, p * size),
    page: p,
    pageSize: size,
    total: items.length,
  };
}
