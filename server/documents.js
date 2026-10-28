'use strict';
/**
 * 文档上传的公共部件：目录、文件名清洗、敏感词抽样、multer 实例、草稿读写。
 *
 * 谁在用：
 *   - routes/docs.js —— 校友在「写回忆」里传一份文档，解析成一堆回忆直接上墙
 *   - routes/admin.js —— 站长在「导入回忆」里传一份文档
 *
 * 文件落在 uploads/docs/，上传本身是磁盘流（diskStorage），不占内存；
 * 解析结果先写一份草稿 JSON（uploads/docs/<id>.draft.json），点「发布」时才写进回忆墙。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const config = require('./config');
const { store } = require('./store');

const DOC_DIR = path.join(config.UPLOAD_DIR, 'docs');
fs.mkdirSync(DOC_DIR, { recursive: true });

/** 只收这几种文档。别的后缀在 multer 层就拒掉，不落盘。 */
const ALLOWED_EXT = ['.docx', '.txt', '.md', '.csv', '.html', '.htm'];

/** 浏览器上传的中文文件名是 latin1 解出来的，转回 utf8 才不会变成问号 */
function safeName(name) {
  let s = String(name || 'document.txt');
  try {
    const fixed = Buffer.from(s, 'latin1').toString('utf8');
    if (!fixed.includes('\ufffd')) s = fixed;
  } catch (_) { /* 保持原样 */ }
  return s.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120);
}

/** 抽样扫描敏感词（只看预览那段，几百 MB 全扫一遍划不来） */
function scanSensitive(text) {
  const words = store.data.settings.sensitiveWords || [];
  if (!words.length || !text) return [];
  const hits = [];
  for (const w of words) {
    if (w && text.includes(w)) hits.push(w);
    if (hits.length >= 20) break;
  }
  return hits;
}

const uploader = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, DOC_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(safeName(file.originalname)).toLowerCase() || '.bin';
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(safeName(file.originalname)).toLowerCase();
    if (!ALLOWED_EXT.includes(ext)) {
      const err = new Error(`不支持 ${ext || '这种'} 文件。可以传 .docx / .txt / .md / .csv / .html`);
      err.code = 'BAD_EXT';
      return cb(err);
    }
    cb(null, true);
  },
});

/* ------------------------------ 解析草稿 ------------------------------ */

function draftPath(id) {
  return path.join(DOC_DIR, `${id}.draft.json`);
}

function saveDraft(id, entries) {
  fs.writeFileSync(draftPath(id), JSON.stringify(entries), 'utf8');
}

function readDraft(id) {
  const p = draftPath(id);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; }
}

function dropDraft(id) {
  try { fs.unlinkSync(draftPath(id)); } catch (_) { /* ignore */ }
}

/** 删掉磁盘上的原文件（记录 itself 由调用方决定是否保留） */
function dropFile(relPath) {
  if (!relPath) return;
  const abs = path.join(config.UPLOAD_DIR, relPath);
  try { fs.unlinkSync(abs); } catch (_) { /* ignore */ }
}

/**
 * 删掉某份文档发到墙上的回忆。
 * 站长在「监控中心」删一份文档、或校友撤掉自己传的文档时调用，
 * 不然墙上会留下没人认领的内容。
 */
function removePublishedOf(f) {
  if (!f || (!f.id && !f.postId)) return 0;
  const before = store.data.posts.length;
  // 两种关联都认：docId（后来补写的）和记录上的 postId（创建时就写的）
  store.data.posts = store.data.posts.filter((p) => p.docId !== f.id && p.id !== f.postId);
  const removed = before - store.data.posts.length;
  if (removed) store.touch();
  return removed;
}

module.exports = {
  DOC_DIR,
  ALLOWED_EXT,
  safeName,
  scanSensitive,
  uploader,
  saveDraft,
  readDraft,
  dropDraft,
  dropFile,
  removePublishedOf,
};