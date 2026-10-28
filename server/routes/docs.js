'use strict';
/**
 * 校友上传文档 → 解析成一堆回忆 → 直接发到回忆墙上（不经过审核）。
 *
 * 为什么不再做审核：站长明确要求"不需要审核，只需要后台能删"。
 * 所以这里的定位是「发出去就是公开的」，出问题由站长在后台删文档 / 删回忆。
 *
 * 两步式：
 *   POST /upload     上传并解析，返回条数和前几条预览（此时还没上墙）
 *   POST /:id/publish 确认发布，把草稿里的条目一次性写进回忆墙
 * 两步之间的解析结果存在 uploads/docs/<id>.draft.json，不塞进 db.json（会撑爆）。
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { store, newId } = require('../store');
const auth = require('../auth');
const importer = require('../importer');
const docs = require('../documents');
const docx = require('../docx');
const { commitEntries, createDocPost } = require('../commit');
const { rateLimit, checkSensitive, gradeLabel } = require('../tracker');

const router = express.Router();

router.use(auth.requireUser);

function whoLabel(year, className, name) {
  return `${gradeLabel(year)}${className ? className + '班' : ''}${name || ''}`;
}

function docRow(f) {
  return {
    id: f.id,
    name: f.name,
    size: f.size,
    ext: f.ext,
    ts: f.ts,
    status: f.status,
    entries: f.entries || 0,
    created: f.created || 0,
    skipped: f.skipped || 0,
    sensitive: f.sensitive || [],
    title: f.title || '',
    hasFile: !!f.path,
    // 整篇模式（.docx 里带照片）：一条回忆、正文在磁盘上
    flex: !!f.flex,
    postId: f.postId || '',
    imageCount: f.imageCount || 0,
    chars: f.chars || 0,
  };
}

/** uploads/posts/<postId> —— 整篇模式下照片和正文都在这儿 */
function postDirOf(postId) {
  return path.join(config.UPLOAD_DIR, 'posts', String(postId).replace(/[^\w-]/g, ''));
}

/** 整篇模式的正文纯文本（db.json 里只存前 2000 字摘要，全文在这里） */
function readDocText(postId) {
  try {
    return fs.readFileSync(path.join(postDirOf(postId), 'text.txt'), 'utf8');
  } catch (_) {
    return '';
  }
}

/**
 * 顺手清掉「传了但一直没点发布」的整篇文档。
 * 一份带照片的文档在磁盘上是几百 MB，没人认领的话不能一直躺着。
 */
function sweepStale(days) {
  const t0 = Date.now() - (days || 7) * 86400000;
  for (const f of store.data.files.slice()) {
    if (f.flex && f.status === 'ready' && Number(f.ts) < t0) {
      docx.removePostDir(f.postId);
      store.removeFile(f.id);
    }
  }
}

/** 今天这个校友已经传了几份 */
function docsTodayOf(uid) {
  const t0 = new Date();
  t0.setHours(0, 0, 0, 0);
  return store.data.files.filter(
    (f) => f.kind === 'post-doc' && f.uploaderId === uid && f.ts >= t0.getTime()
  ).length;
}

/* ------------------------------ 1. 上传并解析 ------------------------------ */
/**
 * .docx 走「整篇模式」：整份文档转成一条回忆，照片留在原来的位置。
 * 转换在这一步就做完（发布时只是写一条记录），所以发布按钮秒响应。
 * 原 .docx 转换完立刻删掉 —— 照片已经解压出来了，再留一份 400MB 的原件没意义。
 */
