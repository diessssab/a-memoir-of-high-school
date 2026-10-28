'use strict';
/**
 * 把一整份 .docx 转成「一条回忆」：正文保留段落/标题/表格，照片抽出来存到磁盘。
 *
 * 为什么单独写一个模块：
 *   importer.js 只抽纯文字（按署名行拆成很多条回忆），照片全丢 —— 这就是
 *   「导入后照片显示不了」的原因。整篇模式需要保留图文顺序，所以这里自己走一遍
 *   word/document.xml，把 <w:t> 文字、<w:drawing> 图片、<w:tbl> 表格按顺序还原成 HTML。
 *
 * 内存：document.xml 才几百 KB，整份读进内存没问题；照片是逐个流式解压写到磁盘，
 * 所以 500MB 的文档也不会把进程撑爆。照片总量另外有上限（MAX_DOC_IMAGES_MB）。
 *
 * HTML 里的文字全部经过 escapeHtml，标签只由本模块生成，所以存进 db.json 后
 * 前端用 innerHTML 渲染是安全的（用户手写的回忆永远走 App.esc 转义）。
 */
const fs = require('fs');
const path = require('path');
const yauzl = require('yauzl');
const config = require('./config');

/* ------------------------------------------------------------------ */
/* 基础工具                                                            */
/* ------------------------------------------------------------------ */

const IMG_EXT_OK = ['.jpeg', '.jpg', '.png', '.gif', '.webp', '.bmp'];

function escapeHtml(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function decodeXmlEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch (_) { return ''; }
    })
    .replace(/&#(\d+);/g, (_, d) => {
      try { return String.fromCodePoint(Number(d)); } catch (_) { return ''; }
    })
    .replace(/&amp;/g, '&');
}

/** 从一段开始标签里取属性，比如 attr('<w:pStyle w:val="Heading1"/>', 'w:val') */
function attr(tag, name) {
  const re = new RegExp(`(?:^|\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*("([^"]*)"|'([^']*)')`);
  const m = tag.match(re);
  if (!m) return null;
  return decodeXmlEntities(m[2] !== undefined ? m[2] : m[3]);
}

/* ------------------------------------------------------------------ */
/* zip 读取                                                            */
/* ------------------------------------------------------------------ */

function openZip(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err) return reject(new Error('这个 .docx 打不开：可能没传完、已损坏，或者不是真正的 Word 文档'));
      resolve(zip);
    });
  });
}

function readEntry(zip, entry, maxBytes) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, rs) => {
      if (err) return reject(err);
      const chunks = [];
      let n = 0;
      rs.on('data', (c) => {
        n += c.length;
        if (maxBytes && n > maxBytes) {
          rs.destroy();
          return reject(new Error(`文档内部结构太大（超过 ${Math.round(maxBytes / 1048576)}MB），无法整篇还原`));
        }
        chunks.push(c);
      });
      rs.on('end', () => resolve(Buffer.concat(chunks)));
      rs.on('error', reject);
    });
  });
}

function copyEntry(zip, entry, destPath) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, rs) => {
      if (err) return reject(err);
      const ws = fs.createWriteStream(destPath);
      let n = 0;
      rs.on('data', (c) => { n += c.length; });
      rs.on('error', (e) => { ws.destroy(); reject(e); });
      ws.on('error', reject);
      ws.on('close', () => resolve(n));
      rs.pipe(ws);
    });
  });
}

/**
 * 按顺序遍历 zip 里的条目；handler 返回 Promise，处理完才继续下一个。
 */
async function walkZip(filePath, handler) {
  const zip = await openZip(filePath);
  return new Promise((resolve, reject) => {
    let stopped = false;
    const done = (err) => {
      if (stopped) return;
      stopped = true;
      try { zip.close(); } catch (_) { /* ignore */ }
      if (err) reject(err); else resolve();
    };
    zip.on('error', done);
    zip.on('entry', (entry) => {
      Promise.resolve()
        .then(() => handler(entry, zip))
        .then(() => { if (!stopped) zip.readEntry(); })
        .catch(done);
    });
    zip.on('end', () => done());
    zip.readEntry();
  });
}

/* ------------------------------------------------------------------ */
/* 关系表 / 样式表                                                     */
/* ------------------------------------------------------------------ */

