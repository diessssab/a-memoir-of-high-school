'use strict';
/**
 * 文档导入：把"金山文档（WPS）共享文档"里的内容变成一条条回忆。
 *
 * 三条路径，按可行性从高到低：
 *   1) 文件导入 —— 在金山文档里【下载 / 导出为 .docx 或 .txt】，再上传。最稳，推荐。
 *   2) 文本粘贴 —— 直接复制金山文档正文粘贴进来。
 *   3) 链接导入 —— 粘贴 kdocs.cn 公开分享链接，服务端尝试抓取。
 *      注意：金山文档的分享页多数是前端渲染 + 需要登录态，抓取成功率不固定；
 *      抓不到时会明确提示你改用前两种方式，不会假装成功。
 *
 * 大文件（最大 500MB）策略：
 *   - 上传本身走磁盘流，不进内存（见 routes/docs.js 的 diskStorage）。
 *   - 纯文本 / CSV / MD 用 readline 逐行流式解析，内存占用只和"单条回忆"有关，
 *     和文件多大无关；到 MAX_IMPORT_ENTRIES 条或 MAX_IMPORT_LINES 行就停下并标记 truncated。
 *   - .docx 用 yauzl 流式解压 word/document.xml，边解边抽 <w:t> 文字，
 *     同样不吃整份文件的内存；只有极小的 docx 才回落到 mammoth 兜底解析。
 */
const fs = require('fs');
const readline = require('readline');
const mammoth = require('mammoth');
const yauzl = require('yauzl');
const config = require('./config');

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/* ------------------------------------------------------------------ */
/* 1. 把各种文件变成纯文本                                             */
/* ------------------------------------------------------------------ */

function stripHtml(html) {
  let s = String(html);
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n');
  s = s.replace(/<li[^>]*>/gi, '· ');
  s = s.replace(/<[^>]+>/g, '');
  const entities = {
    '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
    '&#39;': "'", '&ldquo;': '“', '&rdquo;': '”', '&mdash;': '—', '&hellip;': '…',
  };
  s = s.replace(/&[a-zA-Z#0-9]+;/g, (m) => entities[m] || m);
  return s.replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** 把上传的文件 Buffer 解析成纯文本（只在文件不大时使用；大文件走 parseFile） */
async function bufferToText(buffer, filename = '') {
  const lower = filename.toLowerCase();
  const isDocx = lower.endsWith('.docx') || lower.endsWith('.doc');
  if (isDocx) {
    if (lower.endsWith('.doc')) {
      throw new Error('不支持旧版 .doc 格式，请在金山文档/WPS 里另存为 .docx 后再导入');
    }
    // mammoth 只吃 docx（zip 包），先看是不是 zip 魔数
    if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
      throw new Error('这个文件不是有效的 .docx（可能是网页改名或加密文档），请重新导出');
    }
    const result = await mammoth.extractRawText({ buffer });
    return { text: result.value, format: 'docx' };
  }
  if (lower.endsWith('.pdf')) {
    throw new Error('暂不支持直接解析 PDF，请在金山文档里导出为 .docx 或 .txt 再导入');
  }
  if (lower.endsWith('.html') || lower.endsWith('.htm')) {
    return { text: stripHtml(buffer.toString('utf8')), format: 'html' };
  }
  if (lower.endsWith('.json')) {
    return { text: buffer.toString('utf8'), format: 'json' };
  }
  // txt / md / csv 等按 UTF-8 读；带 BOM 的去掉
  let text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  // 简单判断是不是乱码（GBK 直接按 UTF-8 读会出现大量 ）
  const bad = (text.match(/\ufffd/g) || []).length;
  if (bad > 20 && bad / text.length > 0.02) {
    throw new Error('文件编码可能不是 UTF-8（像是 GBK）。请用记事本另存为 UTF-8 后重试');
  }
  return { text, format: lower.endsWith('.csv') ? 'csv' : 'text' };
}

/* ------------------------------------------------------------------ */
/* 2. 从金山文档链接抓取                                               */
/* ------------------------------------------------------------------ */

/** 从 HTML 里尽力捞出正文 */
function htmlToContent(html) {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripHtml(titleMatch[1]).trim() : '';

  // 有些分享页会把正文塞进 __INITIAL_STATE__ / window.__DATA__ 之类的 JSON
  const chunks = [];
  const jsonBlocks = html.match(/"(?:content|text|body|html|value)"\s*:\s*"((?:[^"\\]|\\.){80,})"/g) || [];
  for (const blk of jsonBlocks.slice(0, 200)) {
    const m = blk.match(/"((?:[^"\\]|\\.){80,})"\s*$/);
    if (!m) continue;
    try {
      const decoded = JSON.parse(`"${m[1]}"`);
      const plain = stripHtml(decoded);
      if (plain.length > 40) chunks.push(plain);
    } catch (_) { /* 忽略坏块 */ }
  }
  const fallback = stripHtml(html);
  const best = chunks.join('\n\n').length > 200 ? chunks.join('\n\n') : fallback;
  return { title, text: best };
}

