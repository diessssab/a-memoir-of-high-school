#!/usr/bin/env node
/**
 * 数据备份脚本
 *   node scripts/backup.js            # 备份一次，默认保留最近 30 份
 *   node scripts/backup.js --keep=60  # 保留 60 份
 *
 * 备份内容：data/db.json（全部用户、回忆、评论、访问日志、设置）
 * 输出：backups/db-20261024-203100.json.gz
 *
 * 建议配一条定时任务（Linux: crontab -e）：
 *   0 3 * * *  cd /var/www/langfang-memoir && /usr/bin/node scripts/backup.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const DB_FILE = path.join(ROOT, 'data', 'db.json');
const BACKUP_DIR = path.join(ROOT, 'backups');

const keepArg = process.argv.find((a) => a.startsWith('--keep='));
const KEEP = keepArg ? Math.max(1, parseInt(keepArg.split('=')[1], 10) || 30) : 30;

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function main() {
  if (!fs.existsSync(DB_FILE)) {
    console.error(`找不到数据文件：${DB_FILE}\n（还没有启动过服务？启动一次会自动创建）`);
    process.exit(1);
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const raw = fs.readFileSync(DB_FILE);
  // 简单校验，避免备份半截文件
  try {
    JSON.parse(raw.toString('utf8'));
  } catch (_) {
    console.error('data/db.json 不是合法 JSON，已中止备份（请先检查数据文件）');
    process.exit(1);
  }

  const out = path.join(BACKUP_DIR, `db-${stamp()}.json.gz`);
  fs.writeFileSync(out, zlib.gzipSync(raw, { level: 9 }));

  const kb = (fs.statSync(out).size / 1024).toFixed(1);
  console.log(`✓ 已备份 ${(raw.length / 1024).toFixed(1)} KB → ${path.relative(ROOT, out)}（${kb} KB 压缩后）`);

  // 清理旧备份
  const files = fs
    .readdirSync(BACKUP_DIR)
    .filter((f) => /^db-\d{8}-\d{6}\.json\.gz$/.test(f))
    .sort()
    .reverse();
  const extra = files.slice(KEEP);
  for (const f of extra) {
    fs.unlinkSync(path.join(BACKUP_DIR, f));
    console.log(`  - 清理旧备份 ${f}`);
  }
  console.log(`当前保留 ${Math.min(files.length, KEEP)} 份备份。`);
}

main();