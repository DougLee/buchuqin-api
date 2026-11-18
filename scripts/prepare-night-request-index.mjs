import pg from 'pg';

/** Add nullable idempotency columns before db push so a populated fixture schema
 * needs no blanket --accept-data-loss. This never alters or truncates old rows. */
export async function prepareNightRequestIndex(databaseUrl) {
  const url = new URL(databaseUrl), schema = url.searchParams.get('schema');
  if (!url.pathname.endsWith('_spec') || !/^night_stock_[a-z0-9_]+$/.test(schema || '')) throw new Error('加法迁移仅允许独立夜宵测试schema');
  const db = new pg.Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    const table = await db.query('SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2', [schema, 'NightOrder']);
    if (!table.rowCount) return;
    await db.query('BEGIN');
    await db.query(`SET LOCAL search_path TO "${schema}"`);
    await db.query('ALTER TABLE "NightOrder" ADD COLUMN IF NOT EXISTS "requestId" VARCHAR(80), ADD COLUMN IF NOT EXISTS "requestHash" TEXT');
    await db.query('CREATE UNIQUE INDEX IF NOT EXISTS "NightOrder_userId_requestId_key" ON "NightOrder"("userId", "requestId")');
    await db.query('COMMIT');
  } catch (error) { await db.query('ROLLBACK'); throw error; }
  finally { await db.end(); }
}
