'use strict';
/**
 * 前台接口：登记、回忆、点赞、评论、图片上传。
 */
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const config = require('../config');
const { store, newId } = require('../store');
const auth = require('../auth');
const pwd = require('../pwd');
const { parseWho } = require('../who');
const { rateLimit, checkSensitive, gradeLabel } = require('../tracker');
const { readDocBody } = require('../commit');

const router = express.Router();

const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

/* ------------------------------ 图片上传 ------------------------------ */
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, config.UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.jpg').toLowerCase().slice(0, 6);
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${/\.(jpe?g|png|gif|webp)$/.test(ext) ? ext : '.jpg'}`);
    },
  }),
  limits: { fileSize: config.MAX_IMAGE_MB * 1024 * 1024, files: 6 },
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(jpeg|png|gif|webp)$/.test(file.mimetype);
    cb(ok ? null : new Error('只支持 jpg / png / gif / webp 图片'), ok);
  },
});

/* ------------------------------ 工具 ------------------------------ */
function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    year: u.year,
    className: u.className,
    name: u.name,
    label: `${gradeLabel(u.year)}${u.className ? u.className + '班' : ''}${u.name}`,
    createdAt: u.createdAt,
    hasPassword: !!u.pwd,
    mustChange: !!u.mustChange,
    pwdLength: u.pwdLen || 0,
  };
}

function publicPost(p, viewerId, full = false) {
  const likes = p.likes || [];
  const isFlex = !!p.flex;
  return {
    id: p.id,
    uid: p.uid,
    author: {
      year: p.authorYear,
      className: p.authorClass,
      name: p.authorName,
      label: `${gradeLabel(p.authorYear)}${p.authorClass ? p.authorClass + '班' : ''}${p.authorName}`,
    },
    title: p.title,
    // 整篇文档的帖子：列表页只给前 300 字，正文 HTML 走详情接口，别把列表撑成几百 KB
    content: isFlex && !full ? String(p.content || '').slice(0, 300) : p.content,
    images: p.images || [],
    // 整篇模式（一份文档 = 一条回忆，含照片）
    flex: isFlex,
    hasBody: !!p.hasBody,
    cover: p.cover || '',
    imageCount: p.imageCount || 0,
    imageBytes: p.imageBytes || 0,
    docName: p.docName || '',
    docSize: p.docSize || 0,
    likeCount: likes.length,
    liked: viewerId ? likes.includes(viewerId) : false,
    commentCount: (p.commentCount || 0),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    pinned: !!p.pinned,
  };
}

function countComments(postId) {
  return store.data.comments.filter((c) => c.postId === postId && !c.hidden).length;
}

/* ------------------------------ 我是谁 ------------------------------ */
/**
 * 登录页要展示的站长联系方式。
 * 两个前提：后台打开了展示开关、并且至少填了一项能联系上的方式（备注不算）。
 * 没填就返回 null，前端连「联系站长」的入口都不显示，不会露出空壳。
 */
function publicContact() {
  const c = store.data.settings.contact || {};
  if (c.enabled === false) return null;
  const out = {
    wechat: c.wechat || '',
    qq: c.qq || '',
    email: c.email || '',
    phone: c.phone || '',
    note: c.note || '',
  };
  if (!out.wechat && !out.qq && !out.email && !out.phone) return null;
  return out;
}

router.get('/me', (req, res) => {
  const policy = store.passwordPolicy();
  res.json({
    user: publicUser(req.user),
    admin: !!req.admin,
    settings: {
      siteTitle: store.data.settings.siteTitle,
      schoolName: store.data.settings.schoolName,
      schoolEn: store.data.settings.schoolEn,
      notice: store.data.settings.notice,
      registrationOpen: store.data.settings.registrationOpen !== false,
      contact: publicContact(),
      gradeMin: config.GRADE_MIN,
      gradeMax: config.GRADE_MAX,
    },
    password: {
      minLength: policy.minLength,
      allowSelfChange: policy.allowSelfChange,
    },
  });
});

/* ------------------------------ 登记 / 登录 ------------------------------ */
/** 浏览器原生表单提交 → 失败时 303 回登录页；JS/fetch 提交 → JSON */
function wantsJson(req) {
  if (req.is('application/json')) return true;
  return String(req.get('accept') || '').includes('application/json');
}

function authFail(req, res, { status = 400, error, tab = 'login', who = '', hint }) {
  if (wantsJson(req)) {
    const body = { error };
    if (hint) body.hint = hint;
    return res.status(status).json(body);
  }
  const qs = new URLSearchParams();
  qs.set('tab', tab);
  if (error) qs.set('err', error);
  if (who) qs.set('who', who);
  if (hint) qs.set('hint', hint);
  res.redirect(303, `/index.html?${qs.toString()}`);
}

function authOk(req, res, user, next = '/wall.html') {
  if (wantsJson(req)) return res.json({ ok: true, user: publicUser(user), next });
  res.redirect(303, next);
}

/** 从请求里取出「几几级的谁谁谁」：优先单框 who，其次兼容 year/className/name */
function readIdentity(body = {}) {
  const raw = String(body.who == null ? '' : body.who).trim();
  if (raw) {
    const r = parseWho(raw);
    // 兜底：单框里没写班级、但表单另外带了 className（浏览器自动填充、原生提交都可能这样）
    const extra = String(body.className == null ? '' : body.className).replace(/\D/g, '').slice(0, 2);
    if (r.ok && !r.className && extra && Number(extra) >= 1) {
      r.className = String(Number(extra));
      r.label = `${String(r.year).slice(2)}级${r.className}班${r.name}`;
    }
    return r;
  }
  const year = String(body.year || '').replace(/\D/g, '');
  const className = String(body.className || '').replace(/\D/g, '').slice(0, 2);
  const name = String(body.name || '').trim().slice(0, 20);
  if (!year || !name) return { ok: false, error: '请填写「几几级的谁谁谁」，例如：1995级 张三' };
  return parseWho(`${year}级 ${className ? className + '班 ' : ''}${name}`);
}

/** 记一次登录/注册的现场信息 */
function touchLogin(user, req) {
  const now = Date.now();
  user.lastSeenAt = now;
  user.lastLoginAt = now;
  user.loginCount = (user.loginCount || 0) + 1;
  user.loginIp = req.clientIp;
  user.ua = String(req.headers['user-agent'] || '').slice(0, 300);
  if (!Array.isArray(user.ips)) user.ips = [];
  if (req.clientIp && !user.ips.includes(req.clientIp)) {
    user.ips.push(req.clientIp);
    if (user.ips.length > 20) user.ips.shift();
  }
}

/* ------------------------------ 登记（第一次来，设密码） ------------------------------ */
router.post(
  '/register',
  rateLimit({ windowMs: 10 * 60 * 1000, max: 12, key: 'register' }),
  async (req, res) => {
    if (store.data.settings.registrationOpen === false) {
      return authFail(req, res, { status: 403, error: '站长暂时关闭了新访客登记，你仍然可以浏览回忆墙', tab: 'register' });
    }
    const policy = store.passwordPolicy();
    const ident = readIdentity(req.body);
    if (!ident.ok) return authFail(req, res, { status: 400, error: ident.error, tab: 'register', who: String(req.body.who || '') });

    const password = String(req.body.password == null ? '' : req.body.password);
    const again = req.body.password2;
    if (again !== undefined && String(again) !== password) {
      return authFail(req, res, { status: 400, error: '两次输入的密码不一样', tab: 'register', who: ident.label });
    }
    const bad = pwd.checkLength(password, policy);
    if (bad) return authFail(req, res, { status: 400, error: bad, tab: 'register', who: ident.label });

    const exists = store.findUserByName(ident.year, ident.className, ident.name);
    if (exists && exists.pwd) {
      return authFail(req, res, {
        status: 409,
        error: `这个身份已经登记过了（${ident.label}），请用「老同学登录」`,
        hint: '忘记密码就找站长重置，站长在后台「密码管控」里能生成临时密码。',
        tab: 'login',
        who: ident.label,
      });
    }

    const now = Date.now();
    const user = exists || {
      id: newId(),
      year: ident.year,
      className: ident.className,
      name: ident.name,
      createdAt: now,
      lastSeenAt: now,
      loginCount: 0,
      ips: [],
    };
    if (!exists) store.data.users.push(user);

    user.pwd = await pwd.hash(password);
    user.pwdLen = password.length;
    user.pwdUpdatedAt = now;
    user.pwdVersion = (user.pwdVersion || 1) + (exists ? 1 : 0);
    user.mustChange = false;
    user.failCount = 0;
    user.lockedUntil = 0;
    touchLogin(user, req);

    auth.createSession(req, res, { role: 'user', uid: user.id, ip: req.clientIp, ua: req.headers['user-agent'] });
    store.addEvent(exists ? 'pwd-setup' : 'register', { uid: user.id, who: ident.label }, req);
    store.touch();
    return authOk(req, res, user, '/wall.html');
  }
);

/* ------------------------------ 登录（老同学，凭密码） ------------------------------ */
router.post(
  '/login',
  rateLimit({ windowMs: 10 * 60 * 1000, max: 30, key: 'login' }),
  async (req, res) => {
    const policy = store.passwordPolicy();
    const ident = readIdentity(req.body);
    if (!ident.ok) return authFail(req, res, { status: 400, error: ident.error, who: String(req.body.who || '') });

    const candidates = store.findUsersByYearName(ident.year, ident.name);
    let user = null;
    if (candidates.length === 1) {
      user = candidates[0];
    } else if (candidates.length > 1) {
      const sameClass = candidates.filter((u) => (u.className || '') === (ident.className || ''));
      if (sameClass.length === 1) user = sameClass[0];
      else {
        return authFail(req, res, {
          status: 409,
          error: `这一级有 ${candidates.length} 位「${ident.name}」，请把班级也写上，例如 ${ident.year}级3班${ident.name}`,
          who: ident.label,
        });
      }
    }
    if (!user) {
      return authFail(req, res, {
        status: 404,
        error: '没找到这个身份 —— 第一次来请先点「第一次来 · 登记」',
        hint: '如果你以前登记过但没设密码，去「登记」页用同样的年级姓名补设一次密码即可。',
        who: ident.label,
      });
    }
    if (user.disabled) {
      return authFail(req, res, { status: 403, error: '这个账号已被站长停用，请联系站长', who: ident.label });
    }
    if (!user.pwd) {
      return authFail(req, res, {
        status: 409,
        error: '这个身份还没有设置密码',
        hint: '请到「第一次来 · 登记」页用同样的年级和姓名补设一次密码。',
        tab: 'register',
        who: ident.label,
      });
    }

    const now = Date.now();
    if (user.lockedUntil && user.lockedUntil > now) {
      const mins = Math.max(1, Math.ceil((user.lockedUntil - now) / 60000));
      return authFail(req, res, {
        status: 429,
        error: `密码输错太多次，这个身份已被锁定，${mins} 分钟后再试（或找站长解锁）`,
        who: ident.label,
      });
    }

    const password = String(req.body.password == null ? '' : req.body.password);
    if (!password) {
      return authFail(req, res, { status: 400, error: '请输入密码', who: ident.label });
    }
    if (!(await pwd.verify(password, user.pwd))) {
      user.failCount = (user.failCount || 0) + 1;
      let lockedNow = false;
      if (policy.maxFail > 0 && user.failCount >= policy.maxFail) {
        user.lockedUntil = now + policy.lockMinutes * 60000;
        user.failCount = 0;
        lockedNow = true;
        store.addEvent('account-lock', { uid: user.id, who: ident.label, minutes: policy.lockMinutes }, req);
      }
      store.addEvent('login-fail', { uid: user.id, who: ident.label, locked: lockedNow }, req);
      store.touch();
      const left = policy.maxFail > 0 ? Math.max(0, policy.maxFail - (user.failCount || 0)) : null;
      return authFail(req, res, {
        status: lockedNow ? 429 : 401,
        error: lockedNow
          ? `密码错误，连续错了 ${policy.maxFail} 次，这个身份被锁定 ${policy.lockMinutes} 分钟`
          : `密码不对${left && left <= 3 ? `（再错 ${left} 次会被临时锁定）` : ''}`,
        who: ident.label,
      });
    }

    user.failCount = 0;
    user.lockedUntil = 0;
    touchLogin(user, req);
    auth.createSession(req, res, { role: 'user', uid: user.id, ip: req.clientIp, ua: req.headers['user-agent'] });
    store.addEvent('login', { uid: user.id, who: ident.label }, req);
    store.touch();
    return authOk(req, res, user, user.mustChange ? '/account.html?must=1' : '/wall.html');
  }
);

/* ------------------------------ 自己改密码 ------------------------------ */
router.post('/password', auth.requireUser, rateLimit({ windowMs: 10 * 60 * 1000, max: 12, key: 'pwd-change' }), async (req, res) => {
  const policy = store.passwordPolicy();
  if (!policy.allowSelfChange && !req.admin) {
    return res.status(403).json({ error: '站长关闭了自助改密码，请联系站长帮你重置' });
  }
  const u = req.user;
  const oldPwd = String(req.body.oldPassword == null ? '' : req.body.oldPassword);
  const newPwd = String(req.body.newPassword == null ? '' : req.body.newPassword);
  const again = req.body.newPassword2;

  if (u.pwd && !(await pwd.verify(oldPwd, u.pwd))) {
    return res.status(400).json({ error: '原密码不对' });
  }
  const bad = pwd.checkLength(newPwd, policy);
  if (bad) return res.status(400).json({ error: bad });
  if (again !== undefined && String(again) !== newPwd) {
    return res.status(400).json({ error: '两次输入的新密码不一样' });
  }
  if (u.pwd && newPwd === oldPwd) {
    return res.status(400).json({ error: '新密码不能和原密码一样' });
  }

  u.pwd = await pwd.hash(newPwd);
  u.pwdLen = newPwd.length;
  u.pwdUpdatedAt = Date.now();
  u.pwdVersion = (u.pwdVersion || 1) + 1;
  u.mustChange = false;
  u.failCount = 0;
  u.lockedUntil = 0;

  // 其它设备上的登录全部作废，当前这台继续用
  const keepSid = req.userSession && req.userSession.sid;
  for (const [sid, s] of Object.entries(store.data.sessions)) {
    if (s.role === 'user' && s.uid === u.id && sid !== keepSid) delete store.data.sessions[sid];
  }
  if (req.userSession) req.userSession.pv = u.pwdVersion;
  store.addEvent('pwd-change', { uid: u.id, bySelf: true }, req);
  store.touch();
  res.json({ ok: true, user: publicUser(u) });
});

router.post('/logout', (req, res) => {
  auth.destroySession(req, res, 'user');
  res.json({ ok: true });
});

/* ------------------------------ 回忆列表 ------------------------------ */
router.get('/posts', (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize) || 12));
  const q = str(req.query.q, 50).toLowerCase();
  const year = req.query.year ? Number(req.query.year) : null;
  const sort = req.query.sort === 'hot' ? 'hot' : 'latest';
  const mine = req.query.mine === '1';

  let list = store.data.posts.filter((p) => !p.hidden);
  if (mine) {
    if (!req.user) return res.status(401).json({ error: '请先登记' });
    list = list.filter((p) => p.uid === req.user.id);
  }
  if (year) list = list.filter((p) => p.authorYear === year);
  if (q) {
    list = list.filter((p) =>
      `${p.title} ${p.content} ${p.authorName} ${p.authorClass} ${p.authorYear}`.toLowerCase().includes(q)
    );
  }

  const score = (p) => (p.likes || []).length * 3 + countComments(p.id) * 2;
  list.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (sort === 'hot') {
      const d = score(b) - score(a);
      if (d !== 0) return d;
    }
    return b.createdAt - a.createdAt;
  });

  const total = list.length;
  const start = (page - 1) * pageSize;
  const items = list.slice(start, start + pageSize).map((p) => publicPost(p, req.user && req.user.id));

  res.json({ items, total, page, pageSize, hasMore: start + items.length < total });
});

/* ------------------------------ 单条回忆 ------------------------------ */
router.get('/posts/:id', (req, res) => {
  const post = store.data.posts.find((p) => p.id === req.params.id);
  if (!post || (post.hidden && !req.admin)) return res.status(404).json({ error: '这条回忆不存在或已被隐藏' });
  const out = publicPost(post, req.user && req.user.id, true);
  // 整篇文档的正文 HTML 存在磁盘上，详情页才去读
  if (post.flex) out.html = post.hasBody ? readDocBody(post.id) : null;
  res.json({ post: out });
});

/* ------------------------------ 发布回忆 ------------------------------ */
router.post(
  '/posts',
  auth.requireUser,
  rateLimit({ windowMs: 60 * 60 * 1000, max: 12, key: 'post' }),
  (req, res) => {
    const title = str(req.body.title, 60);
    const content = str(req.body.content, config.MAX_POST_CHARS);
    if (content.replace(/\s/g, '').length < 4) {
      return res.status(400).json({ error: '回忆内容太短了，至少写几个字吧' });
    }
    if (/<script/i.test(content) || /<iframe/i.test(content)) {
      return res.status(400).json({ error: '内容里不允许包含脚本代码' });
    }
    const bad = checkSensitive(`${title} ${content}`);
    if (bad) return res.status(400).json({ error: `内容包含不允许的词：${bad}` });

    const images = Array.isArray(req.body.images)
      ? req.body.images.filter((s) => /^\/uploads\/[\w.-]+$/.test(String(s))).slice(0, 6)
      : [];

    const u = req.user;
    const isFirst = !store.data.posts.some((p) => p.uid === u.id);
    const needReview = isFirst && store.data.settings.reviewFirstPost;

    const post = {
      id: newId(),
      uid: u.id,
      authorYear: u.year,
      authorClass: u.className,
      authorName: u.name,
      title: title || '',
      content,
      images,
      likes: [],
      hidden: !!needReview,
      pendingReview: !!needReview,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ip: req.clientIp,
    };
    store.data.posts.push(post);
    store.addEvent('post-create', { postId: post.id, title: post.title, needReview }, req);
    store.touch();

    res.json({
      post: publicPost(post, u.id),
      message: needReview ? '已提交，等待站长审核后展示' : '发布成功',
    });
  }
);

/* ------------------------------ 修改 / 删除自己的回忆 ------------------------------ */
router.patch('/posts/:id', auth.requireUser, (req, res) => {
  const post = store.data.posts.find((p) => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: '不存在' });
  if (post.uid !== req.user.id && !req.admin) return res.status(403).json({ error: '只能修改自己的回忆' });
  if (req.body.title !== undefined) post.title = str(req.body.title, 60);
  if (req.body.content !== undefined) {
    const content = str(req.body.content, config.MAX_POST_CHARS);
    if (content.replace(/\s/g, '').length < 4) return res.status(400).json({ error: '内容太短' });
    post.content = content;
  }
  post.updatedAt = Date.now();
  store.addEvent('post-update', { postId: post.id }, req);
  store.touch();
  res.json({ post: publicPost(post, req.user.id) });
});

router.delete('/posts/:id', auth.requireUser, (req, res) => {
  const idx = store.data.posts.findIndex((p) => p.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '不存在' });
  const post = store.data.posts[idx];
  if (post.uid !== req.user.id && !req.admin) return res.status(403).json({ error: '只能删除自己的回忆' });
  store.data.posts.splice(idx, 1);
  store.data.comments = store.data.comments.filter((c) => c.postId !== post.id);
  // 整篇文档的帖子还带着一整个照片目录，一起删掉
  if (post.flex) { try { require('../docx').removePostDir(post.id); } catch (_) { /* ignore */ } }
  store.addEvent('post-delete', { postId: post.id, byAdmin: !!req.admin }, req);
  store.touch();
  res.json({ ok: true });
});

/* ------------------------------ 点赞 ------------------------------ */
router.post('/posts/:id/like', auth.requireUser, rateLimit({ windowMs: 60 * 1000, max: 60, key: 'like' }), (req, res) => {
  const post = store.data.posts.find((p) => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: '不存在' });
  post.likes = post.likes || [];
  const i = post.likes.indexOf(req.user.id);
  if (i >= 0) post.likes.splice(i, 1);
  else post.likes.push(req.user.id);
  store.touch();
  res.json({ liked: i < 0, likeCount: post.likes.length });
});

/* ------------------------------ 评论 ------------------------------ */
router.get('/posts/:id/comments', (req, res) => {
  const post = store.data.posts.find((p) => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: '不存在' });
  const items = store.data.comments
    .filter((c) => c.postId === post.id && (!c.hidden || req.admin))
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((c) => ({
      id: c.id,
      content: c.content,
      author: { year: c.authorYear, className: c.authorClass, name: c.authorName, label: `${gradeLabel(c.authorYear)}${c.authorClass ? c.authorClass + '班' : ''}${c.authorName}` },
      createdAt: c.createdAt,
      hidden: !!c.hidden,
    }));
  res.json({ items });
});

router.post(
  '/posts/:id/comments',
  auth.requireUser,
  rateLimit({ windowMs: 10 * 60 * 1000, max: 30, key: 'comment' }),
  (req, res) => {
    const post = store.data.posts.find((p) => p.id === req.params.id);
    if (!post) return res.status(404).json({ error: '不存在' });
    const content = str(req.body.content, 500);
    if (content.replace(/\s/g, '').length < 1) return res.status(400).json({ error: '评论不能为空' });
    if (checkSensitive(content)) return res.status(400).json({ error: '评论包含不允许的词' });

    const c = {
      id: newId(),
      postId: post.id,
      uid: req.user.id,
      authorYear: req.user.year,
      authorClass: req.user.className,
      authorName: req.user.name,
      content,
      createdAt: Date.now(),
      hidden: false,
      ip: req.clientIp,
    };
    store.data.comments.push(c);
    store.addEvent('comment-create', { postId: post.id, commentId: c.id }, req);
    store.touch();
    res.json({
      comment: {
        id: c.id,
        content: c.content,
        author: { year: c.authorYear, className: c.authorClass, name: c.authorName, label: `${gradeLabel(c.authorYear)}${c.authorClass ? c.authorClass + '班' : ''}${c.authorName}` },
        createdAt: c.createdAt,
      },
    });
  }
);

router.delete('/comments/:id', auth.requireUser, (req, res) => {
  const idx = store.data.comments.findIndex((c) => c.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: '不存在' });
  const c = store.data.comments[idx];
  if (c.uid !== req.user.id && !req.admin) return res.status(403).json({ error: '只能删除自己的评论' });
  store.data.comments.splice(idx, 1);
  store.addEvent('comment-delete', { commentId: c.id, byAdmin: !!req.admin }, req);
  store.touch();
  res.json({ ok: true });
});

/* ------------------------------ 站点统计 ------------------------------ */
router.get('/stats', (req, res) => {
  const posts = store.data.posts.filter((p) => !p.hidden);
  const years = new Set(store.data.users.map((u) => u.year).filter(Boolean));
  const yearCounts = {};
  for (const p of posts) {
    if (!p.authorYear) continue;
    yearCounts[p.authorYear] = (yearCounts[p.authorYear] || 0) + 1;
  }
  res.json({
    postCount: posts.length,
    userCount: store.data.users.length,
    commentCount: store.data.comments.filter((c) => !c.hidden).length,
    likeCount: posts.reduce((n, p) => n + (p.likes || []).length, 0),
    yearCount: years.size,
    years: Object.entries(yearCounts)
      .map(([y, n]) => ({ year: Number(y), count: n }))
      .sort((a, b) => a.year - b.year),
  });
});

/* ------------------------------ 上传图片 ------------------------------ */
router.post('/upload', auth.requireUser, (req, res) => {
  upload.array('images', 6)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || '上传失败' });
    const files = (req.files || []).map((f) => `/uploads/${f.filename}`);
    if (!files.length) return res.status(400).json({ error: '没有收到图片' });
    store.addEvent('upload', { count: files.length }, req);
    res.json({ files });
  });
});

module.exports = router;