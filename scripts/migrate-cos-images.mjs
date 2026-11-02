/**
 * COS 存量图片压缩迁移（道哥 2026-11-02 三项拍板：凭证压 q85/同名换 .webp/
 * 测试库演练通过后低峰换生产）。
 *
 * 用法：
 *   node scripts/migrate-cos-images.mjs scan  [--batch=all]           扫描对账（只读）
 *   node scripts/migrate-cos-images.mjs transcode [--batch=...] [--limit=N]  转码（COS 写新对象+映射落盘，幂等可重跑）
 *   node scripts/migrate-cos-images.mjs rewrite                       测试库换址（本地 DATABASE_URL）
 *   node scripts/migrate-cos-images.mjs sql [--batch=...]             生成生产换址 SQL（服务器 psql 执行）
 *
 * 批次：product / category / banner / uploads / all
 *  - product  Product.image + Product.images[]
 *  - category Category.image
 *  - banner   Banner.image
 *  - uploads  Refund.images[] + Order.package.handoverProof.images（q85 保真）
 * 豁免：wechat-group / idcard / public / wheel 目录、GIF、非本桶域名（外链）。
 * 新 key = 原 key 换 .webp 后缀；原文件永不删除（回滚=库地址改回旧值）。
 * 映射落盘 migrate-cos-map-<batch>.json，换址与回滚依据。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import COS from 'cos-nodejs-sdk-v5';
import sharp from 'sharp';
import pg from 'pg';

const args = process.argv.slice(2);
const cmd = args[0];
const argOf = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
};
const batch = argOf('batch', 'all');
const limit = Number(argOf('limit', '0'));
/** --adopt：目标 .webp 已存在时采纳（拉双方大小记映射换址）——仅当确认
 *  该 .webp 是本脚本前轮产物（如映射文件误删后重建）；默认 SKIP 来源不明 */
const adopt = args.includes('--adopt');
/** --from-bucket：转码输入改为直接列桶对象（跨环境场景：转码机连不上目标库，
 *  生产库引用全集≈全桶按目录批，孤儿对象多转无害且换址只认库引用） */
const fromBucket = args.includes('--from-bucket');

const BUCKET = process.env.COS_BUCKET;
const REGION = process.env.COS_REGION;
const PUBLIC_BASE =
  process.env.COS_PUBLIC_BASE_URL ??
  `https://${BUCKET}.cos.${REGION}.myqcloud.com`;
// 生产库存的是 static.buchuqin.com（COS 自定义域名）——域名归一化后取对象键
const KNOWN_HOSTS = new Set(
  [
    `${BUCKET}.cos.${REGION}.myqcloud.com`,
    'static.buchuqin.com',
  ].map((h) => h.toLowerCase()),
);

/** 同上传压缩策略（files/image-compress.ts 口径）；凭证批次 q85 稍保真 */
const QUALITY = { product: 80, category: 80, banner: 80, uploads: 85 };
const MAX_EDGE = 1600;
const SKIP_DIR = ['app/wechat-group', 'app/idcard', 'app/public', 'app/wheel'];

const cos = new COS({
  SecretId: process.env.COS_SECRET_ID ?? '',
  SecretKey: process.env.COS_SECRET_KEY ?? '',
});
const cosGet = (key) =>
  new Promise((resolve, reject) =>
    cos.getObject(
      { Bucket: BUCKET, Region: REGION, Key: key },
      (err, data) => (err ? reject(err) : resolve(data.Body)),
    ),
  );
const cosHead = (key) =>
  new Promise((resolve) =>
    cos.headObject(
      { Bucket: BUCKET, Region: REGION, Key: key },
      (err) => resolve(!err),
    ),
  );
const cosPut = (key, body, mime) =>
  new Promise((resolve, reject) =>
    cos.putObject(
      { Bucket: BUCKET, Region: REGION, Key: key, Body: body, ContentType: mime },
      (err) => (err ? reject(err) : resolve()),
    ),
  );