async function handleDocxUpload(req, res, absPath, originalName, ext, title) {
  const postId = newId();
  const dir = postDirOf(postId);
  const url = `/uploads/posts/${postId}`;

  let r;
  try {
    r = await docx.convertDocx(absPath, dir, url);
  } catch (e) {
    try { fs.unlinkSync(absPath); } catch (_) {}
    docx.removePostDir(postId);
    store.addEvent('doc-upload-fail', { name: originalName, error: e.message }, req);
    return res.status(400).json({ error: e.message });
  }
  try { fs.unlinkSync(absPath); } catch (_) {}

  const text = String(r.text || '');
  if (!text.replace(/\s/g, '').length) {
    docx.removePostDir(postId);
    store.addEvent('doc-upload-fail', { name: originalName, error: '没解析出内容' }, req);
    return res.status(400).json({
      error: '这份文档里没读出文字。如果整篇都是图片，请把照片单独发到回忆里；文字请用正常的段落写。',
    });
  }

  // 正文纯文本落地，db.json 里只放摘要（不然 5000 条回忆能把 JSON 撑爆）
  fs.writeFileSync(path.join(dir, 'text.txt'), text.slice(0, 400000), 'utf8');
  // 排版好的正文（带照片）也存一份：发布时只写记录，不再转换第二次
  if (r.html) fs.writeFileSync(path.join(dir, 'body.html'), r.html, 'utf8');
  const previewText = text.slice(0, 2000);

  const rec = {
    id: newId(),
    kind: 'post-doc',
    flex: true,
    postId,
    name: originalName,
    title: title || originalName.replace(/\.[^.]+$/, ''),
    size: req.file.size,
    ext,
    ts: Date.now(),
    status: 'ready',
    entries: 1,
    chars: text.length,
    imageCount: r.imageCount || 0,
    imageBytes: r.imageBytes || 0,
    cover: r.images && r.images.length ? r.images[0].url : '',
    truncated: !!r.truncated,
    preview: previewText,
    sensitive: docs.scanSensitive(previewText),
    uploaderId: req.user.id,
    uploaderLabel: whoLabel(req.user.year, req.user.className, req.user.name),
    ip: req.clientIp,
    ua: String(req.headers['user-agent'] || '').slice(0, 160),
    path: '',
  };
  store.addFile(rec);
  store.addEvent('doc-upload', {
    id: rec.id, name: originalName, entries: 1, flex: true, images: rec.imageCount, size: rec.size,
  }, req);

  res.json({
    ok: true,
    flex: true,
    doc: docRow(rec),
    total: 1,
    chars: text.length,
    imageCount: rec.imageCount,
    truncated: !!r.truncated,
    sample: [{
      author: rec.uploaderLabel,
      title: rec.title,
      content: previewText.slice(0, 200),
    }],
  });
}
router.post('/upload', rateLimit({ windowMs: 60 * 60 * 1000, max: 30, key: 'doc-upload' }), (req, res) => {
  const uid = req.user.id;
  if (docsTodayOf(uid) >= config.DOC_DAILY_LIMIT) {
    return res.status(429).json({ error: `今天已经传了 ${config.DOC_DAILY_LIMIT} 份了，明天再来吧` });
  }

  docs.uploader.single('doc')(req, res, async (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `文件太大了，单份文档上限 ${config.MAX_UPLOAD_MB}MB`
        : (err.message || '上传失败');
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: '没有收到文件' });

    const absPath = req.file.path;
    const originalName = docs.safeName(req.file.originalname);
    const ext = path.extname(originalName).toLowerCase() || '.txt';
    const title = String(req.body.title || '').slice(0, 60);

    sweepStale(7);

    // Word 走整篇模式（照片原样保留），其它格式还是按署名拆成多条
    if (ext === '.docx') {
      return handleDocxUpload(req, res, absPath, originalName, ext, title);
    }

    let parsed;
    try {
      parsed = await importer.parseFile(absPath, originalName, title);
    } catch (e) {
      try { fs.unlinkSync(absPath); } catch (_) {}
      store.addEvent('doc-upload-fail', { name: originalName, error: e.message }, req);
      return res.status(400).json({ error: e.message });
    }

    if (!parsed.entries.length) {
      try { fs.unlinkSync(absPath); } catch (_) {}
      store.addEvent('doc-upload-fail', { name: originalName, error: '没解析出内容' }, req);
      return res.status(400).json({
        error: '这份文档里没认出回忆。每条回忆前面写一行「95级3班 张三」，或者用「姓名,内容」的表格；也可以直接把内容粘贴到输入框里。',
      });
    }

    const id = newId();
    const rel = path.relative(config.UPLOAD_DIR, absPath).split(path.sep).join('/');
    const previewText = String(parsed.preview || '').slice(0, 2000);

    const rec = {
      id,
      kind: 'post-doc',
      name: originalName,
      title,
      size: req.file.size,
      ext,
      ts: Date.now(),
      status: 'ready',
      entries: parsed.entries.length,
      chars: parsed.chars || 0,
      lines: parsed.lines || 0,
      truncated: !!parsed.truncated,
      preview: previewText,
      sensitive: docs.scanSensitive(previewText),
      uploaderId: req.user.id,
      uploaderLabel: whoLabel(req.user.year, req.user.className, req.user.name),
      ip: req.clientIp,
      ua: String(req.headers['user-agent'] || '').slice(0, 160),
      path: rel,
    };
    store.addFile(rec);
    docs.saveDraft(id, parsed.entries);
    store.addEvent('doc-upload', { id, name: originalName, entries: parsed.entries.length, size: rec.size }, req);

    res.json({
      ok: true,
      doc: docRow(rec),
      total: parsed.entries.length,
      truncated: !!parsed.truncated,
      sample: parsed.entries.slice(0, 5).map((e) => ({
        author: whoLabel(e.year, e.className, e.name) || '佚名',
        title: e.title || '',
        content: String(e.content || '').slice(0, 200),
      })),
    });
  });
});

