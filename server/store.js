'use strict';
/**
 * 极简 JSON 数据库。
 * - 单文件落盘（data/db.json），便于备份、迁移、人工核查。
 * - 写入是"防抖动 + 原子替换"，不会因为写入一半崩溃把数据写坏。
 * - 对几千到几万条回忆这个量级完全够用；如果以后要上十万级再换 SQLite。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { DEFAULT_POLICY, normalizePolicy } = require('./pwd');

const newId = () => crypto.randomBytes(8).toString('hex');

/**
 * 站名相关三个字段的清洗：
 *   schoolName 学校名称（必填，默认「廊坊一中」）
 *   schoolEn   登录页那行英文小字（可留空 → 不显示）
 *   siteTitle  站点全称（留空 → 自动「学校名称 + 回忆录」）
 * 就地修改传入的 settings 对象，返回它本身。
 */
function normalizeBrand(s) {
  if (!s || typeof s !== 'object') return s;
  const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  s.schoolName = str(s.schoolName, 20) || '廊坊一中';
  if (s.schoolEn === undefined || s.schoolEn === null) s.schoolEn = 'LANGFANG NO.1 MIDDLE SCHOOL';
  s.schoolEn = str(s.schoolEn, 60);
  s.siteTitle = str(s.siteTitle, 40) || `${s.schoolName}回忆录`;
  return s;
}

/**
 * 站长联系方式：显示在登录页，方便校友忘记密码时找人。
 * 只允许这几个字段、限长，避免后台把任意结构塞进来。
 */
function normalizeContact(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  return {
    enabled: c.enabled !== false,
    wechat: str(c.wechat, 60),
    qq: str(c.qq, 30),
    email: str(c.email, 120),
    phone: str(c.phone, 40),
    note: str(c.note, 200),
  };
}

function defaultData() {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    users: [],        // 登记过的校友
    posts: [],        // 回忆
    comments: [],     // 评论
    sessions: {},     // sid -> { role, uid, ip, ua, createdAt, lastSeenAt }
    visits: [],       // 访问日志
    events: [],       // 关键事件（登录、发布、删除、封禁…）
    bans: [],         // 封禁的 IP
    files: [],        // 上传过的文件（导入 / 校友分享），后台监控用
    settings: {
      schoolName: '廊坊一中',          // 学校名称：顶栏、印章、登录页大标题都用它
      schoolEn: 'LANGFANG NO.1 MIDDLE SCHOOL', // 登录页那行英文小字，留空则不显示
      siteTitle: '廊坊一中回忆录',      // 站点全称：浏览器标签页、页脚；留空自动用「学校名称 + 回忆录」
      notice: '',
      registrationOpen: true,
      reviewFirstPost: config.REVIEW_FIRST_POST,
      sensitiveWords: [],
      passwordPolicy: { ...DEFAULT_POLICY },
      contact: normalizeContact(null), // 登录页展示的站长联系方式
      adminPwd: null, // 站长在后台改过自己的密码就存这里（哈希），否则用 .env 里的
    },
  };
}