/**
 * word/_rels/document.xml.rels → { rId: { target, external? } }
 * 图片是内部关系（target 指向 word/media/...），超链接是外部关系（TargetMode="External"）。
 * 两种都要留：图片要解压出来，链接要变成 <a href>。
 */
function parseRels(xml) {
  const map = {};
  if (!xml) return map;
  const re = /<Relationship\b[^>]*>/g;
  let m;
  while ((m = re.exec(xml))) {
    const id = attr(m[0], 'Id');
    const target = attr(m[0], 'Target');
    const mode = attr(m[0], 'TargetMode');
    if (!id || !target) continue;
    if (mode === 'External') {
      // 外链：原样存，后面用 safeHref 过滤一遍才输出
      map[id] = { target: decodeXmlEntities(String(target)).trim(), external: true };
      continue;
    }
    let t = String(target).replace(/^\.?\//, '');
    if (t.startsWith('word/')) t = t.slice(5);
    if (!t.startsWith('media/')) continue; // 模板、脚注这些不关心
    map[id] = { target: t };
  }
  return map;
}

/**
 * 正文里写死的网址（Word 里看着像链接、其实只是普通文字）也要能点。
 * 输入是已经转义过的文本片段，所以这里只往里插 <a>，不会引入危险标签。
 */
const URL_RE = /(?:https?:\/\/|www\.)[^\s<>"'）】。，、；！？]+/gi;
function linkifyText(escaped) {
  if (!/https?:\/\/|www\./i.test(escaped)) return escaped;
  return escaped.replace(URL_RE, (u) => {
    let url = u;
    let tail = '';
    // 句末的标点属于句子，不属于网址
    while (/[.,:!?)\]'"]$/.test(url)) {
      tail = url.slice(-1) + tail;
      url = url.slice(0, -1);
    }
    let href = url;
    if (/^www\./i.test(href)) href = `https://${href}`;
    if (!/^https?:\/\//i.test(href)) return u;
    return `<a class="doc-link" href="${href}" target="_blank" rel="noopener noreferrer">${url}</a>${tail}`;
  });
}

/**
 * 只放行三种链接：http(s)、mailto，以及 www 开头的裸域名。
 * javascript: / file: / 相对路径一律丢掉 —— 别人传的文档不能变成脚本入口。
 */
function safeHref(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (/^(?:https?:\/\/|mailto:)/i.test(s)) return s;
  if (/^www\.[^\s]+\.[^\s]+/i.test(s)) return `https://${s}`;
  return '';
}

/** styles.xml → { styleId: styleName }，用来认出「标题 1」这类段落样式 */
function parseStyles(xml) {
  const map = {};
  if (!xml) return map;
  const re = /<w:style\b[^>]*>([\s\S]*?)<\/w:style>/g;
  let m;
  while ((m = re.exec(xml))) {
    const head = m[0].slice(0, m[0].indexOf('>') + 1);
    const id = attr(head, 'w:styleId');
    if (!id) continue;
    const nameM = m[1].match(/<w:name\b[^>]*>/);
    const name = nameM ? attr(nameM[0], 'w:val') : '';
    const outlineM = m[1].match(/<w:outlineLvl\b[^>]*>/);
    const outline = outlineM ? Number(attr(outlineM[0], 'w:val')) : null;
    map[id] = { name: name || '', outline };
  }
  return map;
}

/** 这个段落样式是不是标题，是的话返回级别 1~6 */
function headingLevel(styleId, styles) {
  if (!styleId) return 0;
  const st = styles[styleId];
  const name = (st && st.name) || '';
  let m = name.match(/^(?:heading|标题)\s*([1-6])$/i);
  if (m) return Number(m[1]);
  m = String(styleId).match(/^(?:heading|标题)\s*([1-6])$/i);
  if (m) return Number(m[1]);
  if (st && typeof st.outline === 'number' && st.outline >= 0 && st.outline < 6) return st.outline + 1;
  return 0;
}

/* ------------------------------------------------------------------ */
/* 正文 XML → HTML                                                     */
/* ------------------------------------------------------------------ */

const BLOCK_SKIP = new Set(['w:sectPr', 'w:tblPr', 'w:tblGrid', 'w:trPr', 'w:tcPr', 'w:pPr', 'w:rPr']);

/**
 * 逐标签走一遍 document.xml。
 * 只输出几种安全标签：h2~h6 / p / strong / em / u / br / table / figure / img
 */
function documentXmlToHtml(xml, ctx) {
  const blocks = [];
  const note = { images: 0, skipped: 0, paragraphs: 0, truncated: false, chars: 0 };

  let cur = null;        // 当前段落
  let run = null;        // 当前 run
  let table = null;      // 当前表格 {rows: []}
  let row = null;
  let cell = null;
  let inDel = 0;         // 修订模式下被删掉的内容，不要
  let capture = null;    // 正在收文字的标签名（w:t / w:instrText / w:delText）
  let captureBuf = '';
  let pendingAlt = '';
  let link = '';         // 当前 run 所在的超链接（<a href>）
  const linkStack = [];  // 嵌套（w:hyperlink 里再套域代码）时用来还原
  // 域代码（HYPERLINK "url"）：begin → instrText → separate → 结果 → end
  const fields = [];
  let instrBuf = '';

  const TOKEN = /<(\/?)([A-Za-z][\w.:-]*)([^>]*?)(\/?)>/g;
  let last = 0;
  let m;

  // 表格单元格里的段落要收进单元格，不要摊到外面
  const pushBlock = (b) => {
    if (!b) return;
    if (cell) { cell.blocks.push(b); return; }
    blocks.push(b);
    if (blocks.length > 40000) note.truncated = true;
  };

  const htmlLen = () => {
    // 粗估，超过上限就不再往里堆，避免 db.json 被一篇文档撑爆
    let n = 0;
    for (const b of blocks) n += b.html ? b.html.length : 0;
    return n;
  };

  function finishParagraph() {
    if (!cur) return;
    const p = cur;
    cur = null;
    note.paragraphs++;
    note.chars += p.plain.length;
    const hasText = p.plain.replace(/[\s\u3000]/g, '').length > 0;
    if (!hasText && !p.images.length) return; // 空段（Word 里常用来撑行高）

    const renderRun = (r) => {
      const body = r.parts
        .map((part) => (typeof part === 'string' ? part : imgTag(part.src, part.alt)))
        .join('');
      if (!body) return '';
      let out = body;
      if (r.u) out = `<u>${out}</u>`;
      if (r.i) out = `<em>${out}</em>`;
      if (r.b) out = `<strong>${out}</strong>`;
      // 超链接包在最外层，点字（或点那张图标）就能跳
      if (r.link) {
        out = `<a class="doc-link" href="${escapeHtml(r.link)}" target="_blank" rel="noopener noreferrer">${out}</a>`;
      }
      return out;
    };
    const inner = p.runs.map(renderRun).join('');

    const align = p.align === 'center' ? 'center' : p.align === 'right' ? 'right' : '';
    const style = align ? ` style="text-align:${align}"` : '';

    if (!hasText && p.images.length) {
      // 只有图的段落：也走 renderRun，这样「HYPERLINK 域里放一张图标」的图片还是能点
      pushBlock({
        type: 'figure',
        plain: '',
        html: `<figure class="doc-fig">${p.runs.map(renderRun).join('') || p.images.map((s) => imgTag(s, p.alt || '')).join('')}</figure>`,
      });
      return;
    }

    const level = headingLevel(p.style, ctx.styles);
    if (level && hasText) {
      const tag = `h${Math.min(6, level + 1)}`;
      pushBlock({ type: 'heading', plain: p.plain, html: `<${tag} class="doc-h"${style}>${inner}</${tag}>` });
      return;
    }
    const cls = p.list ? 'doc-p doc-li' : 'doc-p';
    pushBlock({ type: 'p', plain: p.plain, html: `<p class="${cls}"${style}>${inner}</p>` });
  }

  function imgTag(src, alt) {
    // data-zoom 是前端灯箱认的属性，点一下看大图
    return `<img class="doc-img" src="${escapeHtml(src)}" data-zoom="${escapeHtml(src)}" alt="${escapeHtml(alt || '')}" loading="lazy" decoding="async">`;
  }

  function addImage(rid) {
    const rel = rid ? ctx.rels[rid] : null;
    if (!rel || !rel.url) {
      note.skipped++;
      return;
    }
    const part = { src: rel.url, alt: pendingAlt };
    pendingAlt = '';
    if (run) {
      run.parts.push(part);
      run.imgs.push(part.src);
    } else if (cur) {
      cur.runs.push({ parts: [part], imgs: [part.src], b: false, i: false, u: false, link });
    } else {
      const holder = { runs: [], plain: '', style: null, align: null, list: false, images: [], alt: '' };
      holder.runs.push({ parts: [part], imgs: [part.src], b: false, i: false, u: false, link });
      holder.images.push(part.src);
      cur = holder;
    }
    note.images++;
    if (cur && cur.images) cur.images.push(part.src);
  }

  function feedText(text) {
    if (!text) return;
    if (capture === 'w:t') {
      captureBuf += decodeXmlEntities(text);
    } else if (capture === 'w:instrText') {
      // 域代码（HYPERLINK "https://…"）：不显示，但要攒起来，好让域的结果变成链接
      instrBuf += decodeXmlEntities(text);
    }
    // 其它捕获（delText 删掉的文字）直接丢
  }

  function flushCapture() {
    if (capture === 'w:t' && run) {
      const t = captureBuf;
      captureBuf = '';
      if (!t) return;
      if (inDel) return;
      const piece = linkifyText(escapeHtml(t));
      // 合并到上一段纯文字，避免生成碎成一地 <span>
      const lastPart = run.parts[run.parts.length - 1];
      if (typeof lastPart === 'string') run.parts[run.parts.length - 1] = lastPart + piece;
      else run.parts.push(piece);
      if (cur) cur.plain += t;
      else if (cell) cell.plain = (cell.plain || '') + t;
    } else if (capture === 'w:t' && !run && cur) {
      const t = captureBuf;
      captureBuf = '';
      if (t && !inDel) cur.plain += t;
    } else if (capture === 'w:instrText') {
      if (fields.length) fields[fields.length - 1].instr += instrBuf;
      instrBuf = '';
    } else {
      captureBuf = '';
    }
    capture = null;
  }

  while ((m = TOKEN.exec(xml))) {
    const between = xml.slice(last, m.index);
    last = TOKEN.lastIndex;
    if (between && capture === 'w:t') feedText(between);
    else if (between && capture === 'w:delText') feedText(between);
    else if (between && capture === 'w:instrText') feedText(between);

    const closing = m[1] === '/';
    const name = m[2];
    const tagText = m[0];
    const selfClose = m[4] === '/';

    if (closing) {
      if (capture && name === capture) {
        flushCapture();
        continue;
      }
      if (name === 'w:p') { finishParagraph(); continue; }
      if (name === 'w:r') { if (run) { if (cur) cur.runs.push(run); run = null; } continue; }
      if (name === 'w:tc') { if (cell && row) { row.push(cell); cell = null; } continue; }
      if (name === 'w:tr') { if (row && table) { table.rows.push(row); row = null; } continue; }
      if (name === 'w:tbl') {
        if (table) {
          if (table.rows.length) {
            const html = renderTable(table.rows);
            pushBlock({ type: 'table', plain: '', html });
          }
          table = null;
        }
        continue;
      }
      if (name === 'w:del') { inDel = Math.max(0, inDel - 1); continue; }
      if (name === 'w:hyperlink' || name === 'w:fldSimple') { link = linkStack.pop() || ''; continue; }
      if (name === 'w:tblPr' || name === 'w:sectPr') continue;
      continue;
    }

    // 打开标签
    if (name === 'w:p') {
      if (cell) { /* 单元格里的段落 */ }
      cur = { runs: [], plain: '', style: null, align: null, list: false, images: [], alt: '' };
      continue;
    }
    if (name === 'w:tbl') {
      table = { rows: [] };
      continue;
    }
    if (name === 'w:tr') { row = []; continue; }
    if (name === 'w:tc') { cell = { blocks: [], plain: '' }; continue; }

    if (name === 'w:pStyle') { if (cur) cur.style = attr(tagText, 'w:val'); continue; }
    if (name === 'w:jc') { if (cur) cur.align = attr(tagText, 'w:val'); continue; }
    if (name === 'w:numPr') { if (cur) cur.list = true; continue; }

    if (name === 'w:r') {
      run = { parts: [], imgs: [], b: false, i: false, u: false, link };
      continue;
    }
    if (name === 'w:b') {
      if (run) { const v = attr(tagText, 'w:val'); run.b = !(v === '0' || v === 'false'); }
      continue;
    }
    if (name === 'w:i') {
      if (run) { const v = attr(tagText, 'w:val'); run.i = !(v === '0' || v === 'false'); }
      continue;
    }
    if (name === 'w:u') {
      if (run) { const v = attr(tagText, 'w:val'); run.u = v !== 'none' && v !== '0'; }
      continue;
    }

    if (name === 'w:t' || name === 'w:instrText' || name === 'w:delText') {
      if (!selfClose) {
        capture = name;
        captureBuf = '';
      }
      continue;
    }

    if (name === 'w:br' || name === 'w:cr') {
      if (run) run.parts.push('<br>');
      continue;
    }
    if (name === 'w:tab') {
      if (run) run.parts.push('<span class="doc-tab"></span>');
      continue;
    }

    if (name === 'wp:docPr') {
      const descr = attr(tagText, 'descr') || attr(tagText, 'title') || '';
      if (descr) pendingAlt = descr;
      continue;
    }
    if (name === 'a:blip' || name === 'v:imagedata') {
      const rid = attr(tagText, 'r:embed') || attr(tagText, 'r:id');
      if (rid) addImage(rid);
      continue;
    }
    if (name === 'w:del') { inDel++; continue; }

    /* 域代码外壳：HYPERLINK 域的「结果」可能是一段字，也可能是一张图标（WPS/在线文档那种） */
    if (name === 'w:fldChar') {
      const type = attr(tagText, 'w:fldCharType');
      if (type === 'begin') {
        fields.push({ instr: '', pushed: false });
        instrBuf = '';
      } else if (type === 'separate') {
        const f = fields[fields.length - 1];
        if (f) {
          const hm = f.instr.match(/HYPERLINK\s+"([^"]+)"/i);
          const href = hm ? safeHref(hm[1]) : '';
          if (href) { linkStack.push(link); link = href; f.pushed = true; }
        }
      } else if (type === 'end') {
        const f = fields.pop();
        if (f && f.pushed) link = linkStack.pop() || '';
      }
      continue;
    }

    /* 超链接：<w:hyperlink r:id="rId7">…</w:hyperlink>，URL 在 rels 里 */
    if (name === 'w:hyperlink') {
      const rid = attr(tagText, 'r:id');
      const rel = rid ? ctx.rels[rid] : null;
      linkStack.push(link);
      link = rel && rel.external ? safeHref(rel.target) : link; // w:anchor（页内跳转）没法落地，保持外层链接
      if (selfClose) link = linkStack.pop() || '';
      continue;
    }
    /* 老式域代码：<w:fldSimple w:instr=' HYPERLINK "https://…" '> */
    if (name === 'w:fldSimple') {
      const instr = decodeXmlEntities(attr(tagText, 'w:instr') || '');
      const hm = instr.match(/HYPERLINK\s+"([^"]+)"/i);
      linkStack.push(link);
      if (hm) link = safeHref(hm[1]) || link;
      if (selfClose) link = linkStack.pop() || '';
      continue;
    }

    if (BLOCK_SKIP.has(name)) continue;
  }

  finishParagraph();

  function renderTable(rows) {
    const trs = rows.map((cells) => {
      const tds = cells.map((c) => {
        const inner = (c.blocks || []).map((b) => b.html || '').join('') || escapeHtml(c.plain || '');
        return `<td>${inner}</td>`;
      });
      return `<tr>${tds.join('')}</tr>`;
    });
    return `<div class="doc-table-wrap"><table class="doc-table"><tbody>${trs.join('')}</tbody></table></div>`;
  }

  // 表格里的段落：finishParagraph 直接 push 到 blocks，这里把它们收回单元格
  // （为简单起见，表格走的是另一条通路：见下面 tableMode 说明）

  let html = blocks.map((b) => b.html || '').join('\n');
  if (html.length > ctx.maxHtmlChars) {
    const cut = html.slice(0, ctx.maxHtmlChars);
    const safe = cut.slice(0, Math.max(0, cut.lastIndexOf('<')));
    html = `${safe}\n<p class="doc-p doc-cut">（这篇太长了，后面的内容没有完整载入）</p>`;
    note.truncated = true;
  }

  const plain = blocks.map((b) => b.plain || '').filter(Boolean).join('\n');
  return { html, plain, note };
}

