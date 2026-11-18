import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'docs/day-night-parity');
const bytes = fs.readFileSync(path.join(dir, 'baseline.json'));
const expected = fs.readFileSync(path.join(dir, 'baseline.sha256'), 'utf8').trim();
if (crypto.createHash('sha256').update(bytes).digest('hex') !== expected) throw Error('冻结范围校验失败');
const baseline = JSON.parse(bytes), progress = JSON.parse(fs.readFileSync(path.join(dir, 'progress.json')));
const criteria = Array.isArray(baseline) ? baseline : baseline.rows;
if (!criteria) throw Error('缺少验收范围');
const byId = new Map(progress.rows.map(row => [row.id, row]));
if (byId.size !== criteria.length || progress.rows.length !== criteria.length) throw Error('进度项必须与冻结范围完全一致');
let passed = 0, total = 0;
const pendingCore = [];
for (const criterion of criteria) {
  const row = byId.get(criterion.id);
  if (!row || !['pending', 'in-progress', 'passed', 'blocked'].includes(row.status)) throw Error(`非法进度 ${criterion.id}`);
  total += criterion.weight;
  if (row.status === 'passed') {
    if (!row.evidence?.length) throw Error(`${row.id} 缺少证据`);
    for (const file of row.evidence) {
      const resolved = path.resolve(root, file);
      if (!resolved.startsWith(root + path.sep) || !fs.statSync(resolved).isFile()) throw Error(`${row.id} 无效证据`);
    }
    passed += criterion.weight;
  } else if (criterion.core) pendingCore.push(criterion.id);
}
console.log(JSON.stringify({ total, verifiedWeight: passed, verifiedPercent: passed / total * 100, pendingCore, achieved: passed / total >= .95 && pendingCore.length === 0 }, null, 2));