class Store {
  constructor(file) {
    this.file = file;
    this.data = defaultData();
    this._timer = null;
    this._dirty = false;
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file, 'utf8');
        const parsed = JSON.parse(raw);
        this.data = Object.assign(defaultData(), parsed);
        this.data.settings = Object.assign(defaultData().settings, parsed.settings || {});
        this.data.settings.passwordPolicy = normalizePolicy(this.data.settings.passwordPolicy);
        this.data.settings.contact = normalizeContact(this.data.settings.contact);
        normalizeBrand(this.data.settings);
        if (!Array.isArray(this.data.files)) this.data.files = [];
        if (typeof this.data.settings.shareOpen !== 'boolean') this.data.settings.shareOpen = true;
        if (typeof this.data.settings.shareNote !== 'string') this.data.settings.shareNote = '';
        return;
      }
    } catch (err) {
      // 文件损坏时先备份再重建，避免直接丢数据
      const broken = `${this.file}.broken-${Date.now()}`;
      try { fs.copyFileSync(this.file, broken); } catch (_) {}
      console.error(`[store] 数据库读取失败，已备份到 ${broken}：`, err.message);
    }
    this.data = defaultData();
    this.saveNow();
  }

  /** 立即落盘（原子写：写临时文件 → rename） */
  saveNow() {
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
    this._dirty = false;
  }

  /** 标记有改动，200ms 后合并写盘 */
  touch() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      if (!this._dirty) return;
      try { this.saveNow(); } catch (err) { console.error('[store] 保存失败', err); }
    }, 200);
  }

  /** 进程退出前把没写完的数据刷下去 */
  flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    if (this._dirty) { try { this.saveNow(); } catch (err) { console.error('[store] flush 失败', err); } }
  }

  // ---------- 便捷查询 ----------
  getUser(id) { return this.data.users.find((u) => u.id === id) || null; }

  findUserByName(year, className, name) {
    return this.data.users.find(
      (u) => u.year === year && (u.className || '') === (className || '') && u.name === name
    ) || null;
  }

  /** 按「届别 + 姓名」找人（可能重名，返回列表） */
  findUsersByYearName(year, name) {
    return this.data.users.filter((u) => Number(u.year) === Number(year) && u.name === name);
  }

  /** 当前的密码策略（已归一化） */
  passwordPolicy() {
    return normalizePolicy(this.data.settings.passwordPolicy);
  }

  /** 踢掉某个校友的全部会话（改密码 / 封号时用），返回踢掉几个 */
  dropSessionsOf(uid) {
    let n = 0;
    for (const [sid, s] of Object.entries(this.data.sessions)) {
      if (s.role === 'user' && s.uid === uid) {
        delete this.data.sessions[sid];
        n++;
      }
    }
    if (n) this.touch();
    return n;
  }

  addEvent(type, detail = {}, req = null) {
    this.data.events.push({
      id: newId(),
      ts: Date.now(),
      type,
      detail,
      ip: req ? clientIp(req) : undefined,
      ua: req ? String(req.headers['user-agent'] || '').slice(0, 300) : undefined,
      uid: req && req.user ? req.user.id : undefined,
    });
    if (this.data.events.length > config.MAX_EVENTS) {
      this.data.events.splice(0, this.data.events.length - config.MAX_EVENTS);
    }
    this.touch();
  }

  addVisit(visit) {
    this.data.visits.push(visit);
    const overflow = this.data.visits.length - config.MAX_VISITS;
    if (overflow > 0) this.data.visits.splice(0, overflow);
    this.touch();
  }

  isBanned(ip) {
    return this.data.bans.some((b) => b.ip === ip);
  }

  // ---------- 上传文件记录（监控页用） ----------

  addFile(rec) {
    this.data.files.unshift(rec);
    const overflow = this.data.files.length - config.MAX_FILES;
    if (overflow > 0) this.data.files.splice(this.data.files.length - overflow, overflow);
    this.touch();
    return rec;
  }

  getFile(id) {
    return this.data.files.find((f) => f.id === id) || null;
  }

  removeFile(id) {
    const i = this.data.files.findIndex((f) => f.id === id);
    if (i < 0) return null;
    const [gone] = this.data.files.splice(i, 1);
    this.touch();
    return gone;
  }

  /** 这个校友今天已经提交了几份（用于每日限额） */
  filesTodayOf(uid) {
    const t0 = new Date();
    t0.setHours(0, 0, 0, 0);
    return this.data.files.filter(
      (f) => f.uploaderId === uid && String(f.kind).startsWith('share') && f.ts >= t0.getTime()
    ).length;
  }
}

/** 取真实客户端 IP（考虑反向代理） */
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  let ip = '';
  if (config.TRUST_PROXY && xff) {
    ip = String(xff).split(',')[0].trim();
  } else {
    ip = req.socket ? req.socket.remoteAddress || '' : '';
  }
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip || 'unknown';
}

const store = new Store(config.DB_FILE);

module.exports = { store, newId, clientIp, normalizeContact, normalizeBrand };