/**
 * 敏感字段展示/留痕工具（RBAC V1 2026-09-19）：
 * 身份证号在任何日志/审计/低权响应中一律掩码（保前 2 后 2 供核对）。
 */
export function maskIdCard(no: string | null | undefined): string {
  const s = (no ?? '').trim();
  if (!s) return '';
  if (s.length <= 4) return '****';
  return `${s.slice(0, 2)}${'*'.repeat(Math.max(0, s.length - 4))}${s.slice(-2)}`;
}
