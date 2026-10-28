'use strict';
/**
 * 后台接口：只有站长（管理员密码登录）能访问。
 * 包含：实时访客监控、登录记录、内容审核、封禁、导入、导出、站点设置。
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const config = require('../config');
const { store, newId, normalizeContact, normalizeBrand } = require('../store');
const auth = require('../auth');
const pwd = require('../pwd');
const { rateLimit, gradeLabel, checkSensitive } = require('../tracker');
const importer = require('../importer');
const docx = require('../docx');
const { commitEntries, createDocPost } = require('../commit');
const docs = require('../documents');

const router = express.Router();

/**
 * 站长自己导入文件：也走磁盘（默认 2.5GB），解析完立刻删掉临时文件。
 * 上传的那一份会记进 files 表，出现在「监控中心 → 上传文件」里，和校友分享混排。
 */
const importUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, docs.DOC_DIR),
    filename: (req, file, cb) => {
      const ext = importer.extOf(file.originalname) || '.bin';
      cb(null, `admin-${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: config.MAX_IMPORT_UPLOAD_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = importer.extOf(file.originalname);
    if (!docs.ALLOWED_EXT.includes(ext)) {
      const err = new Error(`不支持 ${ext || '这种'} 文件。可以传 .docx / .txt / .md / .csv / .html`);
      err.code = 'BAD_EXT';
      return cb(err);
    }
    cb(null, true);
  },
});

/* ------------------------------ 登录 ------------------------------ */
router.post('/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 8, key: 'admin-login' }), async (req, res) => {
  const pwdInput = String(req.body.password || '');
  if (!(await auth.checkAdminPassword(pwdInput))) {
    store.addEvent('admin-login-fail', { ip: req.clientIp }, req);
    return res.status(401).json({ error: '密码不正确' });
  }
  auth.createSession(req, res, { role: 'admin', uid: 'admin', ip: req.clientIp, ua: req.headers['user-agent'] });
  store.addEvent('admin-login', {}, req);
  res.json({ ok: true, siteTitle: store.data.settings.siteTitle });
});

router.post('/logout', (req, res) => {
  auth.destroySession(req, res, 'admin');
  res.json({ ok: true });
});

router.get('/ping', auth.requireAdmin, (req, res) => res.json({ ok: true }));

/* 之后所有接口都要求管理员身份 */
router.use(auth.requireAdmin);

/* ------------------------------ 概览 ------------------------------ */
router.get('/overview', (req, res) => {
  const now = Date.now();
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const t0 = dayStart.getTime();
  const visits = store.data.visits;

  const inWindow = (ms) => visits.filter((v) => now - v.ts <= ms);
  const today = visits.filter((v) => v.ts >= t0);

  // 近 5 分钟有活动的独立会话/IP = 当前在线
  const onlineKeys = new Set();
  for (const v of inWindow(config.ONLINE_WINDOW_MS)) onlineKeys.add(v.uid || v.ip);

  // 24 小时按小时分桶
  const hourBuckets = new Array(24).fill(0);
  for (const v of inWindow(24 * 3600 * 1000)) {
    const h = Math.floor((now - v.ts) / 3600000);
    if (h >= 0 && h < 24) hourBuckets[23 - h] += 1;
  }

  // 访问最多的页面
  const pathCount = {};
  for (const v of today) pathCount[v.path] = (pathCount[v.path] || 0) + 1;
  const topPaths = Object.entries(pathCount)
    .map(([path, count]) => ({ path, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  // 可疑行为：今天请求过多 / 4xx 过多
  const riskMap = {};
  for (const v of today) {
    const k = v.ip;
    riskMap[k] = riskMap[k] || { ip: k, total: 0, bad: 0, last: 0, who: v.who };
    riskMap[k].total++;
    if (v.status >= 400) riskMap[k].bad++;
    riskMap[k].last = Math.max(riskMap[k].last, v.ts);
    if (v.who) riskMap[k].who = v.who;
  }
  const suspicious = Object.values(riskMap)
    .filter((r) => r.total > 150 || r.bad > 30)
    .sort((a, b) => b.total - a.total)
    .slice(0, 10)
    .map((r) => ({ ...r, banned: store.isBanned(r.ip) }));

  const recentEvents = store.data.events.slice(-40).reverse();

  res.json({
    onlineNow: onlineKeys.size,
    today: {
      pv: today.length,
      uv: new Set(today.map((v) => v.uid || v.ip)).size,
      logins: store.data.events.filter((e) => e.type === 'login' && e.ts >= t0).length,
      newUsers: store.data.users.filter((u) => u.createdAt >= t0).length,
      postsCreated: store.data.posts.filter((p) => p.createdAt >= t0).length,
    },
    total: {
      users: store.data.users.length,
      posts: store.data.posts.length,
      hiddenPosts: store.data.posts.filter((p) => p.hidden).length,
      comments: store.data.comments.length,
      visits: visits.length,
      bans: store.data.bans.length,
    },
    hourBuckets,
    topPaths,
    suspicious,
    recentEvents,
    retention: {
      maxVisits: config.MAX_VISITS,
      oldestVisit: visits.length ? visits[0].ts : null,
    },
    serverTime: now,
  });
});

/* ------------------------------ 实时访问流 ------------------------------ */
router.get('/visits', (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const since = Number(req.query.since) || 0;
  const onlyBad = req.query.bad === '1';
  let list = store.data.visits;
  if (since) list = list.filter((v) => v.ts > since);
  if (onlyBad) list = list.filter((v) => v.status >= 400);
  const items = list.slice(-limit).reverse();
  res.json({ items, serverTime: Date.now() });
});

/* ------------------------------ 访客档案 ------------------------------ */
router.get('/visitors', (req, res) => {
  const users = store.data.users
    .slice()
    .sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0))
    .map((u) => ({
      id: u.id,
      label: `${gradeLabel(u.year)}${u.className ? u.className + '班' : ''}${u.name}`,
      year: u.year,
      className: u.className,
      name: u.name,
      createdAt: u.createdAt,
      lastSeenAt: u.lastSeenAt,
      loginCount: u.loginCount || 0,
      loginIp: u.loginIp || '',
      ips: u.ips || [],
      postCount: store.data.posts.filter((p) => p.uid === u.id).length,
      commentCount: store.data.comments.filter((c) => c.uid === u.id).length,
      online: Date.now() - (u.lastSeenAt || 0) < config.ONLINE_WINDOW_MS,
    }));
  res.json({ items: users });
});

/* ------------------------------ 删掉一个访客 ------------------------------ */
// DELETE /api/admin/visitors/:uid?content=keep|delete
// keep（默认）：只删档案、会话和访问记录，他发过的回忆保留（作者显示为已注销）
// delete：连他发过的回忆、评论、上传的文件一起删
router.delete('/visitors/:uid', (req, res) => {
  const uid = String(req.params.uid || '');
  const user = store.getUser(uid);
  if (!user) return res.status(404).json({ error: '没找到这个校友' });
  const mode = String(req.query.content || 'keep') === 'delete' ? 'delete' : 'keep';
  const label = `${gradeLabel(user.year)}${user.className ? user.className + '班' : ''}${user.name}`;

  const sessions = store.dropSessionsOf(uid);

  const vBefore = store.data.visits.length;
  store.data.visits = store.data.visits.filter((v) => v.uid !== uid);
  const visitsDeleted = vBefore - store.data.visits.length;

  store.data.users = store.data.users.filter((u) => u.id !== uid);

  let postsDeleted = 0;
  let commentsDeleted = 0;
  let filesDeleted = 0;
  const postIds = new Set(store.data.posts.filter((p) => p.uid === uid).map((p) => p.id));
  const fileIds = new Set(store.data.files.filter((f) => f.uploaderId === uid).map((f) => f.id));

  if (mode === 'delete') {
    postsDeleted = store.data.posts.filter((p) => p.uid === uid).length;
    store.data.posts = store.data.posts.filter((p) => {
      if (p.uid !== uid) return true;
      if (p.docId) docx.removePostDir(p.id);
      return false;
    });
    const cBefore = store.data.comments.length;
    store.data.comments = store.data.comments.filter((c) => c.uid !== uid && !postIds.has(c.postId));
    commentsDeleted = cBefore - store.data.comments.length;
    filesDeleted = store.data.files.filter((f) => f.uploaderId === uid).length;
    store.data.files = store.data.files.filter((f) => f.uploaderId !== uid);
  } else {
    // 保留内容：把作者挂空，别在墙上显示成一串内部 ID
    store.data.posts.forEach((p) => {
      if (p.uid === uid) { p.uid = null; p.authorDeleted = true; }
    });
    store.data.comments.forEach((c) => {
      if (c.uid === uid) { c.uid = null; c.authorDeleted = true; }
    });
    store.data.files.forEach((f) => {
      if (f.uploaderId === uid) { f.uploaderId = null; f.uploaderLabel = '（已注销）'; }
    });
  }

  store.addEvent('visitor-delete', {
    uid, label, mode, visits: visitsDeleted, posts: postsDeleted, comments: commentsDeleted, files: filesDeleted, sessions,
  }, req);
  store.touch();

  res.json({
    ok: true,
    label,
    mode,
    removed: { visits: visitsDeleted, posts: postsDeleted, comments: commentsDeleted, files: filesDeleted, sessions },
  });
});

/* ------------------------------ 登录记录 ------------------------------ */
router.get('/logins', (req, res) => {
  const items = store.data.events
    .filter((e) => e.type === 'login' || e.type === 'admin-login' || e.type === 'admin-login-fail')
    .slice(-300)
    .reverse()
    .map((e) => ({ ts: e.ts, type: e.type, who: e.detail && e.detail.who, ip: e.ip, ua: e.ua }));
  res.json({ items });
});

/* ------------------------------ 内容管理 ------------------------------ */
router.get('/posts', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  let list = store.data.posts.slice().sort((a, b) => b.createdAt - a.createdAt);
  if (q) list = list.filter((p) => `${p.title} ${p.content} ${p.authorName}`.toLowerCase().includes(q));
  if (req.query.hidden === '1') list = list.filter((p) => p.hidden);
  const items = list.slice(0, 500).map((p) => ({
    id: p.id,
    title: p.title,
    content: p.content,
    authorLabel: `${gradeLabel(p.authorYear)}${p.authorClass ? p.authorClass + '班' : ''}${p.authorName}`,
    images: p.images || [],
    hidden: !!p.hidden,
    pendingReview: !!p.pendingReview,
    pinned: !!p.pinned,
    likeCount: (p.likes || []).length,
    commentCount: store.data.comments.filter((c) => c.postId === p.id).length,
    createdAt: p.createdAt,
    ip: p.ip || '',
  }));
  res.json({ items });
});

router.patch('/posts/:id', (req, res) => {
  const post = store.data.posts.find((p) => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: '不存在' });
  if (req.body.hidden !== undefined) {
    post.hidden = !!req.body.hidden;
    if (!post.hidden) post.pendingReview = false;
  }
  if (req.body.pinned !== undefined) post.pinned = !!req.body.pinned;
  if (req.body.title !== undefined) post.title = String(req.body.title).slice(0, 60);
  if (req.body.content !== undefined) post.content = String(req.body.content).slice(0, config.MAX_POST_CHARS);
  post.updatedAt = Date.now();
  store.addEvent('admin-post-update', { postId: post.id, hidden: post.hidden, pinned: post.pinned }, req);
  store.touch();
  res.json({ ok: true });
});

router.delete('/posts/:id', (req, res) => {
  const idx = store.data.posts.findIndex((p) => p.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '不存在' });
  const [post] = store.data.posts.splice(idx, 1);
  store.data.comments = store.data.comments.filter((c) => c.postId !== post.id);
  store.addEvent('admin-post-delete', { postId: post.id, title: post.title, author: post.authorName }, req);
  store.touch();
  res.json({ ok: true });
});

router.get('/comments', (req, res) => {
  const items = store.data.comments
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 500)
    .map((c) => ({
      id: c.id,
      postId: c.postId,
      content: c.content,
      authorLabel: `${gradeLabel(c.authorYear)}${c.authorClass ? c.authorClass + '班' : ''}${c.authorName}`,
      hidden: !!c.hidden,
      createdAt: c.createdAt,
      ip: c.ip || '',
    }));
  res.json({ items });
});

router.patch('/comments/:id', (req, res) => {
  const c = store.data.comments.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '不存在' });
  if (req.body.hidden !== undefined) c.hidden = !!req.body.hidden;
  store.addEvent('admin-comment-update', { commentId: c.id, hidden: c.hidden }, req);
  store.touch();
  res.json({ ok: true });
});

router.delete('/comments/:id', (req, res) => {
  const idx = store.data.comments.findIndex((x) => x.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '不存在' });
  const [c] = store.data.comments.splice(idx, 1);
  store.addEvent('admin-comment-delete', { commentId: c.id }, req);
  store.touch();
  res.json({ ok: true });
});

/* ------------------------------ 封禁 ------------------------------ */
router.get('/bans', (req, res) => res.json({ items: store.data.bans }));

// IPv4 或 IPv6（允许 ::1 这类写法）
const IP_RE = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}|[0-9a-fA-F:]{2,45})$/;

router.post('/bans', (req, res) => {
  const ip = String(req.body.ip || '').trim().slice(0, 60);
  const reason = String(req.body.reason || '').trim().slice(0, 120);
  if (!ip) return res.status(400).json({ error: '请填写要封禁的 IP' });
  if (!IP_RE.test(ip)) return res.status(400).json({ error: '这个 IP 格式不对，请填 192.168.1.10 这样的地址' });
  if (store.isBanned(ip)) return res.json({ ok: true, already: true });
  store.data.bans.push({ ip, reason, ts: Date.now() });
  store.addEvent('ban-add', { ip, reason }, req);
  store.touch();
  res.json({ ok: true });
});

router.delete('/bans/:ip', (req, res) => {
  const ip = decodeURIComponent(req.params.ip);
  const before = store.data.bans.length;
  store.data.bans = store.data.bans.filter((b) => b.ip !== ip);
  store.addEvent('ban-remove', { ip }, req);
  store.touch();
  res.json({ ok: true, removed: before - store.data.bans.length });
});

/* ------------------------------ 密码管控 ------------------------------ */
/** 后台账号表里的一行（绝不返回密码哈希） */
function accountRow(u) {
  const now = Date.now();
  const locked = !!(u.lockedUntil && u.lockedUntil > now);
  return {
    id: u.id,
    year: u.year,
    className: u.className || '',
    name: u.name || '',
    label: `${gradeLabel(u.year)}${u.className ? u.className + '班' : ''}${u.name || ''}`,
    hasPassword: !!u.pwd,
    pwdLength: u.pwdLen || 0,
    strength: pwd.strengthLabel(u.pwdLen || 0),
    pwdUpdatedAt: u.pwdUpdatedAt || null,
    pwdResetCount: u.pwdResetCount || 0,
    mustChange: !!u.mustChange,
    disabled: !!u.disabled,
    failCount: u.failCount || 0,
    locked,
    lockedUntil: locked ? u.lockedUntil : null,
    loginCount: u.loginCount || 0,
    lastLoginAt: u.lastLoginAt || u.lastSeenAt || 0,
    lastLoginIp: u.loginIp || '',
    createdAt: u.createdAt || 0,
    imported: !!u.imported,
    online: now - (u.lastSeenAt || 0) < config.ONLINE_WINDOW_MS,
    postCount: store.data.posts.filter((p) => p.uid === u.id).length,
    commentCount: store.data.comments.filter((c) => c.uid === u.id).length,
  };
}

router.get('/accounts', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase();
  const status = String(req.query.status || '');
  const now = Date.now();
  let list = store.data.users.slice();

  if (q) {
    list = list.filter((u) =>
      `${u.year} ${u.className || ''} ${u.name || ''} ${u.loginIp || ''}`.toLowerCase().includes(q)
    );
  }
  if (status === 'nopwd') list = list.filter((u) => !u.pwd);
  if (status === 'locked') list = list.filter((u) => u.lockedUntil && u.lockedUntil > now);
  if (status === 'mustchange') list = list.filter((u) => !!u.mustChange);
  if (status === 'weak') list = list.filter((u) => u.pwd && (u.pwdLen || 0) < 6);
  if (status === 'fail') list = list.filter((u) => (u.failCount || 0) > 0);

  list.sort((a, b) => (b.lastLoginAt || b.lastSeenAt || 0) - (a.lastLoginAt || a.lastSeenAt || 0));

  const all = store.data.users;
  res.json({
    items: list.slice(0, 1000).map(accountRow),
    total: list.length,
    stats: {
      users: all.length,
      withPwd: all.filter((u) => !!u.pwd).length,
      noPwd: all.filter((u) => !u.pwd).length,
      weak: all.filter((u) => u.pwd && (u.pwdLen || 0) < 6).length,
      locked: all.filter((u) => u.lockedUntil && u.lockedUntil > now).length,
      mustChange: all.filter((u) => !!u.mustChange).length,
      disabled: all.filter((u) => !!u.disabled).length,
      failNow: all.filter((u) => (u.failCount || 0) > 0).length,
    },
    policy: store.passwordPolicy(),
    serverTime: now,
  });
});

/** 重置某个校友的密码（不填就自动生成临时密码，只在这一个响应里出现一次） */
router.post('/accounts/:id/password', async (req, res) => {
  const u = store.getUser(req.params.id);
  if (!u) return res.status(404).json({ error: '账号不存在' });

  const policy = store.passwordPolicy();
  const given = req.body.password == null ? '' : String(req.body.password);
  const wantLen = Math.max(policy.minLength, Math.min(policy.maxLength, Number(req.body.length) || 8));
  const plain = given || pwd.generate(wantLen);
  const bad = pwd.checkLength(plain, policy);
  if (bad) return res.status(400).json({ error: bad });

  const force = req.body.forceChange === undefined ? policy.forceChangeOnReset : !!req.body.forceChange;
  u.pwd = await pwd.hash(plain);
  u.pwdLen = plain.length;
  u.pwdUpdatedAt = Date.now();
  u.pwdVersion = (u.pwdVersion || 1) + 1;
  u.mustChange = force;
  u.failCount = 0;
  u.lockedUntil = 0;
  u.pwdResetCount = (u.pwdResetCount || 0) + 1;
  const kicked = store.dropSessionsOf(u.id);
  const row = accountRow(u);
  store.addEvent('pwd-reset', { uid: u.id, who: row.label, generated: !given, force, kicked }, req);
  store.touch();
  res.json({ ok: true, password: plain, generated: !given, forceChange: force, kicked, account: row });
});

/** 锁定（可指定分钟数，0 = 无限期） */
router.post('/accounts/:id/lock', (req, res) => {
  const u = store.getUser(req.params.id);
  if (!u) return res.status(404).json({ error: '账号不存在' });
  const policy = store.passwordPolicy();
  const minutes = req.body.minutes === undefined ? policy.lockMinutes : Math.max(0, Number(req.body.minutes) || 0);
  u.lockedUntil = minutes > 0 ? Date.now() + minutes * 60000 : Date.now() + 100 * 365 * 86400000;
  u.failCount = 0;
  const kicked = store.dropSessionsOf(u.id);
  const row = accountRow(u);
  store.addEvent('account-lock', { uid: u.id, who: row.label, minutes, byAdmin: true, kicked }, req);
  store.touch();
  res.json({ ok: true, account: row, kicked });
});

router.post('/accounts/:id/unlock', (req, res) => {
  const u = store.getUser(req.params.id);
  if (!u) return res.status(404).json({ error: '账号不存在' });
  u.lockedUntil = 0;
  u.failCount = 0;
  store.addEvent('account-unlock', { uid: u.id }, req);
  store.touch();
  res.json({ ok: true, account: accountRow(u) });
});

/** 要求下次登录必须改密码 */
router.post('/accounts/:id/must-change', (req, res) => {
  const u = store.getUser(req.params.id);
  if (!u) return res.status(404).json({ error: '账号不存在' });
  u.mustChange = req.body.mustChange === undefined ? true : !!req.body.mustChange;
  store.addEvent('account-must-change', { uid: u.id, mustChange: u.mustChange }, req);
  store.touch();
  res.json({ ok: true, account: accountRow(u) });
});

/** 停用 / 恢复账号（停用后不能登录，已登录的也会掉线） */
router.post('/accounts/:id/disabled', (req, res) => {
  const u = store.getUser(req.params.id);
  if (!u) return res.status(404).json({ error: '账号不存在' });
  u.disabled = req.body.disabled === undefined ? true : !!req.body.disabled;
  const kicked = u.disabled ? store.dropSessionsOf(u.id) : 0;
  store.addEvent(u.disabled ? 'account-disable' : 'account-enable', { uid: u.id }, req);
  store.touch();
  res.json({ ok: true, account: accountRow(u), kicked });
});

/** 把人踢下线 */
router.delete('/accounts/:id/sessions', (req, res) => {
  const u = store.getUser(req.params.id);
  if (!u) return res.status(404).json({ error: '账号不存在' });
  const kicked = store.dropSessionsOf(u.id);
  store.addEvent('account-kick', { uid: u.id, kicked }, req);
  res.json({ ok: true, kicked });
});

/** 密码策略 */
router.get('/password/policy', (req, res) => {
  res.json({ policy: store.passwordPolicy(), adminCustom: !!store.data.settings.adminPwd });
});

router.post('/password/policy', (req, res) => {
  const b = req.body || {};
  store.data.settings.passwordPolicy = pwd.normalizePolicy({ ...store.passwordPolicy(), ...b });
  store.addEvent('admin-pwd-policy', store.data.settings.passwordPolicy, req);
  store.touch();
  res.json({ ok: true, policy: store.passwordPolicy() });
});

/** 密码相关日志 */
router.get('/password/logs', (req, res) => {
  const TYPES = new Set(['pwd-reset', 'pwd-change', 'pwd-setup', 'login-fail', 'account-lock', 'account-unlock', 'admin-password', 'admin-pwd-policy']);
  const items = store.data.events
    .filter((e) => TYPES.has(e.type))
    .slice(-300)
    .reverse()
    .map((e) => ({
      ts: e.ts,
      type: e.type,
      who: (e.detail && e.detail.who) || '',
      detail: e.detail || {},
      ip: e.ip || '',
    }));
  res.json({ items });
});

/** 站长改自己的后台密码 */
router.get('/password/self', (req, res) => {
  res.json({ custom: !!store.data.settings.adminPwd, updatedAt: (store.data.settings.adminPwd || {}).updatedAt || null });
});

router.post('/password/self', async (req, res) => {
  const current = String(req.body.currentPassword || '');
  if (!(await auth.checkAdminPassword(current))) {
    store.addEvent('admin-login-fail', { reason: 'change-admin-password' }, req);
    return res.status(401).json({ error: '当前的后台密码不对' });
  }
  // 恢复成 .env 里那个密码
  if (req.body.useEnv) {
    await auth.setAdminPassword('');
    store.addEvent('admin-password', { custom: false }, req);
    return res.json({ ok: true, custom: false });
  }
  const next = String(req.body.newPassword || '');
  const again = req.body.newPassword2;
  if (again !== undefined && String(again) !== next) {
    return res.status(400).json({ error: '两次输入的新密码不一样' });
  }
  if (next.length < 6) return res.status(400).json({ error: '后台密码至少 6 位（这是站长的最高权限，别设太简单）' });
  if (next.length > 72) return res.status(400).json({ error: '后台密码最多 72 位' });
  await auth.setAdminPassword(next);
  // 其它设备上的后台会话全部作废
  const keepSid = req.adminSession && req.adminSession.sid;
  for (const [sid, s] of Object.entries(store.data.sessions)) {
    if (s.role === 'admin' && sid !== keepSid) delete store.data.sessions[sid];
  }
  store.addEvent('admin-password', { custom: true }, req);
  store.touch();
  res.json({ ok: true, custom: true });
});

/* ------------------------------ 站点设置 ------------------------------ */
router.get('/settings', (req, res) => {
  const { adminPwd, ...rest } = store.data.settings;
  res.json({ settings: rest, adminCustom: !!adminPwd });
});

router.post('/settings', (req, res) => {
  const s = store.data.settings;
  const b = req.body || {};
  // 站名三件套：学校名称 / 登录页英文小字 / 站点全称（留空自动「学校名称 + 回忆录」）
  if (b.schoolName !== undefined) s.schoolName = String(b.schoolName).trim().slice(0, 20);
  if (b.schoolEn !== undefined) s.schoolEn = String(b.schoolEn).trim().slice(0, 60);
  if (b.siteTitle !== undefined) s.siteTitle = String(b.siteTitle).trim().slice(0, 40);
  normalizeBrand(s);
  if (b.notice !== undefined) s.notice = String(b.notice).slice(0, 300);
  if (b.registrationOpen !== undefined) s.registrationOpen = !!b.registrationOpen;
  if (b.reviewFirstPost !== undefined) s.reviewFirstPost = !!b.reviewFirstPost;
  if (b.sensitiveWords !== undefined) {
    s.sensitiveWords = (Array.isArray(b.sensitiveWords) ? b.sensitiveWords : String(b.sensitiveWords).split(/[,，\s]+/))
      .map((w) => String(w).trim())
      .filter(Boolean)
      .slice(0, 200);
  }
  if (b.contact !== undefined) {
    // 允许只提交改动的字段：和现有值合并后再清洗
    s.contact = normalizeContact(Object.assign({}, s.contact, b.contact || {}));
  }
  store.addEvent('admin-settings', {}, req);
  store.touch();
  const { adminPwd, ...rest } = s;
  res.json({ settings: rest, adminCustom: !!adminPwd });
});

/* ------------------------------ 导入：链接 ------------------------------ */
router.post('/import/url', rateLimit({ windowMs: 5 * 60 * 1000, max: 10, key: 'import-url' }), async (req, res) => {
  const url = String(req.body.url || '').trim();
  if (!url) return res.status(400).json({ error: '请填写金山文档分享链接' });
  try {
    const r = await importer.fetchSharedDoc(url);
    // 抓回来的可能只是登录页 / 空壳页面
    if (r.text.trim().length < 30) {
      return res.status(400).json({
        error: '这个链接没有抓到正文（大概需要登录才能看，或者不是公开分享的文档）',
        hint: '推荐做法：在金山文档里【文件 → 下载/导出为 Word(.docx)】，再用「文件导入」。',
      });
    }
    const entries = importer.parseEntries(r.text, r.title);
    store.addEvent('import-url', { url: url.slice(0, 200), format: r.format, entries: entries.length }, req);
    res.json({
      format: r.format,
      title: r.title,
      rawLength: r.text.length,
      rawPreview: r.text.slice(0, 4000),
      entries,
    });
  } catch (err) {
    res.status(400).json({
      error: err.message,
      hint: '金山文档的分享页常常需要登录才能读到正文。推荐做法：在金山文档里【文件 → 下载/导出为 Word(.docx) 或 纯文本(.txt)】，再用"文件导入"。',
    });
  }
});

/* ------------------------------ 导入：上限信息（前端显示用） ------------------------------ */
router.get('/import/limits', (req, res) => {
  const mb = config.MAX_IMPORT_UPLOAD_MB;
  const label = mb >= 1024
    ? `${Number((mb / 1024).toFixed(2))}GB（${mb}MB）`
    : `${mb}MB`;
  res.json({
    maxImportMb: mb,
    maxImportGb: Number((mb / 1024).toFixed(2)),
    maxImportLabel: label,
    maxUploadMb: config.MAX_UPLOAD_MB,
    formats: docs.ALLOWED_EXT,
    maxEntries: config.MAX_IMPORT_ENTRIES,
  });
});

/* ------------------------------ 导入：文件（站长大文件，默认 2.5GB） ------------------------------ */
router.post('/import/file', (req, res) => {
  importUpload.single('file')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        const gb = config.MAX_IMPORT_UPLOAD_MB / 1024;
        return res.status(413).json({
          error:
            `文件太大，单个文件上限 ${config.MAX_IMPORT_UPLOAD_MB}MB` +
            (gb >= 1 ? `（约 ${gb % 1 === 0 ? gb : gb.toFixed(1)}GB）` : ''),
        });
      }
      return res.status(400).json({ error: err.message || '上传失败' });
    }
    if (!req.file) return res.status(400).json({ error: '没有收到文件' });

    const name = docs.safeName(req.file.originalname);
    const cleanup = () => { try { fs.unlinkSync(req.file.path); } catch (_) {} };
    try {
      const r = await importer.parseFile(req.file.path, name, '');
      if (!r.entries.length) {
        cleanup();
        store.addFile({
          id: newId(), kind: 'admin-import', name, size: req.file.size,
          ext: importer.extOf(name), mime: req.file.mimetype, ts: Date.now(),
          uploaderId: 'admin', uploaderLabel: '站长', ip: req.clientIp,
          ua: String(req.headers['user-agent'] || '').slice(0, 200),
          status: 'failed', entries: 0, chars: r.chars, preview: '',
          sensitive: [], note: '没解析出内容',
        });
        return res.status(400).json({ error: '这个文件里没有读到文字。如果它是扫描件或图片版 PDF，请先转成文字或直接粘贴内容。' });
      }

      const hits = docs.scanSensitive(r.preview);
      const rec = {
        id: newId(), kind: 'admin-import', name, size: req.file.size,
        ext: importer.extOf(name), mime: req.file.mimetype, ts: Date.now(),
        uploaderId: 'admin', uploaderLabel: '站长', ip: req.clientIp,
        ua: String(req.headers['user-agent'] || '').slice(0, 200),
        status: 'imported', entries: r.entries.length, chars: r.chars,
        truncated: !!r.truncated, preview: String(r.preview || '').slice(0, 2000),
        sensitive: hits, note: '站长自己导入',
      };
      store.addFile(rec);

      store.addEvent('import-file', { name, format: r.format, entries: r.entries.length, size: req.file.size }, req);
      res.json({
        format: r.format,
        filename: name,
        fileId: rec.id,
        size: rec.size,
        rawLength: r.chars,
        rawPreview: String(r.preview || '').slice(0, 4000),
        truncated: !!r.truncated,
        entries: r.entries,
      });
    } catch (e) {
      res.status(400).json({ error: e.message });
    } finally {
      cleanup();
    }
  });
});

/* ------------------------------ 导入：整篇文档当一条回忆 ------------------------------ */
/**
 * 和「按署名拆成多条」完全不同的一条路：
 *   - 整份文档 = 一条回忆，段落/标题/表格顺序保留，照片按原位置插进去
 *   - 照片落到 uploads/posts/<回忆id>/，正文 HTML 也落盘（db.json 只存摘要）
 *   - 只有 .docx 能保留图文；.txt/.md/.html/.csv 就当纯文本整篇发一条
 */
router.post('/import/doc', (req, res) => {
  importUpload.single('file')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        const gb = config.MAX_IMPORT_UPLOAD_MB / 1024;
        return res.status(413).json({
          error:
            `文件太大，单个文件上限 ${config.MAX_IMPORT_UPLOAD_MB}MB` +
            (gb >= 1 ? `（约 ${gb % 1 === 0 ? gb : gb.toFixed(1)}GB）` : ''),
        });
      }
      return res.status(400).json({ error: err.message || '上传失败' });
    }
    if (!req.file) return res.status(400).json({ error: '没有收到文件' });

    const name = docs.safeName(req.file.originalname);
    const ext = importer.extOf(name);
    const dropUpload = () => { try { fs.unlinkSync(req.file.path); } catch (_) {} };
    let postId = null;
    try {
      let html = '';
      let text = '';
      let imageCount = 0;
      let usedBytes = 0;
      let cover = '';
      let truncated = false;
      let format = ext.replace(/^\./, '');

      if (ext === '.docx') {
        // 先定下回忆 id，照片和正文直接落到这个 id 的目录里，省掉改名和地址替换
        postId = newId();
        const dir = path.join(config.UPLOAD_DIR, 'posts', postId);
        const url = `/uploads/posts/${postId}`;
        try {
          const r = await docx.convertDocx(req.file.path, dir, url);
          html = r.html;
          text = r.text;
          imageCount = r.imageCount;
          usedBytes = r.imageBytes || 0;
          truncated = r.truncated;
          cover = r.images.length ? r.images[0].url : '';
        } catch (e) {
          docx.removePostDir(postId);
          postId = null;
          throw e;
        }
        const yearFromName = (String(name).match(/((?:19|20)\d{2})/) || [])[1];
        const title = String(req.body.title || '').trim() || name.replace(/\.[^.]+$/, '');
        // 署名只是「谁」那一段，级别由 authorYear 自己渲染成「23级」，
        // 所以这里别再写「2023级合集」，否则会变成「23级2023级合集」
        const authorName = String(req.body.author || '').trim() || '合集';
        const authorYear = Number(req.body.year) || (yearFromName ? Number(yearFromName) : null);

        createDocPost({
          id: postId,
          title,
          authorYear,
          authorClass: '',
          authorName,
          text,
          html,
          docName: name,
          docSize: req.file.size,
          imageCount,
          imageBytes: usedBytes,
          cover,
          ip: req.clientIp,
        });
        format = 'docx（整篇）';
      } else {
        const r = await importer.parseFile(req.file.path, name, '');
        text = String(r.entries.map((e) => e.content).join('\n\n') || r.rawPreview || '');
        if (!text.trim()) throw new Error('这个文件里没有读到文字，先转成文字再导入吧');
        html = docx.textToHtml(text);
        truncated = !!r.truncated;
        const yearFromName = (String(name).match(/((?:19|20)\d{2})/) || [])[1];
        const out = createDocPost({
          title: String(req.body.title || '').trim() || name.replace(/\.[^.]+$/, ''),
          authorYear: Number(req.body.year) || (yearFromName ? Number(yearFromName) : null),
          authorClass: '',
          authorName: String(req.body.author || '').trim() || '合集',
          text,
          html,
          docName: name,
          docSize: req.file.size,
          imageCount: 0,
          cover: '',
          ip: req.clientIp,
        });
        postId = out.post.id;
        postId = out.post.id;
      }

      const rec = {
        id: newId(), kind: 'post-doc', name, size: req.file.size,
        ext, mime: req.file.mimetype, ts: Date.now(),
        uploaderId: 'admin', uploaderLabel: '站长', ip: req.clientIp,
        ua: String(req.headers['user-agent'] || '').slice(0, 200),
        status: 'published', postId,
        entries: 1, chars: text.length,
        truncated: !!truncated, preview: text.slice(0, 2000),
        sensitive: docs.scanSensitive(text.slice(0, 4000)),
        note: '站长整篇导入',
      };
      store.addFile(rec);
      // 让回忆记住是哪份上传记录来的：将来在监控中心删记录时能连带删掉这条回忆
      const linked = postId ? store.data.posts.find((p) => p.id === postId) : null;
      if (linked) { linked.docId = rec.id; store.touch(); }
      store.addEvent('import-doc', { name, postId, images: imageCount, chars: text.length, size: req.file.size }, req);

      res.json({
        ok: true,
        postId,
        fileId: rec.id,
        format,
        filename: name,
        size: req.file.size,
        chars: text.length,
        imageCount,
        imageBytes: usedBytes,
        cover,
        truncated,
        title: String(req.body.title || '').trim() || name.replace(/\.[^.]+$/, ''),
        previewText: text.slice(0, 1500),
      });
    } catch (e) {
      // 半途失败的回忆连同照片一起撤掉，别在墙上留半条空白
      if (postId) {
        store.data.posts = store.data.posts.filter((p) => p.id !== postId);
        docx.removePostDir(postId);
        store.touch();
      }
      res.status(400).json({ error: e.message });
    } finally {
      dropUpload();
    }
  });
});

/* ------------------------------ 导入：粘贴文本 ------------------------------ */
router.post('/import/text', (req, res) => {
  const text = String(req.body.text || '');
  if (!text.trim()) return res.status(400).json({ error: '请粘贴要导入的内容' });
  const entries = importer.parseEntries(text, String(req.body.title || ''));
  store.addEvent('import-text', { entries: entries.length }, req);
  res.json({ rawLength: text.length, rawPreview: text.slice(0, 4000), entries });
});

/* ------------------------------ 导入：确认写入 ------------------------------ */
router.post('/import/commit', (req, res) => {
  const list = Array.isArray(req.body.entries) ? req.body.entries : [];
  if (!list.length) return res.status(400).json({ error: '没有可导入的条目' });
  if (list.length > 2000) return res.status(400).json({ error: '一次最多导入 2000 条' });

  const r = commitEntries(list, req.clientIp, { source: 'import' });
  store.addEvent('import-commit', { created: r.created, skipped: r.skipped, users: r.users }, req);
  res.json(r);
});

/* ------------------------------ 监控中心 ------------------------------ */
/**
 * 一个页面看两件事：
 *   1) 人 —— 谁在线、在哪些页面晃、最近干了什么（登录失败、发帖、被拦、被锁都算）
 *   2) 文件 —— 谁传了什么、多大、解析出多少条、有没有命中敏感词，点开能看内容
 * 前端每 5 秒轮询一次 /monitor。
 */
const STATUS_LABEL = {
  ready: '已上传未发布',
  published: '已发布上墙',
  imported: '站长已导入',
  failed: '解析失败',
};

/** 整篇模式的正文：uploads/posts/<postId>/text.txt（站长的「看内容」用它） */
function readPostText(postId) {
  try {
    const dir = path.join(config.UPLOAD_DIR, 'posts', String(postId).replace(/[^\w-]/g, ''));
    return fs.readFileSync(path.join(dir, 'text.txt'), 'utf8');
  } catch (_) {
    return '';
  }
}

function fileRow(f) {
  return {
    id: f.id,
    kind: f.kind,
    name: f.name,
    size: f.size || 0,
    ext: f.ext || '',
    ts: f.ts,
    status: f.status,
    statusText: STATUS_LABEL[f.status] || f.status,
    entries: f.entries || 0,
    chars: f.chars || 0,
    truncated: !!f.truncated,
    preview: f.preview || '',
    sensitive: f.sensitive || [],
    note: f.note || '',
    title: f.title || '',
    uploaderId: f.uploaderId || '',
    uploaderLabel: f.uploaderLabel || '',
    ip: f.ip || '',
    ua: f.ua || '',
    reviewedAt: f.reviewedAt || 0,
    reviewNote: f.reviewNote || '',
    hasFile: !!f.path,
    isText: !!f.text,
    created: f.created || 0,
    skipped: f.skipped || 0,
    flex: !!f.flex,
    postId: f.postId || '',
    imageCount: f.imageCount || 0,
    imageBytes: f.imageBytes || 0,
  };
}

const MONITOR_EVENT_TYPES = new Set([
  'login', 'login-fail', 'logout', 'register', 'pwd-setup', 'pwd-change', 'pwd-reset',
  'account-lock', 'account-unlock', 'post', 'post-delete', 'post-hide', 'comment',
  'doc-upload', 'doc-upload-fail', 'doc-publish', 'doc-delete',
  'import-file', 'import-url', 'import-commit', 'blocked-request', 'ban-add',
  'admin-login', 'admin-login-fail', 'admin-settings', 'visits-clear',
  'monitor-view-file', 'monitor-download-file', 'monitor-delete-file',
]);

router.get('/monitor', (req, res) => {
  const now = Date.now();
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const t0 = dayStart.getTime();
  const files = store.data.files;

  // 在线：近 5 分钟有访问的会话/IP
  const onlineMap = new Map();
  for (const v of store.data.visits) {
    if (now - v.ts > config.ONLINE_WINDOW_MS) continue;
    const key = v.uid || v.ip;
    let cur = onlineMap.get(key);
    if (!cur) {
      cur = {
        key,
        uid: v.uid || null,
        who: v.who || '未登录访客',
        ip: v.ip,
        device: v.device || 'desktop',
        hits: 0,
        lastAt: 0,
        paths: [],
      };
      onlineMap.set(key, cur);
    }
    cur.hits++;
    cur.lastAt = Math.max(cur.lastAt, v.ts);
    cur.ip = v.ip;
    cur.device = v.device || cur.device;
    if (v.path && cur.paths[cur.paths.length - 1] !== v.path) {
      cur.paths.push(v.path);
      if (cur.paths.length > 8) cur.paths.shift();
    }
  }
  const online = [...onlineMap.values()]
    .map((u) => ({
      ...u,
      lastLabel: u.lastAt ? new Date(u.lastAt).toLocaleTimeString('zh-CN', { hour12: false }) : '',
      postCount: u.uid ? store.data.posts.filter((p) => p.uid === u.uid).length : 0,
      banned: store.isBanned(u.ip),
    }))
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, 80);

  const stats = {
    online: online.length,
    onlineUsers: new Set(online.filter((u) => u.uid).map((u) => u.uid)).size,
    onlineGuests: online.filter((u) => !u.uid).length,
    pending: files.filter((f) => f.status === 'ready').length,
    docsToday: files.filter((f) => f.ts >= t0 && f.kind === 'post-doc').length,
    docsTotal: files.filter((f) => f.kind === 'post-doc').length,
    flagged: files.filter((f) => (f.sensitive || []).length).length,
    filesToday: files.filter((f) => f.ts >= t0).length,
    filesTotal: files.length,
    bytesTotal: files.reduce((s, f) => s + (f.size || 0), 0),
    loginsToday: store.data.events.filter((e) => e.type === 'login' && e.ts >= t0).length,
    failsToday: store.data.events.filter((e) => e.type === 'login-fail' && e.ts >= t0).length,
    blockedToday: store.data.events.filter((e) => e.type === 'blocked-request' && e.ts >= t0).length,
    bans: store.data.bans.length,
    maxUploadMb: config.MAX_UPLOAD_MB,
    maxImportMb: config.MAX_IMPORT_UPLOAD_MB,
  };

  const activity = store.data.events
    .filter((e) => MONITOR_EVENT_TYPES.has(e.type))
    .slice(-120)
    .reverse()
    .map((e) => ({
      ts: e.ts,
      type: e.type,
      detail: e.detail || {},
      ip: e.ip || '',
      uid: e.uid || '',
    }));

  res.json({ stats, online, activity, serverTime: now });
});

router.get('/monitor/files', (req, res) => {
  const status = String(req.query.status || '').trim();
  const q = String(req.query.q || '').trim().toLowerCase();
  let list = store.data.files;
  if (status) list = list.filter((f) => f.status === status);
  if (q) {
    list = list.filter((f) =>
      String(f.name || '').toLowerCase().includes(q) ||
      String(f.uploaderLabel || '').toLowerCase().includes(q) ||
      String(f.ip || '').includes(q) ||
      String(f.title || '').toLowerCase().includes(q)
    );
  }
  res.json({
    total: list.length,
    items: list.slice(0, 200).map(fileRow),
    serverTime: Date.now(),
  });
});

/** 看文件内容：文本类直接给原文；文件类现场按小批量重新解析几条，只读不写库 */
router.get('/monitor/files/:id', async (req, res) => {
  const f = store.getFile(req.params.id);
  if (!f) return res.status(404).json({ error: '没找到这个文件记录' });

  const out = fileRow(f);
  out.entriesSample = [];
  out.contentTruncated = false;

  try {
    // 站长「整篇导入」发出去的那条回忆：原文件已经删了，内容在回忆里
    const linkedPost = f.postId ? store.data.posts.find((p) => p.id === f.postId) : null;
    // 校友刚传、还没发布的文档：直接读解析好的草稿，省得重新解压一遍
    const draft = f.kind === 'post-doc' && f.status === 'ready' ? docs.readDraft(f.id) : null;
    // 整篇模式（带着照片的那份 .docx）：正文落在 uploads/posts/<id>/text.txt
    const flexText = !linkedPost && f.flex && f.postId ? readPostText(f.postId) : '';
    if (linkedPost) {
      out.postId = linkedPost.id;
      out.title = linkedPost.title || f.name;
      out.fullText = String(linkedPost.content || '').slice(0, 20000);
      out.contentTruncated = String(linkedPost.content || '').length > 20000;
      out.imageCount = linkedPost.imageCount || 0;
      out.fromPost = true;
    } else if (flexText) {
      // 校友传的整篇文档，还没点发布：正文 + 照片都还在，直接给他看
      out.entriesSample = [{
        author: f.uploaderLabel || '',
        title: f.title || f.name || '',
        content: flexText.slice(0, 500),
      }];
      out.fullText = flexText.slice(0, 20000);
      out.contentTruncated = flexText.length > 20000;
      out.imageCount = f.imageCount || 0;
      out.fromDraft = true;
      out.flexText = true;
    } else if (draft && draft.length) {
      out.entriesSample = draft.slice(0, 50);
      out.fullText = draft
        .map((e) => `${gradeLabel(e.year)}${e.className ? `${e.className}班` : ''}${e.name || '佚名'}${e.title ? ` · ${e.title}` : ''}\n${e.content || ''}`)
        .join('\n\n')
        .slice(0, 20000);
      out.contentTruncated = draft.length > 50;
      out.fromDraft = true;
    } else if (f.text) {
      out.entriesSample = importer.parseEntries(f.text, '').slice(0, 50);
      out.fullText = f.text.slice(0, 20000);
      out.contentTruncated = f.text.length > 20000;
    } else if (f.path) {
      const abs = path.join(config.UPLOAD_DIR, f.path);
      if (fs.existsSync(abs)) {
        out.fileExists = true;
        out.fileSize = fs.statSync(abs).size;
        // 超过 8MB 的文件不在详情里全量解析，避免点一下卡半分钟
        if (out.fileSize <= 8 * 1024 * 1024) {
          const r = await importer.parseFile(abs, f.name, '');
          out.entriesSample = r.entries.slice(0, 50);
          out.fullText = String(r.preview || '').slice(0, 20000);
        } else {
          out.contentTruncated = true;
          out.noteBig = '文件较大（>8MB），这里只展示上传时抽样的开头片段；要全文请用「下载原文件」。';
        }
      } else {
        out.fileExists = false;
      }
    }
  } catch (e) {
    out.parseError = e.message;
  }

  store.addEvent('monitor-view-file', { id: f.id, name: f.name }, req);
  res.json(out);
});

/** 下载原文件（站长自己看，不做任何转换） */
router.get('/monitor/files/:id/download', (req, res) => {
  const f = store.getFile(req.params.id);
  if (!f || !f.path) return res.status(404).json({ error: '这个记录没有可下载的原文件' });
  const abs = path.join(config.UPLOAD_DIR, f.path);
  if (!fs.existsSync(abs)) return res.status(404).json({ error: '原文件已经不在了（可能已被删除）' });
  store.addEvent('monitor-download-file', { id: f.id, name: f.name }, req);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name || 'file')}`);
  res.sendFile(abs);
});


