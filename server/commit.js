'use strict';
/**
 * 把"解析出来的条目"真正写进回忆墙。
 * 后台「导入回忆」和「校友分享 → 审核通过」共用这一份逻辑，
 * 免得两条路各写一遍、行为不一致（比如去重指纹、导入用户标记）。
 */
const config = require('./config');
const { store, newId } = require('./store');

/**
 * @param {Array} list  条目数组 {year, className, name, title, content, createdAt}
 * @param {string} ip   操作者 IP（记在回忆上，方便日后追责）
 * @param {object} opts { maxEntries, source, reviewer }
 */
function commitEntries(list, ip, opts = {}) {
  const maxEntries = opts.maxEntries || 2000;
  const items = Array.isArray(list) ? list.slice(0, maxEntries) : [];
  let created = 0;
  let skipped = 0;
  const touchedUsers = new Set();
  // 已有内容指纹，防止同一份文档导入两遍
  const seen = new Set(store.data.posts.map((p) => `${p.uid}\u0000${p.content}`));

  for (const raw of items) {
    const content = String(raw.content || '').trim().slice(0, config.MAX_POST_CHARS);
    if (content.replace(/\s/g, '').length < 2) { skipped++; continue; }
    const year = Number(String(raw.year || '').replace(/[^\d]/g, '')) || null;
    const className = String(raw.className || '').replace(/[^\d]/g, '').slice(0, 2);
    const name = String(raw.name || '').trim().slice(0, 20) || '佚名校友';

    let user = year ? store.findUserByName(year, className, name) : null;
    if (!user) {
      user = {
        id: newId(),
        year,
        className,
        name,
        createdAt: Date.now(),
        lastSeenAt: 0,
        loginCount: 0,
        ips: [],
        imported: true,
      };
      store.data.users.push(user);
    }
    touchedUsers.add(user.id);

    const fingerprint = `${user.id}\u0000${content}`;
    if (seen.has(fingerprint)) { skipped++; continue; }
    seen.add(fingerprint);

    store.data.posts.push({
      id: newId(),
      uid: user.id,
      authorYear: user.year,
      authorClass: user.className,
      authorName: user.name,
      title: String(raw.title || '').slice(0, 60),
      content,
      images: [],
      likes: [],
      hidden: false,
      imported: true,
      source: opts.source || 'import',
      docId: opts.docId || null,
      createdAt: Number(raw.createdAt) || Date.now(),
      updatedAt: Date.now(),
      ip: ip || '',
    });
    created++;
  }

  store.touch();
  return { created, skipped, users: touchedUsers.size };
}

/**
 * 整篇文档当一条回忆发出去（后台导入用）。
 * 正文 HTML 落到 uploads/posts/<id>/body.html，db.json 里只存纯文本摘要，
 * 免得一篇几十万字的文档把 JSON 撑着每次 save 都重写一遍。
 *
 * @param {object} o { title, authorYear, authorName, authorClass, text, html, docName, docSize,
 *                     imageCount, cover, images, ip, uid }
 */
function createDocPost(o) {
  const fs = require('fs');
  const path = require('path');
  const id = o.id || newId();
  const dir = path.join(config.UPLOAD_DIR, 'posts', id);
  const html = String(o.html || '');
  if (html) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'body.html'), html, 'utf8');
  }

  const text = String(o.text || '');
  // 校友上传那条路是「先转换、后发布」，body.html 已经在磁盘上了，
  // 所以 hasBody 不能只看这次有没有传 html 进来。
  let bodyOnDisk = false;
  try {
    bodyOnDisk = fs.existsSync(path.join(dir, 'body.html'));
  } catch (_) { /* ignore */ }
  const post = {
    id,
    uid: o.uid || null,
    authorYear: o.authorYear || null,
    authorClass: o.authorClass || '',
    authorName: o.authorName || '佚名校友',
    title: String(o.title || '').slice(0, 60),
    // 只留前面这段给搜索和卡片摘要用，全文在 body.html 里
    content: text.slice(0, 200000),
    flex: true,
    hasBody: !!(html || bodyOnDisk),
    docName: String(o.docName || '').slice(0, 120),
    docSize: Number(o.docSize) || 0,
    imageCount: Number(o.imageCount) || 0,
    imageBytes: Number(o.imageBytes) || 0,
    cover: o.cover || '',
    images: [],
    likes: [],
    hidden: false,
    imported: true,
    source: 'doc',
    // 让「删文档连带删回忆」能对上号（校友那条路 docId 是必需的）
    docId: o.docId || null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ip: o.ip || '',
  };
  store.data.posts.push(post);
  store.touch();
  return { post, dir };
}

/** 读回整篇正文 HTML（详情页用）。文件没了就返回 null，前端退回纯文本。 */
function readDocBody(postId) {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(config.UPLOAD_DIR, 'posts', String(postId).replace(/[^\w-]/g, ''));
  try {
    return fs.readFileSync(path.join(dir, 'body.html'), 'utf8');
  } catch (_) {
    return null;
  }
}

module.exports = { commitEntries, createDocPost, readDocBody };