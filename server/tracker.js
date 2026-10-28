'use strict';
/**
 * 访客行为追踪 + 限流 + 封禁。
 * 只记录"谁在什么时候看了/动了哪个页面"，用于站长排查恶意访问、恢复被破坏的内容。
 */
const config = require('./config');
const { store, clientIp } = require('./store');

const STATIC_EXT = /\.(css|js|mjs|map|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot|mp4|webm|txt|xml)$/i;
const SKIP_PATHS = new Set(['/favicon.ico', '/healthz']);

/** 记录一次访问（静态资源不记录，避免日志爆炸） */
function trackVisit(req, res, next) {
  if (SKIP_PATHS.has(req.path) || req.method === 'OPTIONS' || STATIC_EXT.test(req.path)) {
    return next();
  }
  const started = Date.now();
  res.on('finish', () => {
    const ua = String(req.headers['user-agent'] || '');
    store.addVisit({
      ts: started,
      ip: req.clientIp || clientIp(req),
      method: req.method,
      path: req.originalUrl.split('?')[0].slice(0, 200),
      query: (req.originalUrl.split('?')[1] || '').slice(0, 200),
      status: res.statusCode,
      ms: Date.now() - started,
      referer: String(req.headers.referer || '').slice(0, 300),
      ua: ua.slice(0, 300),
      device: ua.includes('Mobile') || ua.includes('Android') ? 'mobile' : 'desktop',
      uid: req.user ? req.user.id : null,
      who: req.user ? label(req.user) : null,
      sessionRole: req.userSession ? 'user' : req.adminSession ? 'admin' : 'guest',
    });
  });
  next();
}

function label(user) {
  if (!user) return '访客';
  return `${gradeLabel(user.year)}${user.className ? user.className + '班' : ''}${user.name}`;
}

function gradeLabel(year) {
  if (!year) return '';
  const y = String(year);
  return `${y.length === 4 ? y.slice(2) : y}级`;
}

/** 内存限流器：key -> [时间戳] */
const buckets = new Map();
function rateLimit({ windowMs, max, key }) {
  return (req, res, next) => {
    const k = `${key}:${clientIp(req)}`;
    const now = Date.now();
    const arr = (buckets.get(k) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) {
      const retry = Math.ceil((windowMs - (now - arr[0])) / 1000);
      res.setHeader('Retry-After', String(retry));
      return res.status(429).json({ error: `操作太频繁，请 ${retry} 秒后再试` });
    }
    arr.push(now);
    buckets.set(k, arr);
    next();
  };
}

// 定时清理限流桶，防止内存无限增长
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of buckets) {
    const keep = arr.filter((t) => now - t < 60 * 60 * 1000);
    if (keep.length) buckets.set(k, keep);
    else buckets.delete(k);
  }
}, 10 * 60 * 1000).unref();

/** 封禁检查：命中的 IP 直接 403 */
function banCheck(req, res, next) {
  const ip = clientIp(req);
  if (ip && store.isBanned(ip)) {
    store.addEvent('blocked-request', { path: req.path }, req);
    return res.status(403).json({ error: '该网络地址已被限制访问' });
  }
  next();
}

/** 敏感词过滤：命中直接拒绝（站长可在后台维护词表） */
function checkSensitive(text, extraWords) {
  const words = [...(store.data.settings.sensitiveWords || []), ...(extraWords || [])];
  const hit = words.find((w) => w && text.includes(w));
  return hit || null;
}

/** 极简的 HTML 转义（用于导出 CSV 或邮件正文，前端渲染走 textContent） */
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

module.exports = { trackVisit, rateLimit, banCheck, checkSensitive, escapeHtml, label, gradeLabel };