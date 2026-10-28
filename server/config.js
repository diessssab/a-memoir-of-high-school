'use strict';
/**
 * 配置与环境变量。无需安装 dotenv：这里手写了一个极简的 .env 读取器。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');

/** 读取项目根目录的 .env（如果存在），不覆盖已存在的真实环境变量 */
function loadEnvFile() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

/** 自动生成并持久化一个随机串（用于密钥 / 默认后台密码） */
function ensureRandomFile(filePath, bytes, label) {
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf8').trim();
    if (existing) return existing;
  }
  const value = crypto.randomBytes(bytes).toString('base64url');
  fs.writeFileSync(filePath, value, { mode: 0o600 });
  if (label) {
    console.log(`\n  [初始化] 已生成${label}：${value}`);
    console.log(`  [初始化] 已保存到 ${filePath}（请备份，别提交到 Git）\n`);
  }
  return value;
}

loadEnvFile();

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(ROOT, process.env.DATA_DIR)
  : path.join(ROOT, 'data');
const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(ROOT, process.env.UPLOAD_DIR)
  : path.join(ROOT, 'uploads');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const SESSION_SECRET = process.env.SESSION_SECRET
  ? process.env.SESSION_SECRET
  : ensureRandomFile(path.join(DATA_DIR, '.session-secret'), 32);

const generatedAdminPassword = !process.env.ADMIN_PASSWORD;
const ADMIN_PASSWORD = generatedAdminPassword
  ? ensureRandomFile(path.join(DATA_DIR, '.admin-password'), 6, '后台管理密码')
  : process.env.ADMIN_PASSWORD;

const config = {
  ROOT,
  PUBLIC_DIR: path.join(ROOT, 'public'),
  DATA_DIR,
  UPLOAD_DIR,
  DB_FILE: path.join(DATA_DIR, 'db.json'),
  SESSION_SECRET,
  ADMIN_PASSWORD,
  generatedAdminPassword,
  PORT: Number(process.env.PORT || 3000),
  SITE_URL: process.env.SITE_URL || '',
  TRUST_PROXY: process.env.TRUST_PROXY === '1',
  REVIEW_FIRST_POST: process.env.REVIEW_FIRST_POST === '1',
  MAX_POST_CHARS: Number(process.env.MAX_POST_CHARS || 8000),
  // 校友传文档的大小上限（MB）。默认 500。
  // 上传走磁盘流（不占内存）；正文解析也是流式逐行读（.docx 流式解压），
  // 所以 500MB 也不会把进程撑爆。
  MAX_UPLOAD_MB: Number(process.env.MAX_UPLOAD_MB || 500),
  // 站长在后台「导入回忆」时的大小上限（MB）。默认 2560 = 2.5GB。
  // 整年级的回忆合集动辄一两个 G，所以后台这个口子单独放宽；校友侧仍走 MAX_UPLOAD_MB。
  MAX_IMPORT_UPLOAD_MB: Number(process.env.MAX_IMPORT_UPLOAD_MB || 2560),
  // 配图单独一个上限，别跟着文档一起放大
  MAX_IMAGE_MB: Number(process.env.MAX_IMAGE_MB || 8),
  // 大文件解析时的保护：最多读多少行 / 最多产出多少条回忆
  MAX_IMPORT_LINES: 2000000,
  MAX_IMPORT_ENTRIES: 5000,
  // 单个校友每天最多传几份文档（防有人拿它当网盘）
  DOC_DAILY_LIMIT: Number(process.env.DOC_DAILY_LIMIT || 10),
  // 「整篇作为一个回忆」：文档里的照片会一张张抽出来存到 uploads/posts/<回忆id>/，
  // 这几个上限是防止一篇文档把磁盘和 db.json 一起吃光。
  MAX_DOC_IMAGES_MB: Number(process.env.MAX_DOC_IMAGES_MB || 4096), // 一篇文档的总照片量
  MAX_DOC_XML_MB: Number(process.env.MAX_DOC_XML_MB || 192),         // word/document.xml 的大小
  MAX_DOC_HTML_CHARS: Number(process.env.MAX_DOC_HTML_CHARS || 6000000), // 存进 db.json 的正文 HTML 上限
  // 上传记录最多保留多少条（监控页展示用）
  MAX_FILES: 2000,
  // 会话有效期
  SESSION_TTL_MS: 1000 * 60 * 60 * 24 * 30, // 普通校友 30 天
  ADMIN_TTL_MS: 1000 * 60 * 60 * 12, // 管理员 12 小时
  // 在线判定窗口
  ONLINE_WINDOW_MS: 1000 * 60 * 5,
  // 访问日志最多保留多少条（环形缓冲，超出丢弃最旧的）
  MAX_VISITS: Number(process.env.MAX_VISITS || 100000),
  MAX_EVENTS: Number(process.env.MAX_EVENTS || 5000),
  // 学校建校年份（用于生成"级"下拉）
  GRADE_MIN: 1956,
  GRADE_MAX: new Date().getFullYear(),
};

module.exports = config;