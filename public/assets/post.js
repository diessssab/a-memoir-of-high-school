/* 回忆详情页 */
(() => {
  const id = location.pathname.split('/').filter(Boolean).pop();
  const root = document.getElementById('post-root');
  let me = null;

  App.initLightbox();
  App.bindModalClosers();

  async function loadPost() {
    try {
      const { post } = await App.api(`/api/posts/${id}`);
      document.title = `${post.title || '回忆'} · ${App.brand().siteTitle}`;
      const imgs = (post.images || [])
        .map((s) => `<img src="${App.esc(s)}" data-zoom="${App.esc(s)}" alt="配图">`)
        .join('');
      // 整篇文档（一份 Word 就是一条回忆）：正文是服务端生成的 HTML，图文顺序已排好，
      // 里面的文字都在生成时转义过了，所以可以直接插进 DOM。
      const flex = !!post.flex;
      const bodyHtml = flex
        ? (post.html
            ? `<div class="doc-body" id="doc-body">${post.html}</div>`
            : `<div class="post-body">${App.esc(post.content)}</div>`)
        : `<div class="post-body">${App.esc(post.content)}</div>`;
      const docBar = flex
        ? `<div class="doc-meta-bar">
             ${post.docName ? `<span>原文档：${App.esc(post.docName)}${post.docSize ? `（${(post.docSize / 1048576).toFixed(1)}MB）` : ''}</span>` : ''}
             ${post.imageCount ? `<span>· 共 ${post.imageCount} 张照片${post.imageBytes ? `（${(post.imageBytes / 1048576).toFixed(0)}MB，往下滑会一张张加载）` : ''}</span>` : ''}
           </div>`
        : '';
      root.innerHTML = `
        <div class="post-head">
          <div class="row wrap" style="margin-bottom:10px">
            <span class="tag">${App.esc(post.author.label)}</span>
            <span class="muted" style="font-size:13px">${App.fmtTime(post.createdAt)}</span>
            ${post.pinned ? '<span class="tag red">置顶</span>' : ''}
            ${post.updatedAt && post.updatedAt - post.createdAt > 1000
              ? `<span class="muted" style="font-size:12px">（${App.fmtAgo(post.updatedAt)}编辑过）</span>` : ''}
          </div>
          ${post.title ? `<h1>${App.esc(post.title)}</h1>` : ''}
          ${docBar}
        </div>
        ${bodyHtml}
        ${!flex && imgs ? `<div class="post-imgs">${imgs}</div>` : ''}
        <div class="row wrap" style="margin-top:22px;gap:14px">
          <button class="btn ghost small" id="like-btn">${post.liked ? '♥ 已共鸣' : '♡ 有共鸣'} <span id="like-n">${post.likeCount}</span></button>
          <button class="btn ghost small" id="copy-btn">复制链接</button>
          ${me && me.user && (me.user.id === post.uid || me.admin)
            ? `<button class="btn ghost small" id="del-btn" style="color:var(--red)">删除这条</button>` : ''}
          <span class="spacer"></span>
          <a class="btn ghost small" href="/wall.html">回到墙上</a>
        </div>`;
      if (flex) {
        // 正文里的照片带 data-zoom，common.js 的灯箱会自动接管，这里不用再绑
      }

      document.getElementById('like-btn').addEventListener('click', async () => {
        try {
          const r = await App.api(`/api/posts/${id}/like`, { method: 'POST' });
          document.getElementById('like-n').textContent = r.likeCount;
          document.getElementById('like-btn').innerHTML = `${r.liked ? '♥ 已共鸣' : '♡ 有共鸣'} <span id="like-n">${r.likeCount}</span>`;
          bindLike();
        } catch (err) {
          App.toast(err.message, 'err');
        }
      });
      bindLike();
      document.getElementById('copy-btn').addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(location.href);
          App.toast('链接已复制');
        } catch (_) {
          App.toast('复制失败，请手动复制地址栏', 'err');
        }
      });
      const del = document.getElementById('del-btn');
      if (del) {
        del.addEventListener('click', async () => {
          if (!confirm('确定删除这条回忆吗？删除后无法恢复。')) return;
          try {
            await App.api(`/api/posts/${id}`, { method: 'DELETE' });
            App.toast('已删除');
            setTimeout(() => (location.href = '/wall.html'), 600);
          } catch (err) { App.toast(err.message, 'err'); }
        });
      }
      loadComments();
    } catch (err) {
      root.innerHTML = `<div class="empty">${App.esc(err.message)}<br><br><a class="btn ghost" href="/wall.html">回到回忆墙</a></div>`;
    }
  }

  function bindLike() {
    // 重新绑定（innerHTML 替换后 id 会重建）
    const b = document.getElementById('like-btn');
    if (!b) return;
    b.onclick = async () => {
      try {
        const r = await App.api(`/api/posts/${id}/like`, { method: 'POST' });
        b.innerHTML = `${r.liked ? '♥ 已共鸣' : '♡ 有共鸣'} <span id="like-n">${r.likeCount}</span>`;
      } catch (err) {
        App.toast(err.message, 'err');
      }
    };
  }

  async function loadComments() {
    const box = document.getElementById('comments');
    try {
      const { items } = await App.api(`/api/posts/${id}/comments`);
      document.getElementById('c-count').textContent = items.length ? `（${items.length}）` : '';
      box.innerHTML = items.length
        ? items.map((c) => `
          <div class="comment">
            <span class="avatar">${App.esc((c.author.name || '客').slice(0, 1))}</span>
            <div class="c-main">
              <div class="c-top">
                <span class="c-name">${App.esc(c.author.label)}</span>
                <span>${App.fmtAgo(c.createdAt)}</span>
                ${c.hidden ? '<span class="tag red">已隐藏</span>' : ''}
              </div>
              <div class="c-text">${App.esc(c.content)}</div>
            </div>
          </div>`).join('')
        : '<div class="muted" style="font-size:13px;padding:10px 0">还没有人说话，你可以是第一个。</div>';
    } catch (err) {
      box.innerHTML = `<div class="muted">${App.esc(err.message)}</div>`;
    }
  }

  document.getElementById('c-submit').addEventListener('click', async () => {
    const input = document.getElementById('c-input');
    const content = input.value.trim();
    if (!content) return App.toast('写点什么再发吧', 'err');
    try {
      await App.api(`/api/posts/${id}/comments`, { method: 'POST', body: { content } });
      input.value = '';
      App.toast('已发表');
      loadComments();
    } catch (err) {
      App.toast(err.message, 'err');
      if (err.status === 401) setTimeout(() => (location.href = '/index.html'), 800);
    }
  });

  (async () => {
    me = await App.renderTopbar('wall');
    loadPost();
  })();
})();