/** URL → 本桶对象键；非本桶（外链）返回 null */
function urlToKey(url) {
  if (typeof url !== 'string' || !url) return null;
  try {
    if (!/^https?:\/\//i.test(url)) return null;
    const u = new URL(url);
    if (!KNOWN_HOSTS.has(u.hostname.toLowerCase())) return null;
    return decodeURIComponent(u.pathname.replace(/^\//, ''));
  } catch {
    return null;
  }
}
const isSkipped = (key) =>
  SKIP_DIR.some((d) => key.startsWith(`${d}/`)) || key.toLowerCase().endsWith('.gif');
/** 批次归属：按对象键目录判定（category/banner 优先级高于 product 兜底） */
function batchOf(key) {
  if (key.startsWith('app/category/')) return 'category';
  if (key.startsWith('app/banner/')) return 'banner';
  if (key.startsWith('uploads/')) return 'uploads';
  if (key.startsWith('app/product/')) return 'product';
  return 'stray';
}

/* ---------- 扫描：从数据库收集引用的 COS 键 ---------- */
async function collectRefs(dbUrl, want) {
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  const wanted = (b) => want === 'all' || want === b;
  const refs = new Map(); // key -> {batch, sources:[...]}
  const add = (key, source) => {
    if (!key || isSkipped(key)) return;
    const b = batchOf(key);
    if (b === 'stray' && !wanted('stray') && !wanted('all')) return;
    if (!refs.has(key)) refs.set(key, { batch: b, sources: [] });
    refs.get(key).sources.push(source);
  };
  if (wanted('product') || want === 'all') {
    const { rows } = await client.query(
      `SELECT id, image, images FROM "Product" WHERE COALESCE(image,'') <> '' OR images IS NOT NULL`,
    );
    for (const r of rows) {
      const k = urlToKey(r.image);
      if (k) add(k, `Product:${r.id}.image`);
      for (const u of r.images ?? []) {
        const kk = urlToKey(u);
        if (kk) add(kk, `Product:${r.id}.images[]`);
      }
    }
  }
  if (wanted('category') || want === 'all') {
    const { rows } = await client.query(
      `SELECT id, image FROM "Category" WHERE COALESCE(image,'') <> ''`,
    );
    for (const r of rows) {
      const k = urlToKey(r.image);
      if (k) add(k, `Category:${r.id}`);
    }
  }
  if (wanted('banner') || want === 'all') {
    const { rows } = await client.query(`SELECT id, image FROM "Banner"`);
    for (const r of rows) {
      const k = urlToKey(r.image);
      if (k) add(k, `Banner:${r.id}`);
    }
  }
  if (wanted('uploads') || want === 'all') {
    const { rows } = await client.query(
      `SELECT id, images FROM "Refund" WHERE images IS NOT NULL`,
    );
    for (const r of rows)
      for (const u of r.images ?? []) {
        const k = urlToKey(u);
        if (k) add(k, `Refund:${r.id}`);
      }
    const { rows: orows } = await client.query(
      `SELECT id, package FROM "Order" WHERE package IS NOT NULL`,
    );
    for (const r of orows) {
      // package.handoverProof / package.proof 均为单对象 {time, images[]}
      for (const slot of ['handoverProof', 'proof']) {
        for (const u of r.package?.[slot]?.images ?? []) {
          const k = urlToKey(u);
          if (k) add(k, `Order:${r.id}.${slot}`);
        }
      }
    }
  }
  await client.end();
  return refs;
}

/* ---------- 转码 ---------- */
async function transcode() {
  const dbUrl = process.env.DATABASE_URL;
  if (!BUCKET || !REGION || (!fromBucket && !dbUrl)) {
    console.error('缺 COS_*/DATABASE_URL 环境变量（.env 加载：node --env-file=.env ...）');
    process.exit(1);
  }
  let keys;
  if (fromBucket) {
    // 全桶模式：列桶对象按目录过滤（跨环境场景——生产库引用全集≈全桶按
    // 目录批；孤儿对象多转无害，换址只认库引用）
    keys = [];
    let marker = '';
    for (;;) {
      const page = await new Promise((resolve, reject) =>
        cos.getBucket(
          { Bucket: BUCKET, Region: REGION, Marker: marker, MaxKeys: 1000 },
          (err, d) => (err ? reject(err) : resolve(d)),
        ),
      );
      for (const o of page.Contents ?? []) {
        const key = o.Key;
        if (isSkipped(key)) continue;
        if (key.toLowerCase().endsWith('.webp')) continue; // 已 webp 免转
        const b = batchOf(key);
        if (b === 'stray' && batch !== 'all' && batch !== 'stray') continue;
        if (batch !== 'all' && b !== batch) continue;
        keys.push(key);
      }
      if (page.IsTruncated === 'true') marker = page.NextMarker;
      else break;
    }
  } else {
    const refs = await collectRefs(dbUrl, batch);
    keys = [...refs.keys()];
  }
  keys.sort();
  const capped = limit > 0 ? keys.slice(0, limit) : keys;
  console.log(
    `扫描 ${fromBucket ? '全桶' : '库引用'} ${keys.length} 个对象，本次处理 ${capped.length} 个`,
  );

  const map = { generatedAt: new Date().toISOString(), batch, items: [] };
  let done = 0,
    skippedExisting = 0,
    skippedNoGain = 0,
    failed = 0;
  for (const key of capped) {
    const newKey = key.replace(/\.[a-z0-9]+$/i, '.webp');
    // 已是 webp：无需转码，引用原样保留（不进映射，rewrite 无事可做）
    if (key === newKey) {
      skippedExisting++;
      continue;
    }
    const q = QUALITY[batchOf(key)] ?? 80;
    try {
      if (await cosHead(newKey)) {
        if (!adopt) {
          // 默认保守：来源不明（可能是别家引用的图）不覆盖不换址
          console.warn(
            `  SKIP ${key}：目标 ${newKey} 已存在（加 --adopt 可采纳为前轮产物）`,
          );
          skippedExisting++;
          continue;
        }
        // --adopt：确认是本脚本前轮产物——拉双方大小重建映射
        const [orig, news] = await Promise.all([cosGet(key), cosGet(newKey)]);
        map.items.push({
          oldKey: key,
          newKey,
          oldSize: orig.length,
          newSize: news.length,
        });
        skippedExisting++;
        continue;
      }
      const body = await cosGet(key);
      const out = await sharp(body)
        .rotate()
        .resize({
          width: MAX_EDGE,
          height: MAX_EDGE,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: q })
        .toBuffer();
      if (out.length >= body.length) {
        // 压不动（已优化的 webp 等）——保留原文件不换址
        skippedNoGain++;
        continue;
      }
      await cosPut(newKey, out, 'image/webp');
      map.items.push({
        oldKey: key,
        newKey,
        oldSize: body.length,
        newSize: out.length,
      });
      done++;
      if (done % 50 === 0)
        console.log(
          `  ${done} 完成…（累计省 ${(
            map.items.reduce((s, i) => s + ((i.oldSize ?? 0) - (i.newSize ?? 0)), 0) / 1048576
          ).toFixed(1)} MB）`,
        );
    } catch (e) {
      failed++;
      console.warn(`  FAIL ${key}: ${e.message}`);
    }
  }
  const mapFile = path.resolve(`migrate-cos-map-${batch}.json`);
  writeFileSync(mapFile, JSON.stringify(map, null, 1));
  const saved = map.items.reduce(
    (s, i) => s + ((i.oldSize ?? 0) - (i.newSize ?? 0)),
    0,
  );
  console.log(
    `转码完成：新写 ${done} | 幂等复用 ${skippedExisting} | 无收益跳过 ${skippedNoGain} | 失败 ${failed}`,
  );
  console.log(`节省 ${(saved / 1048576).toFixed(1)} MB；映射已落盘 ${mapFile}`);
}

/* ---------- 换址（测试库直连） ---------- */
async function rewrite() {
  const dbUrl = process.env.DATABASE_URL;
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  let total = 0;
  const applyMaps = async () => {
    for (const b of ['product', 'category', 'banner', 'uploads']) {
      const f = path.resolve(`migrate-cos-map-${b}.json`);
      if (!existsSync(f)) continue;
      const map = JSON.parse(readFileSync(f, 'utf8'));
      for (const it of map.items) {
        if (it.reused && !it.oldSize && it.oldKey === it.newKey) continue;
        // key 级替换：URL 尾部即对象键，域名无关（static.buchuqin.com 与
        // 原始 COS 域名两种库存前缀都命中）
        const oldUrl = it.oldKey;
        const newUrl = it.newKey;
        // Product 主图+轮播
        const { rowCount: r1 } = await client.query(
          `UPDATE "Product" SET image = replace(image, $1, $2)
           WHERE image LIKE '%' || $1`,
          [oldUrl, newUrl],
        );
        const { rowCount: r2 } = await client.query(
          `UPDATE "Product"
           SET images = (
             SELECT jsonb_agg(to_jsonb(replace(x, $1, $2)))
             FROM jsonb_array_elements_text(images) x
           )
           WHERE images @> jsonb_build_array($1::text)`,
          [oldUrl, newUrl],
        );
        // Category / Banner
        const { rowCount: r3 } = await client.query(
          `UPDATE "Category" SET image = replace(image, $1, $2)
           WHERE image LIKE '%' || $1`,
          [oldUrl, newUrl],
        );
        const { rowCount: r4 } = await client.query(
          `UPDATE "Banner" SET image = replace(image, $1, $2)
           WHERE image LIKE '%' || $1`,
          [oldUrl, newUrl],
        );
        // Refund.images[]
        const { rowCount: r5 } = await client.query(
          `UPDATE "Refund"
           SET images = (
             SELECT jsonb_agg(to_jsonb(replace(x, $1, $2)))
             FROM jsonb_array_elements_text(images) x
           )
           WHERE images @> jsonb_build_array($1::text)`,
          [oldUrl, newUrl],
        );
        // Order.package.handoverProof.images[]（jsonb 深路径逐单改写）
        const { rows: orows } = await client.query(
          `SELECT id, package FROM "Order"
           WHERE package::text LIKE '%' || $1`,
          [oldUrl],
        );
        let r6 = 0;
        for (const o of orows) {
          const text = JSON.stringify(o.package).split(oldUrl).join(newUrl);
          await client.query(`UPDATE "Order" SET package = $2::jsonb WHERE id = $1`, [
            o.id,
            text,
          ]);
          r6++;
        }
        total += r1 + r2 + r3 + r4 + r5 + r6;
        if (r1 + r2 + r3 + r4 + r5 + r6)
          console.log(
            `  ${path.basename(it.oldKey)}: 更新 ${r1 + r2 + r3 + r4 + r5 + r6} 行`,
          );
      }
    }
  };
  await applyMaps();
  await client.end();
  console.log(`换址完成：共更新 ${total} 行`);
}

/* ---------- 生产换址 SQL 生成 ---------- */
async function genSql() {
  let out = `-- 生产换址 SQL（道哥发令后服务器 psql 执行；幂等：replace 无匹配无副作用）\nBEGIN;\n`;
  let n = 0;
  const allMap = path.resolve('migrate-cos-map-all.json');
  const batches = existsSync(allMap)
    ? ['all']
    : ['product', 'category', 'banner', 'uploads'];
  for (const b of batches) {
    const f = path.resolve(`migrate-cos-map-${b}.json`);
    if (!existsSync(f)) continue;
    const map = JSON.parse(readFileSync(f, 'utf8'));
    for (const it of map.items) {
      const oldUrl = it.oldKey;
      const newUrl = it.newKey;
      const esc = (s) => s.replace(/'/g, "''");
      out += `UPDATE "Product" SET image = replace(image,'${esc(oldUrl)}','${esc(newUrl)}') WHERE image LIKE '%${esc(oldUrl)}';\n`;
      out += `UPDATE "Product" SET images = (SELECT jsonb_agg(to_jsonb(replace(x,'${esc(oldUrl)}','${esc(newUrl)}'))) FROM jsonb_array_elements_text(images) x) WHERE images::text LIKE '%${esc(oldUrl)}%';\n`;
      out += `UPDATE "Category" SET image = replace(image,'${esc(oldUrl)}','${esc(newUrl)}') WHERE image LIKE '%${esc(oldUrl)}';\n`;
      out += `UPDATE "Banner" SET image = replace(image,'${esc(oldUrl)}','${esc(newUrl)}') WHERE image LIKE '%${esc(oldUrl)}';\n`;
      out += `UPDATE "Refund" SET images = (SELECT jsonb_agg(to_jsonb(replace(x,'${esc(oldUrl)}','${esc(newUrl)}'))) FROM jsonb_array_elements_text(images) x) WHERE images::text LIKE '%${esc(oldUrl)}%';\n`;
      out += `UPDATE "Order" SET package = replace(package::text,'${esc(oldUrl)}','${esc(newUrl)}')::jsonb WHERE package::text LIKE '%${esc(oldUrl)}';\n`;
      n += 6;
    }
  }
  out += `COMMIT;\n`;
  const f = path.resolve(`migrate-cos-rewrite-prod.sql`);
  writeFileSync(f, out);
  console.log(`生成 ${f}（${n} 条 UPDATE，一个事务）`);
}

/* ---------- scan ---------- */
async function scan() {
  const refs = await collectRefs(process.env.DATABASE_URL, batch);
  const byBatch = {};
  for (const [key, v] of refs) {
    byBatch[v.batch] = byBatch[v.batch] || { n: 0, sources: 0 };
    byBatch[v.batch].n++;
    byBatch[v.batch].sources += v.sources.length;
  }
  console.log(`数据库引用的 COS 对象（含 ${PUBLIC_BASE} 域名）：`);
  for (const [b, v] of Object.entries(byBatch))
    console.log(`  ${b}: ${v.n} 个对象 / ${v.sources} 处引用`);
  console.log(`合计 ${refs.size} 个`);
}

const runners = { scan, transcode, rewrite, sql: genSql };
if (!runners[cmd]) {
  console.error('用法：scan | transcode [--batch=...] [--limit=N] | rewrite | sql');
  process.exit(1);
}
runners[cmd]().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
