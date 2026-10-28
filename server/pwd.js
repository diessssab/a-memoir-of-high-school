'use strict';
/**
 * 密码哈希与策略。
 * - 用 Node 自带的 scrypt（加盐、慢哈希），不引入 bcrypt / argon2 之类的原生依赖，
 *   免得在云服务器上编译失败。
 * - 存的是 `scrypt$盐$摘要` 这种自描述格式，以后要换算法也认得出旧格式。
 * - 具体的长度/锁定策略放在数据库 settings.passwordPolicy 里，站长可以在后台改。
 */
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const KEY_LEN = 64;
const SALT_LEN = 16;

const DEFAULT_POLICY = {
  minLength: 1,          // 「密码没有要求」：默认 1 位就够，站长可以在后台调高
  maxLength: 72,
  maxFail: 8,            // 连续输错几次就锁
  lockMinutes: 30,       // 锁多久
  forceChangeOnReset: true, // 站长重置后，用户下次登录必须改密码
  allowSelfChange: true,    // 允许校友自己改密码
};

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 把外部传进来的策略对象收拾干净，坏值一律回落到默认 */
function normalizePolicy(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const d = DEFAULT_POLICY;
  return {
    minLength: clampInt(p.minLength, 1, 72, d.minLength),
    maxLength: clampInt(p.maxLength, 8, 200, d.maxLength),
    maxFail: clampInt(p.maxFail, 0, 999, d.maxFail),
    lockMinutes: clampInt(p.lockMinutes, 0, 60 * 24 * 30, d.lockMinutes),
    forceChangeOnReset: p.forceChangeOnReset === undefined ? d.forceChangeOnReset : !!p.forceChangeOnReset,
    allowSelfChange: p.allowSelfChange === undefined ? d.allowSelfChange : !!p.allowSelfChange,
  };
}

/** 生成 scrypt 哈希串 */
async function hash(password) {
  const salt = crypto.randomBytes(SALT_LEN);
  const key = await scrypt(String(password), salt, KEY_LEN);
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** 校验密码（定长比较） */
async function verify(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const m = /^scrypt\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(stored);
  if (!m) return false;
  const salt = Buffer.from(m[1], 'base64url');
  const expect = Buffer.from(m[2], 'base64url');
  if (!salt.length || !expect.length) return false;
  let key;
  try {
    key = await scrypt(String(password), salt, expect.length);
  } catch (_) {
    return false;
  }
  return key.length === expect.length && crypto.timingSafeEqual(key, expect);
}

// 去掉了容易看错的 0/o/O/1/l/I，方便站长口头/微信告诉老同学
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** 生成随机密码（默认 8 位） */
function generate(len = 8) {
  const n = clampInt(len, 4, 64, 8);
  const bytes = crypto.randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** 给人看的"密码强度"，后台列表里显示 */
function strengthLabel(len) {
  const n = Number(len) || 0;
  if (n === 0) return '未设置';
  if (n < 4) return '很弱';
  if (n < 6) return '偏弱';
  if (n < 9) return '一般';
  return '较安全';
}

/** 按策略校验长度，返回错误文案或 null */
function checkLength(password, policy) {
  const s = String(password == null ? '' : password);
  const p = policy || DEFAULT_POLICY;
  if (!s.length) return '密码不能为空';
  if (s.length < p.minLength) return `密码至少 ${p.minLength} 位`;
  if (s.length > p.maxLength) return `密码最多 ${p.maxLength} 位`;
  return null;
}

module.exports = {
  DEFAULT_POLICY,
  normalizePolicy,
  hash,
  verify,
  generate,
  strengthLabel,
  checkLength,
};