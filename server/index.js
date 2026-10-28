'use strict';
/**
 * 廊坊一中回忆录 · 服务入口
 * 启动：npm start   （开发热重载：npm run dev）
 */
const path = require('path');
const express = require('express');
const config = require('./config');
const { store } = require('./store');
const auth = require('./auth');
const { trackVisit, banCheck } = require('./tracker');

const app = express();

app.disable('x-powered-by');
if (config.TRUST_PROXY) app.set('trust proxy', true);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// 安全响应头（不依赖 helmet，几行就够）
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'self'"
  );
  next();
});

// 身份识别 + 封禁检查 + 访问记录
app.use(auth.attach);
app.use(banCheck);
app.use(trackVisit);

app.get('/healthz', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// 接口
app.use('/api', require('./routes/public'));
app.use('/api/docs', require('./routes/docs'));
app.use('/api/admin', require('./routes/admin'));

// 上传的图片
app.use(
  '/uploads',
  express.static(config.UPLOAD_DIR, {
    maxAge: '30d',
    setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
  })
);

// 静态页面
app.use(express.static(config.PUBLIC_DIR, { extensions: ['html'], maxAge: '1h' }));

// 友好的页面路由
app.get('/admin', (req, res) => res.sendFile(path.join(config.PUBLIC_DIR, 'admin.html')));
app.get('/wall', (req, res) => res.sendFile(path.join(config.PUBLIC_DIR, 'wall.html')));
app.get('/account', (req, res) => res.sendFile(path.join(config.PUBLIC_DIR, 'account.html')));
app.get('/monitor', (req, res) => res.sendFile(path.join(config.PUBLIC_DIR, 'monitor.html')));
app.get('/post/:id', (req, res) => res.sendFile(path.join(config.PUBLIC_DIR, 'post.html')));

// 404
app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: '接口不存在' });
  res.status(404).sendFile(path.join(config.PUBLIC_DIR, '404.html'));
});

// 统一错误处理
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  // 客户端提交的 JSON 坏了 → 400，而不是 500
  if (err && (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && err.status === 400))) {
    return res.status(400).json({ error: '提交的数据格式不对（JSON 解析失败）' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: '提交的内容太大了' });
  }
  console.error('[error]', req.method, req.originalUrl, err);
  res.status(500).json({ error: '服务器开小差了，请稍后再试' });
});

const server = app.listen(config.PORT, () => {
  const base = config.SITE_URL || `http://localhost:${config.PORT}`;
  console.log(`
  ┌──────────────────────────────────────────────┐
  │        廊坊一中回忆录  已启动                │
  ├──────────────────────────────────────────────┤
  │  前台首页   ${base}/
  │  回忆墙     ${base}/wall.html
  │  后台监控   ${base}/admin.html
  │  数据文件   ${config.DB_FILE}
  └──────────────────────────────────────────────┘`);
  if (config.generatedAdminPassword) {
    console.log(`  后台管理密码：${config.ADMIN_PASSWORD}   （已保存在 data/.admin-password，可在 .env 里改）\n`);
  }
});

// 定时清理过期会话
setInterval(auth.pruneSessions, 30 * 60 * 1000).unref();

function shutdown(signal) {
  console.log(`\n收到 ${signal}，正在保存数据…`);
  store.flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  store.flush();
});
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));

module.exports = app;