async function fetchSharedDoc(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    throw new Error('链接格式不对，请粘贴完整的 https:// 开头的地址');
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('只支持 http/https 链接');

  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  };

  let res;
  try {
    res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  } catch (err) {
    throw new Error(`抓取失败（${err.name === 'TimeoutError' ? '超时' : err.message}）。可能是网络不通或对方需要登录。`);
  }
  if (!res.ok) {
    throw new Error(`金山文档返回 HTTP ${res.status}，说明这个链接不是公开可读的。请在金山文档里把分享权限设为"获得链接的人可查看"，或改用文件导入。`);
  }

  const ct = String(res.headers.get('content-type') || '').toLowerCase();
  const buf = Buffer.from(await res.arrayBuffer());

  if (ct.includes('wordprocessingml') || ct.includes('officedocument') || buf.slice(0, 2).toString() === 'PK') {
    const { text } = await bufferToText(buf, 'shared.docx');
    return { text, format: 'docx', title: '' };
  }
  const text = buf.toString('utf8');
  if (ct.includes('json')) {
    const obj = JSON.parse(text);
    const guess = obj.content || obj.data || obj.text || JSON.stringify(obj);
    return { text: stripHtml(typeof guess === 'string' ? guess : JSON.stringify(guess)), format: 'json', title: obj.title || '' };
  }
  return { ...htmlToContent(text), format: 'html' };
}

/* ------------------------------------------------------------------ */
/* 3. 把纯文本切成一条条回忆                                           */
/* ------------------------------------------------------------------ */

const GRADE_LINE = /^\s*(?:(19\d{2}|20\d{2}|\d{2})\s*[级屆届]\s*)?(?:(\d{1,2})\s*班\s*)?([\u4e00-\u9fa5·•]{2,6})\s*[:：]?\s*$/;

