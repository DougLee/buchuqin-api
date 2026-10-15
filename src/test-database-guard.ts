import fs from 'node:fs';
import path from 'node:path';

/**
 * 集成测试会创建订单、用户、校区等完整业务数据。若误连共享测试环境库，
 * 不仅污染运营数据，还会触发后台“新订单”提醒。测试启动前强制确认数据库
 * 名称以 `_spec` 结尾；这是最后一道防线，不依赖每个用例自行清理成功。
 */
function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return '';
  const line = fs
    .readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .find((item) => item.trim().startsWith('DATABASE_URL='));
  return (
    line
      ?.slice(line.indexOf('=') + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '') ?? ''
  );
}

const url = databaseUrl();
let databaseName = '';
try {
  databaseName = new URL(url).pathname.replace(/^\//, '');
} catch {
  // 下方统一给出不包含凭证的错误，避免把连接串泄露到测试日志。
}

if (!databaseName.endsWith('_spec')) {
  throw new Error(
    `拒绝运行测试：当前数据库“${databaseName || '未配置'}”不是 _spec 专用测试库`,
  );
}
