import { paginate, parsePagination } from './pagination';

/** 列表统一分页（IK8W5X）：默认 20/页、上限 100、响应 { items, page, pageSize, total }。 */
describe('pagination helper (IK8W5X)', () => {
  it('defaults to page=1 pageSize=20 and echoes total', () => {
    const items = Array.from({ length: 25 }, (_, i) => i);
    const result = paginate(items);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(20);
    expect(result.total).toBe(25);
    expect(result.items).toHaveLength(20);
  });

  it('slices later pages and returns empty tail beyond the end', () => {
    const items = Array.from({ length: 25 }, (_, i) => i);
    expect(paginate(items, '2', '20').items).toEqual(items.slice(20, 40));
    expect(paginate(items, '3', '20').items).toEqual([]);
    expect(paginate(items, '3', '20').total).toBe(25);
  });

  it('caps pageSize at 100 and floors invalid input to defaults', () => {
    expect(parsePagination('1', '500')).toEqual({ page: 1, pageSize: 100 });
    expect(parsePagination('0', '0')).toEqual({ page: 1, pageSize: 20 });
    expect(parsePagination('abc', 'abc')).toEqual({ page: 1, pageSize: 20 });
    expect(parsePagination('-3', '5')).toEqual({ page: 1, pageSize: 5 });
  });
});