function normalizeYear(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (s.length === 4) return Number(s);
  if (s.length === 2) {
    const n = Number(s);
    // 56~99 视为 19xx，00~30 视为 20xx
    return n >= 40 ? 1900 + n : 2000 + n;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 解析 "1998级3班 张三" / "98届初三(3)班张三" 这类署名行 */
function parseAuthorLine(line) {
  const t = line.trim().replace(/^[-—*·\s]+/, '').replace(/[:：]\s*$/, '');
  if (!t || t.length > 24) return null;
  const m = t.match(GRADE_LINE);
  if (!m) return null;
  const [, grade, cls, name] = m;
  if (!name) return null;
  const hasAnchor = Boolean(grade || cls) || /[:：]$/.test(line.trim());
  if (!hasAnchor) return null;
  return { year: normalizeYear(grade), className: cls || '', name };
}

/** 拆一行 CSV / TSV（支持双引号转义） */
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',' || ch === '\t') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const CSV_HEADER_HINT = /(姓名|名字)/;

/** 根据表头算各列下标；不像表头就返回 null */
function csvColumns(headerLine) {
  if (!headerLine || !/[,\t]/.test(headerLine) || !CSV_HEADER_HINT.test(headerLine)) return null;
  const header = splitCsvLine(headerLine);
  const idx = (names) => header.findIndex((h) => names.some((n) => h.includes(n)));
  const cols = {
    iYear: idx(['级', '届', '年份', '毕业']),
    iClass: idx(['班']),
    iName: idx(['姓名', '名字', '谁']),
    iTitle: idx(['标题', '题目']),
    iContent: idx(['回忆', '内容', '正文', '故事', '描述', '留言']),
    sep: headerLine.includes('\t') ? '\t' : ',',
  };
  if (cols.iName < 0 || cols.iContent < 0) return null;
  return cols;
}

function csvRowToEntry(line, cols, maxChars) {
  const cells = splitCsvLine(line);
  const content = String(cells[cols.iContent] || '').slice(0, maxChars);
  if (content.trim().length < 2) return null;
  return {
    year: cols.iYear >= 0 ? normalizeYear(String(cells[cols.iYear] || '').replace(/[^\d]/g, '')) : null,
    className: cols.iClass >= 0 ? String(cells[cols.iClass] || '').replace(/[^\d]/g, '') : '',
    name: String(cells[cols.iName] || '').slice(0, 20),
    title: cols.iTitle >= 0 ? String(cells[cols.iTitle] || '').slice(0, 60) : '',
    content,
    source: 'table',
  };
}

/**
 * 逐行喂料的解析器：文本模式和表格模式共用一套。
 * 流式读文件和一次性读字符串都走它，保证两种入口的解析结果一致。
 */
function makeEntryParser(defaultTitle = '') {
  const maxChars = config.MAX_POST_CHARS;
  const entries = [];
  let cur = null;
  let lineNo = 0;
  let cols = null;          // 表格模式生效时非 null
  let headerSeen = false;   // 已经处理过第一行
  let truncated = false;

  const push = () => {
    if (!cur) return;
    const body = cur.lines.join('\n').trim();
    if (body.length >= 2) {
      entries.push({
        year: cur.year,
        className: cur.className,
        name: cur.name,
        title: cur.title || defaultTitle,
        content: body.slice(0, maxChars),
        source: 'text',
      });
    }
    cur = null;
  };

  function feed(line) {
    if (entries.length >= config.MAX_IMPORT_ENTRIES) { truncated = true; return; }
    lineNo++;
    if (lineNo > config.MAX_IMPORT_LINES) { truncated = true; return; }

    // 第一行：先判断是不是 CSV/TSV 表头
    if (!headerSeen) {
      headerSeen = true;
      const maybe = csvColumns(line);
      if (maybe) { cols = maybe; return; }
    }
    if (cols) {
      if (!line.trim()) return;
      const e = csvRowToEntry(line, cols, maxChars);
      if (e) {
        entries.push(e);
        truncated = entries.length >= config.MAX_IMPORT_ENTRIES;
      }
      return;
    }

    const author = parseAuthorLine(line);
    if (author) {
      push();
      cur = { ...author, title: '', lines: [] };
      return;
    }
    if (!cur) {
      if (!line.trim()) return;
      cur = { year: null, className: '', name: '', title: '', lines: [] };
    }
    // 连续两个空行 → 视为分段边界
    if (!line.trim() && cur.lines.length && !cur.lines[cur.lines.length - 1].trim()) {
      push();
      return;
    }
    cur.lines.push(line);
  }

  function done() {
    push();
    // 文档开头没有署名的块（多半是标题或说明文字），在有条目的情况下忽略
    while (entries.length > 1 && !entries[0].name) entries.shift();
    return {
      entries: entries.filter((e) => e.content.replace(/\s/g, '').length >= 2),
      lines: lineNo,
      // 流式读取到上限时会提前 stop()，那时还没轮到下一次 feed 去置位，
      // 所以这里补一个判断：条目数已经顶到上限，就是被截断了。
      truncated: truncated || entries.length >= config.MAX_IMPORT_ENTRIES,
    };
  }

  /** 是否已经触到上限（行数 / 条目数），用于流式读取时提前收工 */
  function overflowed() {
    return truncated || lineNo > config.MAX_IMPORT_LINES || entries.length >= config.MAX_IMPORT_ENTRIES;
  }

  return { feed, done, overflowed };
}

/** 一次性解析一段文本（粘贴导入、链接抓取、小文件都走这里） */
function parseEntries(rawText, defaultTitle = '') {
  const text = String(rawText || '').replace(/\r\n?/g, '\n').trim();
  if (!text) return [];
  const p = makeEntryParser(defaultTitle);
  for (const line of text.split('\n')) p.feed(line);
  return p.done().entries;
}

/* ------------------------------------------------------------------ */
/* 4. 从磁盘上的文件解析（站长大文件，默认 2.5GB）                                   */
/* ------------------------------------------------------------------ */

const TEXTY = ['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log'];

function extOf(filename) {
  const m = /(\.[a-z0-9]+)$/i.exec(String(filename || ''));
  return m ? m[1].toLowerCase() : '';
}

/**
 * 流式读取一个大文本文件，逐行喂给解析器。
 * 内存只和"当前这条回忆"相关，2.5GB 的文件也不会 OOM。
 */
function parseTextFileStream(filePath, defaultTitle = '') {
  return new Promise((resolve, reject) => {
    const parser = makeEntryParser(defaultTitle);
    let totalChars = 0;
    let bad = 0;
    let stopped = false;
    const previewParts = [];
    let previewLen = 0;

    const stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 1 << 20 });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    const stop = (err) => {
      if (stopped) return;
      stopped = true;
      rl.close();
      stream.destroy();
      if (err) reject(err);
      else finish();
    };

    const finish = () => {
      const r = parser.done();
      if (bad > 200 && bad / Math.max(1, totalChars) > 0.02) {
        return reject(new Error('文件编码可能不是 UTF-8（像是 GBK）。请用记事本另存为 UTF-8 后重试'));
      }
      resolve({
        entries: r.entries,
        lines: r.lines,
        chars: totalChars,
        truncated: r.truncated,
        preview: previewParts.join('').slice(0, 4000),
      });
    };

    rl.on('line', (rawLine) => {
      if (stopped) return;
      const line = rawLine.charCodeAt(0) === 0xfeff ? rawLine.slice(1) : rawLine;
      totalChars += line.length + 1;
      for (let i = 0; i < line.length; i++) if (line.charCodeAt(i) === 0xfffd) bad++;
      if (previewLen < 4000) {
        const piece = line + '\n';
        previewParts.push(piece);
        previewLen += piece.length;
      }
      parser.feed(line);
      // 条目或行数到顶就提前收工，别把 2.5GB 白读一遍
      if (parser.overflowed()) stop();
    });
    rl.on('close', () => stop());
    rl.on('error', (err) => stop(err));
    stream.on('error', (err) => stop(err));
  });
}