/** 删掉一条记录（连带原文件，以及从这份文档发到墙上的回忆） */
router.delete('/monitor/files/:id', (req, res) => {
  const f = store.getFile(req.params.id);
  if (!f) return res.status(404).json({ error: '没找到这个文件记录' });
  // 先记下这条记录关联的回忆 id，删完把照片目录一起清掉，别在磁盘上留垃圾
  const linkedPostIds = store.data.posts
    .filter((p) => p.docId === f.id || p.id === f.postId)
    .map((p) => p.id);
  const removed = docs.removePublishedOf(f);
  for (const pid of linkedPostIds) docx.removePostDir(pid);
  if (f.path) { try { fs.unlinkSync(path.join(config.UPLOAD_DIR, f.path)); } catch (_) {} }
  store.removeFile(f.id);
  store.addEvent('monitor-delete-file', { id: f.id, name: f.name, posts: removed }, req);
  res.json({ ok: true, posts: removed });
});

/** 从监控页直接踢人下线 */
router.post('/monitor/users/:uid/kick', (req, res) => {
  const uid = String(req.params.uid || '');
  if (!store.getUser(uid)) return res.status(404).json({ error: '没找到这个校友' });
  const n = store.dropSessionsOf(uid);
  store.addEvent('admin-kick', { uid, sessions: n }, req);
  res.json({ ok: true, kicked: n });
});

