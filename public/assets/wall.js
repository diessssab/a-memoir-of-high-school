/* 回忆墙 */
(() => {
  const wall = document.getElementById('wall');
  const searchInput = document.getElementById('search');
  const sortSelect = document.getElementById('sort');
  const mineBtn = document.getElementById('mine-btn');
  const moreBtn = document.getElementById('more-btn');
  const yearStrip = document.getElementById('year-strip');
  const writeBtn = document.getElementById('write-btn');

  const state = {
    page: 1,
    pageSize: 12,
    q: '',
    sort: 'latest',
    year: null,
    mine: false,
    hasMore: false,
    loading: false,
    user: null,
    total: 0,
  };

  App.initLightbox();
  App.bindModalClosers();

  /* ---------------- 加载列表 ---------------- */
  async function load({ append = false } = {}) {
    if (state.loading) return;
    state.loading = true;
    if (!append) { state.page = 1; }
    const params = new URLSearchParams({
      page: String(state.page),
      pageSize: String(state.pageSize),
      sort: state.sort,
    });
    if (state.q) params.set('q', state.q);
    if (state.year) params.set('year', String(state.year));
    if (state.mine) params.set('mine', '1');

    try {
      const data = await App.api(`/api/posts?${params}`);
      state.hasMore = data.hasMore;
      state.total = data.total;
      if (!append) wall.innerHTML = '';
      if (!data.items.length && !append) {
        wall.innerHTML = '';
        wall.insertAdjacentHTML('afterend', '');
        showEmpty();
      } else {
        removeEmpty();
        for (const p of data.items) wall.appendChild(renderCard(p));
      }
      moreBtn.classList.toggle('hidden', !state.hasMore);
      document.getElementById('wall-sub').textContent = state.total
        ? `共 ${state.total} 条回忆，正在被 ${state.mine ? '你' : '大家'}一条条想起来。`
        : '把它们贴在这面墙上，谁也擦不掉。';
    } catch (err) {
      App.toast(err.message, 'err');
    } finally {
      state.loading = false;
    }
  }

  function showEmpty() {
    removeEmpty();
    const div = document.createElement('div');
    div.className = 'empty';
    div.id = 'empty-box';
    div.innerHTML = state.mine
      ? '你还没有写下任何回忆。<br><br><button class="btn" id="empty-write">写第一条</button>'
      : '这一页还是空的。<br>也许你是第一个想起来的人。';
    wall.parentNode.insertBefore(div, wall.nextSibling);
    const b = document.getElementById('empty-write');
    if (b) b.addEventListener('click', openWrite);
  }
  function removeEmpty() {
    const e = document.getElementById('empty-box');
    if (e) e.remove();
  }

  /* ---------------- 渲染一张便签 ---------------- */
  function renderCard(p) {
    const el = document.createElement('article');
    el.className = 'memo';
    el.dataset.id = p.id;
    const thumbs = (p.images || [])
      .map((src) => `<img src="${App.esc(src)}" data-zoom="${App.esc(src)}" alt="配图" loading="lazy">`)
      .join('');
    // 整篇文档 = 一条回忆：拿第一张照片当封面，正文只露个开头
    const flexCover = p.flex && p.cover
      ? `<a class="doc-cover" href="/post/${App.esc(p.id)}">
           <img src="${App.esc(p.cover)}" alt="封面" loading="lazy">
           ${p.imageCount > 1 ? `<span class="doc-cover-n">共 ${p.imageCount} 张照片</span>` : ''}
         </a>`
      : '';
    el.innerHTML = `
      <div class="memo-meta">
        <span class="memo-author">${App.esc(p.author.label)}</span>
        <span>·</span>
        <span>${App.fmtTime(p.createdAt)}</span>
        ${p.pinned ? '<span class="tag red">置顶</span>' : ''}
        ${p.flex ? '<span class="tag">整篇文档</span>' : ''}
      </div>
      ${flexCover}
      ${p.title ? `<h3>${App.esc(p.title)}</h3>` : ''}
      <div class="body${p.flex ? ' doc-flex-body' : ''}">${App.esc(p.content)}</div>
      ${thumbs ? `<div class="thumbs">${thumbs}</div>` : ''}
      <div class="memo-foot">
        <button class="act ${p.liked ? 'liked' : ''}" data-like>
          <span class="heart">${p.liked ? '♥' : '♡'}</span>
          <span data-like-count>${p.likeCount}</span>
        </button>
        <a class="act" href="/post/${App.esc(p.id)}">💬 <span>${p.commentCount}</span></a>
        <span class="spacer"></span>
        <a class="act" href="/post/${App.esc(p.id)}">${p.flex ? '翻整篇 →' : '看全文 →'}</a>
      </div>`;
    el.querySelector('[data-like]').addEventListener('click', (e) => {
      e.preventDefault();
      toggleLike(p.id, el);
    });
    // 内容过长时点击展开
    const body = el.querySelector('.body');
    body.addEventListener('click', () => body.classList.toggle('open'));
    return el;
  }

  async function toggleLike(id, el) {
    if (!state.user) {
      App.toast('先登记身份才能点赞', 'err');
      setTimeout(() => (location.href = '/index.html'), 700);
      return;
    }
    const btn = el.querySelector('[data-like]');
    try {
      const r = await App.api(`/api/posts/${id}/like`, { method: 'POST' });
      btn.classList.toggle('liked', r.liked);
      btn.querySelector('.heart').textContent = r.liked ? '♥' : '♡';
      btn.querySelector('[data-like-count]').textContent = r.likeCount;
      if (r.liked) {
        const h = btn.querySelector('.heart');
        h.classList.remove('heart-pop');
        void h.offsetWidth;
        h.classList.add('heart-pop');
      }
    } catch (err) {
      App.toast(err.message, 'err');
    }
  }

  /* ---------------- 筛选交互 ---------------- */
  searchInput.addEventListener('input', App.debounce(() => {
    state.q = searchInput.value.trim();
    load();
  }, 350));

  sortSelect.addEventListener('change', () => {
    state.sort = sortSelect.value;
    load();
  });

  mineBtn.addEventListener('click', () => {
    if (!state.user) {
      App.toast('先登记身份', 'err');
      setTimeout(() => (location.href = '/index.html'), 700);
      return;
    }
    state.mine = !state.mine;
    mineBtn.classList.toggle('ghost', !state.mine);
    load();
  });

  moreBtn.addEventListener('click', () => {
    state.page += 1;
    load({ append: true });
  });

  /* 年份条 */
  async function buildYearStrip() {
    try {
      const s = await App.api('/api/stats');
      yearStrip.innerHTML = '';
      const all = document.createElement('button');
      all.className = 'year-pill on';
      all.textContent = '全部届别';
      all.addEventListener('click', () => {
        state.year = null;
        [...yearStrip.children].forEach((c) => c.classList.remove('on'));
        all.classList.add('on');
        load();
      });
      yearStrip.appendChild(all);
      for (const y of s.years) {
        const b = document.createElement('button');
        b.className = 'year-pill';
        b.textContent = `${App.gradeLabel(y.year)} · ${y.count}`;
        b.addEventListener('click', () => {
          state.year = y.year;
          [...yearStrip.children].forEach((c) => c.classList.remove('on'));
          b.classList.add('on');
          load();
        });
        yearStrip.appendChild(b);
      }
    } catch (_) {}
  }

  /* ---------------- 写回忆 ---------------- */
  const wModal = document.getElementById('write-modal');
  const wTitle = document.getElementById('w-title');
  const wContent = document.getElementById('w-content');
  const wCount = document.getElementById('w-count');
  const wFiles = document.getElementById('w-files');
  const wThumbs = document.getElementById('w-thumbs');
  const wSubmit = document.getElementById('w-submit');
  let uploaded = [];

  function openWrite() {
    if (!state.user) {
      App.toast('先登记你是几几级的谁谁谁', 'err');
      setTimeout(() => (location.href = '/index.html'), 800);
      return;
    }
    document.getElementById('write-who').textContent =
      `署名：${App.whoLabel(state.user.year, state.user.className, state.user.name)}（不可修改，如需改动请重新登记）`;
    App.openModal('write-modal');
    checkPendingDoc();
  }
  writeBtn.addEventListener('click', openWrite);

  wContent.addEventListener('input', () => {
    wCount.textContent = wContent.value.length;
  });

  wFiles.addEventListener('change', async () => {
    const files = [...wFiles.files].slice(0, 6 - uploaded.length);
    if (!files.length) return;
    const fd = new FormData();
    files.forEach((f) => fd.append('images', f));
    document.getElementById('w-file-hint').textContent = '上传中…';
    try {
      const r = await App.api('/api/upload', { method: 'POST', body: fd });
      uploaded.push(...r.files);
      renderThumbs();
      document.getElementById('w-file-hint').textContent = `已上传 ${uploaded.length} 张`;
    } catch (err) {
      App.toast(err.message, 'err');
      document.getElementById('w-file-hint').textContent = 'jpg / png / webp，每张不超过 8MB';
    }
    wFiles.value = '';
  });

  function renderThumbs() {
    wThumbs.innerHTML = uploaded
      .map((src, i) => `<span style="position:relative;display:inline-block">
          <img src="${App.esc(src)}" style="width:64px;height:64px;object-fit:cover;border:1px solid var(--line);border-radius:2px">
          <button data-rm="${i}" style="position:absolute;top:-6px;right:-6px;width:18px;height:18px;border-radius:50%;
            border:none;background:var(--red);color:#fff;font-size:12px;line-height:1;cursor:pointer">×</button>
        </span>`)
      .join('');
    wThumbs.querySelectorAll('[data-rm]').forEach((b) => {
      b.addEventListener('click', () => {
        uploaded.splice(Number(b.dataset.rm), 1);
        renderThumbs();
      });
    });
  }

  /* ---------------- 传文档（解析成多条回忆，直接发到墙上） ---------------- */
  const wDoc = document.getElementById('w-doc');
  const wDocHint = document.getElementById('w-doc-hint');
  const wDocProg = document.getElementById('w-doc-progress');
  const wDocBar = document.getElementById('w-doc-bar');
  const wDocResult = document.getElementById('w-doc-result');
  const DOC_HINT = '.docx 会整篇保留照片发出去；.txt / .md / .csv / .html 会按署名拆成一条条';

  wDoc.addEventListener('change', () => {
    const f = wDoc.files[0];
    wDoc.value = '';
    if (f) uploadDoc(f);
  });

  function setBar(pct) {
    wDocProg.classList.remove('hidden');
    wDocBar.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  }
  function hideBar() {
    setTimeout(() => {
      wDocProg.classList.add('hidden');
      wDocBar.style.width = '0%';
    }, 500);
  }

  function uploadDoc(file) {
    wDocResult.classList.add('hidden');
    wDocHint.textContent = '正在上传…';
    setBar(0);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/docs/upload');
    xhr.withCredentials = true;
    xhr.upload.addEventListener('progress', (e) => {
      if (!e.lengthComputable) return;
      const pct = (e.loaded / e.total) * 100;
      setBar(pct);
      wDocHint.textContent = `正在上传 ${pct.toFixed(0)}%（${(e.loaded / 1048576).toFixed(1)}MB / ${(e.total / 1048576).toFixed(1)}MB）`;
    });
    xhr.addEventListener('load', () => {
      hideBar();
      let data = null;
      try { data = JSON.parse(xhr.responseText || '{}'); } catch (_) { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300 && data && data.ok) {
        wDocHint.textContent = DOC_HINT;
        renderDocResult(data);
      } else {
        wDocHint.textContent = DOC_HINT;
        App.toast((data && data.error) || `上传失败（${xhr.status}）`, 'err', 5000);
      }
    });
    xhr.addEventListener('error', () => {
      hideBar();
      wDocHint.textContent = DOC_HINT;
      App.toast('上传中断了，检查一下网络再试', 'err');
    });
    const fd = new FormData();
    fd.append('doc', file);
    xhr.send(fd);
  }

  /** 显示「解析出 N 条」+ 前几条预览 + 发布按钮（整篇文档走另一套文案） */
  function renderDocResult(d) {
    const doc = d.doc || {};
    const sample = d.sample || [];
    wDocResult.classList.remove('hidden');

    if (d.flex) {
      const imgs = d.imageCount || 0;
      wDocResult.innerHTML = `
        <div class="doc-head">《${App.esc(doc.name || '文档')}》会作为 <b>一整篇</b> 发到回忆墙上，照片按原来位置排${
          imgs ? `（共 ${imgs} 张）` : ''}${d.truncated ? '（文档太长，后面的部分省略了）' : ''}</div>
        <div class="doc-sample">${sample.map((s) => `
          <div class="doc-one">
            <b>${App.esc(s.author || '佚名')}</b>${s.title ? ` · ${App.esc(s.title)}` : ''}
            <div>${App.esc(s.content || '')}…</div>
          </div>`).join('')}</div>
        <div class="row wrap" style="margin-top:12px">
          <button class="btn" id="w-doc-publish">发布这一篇</button>
          <button class="btn ghost small" id="w-doc-discard">不发了</button>
        </div>`;
    } else {
      wDocResult.innerHTML = `
        <div class="doc-head">《${App.esc(doc.name || '文档')}》解析出 <b>${d.total || 0}</b> 条回忆${
          d.truncated ? '（文档太长，只取了前面一部分）' : ''}</div>
        <div class="doc-sample">${sample.map((s) => `
          <div class="doc-one">
            <b>${App.esc(s.author || '佚名')}</b>${s.title ? ` · ${App.esc(s.title)}` : ''}
            <div>${App.esc(s.content || '')}…</div>
          </div>`).join('')}</div>
        <div class="row wrap" style="margin-top:12px">
          <button class="btn" id="w-doc-publish">把 ${d.total || 0} 条全部发到墙上</button>
          <button class="btn ghost small" id="w-doc-discard">不发了</button>
        </div>`;
    }

    document.getElementById('w-doc-publish').addEventListener('click', () => publishDoc(doc.id));
    document.getElementById('w-doc-discard').addEventListener('click', async () => {
      wDocResult.classList.add('hidden');
      wDocResult.innerHTML = '';
      try { await App.api(`/api/docs/${doc.id}`, { method: 'DELETE' }); } catch (_) { /* ignore */ }
    });
  }

  async function publishDoc(id) {
    const btn = document.getElementById('w-doc-publish');
    if (btn) { btn.disabled = true; btn.textContent = '正在发…'; }
    try {
      const r = await App.api(`/api/docs/${id}/publish`, { method: 'POST' });
      App.toast(
        r.flex
          ? '发布成功，已经排在回忆墙最上面了'
          : `已发到墙上 ${r.created} 条${r.skipped ? `，跳过重复/敏感 ${r.skipped} 条` : ''}`,
        'ok',
        4200
      );
      App.closeModal('write-modal');
      wDocResult.classList.add('hidden');
      wDocResult.innerHTML = '';
      wTitle.value = '';
      wContent.value = '';
      wCount.textContent = '0';
      uploaded = [];
      renderThumbs();
      state.mine = false;
      mineBtn.classList.add('ghost');
      await load();
      buildYearStrip();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      App.toast(err.message, 'err', 5000);
      if (btn) { btn.disabled = false; btn.textContent = '重新发布'; }
    }
  }

  /** 打开弹窗时，把上次传了还没发布的文档找出来，别让人以为白传了 */
  async function checkPendingDoc() {
    try {
      const r = await App.api('/api/docs/mine');
      const ready = (r.items || []).find((d) => d.status === 'ready');
      if (!ready) return;
      wDocResult.classList.remove('hidden');
      wDocResult.innerHTML = ready.flex
        ? `
        <div class="doc-head">你上次传的《${App.esc(ready.name)}》是一整篇文档${
          ready.imageCount ? `（${ready.imageCount} 张照片）` : ''}，还没发到墙上。</div>
        <div class="row wrap" style="margin-top:12px">
          <button class="btn" id="w-doc-publish">发布这一篇</button>
          <button class="btn ghost small" id="w-doc-discard">删掉它</button>
        </div>`
        : `
        <div class="doc-head">你上次传的《${App.esc(ready.name)}》解析出 <b>${ready.entries || 0}</b> 条，还没发到墙上。</div>
        <div class="row wrap" style="margin-top:12px">
          <button class="btn" id="w-doc-publish">把 ${ready.entries || 0} 条发出去</button>
          <button class="btn ghost small" id="w-doc-discard">删掉它</button>
        </div>`;
      document.getElementById('w-doc-publish').addEventListener('click', () => publishDoc(ready.id));
      document.getElementById('w-doc-discard').addEventListener('click', async () => {
        wDocResult.classList.add('hidden');
        wDocResult.innerHTML = '';
        try { await App.api(`/api/docs/${ready.id}`, { method: 'DELETE' }); } catch (_) { /* ignore */ }
      });
    } catch (_) { /* 没登录 / 没传过，都不管 */ }
  }

  wSubmit.addEventListener('click', async () => {
    const content = wContent.value.trim();
    if (content.replace(/\s/g, '').length < 4) {
      App.toast('再多写几个字吧', 'err');
      return;
    }
    wSubmit.disabled = true;
    wSubmit.textContent = '发送中…';
    try {
      const r = await App.api('/api/posts', {
        method: 'POST',
        body: { title: wTitle.value.trim(), content, images: uploaded },
      });
      App.closeModal('write-modal');
      App.toast(r.message || '发布成功');
      wTitle.value = '';
      wContent.value = '';
      wCount.textContent = '0';
      uploaded = [];
      renderThumbs();
      state.mine = false;
      mineBtn.classList.add('ghost');
      await load();
      buildYearStrip();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      App.toast(err.message, 'err');
    } finally {
      wSubmit.disabled = false;
      wSubmit.textContent = '发到墙上';
    }
  });

  /* ---------------- 启动 ---------------- */
  (async () => {
    const me = await App.renderTopbar('wall');
    state.user = me && me.user;
    // 站长重置过密码 → 先去改密码再来写
    if (state.user && state.user.mustChange) {
      location.replace('/account.html?must=1');
      return;
    }
    const url = new URL(location.href);
    if (url.searchParams.get('mine') === '1') {
      state.mine = true;
      mineBtn.classList.remove('ghost');
    }
    await load();
    buildYearStrip();
  })();
})();