/* ------------------------------ 2. 确认发布 ------------------------------ */
router.post('/:id/publish', rateLimit({ windowMs: 60 * 60 * 1000, max: 20, key: 'doc-publish' }), (req, res) => {
  const f = store.getFile(req.params.id);
  if (!f || f.kind !== 'post-doc') return res.status(404).json({ error: '没找到这份文档' });
  if (f.uploaderId !== req.user.id && !req.admin) return res.status(403).json({ error: '这不是你传的文档' });
  if (f.status === 'published') return res.status(400).json({ error: '这份文档已经发布过了' });

  /* ---- 整篇模式：内容早就转好了，这一步只是把它挂到墙上 ---- */
  if (f.flex) {
    const text = readDocText(f.postId);
    if (!text) {
      return res.status(410).json({ error: '这篇的内容不在了（可能被清理过），请重新传一次文档' });
    }
    // 整篇没法逐条过滤，命中就照发、由站长在后台看情况删，只把结果记在记录上
    const hit = checkSensitive(text.slice(0, 8000));
    createDocPost({
      id: f.postId,
      docId: f.id,
      title: f.title || f.name,
      authorYear: req.user.year,
      authorClass: req.user.className,
      authorName: req.user.name,
      text,
      html: '', // body.html 上传时就写好了，这里别覆盖
      docName: f.name,
      docSize: f.size,
      imageCount: f.imageCount || 0,
      imageBytes: f.imageBytes || 0,
      cover: f.cover || '',
      ip: req.clientIp,
      uid: req.user.id,
    });
    f.status = 'published';
    f.publishedAt = Date.now();
    f.created = 1;
    f.skipped = 0;
    f.blocked = hit ? 1 : 0;
    store.touch();
    store.addEvent('doc-publish', { id: f.id, name: f.name, created: 1, flex: true }, req);
    return res.json({
      ok: true, flex: true, created: 1, skipped: 0, blocked: hit ? 1 : 0,
      postId: f.postId, doc: docRow(f),
    });
  }

  const entries = docs.readDraft(f.id);
  if (!entries || !entries.length) {
    return res.status(410).json({ error: '解析草稿不在了（可能服务器重启过），请重新传一次文档' });
  }

  const bad = [];
  const clean = [];
  for (const e of entries) {
    const hit = checkSensitive(`${e.title || ''} ${e.content || ''}`);
    if (hit) bad.push(hit);
    else clean.push(e);
  }

  const r = commitEntries(clean, req.clientIp, { source: 'doc', docId: f.id, maxEntries: config.MAX_IMPORT_ENTRIES });
  f.status = 'published';
  f.publishedAt = Date.now();
  f.created = r.created;
  f.skipped = r.skipped + bad.length;
  f.blocked = bad.length;
  store.touch();
  docs.dropDraft(f.id);

  store.addEvent('doc-publish', { id: f.id, name: f.name, created: r.created, skipped: r.skipped, blocked: bad.length }, req);

  res.json({
    ok: true,
    created: r.created,
    skipped: r.skipped,
    blocked: bad.length,
    doc: docRow(f),
  });
});

/* ------------------------------ 3. 我传过的文档 ------------------------------ */
router.get('/mine', (req, res) => {
  const items = store.data.files
    .filter((f) => f.uploaderId === req.user.id && f.kind === 'post-doc')
    .slice(0, 30)
    .map(docRow);
  res.json({ items });
});

/* ------------------------------ 4. 删掉自己传的文档 ------------------------------ */
router.delete('/:id', (req, res) => {
  const f = store.getFile(req.params.id);
  if (!f || f.kind !== 'post-doc') return res.status(404).json({ error: '没找到这份文档' });
  if (f.uploaderId !== req.user.id && !req.admin) return res.status(403).json({ error: '这不是你传的文档' });

  const removed = docs.removePublishedOf(f);
  docs.dropFile(f.path);
  docs.dropDraft(f.id);
  if (f.postId) docx.removePostDir(f.postId); // 照片目录一起清，别留几百 MB 垃圾
  store.removeFile(f.id);
  store.addEvent('doc-delete', { id: f.id, name: f.name, byAdmin: !!req.admin, posts: removed }, req);
  res.json({ ok: true, posts: removed });
});

module.exports = router;