/* ------------------------------ 导出 ------------------------------ */
function csvEscape(v) {
  const s = String(v == null ? '' : v).replace(/"/g, '""');
  return /[",\n]/.test(s) ? `"${s}"` : s;
}
function toCsv(headers, rows) {
  const head = headers.map(csvEscape).join(',');
  const body = rows.map((r) => r.map(csvEscape).join(',')).join('\n');
  return `\ufeff${head}\n${body}`; // BOM 让 Excel 正确识别中文
}

router.get('/export', (req, res) => {
  const type = String(req.query.type || 'visits');
  let csv = '';
  let name = '';
  if (type === 'users') {
    csv = toCsv(
      ['ID', '级别', '班级', '姓名', '登记时间', '最近活跃', '登录次数', 'IP列表', '回忆数', '评论数'],
      store.data.users.map((u) => [
        u.id, u.year, u.className, u.name,
        u.createdAt ? new Date(u.createdAt).toISOString() : '',
        u.lastSeenAt ? new Date(u.lastSeenAt).toISOString() : '',
        u.loginCount || 0, (u.ips || []).join(' '),
        store.data.posts.filter((p) => p.uid === u.id).length,
        store.data.comments.filter((c) => c.uid === u.id).length,
      ])
    );
    name = 'visitors';
  } else if (type === 'posts') {
    csv = toCsv(
      ['ID', '级别', '班级', '姓名', '标题', '内容', '点赞', '隐藏', '时间'],
      store.data.posts.map((p) => [
        p.id, p.authorYear, p.authorClass, p.authorName, p.title, p.content,
        (p.likes || []).length, p.hidden ? '是' : '否',
        new Date(p.createdAt).toISOString(),
      ])
    );
    name = 'posts';
  } else if (type === 'accounts') {
    const now = Date.now();
    csv = toCsv(
      ['ID', '级别', '班级', '姓名', '是否已设密码', '密码长度', '强度', '待改密', '锁定', '停用', '失败次数', '重置次数', '密码更新时间', '最近登录', '最近登录IP', '登录次数'],
      store.data.users.map((u) => {
        const locked = !!(u.lockedUntil && u.lockedUntil > now);
        return [
          u.id, u.year, u.className, u.name,
          u.pwd ? '是' : '否', u.pwdLen || 0, pwd.strengthLabel(u.pwdLen || 0),
          u.mustChange ? '是' : '否', locked ? '是' : '否', u.disabled ? '是' : '否',
          u.failCount || 0, u.pwdResetCount || 0,
          u.pwdUpdatedAt ? new Date(u.pwdUpdatedAt).toISOString() : '',
          u.lastLoginAt ? new Date(u.lastLoginAt).toISOString() : '',
          u.loginIp || '', u.loginCount || 0,
        ];
      })
    );
    name = 'accounts';
  } else if (type === 'events') {
    csv = toCsv(
      ['时间', '类型', '详情', 'IP', 'UA'],
      store.data.events.map((e) => [
        new Date(e.ts).toISOString(), e.type, JSON.stringify(e.detail || {}), e.ip || '', e.ua || '',
      ])
    );
    name = 'events';
  } else {
    csv = toCsv(
      ['时间', 'IP', '身份', '方式', '路径', '状态码', '耗时ms', '来源', '设备', 'UA'],
      store.data.visits.map((v) => [
        new Date(v.ts).toISOString(), v.ip, v.who || '访客', v.method, v.path,
        v.status, v.ms, v.referer || '', v.device || '', v.ua || '',
      ])
    );
    name = 'visits';
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

/* ------------------------------ 清空访问日志 ------------------------------ */
router.post('/visits/clear', (req, res) => {
  const n = store.data.visits.length;
  store.data.visits = [];
  store.addEvent('visits-clear', { removed: n }, req);
  store.touch();
  res.json({ ok: true, removed: n });
});

module.exports = router;
