import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const matrix = JSON.parse(fs.readFileSync(path.join(root, 'docs/night-store/acceptance-matrix.json'), 'utf8'));
assert.equal(matrix.frozen, true);
assert.equal(matrix.rows.length, 43, '不能减少冻结的验收项');
assert.equal(new Set(matrix.rows.map(row => row.id)).size, 43);
assert.equal(matrix.rows.reduce((sum, row) => sum + row.weight, 0), 100);
assert.equal(matrix.totalWeight, 100);
const baseline = matrix.rows.map(({ id, name, criteria, critical, weight }) => ({ id, name, criteria, critical, weight }));
assert.equal(createHash('sha256').update(JSON.stringify(baseline)).digest('hex'), '84030c7c1795a715dee3040214928c56a037531a08e7e26b670535dab8ab9882', '冻结标准/权重发生变化，不能据此提高完成率');
let accepted = 0;
for (const row of matrix.rows) {
  for (const field of ['roles', 'pages', 'api', 'testMethods']) assert.ok(Array.isArray(row[field]) && row[field].length && row[field].every(value => typeof value === 'string' && value.trim()), `${row.id} 缺少 ${field}`);
  for (const field of ['dataFlow', 'normalFlow', 'abnormalFlow', 'permissionBoundary', 'currentImplementation', 'notes']) assert.ok(typeof row[field] === 'string' && row[field].trim(), `${row.id} 缺少 ${field}`);
  assert.ok(Array.isArray(row.openIssues), `${row.id} 缺少未完成事项结论`);
  assert.ok(['pending', 'passed', 'failed', 'external-blocked'].includes(row.result), `无效结论：${row.id}`);
  if (row.result !== 'passed') continue;
  assert.ok(row.evidence.length && row.evidence.some(file => file.startsWith('docs/night-store/evidence/')), `必须有实际运行证据：${row.id}`);
  for (const file of row.evidence) {
    const target = path.resolve(root, file);
    assert.ok(target.startsWith(root + path.sep) && fs.existsSync(target), `证据缺失：${row.id} ${file}`);
  }
  accepted += row.weight;
}
const outstanding = matrix.rows.filter(row => row.result !== 'passed');
const coreOutstanding = outstanding.filter(row => row.critical).map(row => row.id);
const report = { acceptedWeight: accepted, totalWeight: 100, completionPercent: accepted, goalComplete: accepted >= 95 && coreOutstanding.length === 0 && outstanding.every(row => row.result !== 'pending' && row.result !== 'failed'), coreOutstanding, rows: matrix.rows.map(({ id, name, weight, result, evidence, notes }) => ({ id, name, weight, result, evidence, notes })) };
if (process.argv.includes('--write')) {
  fs.writeFileSync(path.join(root, 'docs/night-store/acceptance-progress.json'), JSON.stringify(report, null, 2) + '\n');
  const label = { passed: '通过', pending: '待验收', failed: '失败', 'external-blocked': '外部待验收' };
  const lines = ['# 夜宵四端冻结验收矩阵', '', `完成率 **${accepted}%**；通过 ${43 - outstanding.length}/43 项。核心未完成：${coreOutstanding.join('、') || '无'}。冻结基线 SHA-256：\`${createHash('sha256').update(JSON.stringify(baseline)).digest('hex')}\`。`, '', '由 `node scripts/report-night-acceptance.mjs --write` 从 JSON 生成；不能修改标准或权重以提高完成率。', ''];
  for (const row of matrix.rows) {
    lines.push(
      `## ${row.id} ${row.name}（${row.weight}% · ${label[row.result]}${row.critical ? ' · 核心' : ''}）`, '',
      `验收标准：${row.criteria}`, '',
      `角色：${row.roles.join('、')}。页面：${row.pages.join('、')}。`, '',
      `接口：${row.api.map(value => '`' + value + '`').join('；')}。`, '',
      `数据流：${row.dataFlow}`, '', `正常：${row.normalFlow}`, '',
      `异常：${row.abnormalFlow}`, '', `权限边界：${row.permissionBoundary}`, '',
      `测试：${row.testMethods.join('；')}。结论：${row.notes}`, '',
      `未完成：${row.openIssues.join('；') || '无'}`, '',
      '证据：' + (row.evidence.map(file => `[${path.basename(file)}](${path.relative(path.join(root, 'docs/night-store'), path.join(root, file))})`).join('、') || '尚无'), '',
    );
  }
  fs.writeFileSync(path.join(root, 'docs/night-store/ACCEPTANCE_MATRIX.md'), lines.join('\n'));
}
console.log(JSON.stringify({ completionPercent: report.completionPercent, goalComplete: report.goalComplete, passed: 43 - outstanding.length, remaining: outstanding.length, coreOutstanding }, null, 2));