/* ------------------------------------------------------------------ */
/* 对外入口                                                            */
/* ------------------------------------------------------------------ */

/**
 * @param {string} filePath  上传到磁盘的 .docx
 * @param {string} outDirAbs 照片落地目录（一般是 uploads/posts/<postId>）
 * @param {string} urlBase   照片对外访问前缀（默认 /uploads/posts/<postId>）
 */
async function convertDocx(filePath, outDirAbs, urlBase) {
  const maxXml = (config.MAX_DOC_XML_MB || 192) * 1024 * 1024;

  let relsXml = '';
  let stylesXml = '';
  let docXml = '';

  await walkZip(filePath, async (entry, zip) => {
    const n = entry.fileName.toLowerCase();
    if (n === 'word/_rels/document.xml.rels') relsXml = (await readEntry(zip, entry, 8 * 1024 * 1024)).toString('utf8');
    else if (n === 'word/styles.xml') stylesXml = (await readEntry(zip, entry, 16 * 1024 * 1024)).toString('utf8');
    else if (n === 'word/document.xml') docXml = (await readEntry(zip, entry, maxXml)).toString('utf8');
  });

  if (!docXml) throw new Error('这个 .docx 里没找到正文（可能是个空文档，或者导出时只存了图片）');

  const relMap = parseRels(relsXml);
  const styles = parseStyles(stylesXml);

  fs.mkdirSync(outDirAbs, { recursive: true });

  // 第二遍：把真正用到的照片解压出来
  // 注意：同一个 media 文件可能被多个 rId 引用（复制粘贴出来的图片），
  // 所以落盘文件名只跟 media 文件名有关，多个 rId 共用同一个 URL。
  const wanted = new Map(); // 'media/image1.png' -> { name, url }
  for (const rel of Object.values(relMap)) {
    const base = path.basename(rel.target);
    const ext = path.extname(base).toLowerCase();
    if (!IMG_EXT_OK.includes(ext)) { rel.url = null; continue; }
    const safe = base.replace(/[^\w.-]/g, '_');
    rel.url = `${urlBase}/${safe}`;
    if (!wanted.has(rel.target)) wanted.set(rel.target, { name: safe, url: rel.url });
  }

  const budget = (config.MAX_DOC_IMAGES_MB || 4096) * 1024 * 1024;
  let used = 0;
  const images = [];
  let skippedBig = 0;

  if (wanted.size) {
    await walkZip(filePath, async (entry, zip) => {
      if (!entry.fileName.toLowerCase().startsWith('word/media/')) return;
      const key = `media/${path.basename(entry.fileName)}`;
      const w = wanted.get(key);
      if (!w) return;
      if (entry.uncompressedSize > budget - used) {
        // 照片总量到顶了：剩下的不再落盘，正文里会跳过
        skippedBig++;
        for (const [rid, rel] of Object.entries(relMap)) {
          if (rel.target === key) rel.url = null;
        }
        return;
      }
      const dest = path.join(outDirAbs, w.name);
      const bytes = await copyEntry(zip, entry, dest);
      used += bytes;
      images.push({ name: entry.fileName.replace(/^word\/media\//, ''), file: w.name, url: w.url, bytes });
    });
  }

  const { html, plain, note } = documentXmlToHtml(docXml, {
    rels: relMap,
    styles,
    maxHtmlChars: config.MAX_DOC_HTML_CHARS || 6000000,
  });

  note.skipped += skippedBig;
  note.imageBytes = used;

  return {
    html,
    text: plain,
    chars: plain.length,
    images,
    imageCount: images.length,
    imagesSkipped: note.skipped,
    paragraphs: note.paragraphs,
    truncated: note.truncated,
    imageBytes: used,
  };
}

/** 纯文本类文档整篇当一条回忆：不保留格式，只保留换行 */
function textToHtml(text) {
  const paras = String(text || '')
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
  return paras.map((p) => `<p class="doc-p">${linkifyText(escapeHtml(p)).replace(/\n/g, '<br>')}</p>`).join('\n');
}

/** 删掉某条回忆的照片目录（删回忆时调用，免得磁盘越攒越满） */
function removePostDir(postId) {
  if (!postId) return;
  const dir = path.join(config.UPLOAD_DIR, 'posts', String(postId).replace(/[^\w-]/g, ''));
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_) { /* ignore */ }
}

module.exports = { convertDocx, textToHtml, removePostDir, escapeHtml };