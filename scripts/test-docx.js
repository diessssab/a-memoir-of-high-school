'use strict';
/**
 * 转换器的回归自检：造一份「带链接」的最小 .docx，转成 HTML，看链接对不对。
 *
 * 覆盖三种真实文档里会碰到的写法：
 *   1. <w:hyperlink r:id>       —— Word 里插入的超链接
 *   2. HYPERLINK 域代码          —— WPS / 在线文档的附件图标就是这种
 *   3. 正文里写死的网址           —— 在 Word 里看着像链接，其实只是文字
 * 另外确认 javascript: 这种不能进 href。
 *
 * 造 .docx 用的是 jszip（mammoth 的依赖，装 mammoth 就有）。
 * 用法：node scripts/test-docx.js   （通过退出码报告结果）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>
<w:p><w:r><w:t>普通一行字</w:t></w:r></w:p>
<w:p>
  <w:hyperlink r:id="rIdLink1"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr><w:t>点我访问学校官网</w:t></w:r></w:hyperlink>
</w:p>
<w:p>
  <w:r><w:fldChar w:fldCharType="begin"/></w:r>
  <w:r><w:instrText xml:space="preserve"> HYPERLINK "https://example.com/field?a=1&amp;b=2" </w:instrText></w:r>
  <w:r><w:fldChar w:fldCharType="separate"/></w:r>
  <w:r><w:t>域里的链接</w:t></w:r>
  <w:r><w:fldChar w:fldCharType="end"/></w:r>
</w:p>
<w:p><w:r><w:t>正文里写死的网址 https://example.com/auto?x=1&amp;y=2 也应该能点。</w:t></w:r></w:p>
<w:p><w:hyperlink r:id="rIdLink2"><w:r><w:t>危险链接</w:t></w:r></w:hyperlink></w:p>
</w:body></w:document>`;

const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rIdLink1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/one?k=1&amp;m=2" TargetMode="External"/>
<Relationship Id="rIdLink2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:alert(1)" TargetMode="External"/>
</Relationships>`;

const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

(async () => {
  let JSZip;
  try {
    JSZip = require('jszip');
  } catch (_) {
    console.log('跳过：没装 jszip（mammoth 的依赖），装完 mammoth 才有');
    return;
  }

  const zip = new JSZip();
  zip.file('[Content_Types].xml', contentTypes);
  zip.file('_rels/.rels', rootRels);
  zip.file('word/document.xml', documentXml);
  zip.file('word/_rels/document.xml.rels', relsXml);
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-check-'));
  const src = path.join(tmpDir, 'link-test.docx');
  fs.writeFileSync(src, buf);

  const docx = require('../server/docx');
  const outDir = path.join(tmpDir, 'out');
  const r = await docx.convertDocx(src, outDir, '/uploads/posts/test');
  const html = String(r.html || '');

  const cases = [
    ['Word 超链接（w:hyperlink）变成 <a>',
      /<a class="doc-link" href="https:\/\/example\.com\/one\?k=1&amp;m=2"[^>]*>点我访问学校官网<\/a>/.test(html)],
    ['域代码 HYPERLINK 变成 <a>',
      /<a class="doc-link" href="https:\/\/example\.com\/field\?a=1&amp;b=2"[^>]*>域里的链接<\/a>/.test(html)],
    ['正文里写死的网址自动变链接',
      /<a class="doc-link" href="https:\/\/example\.com\/auto\?x=1&amp;y=2"[^>]*>/.test(html)],
    ['javascript: 被拦下来（不生成 href）',
      !/href="[^"]*javascript:/i.test(html) && /危险链接/.test(html)],
    ['链接都在新标签打开，且带 noopener',
      (html.match(/<a class="doc-link"/g) || []).length === 3
      && (html.match(/target="_blank" rel="noopener noreferrer"/g) || []).length === 3],
    ['普通文字没被弄坏',
      /普通一行字/.test(html) && !/href="[^"]*&lt;/.test(html)],
  ];

  let bad = 0;
  for (const [name, ok] of cases) {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`);
    if (!ok) bad++;
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (bad) {
    console.log(`\n${bad} 项没过`);
    process.exit(1);
  }
  console.log(`\n全部 ${cases.length} 项通过`);
})().catch((e) => {
  console.error('跑挂了：', e && e.message);
  process.exit(1);
});