/* ------------------------------------------------------------------ */
/* 1.5 流式读 .docx（不吃整份文件的内存，500MB 也能跑）                 */
/* ------------------------------------------------------------------ */

function decodeXmlEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

/**
 * 把 word/document.xml 的字节流变成一条条回忆。
 * 只认 <w:t> 里的文字，</w:p> 当一个换行，<w:tab/> 当制表符。
 */
function xmlToEntries(stream, defaultTitle = '') {
  const parser = makeEntryParser(defaultTitle);
  return new Promise((resolve, reject) => {
    const TOKEN = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<w:cr\s*\/>|<\/w:p>/g;
    let carry = '';
    let line = '';
    let chars = 0;
    let preview = '';
    let stopped = false;

    const flushLine = () => {
      excerpt(line);
      parser.feed(line);
      line = '';
      if (parser.overflowed()) stop();
    };

    function excerpt(t) {
      if (preview.length < 4000) preview += (t || '') + '\n';
    }

    stream.on('data', (chunk) => {
      if (stopped) return;
      carry += chunk.toString('utf8');
      let consumed = 0;
      let m;
      TOKEN.lastIndex = 0;
      while ((m = TOKEN.exec(carry))) {
        consumed = TOKEN.lastIndex;
        if (m[1] !== undefined) {
          const t = decodeXmlEntities(m[1]);
          chars += t.length;
          line += t;
        } else if (m[0] === '</w:p>') {
          flushLine();
          if (stopped) return;
        } else if (m[0].startsWith('<w:tab')) {
          line += '\t';
        } else {
          // <w:br/> / <w:cr/>
          flushLine();
        }
      }
      if (consumed) carry = carry.slice(consumed);
      // 万一整段都是看不懂的标签，别让 carry 无限长
      if (carry.length > 262144) carry = carry.slice(-1024);
    });

    stream.on('end', () => {
      if (stopped) return;
      if (line) flushLine();
      const r = parser.done();
      resolve({ entries: r.entries, lines: r.lines, truncated: r.truncated, chars, preview: preview.slice(0, 4000) });
    });
    stream.on('error', (err) => { if (!stopped) reject(err); });

    function stop() {
      stopped = true;
      const r = parser.done();
      try { stream.destroy(); } catch (_) { /* ignore */ }
      resolve({ entries: r.entries, lines: r.lines, truncated: r.truncated, chars, preview: preview.slice(0, 4000) });
    }
  });
}

/** 流式打开 .docx，只解压 word/document.xml */
function parseDocxStream(filePath, defaultTitle = '') {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err) return reject(new Error('这个 .docx 打不开，可能文件已损坏，或者不是真正的 Word 文档'));
      let settled = false;
      const fail = (e) => {
        if (settled) return;
        settled = true;
        try { zip.close(); } catch (_) {}
        reject(e);
      };
      zip.on('error', fail);
      zip.on('entry', (entry) => {
        if (/^word\/document\.xml$/i.test(entry.fileName)) {
          zip.openReadStream(entry, (e2, rs) => {
            if (e2) return fail(e2);
            xmlToEntries(rs, defaultTitle).then((r) => {
              if (settled) return;
              settled = true;
              try { zip.close(); } catch (_) {}
              resolve(r);
            }, fail);
          });
        } else {
          zip.readEntry();
        }
      });
      zip.on('end', () => fail(new Error('这个 .docx 里没找到正文（word/document.xml），可能是个空文档')));
      zip.readEntry();
    });
  });
}

