'use strict';
/**
 * 认证与会话。
 * - 会话 ID 放在 HttpOnly + SameSite=Lax 的 Cookie 里，数据库留副本，可随时踢人下线。
 * - 校友和管理员用两个不同的 Cookie，所以站长可以"既是访客也是管理员"。
 * - 不引入 jsonwebtoken 之类的依赖：自己用 HMAC-SHA256 给 sid 签名即可。
 */
const crypto = require('crypto');
const config = require('./config');
const { store, newId, clientIp } = require('./store');
const pwd = require('./pwd');

const COOKIE_USER = 'mem_uid';
const COOKIE_ADMIN = 'mem_admin';

function hmac(sid) {
  return crypto.createHmac('sha256', config.SESSION_SECRET).update(sid).digest('base64url');
}

function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function readCookie(req, name) {
  const raw = parseCookies(req)[name];
  if (!raw) return null;
  const dot = raw.lastIndexOf('.');
  if (dot < 0) return null;
  const sid = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expect = hmac(sid);
  if (sig.length !== expect.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  return sid;
}

function cookieHeader(name, value, maxAgeMs) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  // 只有在 https 场景下才加 Secure（本地 http 调试加了会导致登不上）
  if ((config.SITE_URL || '').startsWith('https://')) parts.push('Secure');
  return parts.join('; ');
}

/** 新建会话并下发 Cookie */
function createSession(req, res, { role, uid, ip, ua }) {
  const sid = newId();
  const now = Date.now();
  const user = role === 'user' ? store.getUser(uid) : null;
  store.data.sessions[sid] = {
    role,
    uid,
    // 记下当时用户的"密码版本"：密码一改，旧会话自动失效
    pv: user ? user.pwdVersion || 1 : undefined,
    ip: ip || clientIp(req),
    ua: String(ua || req.headers['user-agent'] || '').slice(0, 300),
    createdAt: now,
    lastSeenAt: now,
  };
  if (role === 'admin') {
    res.append('Set-Cookie', cookieHeader(COOKIE_ADMIN, `${sid}.${hmac(sid)}`, config.ADMIN_TTL_MS));
  } else {
    res.append('Set-Cookie', cookieHeader(COOKIE_USER, `${sid}.${hmac(sid)}`, config.SESSION_TTL_MS));
  }
  store.touch();
  return sid;
}

/** 销毁当前角色的会话 */
function destroySession(req, res, role) {
  const cookieName = role === 'admin' ? COOKIE_ADMIN : COOKIE_USER;
  const sid = readCookie(req, cookieName);
  if (sid) {
    delete store.data.sessions[sid];
    store.touch();
  }
  res.append('Set-Cookie', cookieHeader(cookieName, '', 0));
}

function getSession(req, role) {
  const cookieName = role === 'admin' ? COOKIE_ADMIN : COOKIE_USER;
  const sid = readCookie(req, cookieName);
  if (!sid) return null;
  const s = store.data.sessions[sid];
  if (!s || s.role !== role) return null;
  const ttl = role === 'admin' ? config.ADMIN_TTL_MS : config.SESSION_TTL_MS;
  if (Date.now() - s.createdAt > ttl) {
    delete store.data.sessions[sid];
    store.touch();
    return null;
  }
  // 每 60 秒刷新一次 lastSeen，避免频繁写盘
  if (Date.now() - (s.lastSeenAt || 0) > 60_000) {
    s.lastSeenAt = Date.now();
    store.touch();
  }
  return { sid, ...s };
}

/** 把 req.user / req.admin 挂上去，供后续中间件和日志使用 */
function attach(req, res, next) {
  // 注意：Express 的 req.ip 是只读 getter，不能赋值，这里用自建的 clientIp
  req.clientIp = clientIp(req);
  const userSess = getSession(req, 'user');
  req.user = userSess ? store.getUser(userSess.uid) : null;
  req.userSession = userSess;
  // 密码被改过（或账号被重置）→ 之前发出去的会话一律作废
  if (req.user && userSess && userSess.pv !== undefined && (req.user.pwdVersion || 1) !== userSess.pv) {
    delete store.data.sessions[userSess.sid];
    store.touch();
    req.user = null;
    req.userSession = null;
  }
  if (req.user && req.user.disabled) {
    req.user = null;
    req.userSession = null;
  }
  const adminSess = getSession(req, 'admin');
  req.admin = adminSess ? { role: 'admin' } : null;
  req.adminSession = adminSess;
  next();
}

const requireUser = (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: '请先登记（登录）后再操作' });
  next();
};

const requireAdmin = (req, res, next) => {
  if (!req.admin) return res.status(401).json({ error: '需要管理员身份' });
  next();
};

/** 校验后台密码：站长在后台改过就用数据库里的，否则用 .env 里的 */
async function checkAdminPassword(input) {
  const override = store.data.settings.adminPwd;
  if (override && override.hash) {
    return pwd.verify(String(input || ''), override.hash);
  }
  const a = Buffer.from(String(input || ''));
  const b = Buffer.from(String(config.ADMIN_PASSWORD || ''));
  if (a.length !== b.length) {
    // 仍然消耗一次比较，避免通过响应时间猜长度
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/** 站长在后台设置自己的新密码（存哈希；传空则回退到 .env） */
async function setAdminPassword(newPassword) {
  if (!newPassword) {
    store.data.settings.adminPwd = null;
    store.touch();
    return;
  }
  store.data.settings.adminPwd = {
    hash: await pwd.hash(String(newPassword)),
    updatedAt: Date.now(),
  };
  store.touch();
}

/** 清理过期会话，每小时跑一次 */
function pruneSessions() {
  const now = Date.now();
  let changed = false;
  for (const [sid, s] of Object.entries(store.data.sessions)) {
    const ttl = s.role === 'admin' ? config.ADMIN_TTL_MS : config.SESSION_TTL_MS;
    if (now - s.createdAt > ttl) {
      delete store.data.sessions[sid];
      changed = true;
    }
  }
  if (changed) store.touch();
}

module.exports = {
  COOKIE_USER,
  COOKIE_ADMIN,
  attach,
  createSession,
  destroySession,
  getSession,
  requireUser,
  requireAdmin,
  checkAdminPassword,
  setAdminPassword,
  pruneSessions,
  parseCookies,
};