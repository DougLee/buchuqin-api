/** Purchase periods follow China time, independent of the server's local timezone. */
export function purchaseWindowStart(kind: string, now = new Date()): Date {
  if (kind !== 'weekly' && kind !== 'monthly') return new Date(0);
  const china = new Date(now.getTime() + 8 * 3_600_000);
  china.setUTCHours(0, 0, 0, 0);
  if (kind === 'weekly') china.setUTCDate(china.getUTCDate() - (china.getUTCDay() + 6) % 7);
  else china.setUTCDate(1);
  return new Date(china.getTime() - 8 * 3_600_000);
}