/**
 * 统一的"给我一个文件，还我一堆回忆"入口。
 * 返回 { format, entries, chars, lines, truncated, preview, title }
 */
async function parseFile(filePath, filename = '', defaultTitle = '') {
  const ext = extOf(filename);
  const stat = fs.statSync(filePath);

  if (ext === '.doc' || ext === '.pdf') {
    throw new Error(
      ext === '.doc'
        ? '不支持旧版 .doc 格式，请在金山文档/WPS 里另存为 .docx 后再导入'
        : '暂不支持直接解析 PDF。请在金山文档里导出为 .docx 或 .txt 再导入'
    );
  }

  if (ext === '.docx') {
    // 流式解压：500MB 的 docx 也只是一边解一边抽文字，不把整份文件读进内存
    let streamed = null;
    let streamError = null;
    try {
      streamed = await parseDocxStream(filePath, defaultTitle);
    } catch (e) {
      streamError = e;
    }
    // 流式没解出东西、而且文件不大时，用 mammoth 再兜一次（兼容特殊生成的 docx）
    const smallEnough = stat.size <= 64 * 1024 * 1024;
    if ((!streamed || !streamed.entries.length) && smallEnough) {
      try {
        const buffer = fs.readFileSync(filePath);
        const { text } = await bufferToText(buffer, filename);
        const r = parseEntriesWithMeta(text, defaultTitle);
        if (r.entries.length) {
          return {
            format: 'docx',
            entries: r.entries,
            chars: text.length,
            lines: r.lines,
            truncated: r.truncated,
            preview: text.slice(0, 4000),
          };
        }
      } catch (_) { /* 兜底也失败就用流式结果 */ }
    }
    if (!streamed) throw streamError || new Error('这个 .docx 读不出内容');
    return {
      format: 'docx',
      entries: streamed.entries,
      chars: streamed.chars,
      lines: streamed.lines,
      truncated: streamed.truncated,
      preview: streamed.preview,
    };
  }

  if (ext === '.html' || ext === '.htm') {
    // HTML 都是标签，2.5GB 也没有意义；只读前 32MB
    const cap = 32 * 1024 * 1024;
    const fd = fs.openSync(filePath, 'r');
    const len = Math.min(stat.size, cap);
    const buf = Buffer.alloc(len);
    try { fs.readSync(fd, buf, 0, len, 0); } finally { fs.closeSync(fd); }
    const text = stripHtml(buf.toString('utf8'));
    const r = parseEntriesWithMeta(text, defaultTitle);
    return {
      format: 'html',
      entries: r.entries,
      chars: text.length,
      lines: r.lines,
      truncated: stat.size > cap,
      preview: text.slice(0, 4000),
    };
  }

  if (!TEXTY.includes(ext)) {
    // 未知后缀：按文本试一把，前 2000 字符是二进制的就拒掉
    const head = Buffer.alloc(2000);
    const fd = fs.openSync(filePath, 'r');
    let n = 0;
    try { n = fs.readSync(fd, head, 0, 2000, 0); } finally { fs.closeSync(fd); }
    const sample = head.slice(0, n);
    let zeros = 0;
    for (const b of sample) if (b === 0) zeros++;
    if (zeros > 4) {
      throw new Error('这个文件看起来不是文本文件。支持 .docx / .txt / .md / .csv / .html，请先导出成其中一种');
    }
  }

  const r = await parseTextFileStream(filePath, defaultTitle);
  return {
    format: ext === '.csv' || ext === '.tsv' ? 'csv' : 'text',
    entries: r.entries,
    chars: r.chars,
    lines: r.lines,
    truncated: r.truncated,
    preview: r.preview,
  };
}

/** parseEntries 的带统计版本 */
function parseEntriesWithMeta(rawText, defaultTitle = '') {
  const text = String(rawText || '').replace(/\r\n?/g, '\n').trim();
  const p = makeEntryParser(defaultTitle);
  for (const line of text.split('\n')) p.feed(line);
  const r = p.done();
  return { entries: r.entries, lines: r.lines, truncated: r.truncated };
}

module.exports = {
  bufferToText,
  fetchSharedDoc,
  parseEntries,
  parseEntriesWithMeta,
  parseFile,
  parseDocxStream,
  parseTextFileStream,
  makeEntryParser,
  stripHtml,
  normalizeYear,
  parseAuthorLine,
  extOf,
  DOCX_MIME,
};