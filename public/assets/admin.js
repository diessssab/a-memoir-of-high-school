/* 站长后台 */
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const state = {
    tab: 'overview',
    livePaused: false,
    liveTimer: null,
    entries: [],
    rawPreview: '',
    visitors: [],
    onlyBad: false,
  };

  /* ================= 门的开关 ================= */
  async function boot() {
    const ok = await checkAdmin();
    if (ok) showShell();
    else showGate();
  }

  async function checkAdmin() {
    try {
      await App.api('/api/admin/ping');
      return true;
    } catch (_) {
      return false;
    }
  }

  function showGate() {
    $('#gate').classList.remove('hidden');
    $('#shell').classList.add('hidden');
    stopLive();
  }

  function showShell() {
    $('#gate').classList.add('hidden');
    $('#shell').classList.remove('hidden');
    startClock();
    loadTab('overview');
  }

  $('#gate-btn').addEventListener('click', doLogin);
  $('#admin-pwd').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

  async function doLogin() {
    const pwd = $('#admin-pwd').value;
    const err = $('#gate-error');
    err.classList.remove('show');
    if (!pwd) { err.textContent = '请输入密码'; err.classList.add('show'); return; }
    const btn = $('#gate-btn');
    btn.disabled = true;
    btn.textContent = '验证中…';
    try {
      await App.api('/api/admin/login', { method: 'POST', body: { password: pwd } });
      $('#admin-pwd').value = '';
      showShell();
      App.toast('欢迎回来，站长');
    } catch (e) {
      err.textContent = e.message;
      err.classList.add('show');
    } finally {
      btn.disabled = false;
      btn.textContent = '进入后台';
    }
  }

  $('#logout-btn').addEventListener('click', async () => {
    await App.api('/api/admin/logout', { method: 'POST' });
    stopLive();
    location.reload();
  });

  function startClock() {
    const el = $('#clock');
    const tick = () => { el.textContent = App.fmtClock(Date.now()); };
    tick();
    setInterval(tick, 1000);
  }

  /* ================= 标签切换 ================= */
  $('#admin-nav').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (!b) return;
    loadTab(b.dataset.tab);
  });

  function loadTab(tab) {
    state.tab = tab;
    $$('#admin-nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
    ['overview', 'live', 'visitors', 'logins', 'accounts', 'posts', 'import', 'settings'].forEach((t) => {
      $(`#tab-${t}`).classList.toggle('hidden', t !== tab);
    });
    if (tab !== 'live') stopLive();

    if (tab === 'overview') loadOverview();
    if (tab === 'live') { startLive(); }
    if (tab === 'visitors') loadVisitors();
    if (tab === 'logins') loadLogins();
    if (tab === 'accounts') loadAccounts();
    if (tab === 'posts') { loadPosts(); loadComments(); }
    if (tab === 'import') loadImportLimits();
    if (tab === 'settings') loadSettings();
  }

  /* ================= 概览 ================= */
  async function loadOverview() {
    let d;
    try {
      d = await App.api('/api/admin/overview');
    } catch (e) {
      App.toast(e.message, 'err');
      if (e.status === 401) showGate();
      return;
    }

    const cards = [
      { k: '此刻在线', v: d.onlineNow, s: '人', warn: false },
      { k: '今日访问', v: d.today.pv, s: '次' },
      { k: '今日访客', v: d.today.uv, s: '人' },
      { k: '今日登录', v: d.today.logins, s: '次' },
      { k: '今日新登记', v: d.today.newUsers, s: '人' },
      { k: '回忆总数', v: d.total.posts, s: `含隐藏 ${d.total.hiddenPosts}` },
      { k: '登记人数', v: d.total.users, s: '人' },
      { k: '评论', v: d.total.comments, s: '条' },
      { k: '访问日志', v: d.total.visits, s: `上限 ${d.retention.maxVisits}` },
      { k: '封禁 IP', v: d.total.bans, s: '个', warn: d.total.bans > 0 },
    ];
    $('#stat-grid').innerHTML = cards.map((c) => `
      <div class="stat ${c.warn ? 'warn' : ''}">
        <div class="k">${c.k}</div>
        <div class="v">${c.v}<small> ${c.s || ''}</small></div>
      </div>`).join('');

    // 24 小时柱状图
    const max = Math.max(...d.hourBuckets, 1);
    $('#chart').innerHTML = d.hourBuckets.map((n, i) => {
      const h = Math.max(2, Math.round((n / max) * 100));
      const label = i === 23 ? '现在' : `${24 - i}h 前`;
      return `<div class="bar" style="height:${h}%" data-empty="${n ? 0 : 1}" title="${label}：${n} 次访问"></div>`;
    }).join('');

    // 热门页面
    $('#top-paths').innerHTML = d.topPaths.length
      ? d.topPaths.map((p) => `
          <div class="row" style="justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--line);font-size:13px">
            <span class="mono" style="font-size:12px">${App.esc(p.path)}</span>
            <span>${p.count}</span>
          </div>`).join('')
      : '<div class="muted" style="font-size:13px">今天还没有访问记录</div>';

    // 可疑访问
    $('#suspicious').innerHTML = d.suspicious.length
      ? d.suspicious.map((r) => `
          <div class="row wrap" style="justify-content:space-between;gap:8px;padding:7px 0;border-bottom:1px solid var(--line);font-size:13px">
            <span>
              <span class="mono">${App.esc(r.ip)}</span>
              ${r.who ? `<span class="tag" style="margin-left:6px">${App.esc(r.who)}</span>` : '<span class="tag gray" style="margin-left:6px">未登记</span>'}
            </span>
            <span>
              请求 ${r.total} · 错误 ${r.bad} · ${App.fmtAgo(r.last)}
              ${r.banned
                ? '<span class="tag red" style="margin-left:6px">已封禁</span>'
                : `<button class="btn tiny ghost" data-ban="${App.esc(r.ip)}" style="margin-left:6px">封禁</button>`}
            </span>
          </div>`).join('')
      : '<div class="muted" style="font-size:13px">没有发现异常 —— 一切安静。</div>';

    $$('#suspicious [data-ban]').forEach((b) => {
      b.addEventListener('click', () => banIp(b.dataset.ban, '异常访问量'));
    });

    // 最近事件
    const evName = {
      login: '登记登录', 'admin-login': '站长登录', 'admin-login-fail': '后台密码错误',
      'post-create': '发布回忆', 'post-update': '修改回忆', 'post-delete': '删除回忆',
      'admin-post-delete': '站长删除回忆', 'admin-post-update': '站长修改回忆',
      'comment-create': '发表评论', 'comment-delete': '删除评论',
      'admin-comment-delete': '站长删除评论', 'admin-comment-update': '站长修改评论',
      'ban-add': '封禁 IP', 'ban-remove': '解除封禁', 'blocked-request': '拦截被封禁访问',
      'import-file': '导入文件', 'import-url': '导入链接', 'import-text': '导入文本',
      'import-commit': '确认导入', 'admin-settings': '修改设置',
      'visits-clear': '清空访问日志', upload: '上传图片',
    };
    $('#events').innerHTML = d.recentEvents.map((e) => {
      const detail = e.detail && Object.keys(e.detail).length
        ? Object.entries(e.detail).filter(([k]) => k !== 'who').map(([k, v]) => `${k}=${v}`).join(' ')
        : '';
      return `<div class="row wrap" style="justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid var(--line);font-size:12.5px">
        <span>
          <span class="muted mono">${App.fmtTime(e.ts)}</span>
          <b style="margin-left:8px;color:${/fail|delete|ban|blocked/.test(e.type) ? 'var(--red)' : 'var(--green)'}">${evName[e.type] || e.type}</b>
          ${e.detail && e.detail.who ? `<span class="tag" style="margin-left:6px">${App.esc(e.detail.who)}</span>` : ''}
          ${detail ? `<span class="muted">${App.esc(detail)}</span>` : ''}
        </span>
        <span class="muted mono" style="font-size:11px">${App.esc(e.ip || '')}</span>
      </div>`;
    }).join('') || '<div class="muted" style="font-size:13px">还没有事件</div>';
  }

  /* ================= 实时访问 ================= */
  function startLive() {
    fetchLive();
    stopLive();
    state.liveTimer = setInterval(() => {
      if (!state.livePaused) fetchLive();
    }, 3000);
  }
  function stopLive() {
    if (state.liveTimer) { clearInterval(state.liveTimer); state.liveTimer = null; }
  }

  $('#live-pause').addEventListener('click', () => {
    state.livePaused = !state.livePaused;
    $('#live-pause').textContent = state.livePaused ? '继续刷新' : '暂停刷新';
  });
  $('#refresh-live').addEventListener('click', fetchLive);
  $('#only-bad').addEventListener('change', (e) => {
    state.onlyBad = e.target.checked;
    fetchLive();
  });

  async function fetchLive() {
    try {
      const d = await App.api(`/api/admin/visits?limit=300${state.onlyBad ? '&bad=1' : ''}`);
      const tbody = $('#live-table tbody');
      tbody.innerHTML = d.items.map((v) => {
        const roleTag = v.who
          ? `<span class="tag">${App.esc(v.who)}</span>`
          : v.sessionRole === 'admin'
            ? '<span class="tag red">站长</span>'
            : '<span class="tag gray">访客</span>';
        return `<tr>
          <td class="mono" style="white-space:nowrap">${App.fmtClock(v.ts)}</td>
          <td class="mono">${App.esc(v.ip)}</td>
          <td>${roleTag}</td>
          <td class="mono">${App.esc(v.method)}</td>
          <td class="mono" style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${App.esc(v.path)}">${App.esc(v.path)}</td>
          <td class="status-${String(v.status).charAt(0)}">${v.status}</td>
          <td class="mono">${v.ms}ms</td>
          <td class="chipcell" style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${App.esc(v.referer || '—')}</td>
          <td>${v.device === 'mobile' ? '手机' : '电脑'}</td>
          <td>${v.ip ? `<button class="btn tiny ghost" data-ban="${App.esc(v.ip)}">封禁</button>` : ''}</td>
        </tr>`;
      }).join('') || '<tr><td colspan="10" class="muted">暂无记录</td></tr>';
      $$('#live-table [data-ban]').forEach((b) => {
        b.addEventListener('click', () => banIp(b.dataset.ban, '实时访问中手动封禁'));
      });
    } catch (e) {
      if (e.status === 401) { stopLive(); showGate(); }
    }
  }

  /* ================= 访客档案 ================= */
  async function loadVisitors() {
    try {
      const d = await App.api('/api/admin/visitors');
      state.visitors = d.items;
      renderVisitors();
    } catch (e) {
      App.toast(e.message, 'err');
      if (e.status === 401) showGate();
    }
  }

  function renderVisitors() {
    const q = $('#visitor-search').value.trim().toLowerCase();
    const list = state.visitors.filter((u) => !q ||
      `${u.label} ${u.year} ${u.className} ${u.name} ${u.ips.join(' ')}`.toLowerCase().includes(q));
    $('#visitor-table tbody').innerHTML = list.map((u) => `
      <tr>
        <td>${u.online ? '<span class="live-dot"></span>在线' : '<span class="muted">离线</span>'}</td>
        <td><b>${App.esc(u.name)}</b></td>
        <td>${App.esc(App.gradeLabel(u.year))}${u.className ? ' · ' + App.esc(u.className) + '班' : ''}</td>
        <td class="mono">${App.fmtTime(u.createdAt)}</td>
        <td>${App.fmtAgo(u.lastSeenAt)}</td>
        <td>${u.loginCount}</td>
        <td>${u.postCount} / ${u.commentCount}</td>
        <td class="mono" style="font-size:11px">${App.esc(u.ips.join(', ') || u.loginIp || '—')}</td>
        <td><button class="btn tiny ghost" data-ban="${App.esc(u.loginIp || u.ips[0] || '')}">封禁 IP</button></td>
      </tr>`).join('') || '<tr><td colspan="9" class="muted">还没有人登记</td></tr>';
    $$('#visitor-table [data-ban]').forEach((b) => {
      b.addEventListener('click', () => {
        if (!b.dataset.ban) return App.toast('这个人没有留下 IP 记录', 'err');
        banIp(b.dataset.ban, '来自访客档案');
      });
    });
  }
  $('#visitor-search').addEventListener('input', App.debounce(renderVisitors, 200));

  /* ================= 登录记录 ================= */
  async function loadLogins() {
    try {
      const d = await App.api('/api/admin/logins');
      const nameMap = { login: '校友登记', 'admin-login': '站长登录成功', 'admin-login-fail': '站长密码错误' };
      $('#login-table tbody').innerHTML = d.items.map((l) => `
        <tr>
          <td class="mono" style="white-space:nowrap">${App.fmtTime(l.ts)}</td>
          <td><span class="tag ${l.type === 'admin-login-fail' ? 'red' : l.type === 'admin-login' ? '' : 'gray'}">${nameMap[l.type] || l.type}</span></td>
          <td>${App.esc(l.who || '—')}</td>
          <td class="mono">${App.esc(l.ip || '')}</td>
          <td class="muted" style="max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px">${App.esc(l.ua || '')}</td>
        </tr>`).join('') || '<tr><td colspan="5" class="muted">暂无记录</td></tr>';
    } catch (e) {
      App.toast(e.message, 'err');
      if (e.status === 401) showGate();
    }
  }

  /* ================= 内容管理 ================= */
  async function loadPosts() {
    const q = $('#post-search').value.trim();
    const hidden = $('#only-hidden').checked ? '1' : '';
    try {
      const d = await App.api(`/api/admin/posts?q=${encodeURIComponent(q)}${hidden ? '&hidden=1' : ''}`);
      $('#post-list').innerHTML = d.items.map((p) => `
        <div class="entry-item" data-pid="${p.id}">
          <div class="e-head">
            <span class="tag">${App.esc(p.authorLabel)}</span>
            <span class="muted" style="font-size:12px">${App.fmtTime(p.createdAt)}</span>
            ${p.hidden ? '<span class="tag red">已隐藏</span>' : ''}
            ${p.pendingReview ? '<span class="tag red">待审核</span>' : ''}
            ${p.pinned ? '<span class="tag">置顶</span>' : ''}
            <span class="muted" style="font-size:12px">♥ ${p.likeCount} · 💬 ${p.commentCount}</span>
            <span class="spacer"></span>
            <span class="muted mono" style="font-size:11px">${App.esc(p.ip)}</span>
            <a class="btn tiny ghost" href="/post/${p.id}" target="_blank">查看</a>
            <button class="btn tiny ghost" data-act="pin">${p.pinned ? '取消置顶' : '置顶'}</button>
            <button class="btn tiny ghost" data-act="hide">${p.hidden ? '恢复显示' : '隐藏'}</button>
            <button class="btn tiny ghost" data-act="del" style="color:var(--red)">删除</button>
          </div>
          ${p.title ? `<b style="font-family:var(--serif);font-size:14px">${App.esc(p.title)}</b>` : ''}
          <div class="e-body">${App.esc(p.content)}</div>
          <div class="row" style="margin-top:6px">
            ${(p.images || []).map((s) => `<img src="${App.esc(s)}" style="width:56px;height:56px;object-fit:cover;border:1px solid var(--line);border-radius:2px">`).join('')}
          </div>
          <button class="btn tiny" data-act="expand" style="margin-top:6px">展开/收起</button>
        </div>`).join('') || '<div class="muted">没有匹配的回忆</div>';

      $$('#post-list .entry-item').forEach((item) => {
        const pid = item.dataset.pid;
        item.querySelector('[data-act="expand"]').addEventListener('click', () =>
          item.querySelector('.e-body').classList.toggle('open'));
        item.querySelector('[data-act="hide"]').addEventListener('click', async () => {
          const hiddenNow = item.querySelector('[data-act="hide"]').textContent.includes('恢复');
          await adminPatchPost(pid, { hidden: !hiddenNow });
          loadPosts();
        });
        item.querySelector('[data-act="pin"]').addEventListener('click', async () => {
          const pinnedNow = item.querySelector('[data-act="pin"]').textContent.includes('取消');
          await adminPatchPost(pid, { pinned: !pinnedNow });
          loadPosts();
        });
        item.querySelector('[data-act="del"]').addEventListener('click', async () => {
          if (!confirm('确定永久删除这条回忆？含其下所有评论。')) return;
          try {
            await App.api(`/api/admin/posts/${pid}`, { method: 'DELETE' });
            App.toast('已删除');
            loadPosts();
          } catch (e) { App.toast(e.message, 'err'); }
        });
      });
    } catch (e) {
      App.toast(e.message, 'err');
      if (e.status === 401) showGate();
    }
  }

  async function adminPatchPost(id, body) {
    try {
      await App.api(`/api/admin/posts/${id}`, { method: 'PATCH', body });
      App.toast('已更新');
    } catch (e) { App.toast(e.message, 'err'); }
  }

  $('#post-search').addEventListener('input', App.debounce(loadPosts, 300));
  $('#only-hidden').addEventListener('change', loadPosts);
  $('#refresh-comments').addEventListener('click', loadComments);

  async function loadComments() {
    try {
      const d = await App.api('/api/admin/comments');
      $('#comment-table tbody').innerHTML = d.items.map((c) => `
        <tr>
          <td class="mono" style="white-space:nowrap">${App.fmtTime(c.createdAt)}</td>
          <td>${App.esc(c.authorLabel)}</td>
          <td style="max-width:420px">${App.esc(c.content)} ${c.hidden ? '<span class="tag red">已隐藏</span>' : ''}</td>
          <td class="mono" style="font-size:11px">${App.esc(c.ip)}</td>
          <td style="white-space:nowrap">
            <button class="btn tiny ghost" data-hide="${c.id}">${c.hidden ? '显示' : '隐藏'}</button>
            <button class="btn tiny ghost" data-del="${c.id}" style="color:var(--red)">删除</button>
          </td>
        </tr>`).join('') || '<tr><td colspan="5" class="muted">暂无评论</td></tr>';

      $$('#comment-table [data-hide]').forEach((b) => b.addEventListener('click', async () => {
        const row = b.closest('tr');
        const hiddenNow = row.innerHTML.includes('已隐藏');
        try {
          await App.api(`/api/admin/comments/${b.dataset.hide}`, { method: 'PATCH', body: { hidden: !hiddenNow } });
          loadComments();
        } catch (e) { App.toast(e.message, 'err'); }
      }));
      $$('#comment-table [data-del]').forEach((b) => b.addEventListener('click', async () => {
        if (!confirm('删除这条评论？')) return;
        try {
          await App.api(`/api/admin/comments/${b.dataset.del}`, { method: 'DELETE' });
          loadComments();
        } catch (e) { App.toast(e.message, 'err'); }
      }));
    } catch (e) {
      App.toast(e.message, 'err');
    }
  }

  /* ================= 导入 ================= */
  $('#import-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-im]');
    if (!b) return;
    $$('#import-tabs button').forEach((x) => x.classList.toggle('on', x === b));
    ['file', 'doc', 'url', 'text'].forEach((k) => $(`#im-${k}`).classList.toggle('hidden', k !== b.dataset.im));
  });

  /* ---- 整篇文档：一份 .docx = 一条回忆（照片按原位置保留） ---- */
  const docZone = $('#doc-zone');
  const docFile = $('#doc-file');
  const docProg = $('#doc-prog');
  const docResult = $('#doc-result');

  docZone.addEventListener('click', () => docFile.click());
  docZone.addEventListener('dragover', (e) => { e.preventDefault(); docZone.classList.add('drag'); });
  docZone.addEventListener('dragleave', () => docZone.classList.remove('drag'));
  docZone.addEventListener('drop', (e) => {
    e.preventDefault();
    docZone.classList.remove('drag');
    const f = e.dataTransfer.files[0];
    if (f) uploadWholeDoc(f);
  });
  docFile.addEventListener('change', (e) => {
    if (e.target.files[0]) uploadWholeDoc(e.target.files[0]);
    e.target.value = '';
  });

  /** 整篇上传：401MB 的 docx 要传好几分钟，必须有进度 */
  function uploadWholeDoc(file) {
    const maxMb = importLimits ? importLimits.maxImportMb : 2560;
    if (file.size > maxMb * 1024 * 1024) {
      App.toast(`这个文件 ${fmtMb(file.size)}，超过单文件上限 ${maxMb}MB`, 'err', 6000);
      return;
    }
    docResult.classList.add('hidden');
    docProg.classList.remove('hidden');
    docProg.textContent = `正在上传 ${file.name}（${fmtMb(file.size)}）… 0%`;
    const fields = {
      title: $('#doc-title').value.trim(),
      year: $('#doc-year').value.trim(),
      author: $('#doc-author').value.trim(),
    };
    uploadWithProgress('/api/admin/import/doc', file, (loaded, total) => {
      const pct = total ? Math.floor((loaded / total) * 100) : 0;
      docProg.textContent = pct < 100
        ? `正在上传 ${file.name}（${fmtMb(file.size)}）… ${pct}% · 已传 ${fmtMb(loaded)}`
        : '传完了，正在拆文档、抽照片（大文档要几十秒，别关页面）…';
    }, fields)
      .then((d) => {
        docProg.textContent = `完成：${d.format} · 正文 ${d.chars} 字 · 照片 ${d.imageCount} 张`;
        docResult.classList.remove('hidden');
        docResult.innerHTML = `
          <div class="panel" style="margin:0">
            <div class="row wrap" style="margin-bottom:10px">
              <h3 style="margin:0">已经发到回忆墙上</h3>
              <span class="tag">整篇文档</span>
              <span class="spacer"></span>
              <a class="btn small" href="/post/${App.esc(d.postId)}" target="_blank" rel="noopener">看这条回忆 ↗</a>
            </div>
            <div class="panel-sub">标题：<b>${App.esc(d.title)}</b> · 照片 ${d.imageCount} 张${
              d.truncated ? '（文档太长，尾部内容没载入）' : ''}</div>
            ${d.cover ? `<img src="${App.esc(d.cover)}" alt="封面" style="max-width:220px;border:1px solid var(--line);border-radius:2px;margin:6px 0">` : ''}
            <div class="doc-sample" style="max-height:200px;overflow:auto;font-size:13px;line-height:1.8;white-space:pre-wrap">${App.esc(d.previewText || '')}</div>
          </div>`;
      })
      .catch((e) => {
        docProg.textContent = '';
        App.toast(e.message, 'err', 6000);
      });
  }

  const dropZone = $('#drop-zone');

  // 单文件上限由服务端说了算（MAX_IMPORT_UPLOAD_MB，默认 2.5GB），这里只负责显示
  let importLimits = null;
  function zoneIdleHtml() {
    const limit = importLimits ? (importLimits.maxImportLabel || `${importLimits.maxImportMb}MB`) : '2.5GB（2560MB）';
    const fmts = importLimits && importLimits.formats ? importLimits.formats.join(' / ') : '.docx / .txt / .md / .csv / .html';
    return `<div style="font-size:15px;margin-bottom:6px">把文件拖进来，或点击选择</div>
      <div>支持 ${fmts}，单文件最大 ${limit}</div>`;
  }
  async function loadImportLimits() {
    try {
      importLimits = await App.api('/api/admin/import/limits');
      dropZone.innerHTML = zoneIdleHtml();
    } catch (_) { /* 拿不到就用默认文案 */ }
  }

  dropZone.addEventListener('click', () => $('#import-file').click());
  dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag');
    const f = e.dataTransfer.files[0];
    if (f) uploadImportFile(f);
  });
  $('#import-file').addEventListener('change', (e) => {
    if (e.target.files[0]) uploadImportFile(e.target.files[0]);
    e.target.value = '';
  });

  async function uploadImportFile(file) {
    // 2.5GB 的合集要传好几分钟，用 XHR 才拿得到进度；fetch 给不了上传进度
    const maxMb = importLimits ? importLimits.maxImportMb : 2560;
    if (file.size > maxMb * 1024 * 1024) {
      const msg = `这个文件 ${fmtMb(file.size)}，超过单文件上限 ${maxMb}MB。太大的话在金山文档里拆成几个文档分次导入。`;
      App.toast(msg, 'err', 6000);
      showPreviewError(msg);
      return;
    }

    dropZone.innerHTML = `<div style="font-size:15px;margin-bottom:6px">正在上传 ${App.esc(file.name)}（${fmtMb(file.size)}）</div>
      <div id="im-prog-text">0%</div>`;
    const prog = $('#im-prog-text');
    try {
      const d = await uploadWithProgress('/api/admin/import/file', file, (loaded, total) => {
        if (!prog) return;
        const pct = total ? Math.floor((loaded / total) * 100) : 0;
        prog.textContent = pct < 100
          ? `${pct}% · 已传 ${fmtMb(loaded)} / ${fmtMb(total)}`
          : '传完了，正在解析文档…';
      });
      showPreview(d, `${d.filename}（${d.format}，${d.rawLength} 字）`);
    } catch (e) {
      App.toast(e.message, 'err', 5000);
      showPreviewError(e.message, e.data && e.data.hint);
    } finally {
      dropZone.innerHTML = zoneIdleHtml();
    }
  }

  function fmtMb(bytes) {
    const mb = bytes / 1048576;
    return mb >= 1024 ? `${(mb / 1024).toFixed(2)}GB` : `${mb.toFixed(mb >= 10 ? 0 : 1)}MB`;
  }

  /** 带进度的上传（XHR）。返回和 App.api 一样的：成功给解析后的 JSON，失败抛 Error */
  function uploadWithProgress(url, file, onProgress, fields) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      xhr.withCredentials = true;
      if (xhr.upload && onProgress) {
        xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded, e.total); };
      }
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch (_) { data = null; }
        if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
        const err = new Error((data && data.error) || `上传失败（${xhr.status}）`);
        err.status = xhr.status;
        err.data = data;
        reject(err);
      };
      xhr.onerror = () => reject(new Error('上传中断了：检查网络，或者服务是不是被重启了'));
      xhr.ontimeout = () => reject(new Error('上传超时了，网络太慢或者文件太大'));
      const fd = new FormData();
      if (fields) for (const [k, v] of Object.entries(fields)) fd.append(k, String(v == null ? '' : v));
      fd.append('file', file);
      xhr.send(fd);
    });
  }

  $('#do-import-url').addEventListener('click', async () => {
    const url = $('#import-url').value.trim();
    if (!url) return App.toast('请填写链接', 'err');
    const btn = $('#do-import-url');
    btn.disabled = true;
    btn.textContent = '抓取中…';
    try {
      const d = await App.api('/api/admin/import/url', { method: 'POST', body: { url } });
      showPreview(d, `来自链接（${d.format}，${d.rawLength} 字）`);
    } catch (e) {
      showPreviewError(e.message, e.data && e.data.hint);
    } finally {
      btn.disabled = false;
      btn.textContent = '尝试抓取';
    }
  });

  $('#do-import-text').addEventListener('click', async () => {
    const text = $('#import-text').value;
    if (!text.trim()) return App.toast('请先粘贴内容', 'err');
    try {
      const d = await App.api('/api/admin/import/text', { method: 'POST', body: { text } });
      showPreview(d, `粘贴文本（${d.rawLength} 字）`);
    } catch (e) {
      App.toast(e.message, 'err');
    }
  });

  function showPreviewError(msg, hint) {
    $('#preview-panel').classList.remove('hidden');
    $('#entry-list').innerHTML = `<div class="form-error show">${App.esc(msg)}</div>
      ${hint ? `<div class="hint" style="margin-top:10px;line-height:1.8">${App.esc(hint)}</div>` : ''}`;
    $('#preview-count').textContent = '0 条';
    state.entries = [];
  }

  function showPreview(d, sourceLabel) {
    state.entries = (d.entries || []).map((e) => ({
      year: e.year || '',
      className: e.className || '',
      name: e.name || '',
      title: e.title || '',
      content: e.content || '',
    }));
    state.rawPreview = d.rawPreview || '';
    $('#preview-panel').classList.remove('hidden');
    $('#preview-count').textContent = `${state.entries.length} 条 · ${sourceLabel}`;
    $('#preview-raw').textContent = state.rawPreview;
    renderEntries();
    if (!state.entries.length) {
      $('#entry-list').innerHTML = `<div class="form-error show">没能从内容里解析出回忆条目。
        如果文档是一整段连续文字，可以试试在每段之间加空行，或者用「98级3班 张三」这样的署名行分隔。</div>`;
    }
    $('#preview-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderEntries() {
    const box = $('#entry-list');
    if (!state.entries.length) { box.innerHTML = ''; return; }
    box.innerHTML = state.entries.map((e, i) => `
      <div class="entry-item" data-i="${i}">
        <div class="e-head">
          <span class="muted" style="font-size:12px">#${i + 1}</span>
          <input class="input" data-f="year" value="${App.esc(e.year)}" placeholder="级别" style="width:80px;padding:2px 6px;font-size:12px">
          <input class="input" data-f="className" value="${App.esc(e.className)}" placeholder="班" style="width:60px;padding:2px 6px;font-size:12px">
          <input class="input" data-f="name" value="${App.esc(e.name)}" placeholder="姓名" style="width:110px;padding:2px 6px;font-size:12px">
          <input class="input" data-f="title" value="${App.esc(e.title)}" placeholder="标题（选填）" style="flex:1;min-width:140px;padding:2px 6px;font-size:12px">
          <button class="btn tiny ghost" data-act="toggle">展开</button>
          <button class="btn tiny ghost" data-act="rm" style="color:var(--red)">移除</button>
        </div>
        <div class="e-body">${App.esc(e.content)}</div>
        <textarea class="textarea hidden" data-f="content" style="min-height:90px;margin-top:6px;font-size:13px">${App.esc(e.content)}</textarea>
      </div>`).join('');

    $$('#entry-list .entry-item').forEach((item) => {
      const i = Number(item.dataset.i);
      item.querySelectorAll('input[data-f]').forEach((inp) => {
        inp.addEventListener('input', () => { state.entries[i][inp.dataset.f] = inp.value; });
      });
      const ta = item.querySelector('textarea[data-f="content"]');
      ta.addEventListener('input', () => { state.entries[i].content = ta.value; });
      item.querySelector('[data-act="toggle"]').addEventListener('click', () => {
        ta.classList.toggle('hidden');
        item.querySelector('.e-body').classList.toggle('open');
      });
      item.querySelector('[data-act="rm"]').addEventListener('click', () => {
        state.entries.splice(i, 1);
        renderEntries();
        $('#preview-count').textContent = `${state.entries.length} 条`;
      });
    });
  }

  $('#preview-raw-toggle').addEventListener('change', (e) => {
    $('#preview-raw').classList.toggle('hidden', !e.target.checked);
  });

  $('#preview-clear').addEventListener('click', () => {
    state.entries = [];
    $('#preview-panel').classList.add('hidden');
    $('#entry-list').innerHTML = '';
    $('#import-text').value = '';
    $('#import-url').value = '';
  });

  $('#preview-commit').addEventListener('click', async () => {
    if (!state.entries.length) return App.toast('没有可导入的条目', 'err');
    const btn = $('#preview-commit');
    btn.disabled = true;
    btn.textContent = '导入中…';
    try {
      const r = await App.api('/api/admin/import/commit', { method: 'POST', body: { entries: state.entries } });
      App.toast(`导入完成：新增 ${r.created} 条，跳过 ${r.skipped} 条`);
      $('#preview-clear').click();
      loadPosts();
    } catch (e) {
      App.toast(e.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '确认导入';
    }
  });

  /* ================= 设置 / 封禁 ================= */
  /* ---- 站名：学校名称 / 站点全称 / 英文名，边打边预览 ---- */
  // 上次「学校名 + 回忆录」这个自动值；全称等于它（或为空）时，改学校名就跟着改
  let autoTitleBase = '';

  function brandValues() {
    const school = $('#s-school').value.trim() || '廊坊一中';
    const title = $('#s-title').value.trim() || `${school}回忆录`;
    return { school, en: $('#s-school-en').value.trim(), title };
  }

  function renderBrandPreview() {
    const f = brandValues();
    $('#bp-school').textContent = f.school;
    $('#bp-seal').textContent = f.school;
    $('#bp-foot').textContent = `${f.title} · 由校友共同守护`;
    $('#bp-tab').textContent = `${f.title} · 入院登记`;
    const en = $('#bp-en');
    if (f.en) { en.textContent = f.en; en.style.display = ''; } else { en.style.display = 'none'; }
    return f.title;
  }

  // 改学校名称时，站点全称会跟着走（除非站长自己填过一个不一样的全称）
  function syncAutoTitle() {
    const school = $('#s-school').value.trim() || '廊坊一中';
    const cur = $('#s-title').value.trim();
    if (!cur || cur === autoTitleBase) $('#s-title').value = `${school}回忆录`;
    autoTitleBase = `${school}回忆录`;
    renderBrandPreview();
  }

  ['#s-school', '#s-title', '#s-school-en'].forEach((sel) => {
    const el = $(sel);
    if (!el) return;
    el.addEventListener('input', () => {
      if (sel === '#s-school') syncAutoTitle();
      else renderBrandPreview();
    });
  });

  async function loadSettings() {
    try {
      const { settings } = await App.api('/api/admin/settings');
      const school = settings.schoolName || '廊坊一中';
      $('#s-school').value = school;
      $('#s-school-en').value = settings.schoolEn === undefined ? '' : settings.schoolEn;
      $('#s-title').value = settings.siteTitle || '';
      // 存的全称正好是自动值 → 记下来，之后改学校名就自动跟
      autoTitleBase = settings.siteTitle === `${school}回忆录` ? settings.siteTitle : '';
      const t0 = renderBrandPreview();
      // 后台自己的顶栏和标签页也跟着站名走
      $('#shell-title').firstChild.textContent = t0;
      App.applyBrand({ schoolName: school, siteTitle: t0, schoolEn: settings.schoolEn || '' });
      $('#s-notice').value = settings.notice || '';
      $('#s-words').value = (settings.sensitiveWords || []).join('，');
      $('#s-open').checked = settings.registrationOpen !== false;
      $('#s-review').checked = !!settings.reviewFirstPost;
      const c = settings.contact || {};
      $('#s-wechat').value = c.wechat || '';
      $('#s-qq').value = c.qq || '';
      $('#s-email').value = c.email || '';
      $('#s-phone').value = c.phone || '';
      $('#s-note').value = c.note || '';
      $('#s-contact-on').checked = c.enabled !== false;
      loadBans();
    } catch (e) {
      App.toast(e.message, 'err');
      if (e.status === 401) showGate();
    }
  }

  $('#save-settings').addEventListener('click', async () => {
    try {
      await App.api('/api/admin/settings', {
        method: 'POST',
        body: {
          schoolName: $('#s-school').value,
          schoolEn: $('#s-school-en').value,
          siteTitle: $('#s-title').value,
          notice: $('#s-notice').value,
          sensitiveWords: $('#s-words').value,
          registrationOpen: $('#s-open').checked,
          reviewFirstPost: $('#s-review').checked,
          contact: {
            enabled: $('#s-contact-on').checked,
            wechat: $('#s-wechat').value,
            qq: $('#s-qq').value,
            email: $('#s-email').value,
            phone: $('#s-phone').value,
            note: $('#s-note').value,
          },
        },
      });
      App.toast('设置已保存，刷新页面就能看到新站名');
      $('#shell-title').firstChild.textContent = renderBrandPreview();
      autoTitleBase = $('#s-title').value.trim() === `${($('#s-school').value.trim() || '廊坊一中')}回忆录`
        ? $('#s-title').value.trim() : '';
    } catch (e) { App.toast(e.message, 'err'); }
  });

  async function loadBans() {
    try {
      const { items } = await App.api('/api/admin/bans');
      $('#ban-list').innerHTML = items.length
        ? `<div class="table-wrap"><table class="data">
            <thead><tr><th>IP</th><th>原因</th><th>时间</th><th>操作</th></tr></thead>
            <tbody>${items.map((b) => `<tr>
              <td class="mono">${App.esc(b.ip)}</td>
              <td>${App.esc(b.reason || '—')}</td>
              <td class="mono">${App.fmtTime(b.ts)}</td>
              <td><button class="btn tiny ghost" data-unban="${App.esc(b.ip)}">解除</button></td>
            </tr>`).join('')}</tbody></table></div>`
        : '<div class="muted" style="font-size:13px">封禁名单是空的 —— 天下太平。</div>';
      $$('#ban-list [data-unban]').forEach((b) => b.addEventListener('click', async () => {
        await App.api(`/api/admin/bans/${encodeURIComponent(b.dataset.unban)}`, { method: 'DELETE' });
        loadBans();
      }));
    } catch (e) { /* 忽略 */ }
  }

  $('#ban-add').addEventListener('click', () => {
    const ip = $('#ban-ip').value.trim();
    if (!ip) return App.toast('请填写 IP', 'err');
    banIp(ip, $('#ban-reason').value.trim());
  });

  async function banIp(ip, reason) {
    if (!ip) return App.toast('没有可封禁的 IP', 'err');
    if (!confirm(`确定封禁 ${ip} 吗？该地址之后所有请求都会被拒绝。`)) return;
    try {
      await App.api('/api/admin/bans', { method: 'POST', body: { ip, reason } });
      App.toast(`已封禁 ${ip}`);
      $('#ban-ip').value = '';
      $('#ban-reason').value = '';
      if (state.tab === 'settings') loadBans();
      if (state.tab === 'overview') loadOverview();
    } catch (e) { App.toast(e.message, 'err'); }
  }

  $('#clear-visits').addEventListener('click', async () => {
    if (!confirm('清空所有访问日志？建议先导出 CSV 留档。')) return;
    try {
      const r = await App.api('/api/admin/visits/clear', { method: 'POST' });
      App.toast(`已清空 ${r.removed} 条访问日志`);
    } catch (e) { App.toast(e.message, 'err'); }
  });

  /* ================= 密码管控 ================= */
  const TYPE_LABEL = {
    'pwd-reset': '重置密码',
    'pwd-change': '自己改密',
    'pwd-setup': '补设密码',
    'login-fail': '密码输错',
    'account-lock': '锁定',
    'account-unlock': '解锁',
    'admin-password': '后台密码变更',
    'admin-pwd-policy': '策略变更',
  };

  function loadAccounts() {
    loadAccountsList();
    loadPolicyForm();
    loadPwdLogs();
    loadAdminPwdState();
  }

  async function loadAccountsList() {
    const q = $('#acc-q').value.trim();
    const status = $('#acc-status').value;
    let d;
    try {
      d = await App.api(`/api/admin/accounts?q=${encodeURIComponent(q)}&status=${encodeURIComponent(status)}`);
    } catch (e) {
      App.toast(e.message, 'err');
      if (e.status === 401) showGate();
      return;
    }

    const s = d.stats;
    $('#pwd-stats').innerHTML = [
      { k: '登记账号', v: s.users, s: '个' },
      { k: '已设密码', v: s.withPwd, s: '个' },
      { k: '还没密码', v: s.noPwd, s: '个', warn: s.noPwd > 0 },
      { k: '密码偏短', v: s.weak, s: '<6 位', warn: s.weak > 0 },
      { k: '已锁定', v: s.locked, s: '个', warn: s.locked > 0 },
      { k: '待改密码', v: s.mustChange, s: '个' },
      { k: '有输错', v: s.failNow, s: '个' },
      { k: '已停用', v: s.disabled, s: '个' },
    ].map((c) => `
      <div class="stat ${c.warn ? 'warn' : ''}">
        <div class="k">${c.k}</div>
        <div class="v">${c.v}<small> ${c.s}</small></div>
      </div>`).join('');

    $('#acc-count').textContent = `显示 ${d.items.length} / 共 ${d.total} 个`;

    if (!d.items.length) {
      $('#account-list').innerHTML = '<div class="muted" style="font-size:13px">没有符合条件的账号。</div>';
      return;
    }

    $('#account-list').innerHTML = `<div class="table-wrap"><table class="data">
      <thead><tr><th>身份</th><th>密码</th><th>状态</th><th>最后登录</th><th>操作</th></tr></thead>
      <tbody>${d.items.map((a) => {
        const tags = [];
        if (a.locked) tags.push('<span class="tag red">已锁定</span>');
        if (a.disabled) tags.push('<span class="tag red">已停用</span>');
        if (a.mustChange) tags.push('<span class="tag">待改密</span>');
        if (!a.hasPassword) tags.push('<span class="tag gray">无密码</span>');
        if (a.failCount > 0) tags.push(`<span class="tag gray">输错 ${a.failCount}</span>`);
        if (a.online) tags.push('<span class="tag">在线</span>');
        return `<tr>
          <td><b>${App.esc(a.label)}</b>${a.imported ? ' <span class="tag gray">导入</span>' : ''}
            <div class="muted" style="font-size:11px">登记 ${App.fmtTime(a.createdAt)}</div></td>
          <td>${App.esc(a.strength)} <span class="muted">${a.pwdLength} 位</span>
            <div class="muted" style="font-size:11px">
              ${a.pwdUpdatedAt ? '改于 ' + App.fmtTime(a.pwdUpdatedAt) : '—'}
              ${a.pwdResetCount ? ' · 重置 ' + a.pwdResetCount + ' 次' : ''}
            </div></td>
          <td>${tags.join(' ') || '<span class="muted">正常</span>'}</td>
          <td>${App.fmtAgo(a.lastLoginAt)}
            <div class="mono" style="font-size:11px">${App.esc(a.lastLoginIp || '—')}</div></td>
          <td><div class="row wrap" style="gap:6px">
            <button class="btn tiny" data-reset="${a.id}">重置</button>
            ${a.locked
              ? `<button class="btn tiny ghost" data-unlock="${a.id}">解锁</button>`
              : `<button class="btn tiny ghost" data-lock="${a.id}">锁定</button>`}
            <button class="btn tiny ghost" data-must="${a.id}">${a.mustChange ? '取消待改密' : '要求改密'}</button>
            <button class="btn tiny ghost" data-kick="${a.id}">踢下线</button>
            <button class="btn tiny ghost" data-disable="${a.id}" data-disabled="${a.disabled ? 1 : 0}">${a.disabled ? '恢复' : '停用'}</button>
          </div></td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
  }

  async function act(id, path, body, okMsg) {
    try {
      const r = await App.api(path, { method: 'POST', body: body || {} });
      App.toast(okMsg || '已生效');
      loadAccountsList();
      loadPwdLogs();
      return r;
    } catch (e) {
      App.toast(e.message, 'err');
      if (e.status === 401) showGate();
      return null;
    }
  }

  $('#account-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const d = btn.dataset;
    const id = d.reset || d.lock || d.unlock || d.must || d.kick || d.disable;
    if (!id) return;

    if (d.reset) {
      const input = window.prompt('重置密码：留空 = 自动生成 8 位临时密码；也可以直接输入要设的密码。', '');
      if (input === null) return;
      const r = await act(id, `/api/admin/accounts/${id}/password`, { password: input.trim() }, '密码已重置，请记下临时密码');
      if (r) showPwdResult(r);
      return;
    }
    if (d.lock) {
      if (confirm('锁定该账号？锁定期间无法登录。')) await act(id, `/api/admin/accounts/${id}/lock`, {}, '已锁定');
      return;
    }
    if (d.unlock) { await act(id, `/api/admin/accounts/${id}/unlock`, {}, '已解锁'); return; }
    if (d.must) { await act(id, `/api/admin/accounts/${id}/must-change`, {}, '已更新'); return; }
    if (d.kick) {
      try {
        const r = await App.api(`/api/admin/accounts/${id}/sessions`, { method: 'DELETE' });
        App.toast(`已踢下线 ${r.kicked || 0} 台设备`);
        loadAccountsList();
        loadPwdLogs();
      } catch (err) { App.toast(err.message, 'err'); }
      return;
    }
    if (d.disable) {
      const on = d.disabled === '1';
      if (!confirm(on ? '恢复这个账号的登录？' : '停用这个账号？停用后不能登录，已登录的会被踢下线，回忆保留。')) return;
      await act(id, `/api/admin/accounts/${id}/disabled`, { disabled: !on }, on ? '已恢复' : '已停用');
    }
  });

  function showPwdResult(r) {
    const box = $('#pwd-result');
    box.innerHTML = `新密码：<b class="mono" style="font-size:15px">${App.esc(r.password)}</b>
      ${r.generated ? '<span class="tag">自动生成</span>' : '<span class="tag">手动指定</span>'}
      ${r.forceChange ? '<span class="tag red">下次登录须改密</span>' : ''}
      <button class="btn tiny" id="copy-pwd" style="margin-left:8px">复制</button>
      <span class="muted" style="margin-left:8px">已踢下线 ${r.kicked || 0} 台设备。这串密码只显示这一次。</span>`;
    box.classList.remove('hidden');
    const btn = $('#copy-pwd');
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(r.password);
        App.toast('已复制到剪贴板');
      } catch (_) {
        App.toast('浏览器不让自动复制，请手动选中', 'err');
      }
    });
  }

  async function loadPolicyForm() {
    try {
      const { policy: p } = await App.api('/api/admin/password/policy');
      $('#p-min').value = p.minLength;
      $('#p-fail').value = p.maxFail;
      $('#p-lock').value = p.lockMinutes;
      $('#p-force').checked = !!p.forceChangeOnReset;
      $('#p-self').checked = !!p.allowSelfChange;
    } catch (_) { /* 忽略 */ }
  }

  $('#save-policy').addEventListener('click', async () => {
    try {
      await App.api('/api/admin/password/policy', {
        method: 'POST',
        body: {
          minLength: Number($('#p-min').value),
          maxFail: Number($('#p-fail').value),
          lockMinutes: Number($('#p-lock').value),
          forceChangeOnReset: $('#p-force').checked,
          allowSelfChange: $('#p-self').checked,
        },
      });
      App.toast('策略已保存');
      loadPolicyForm();
      loadPwdLogs();
    } catch (e) { App.toast(e.message, 'err'); }
  });

  async function loadPwdLogs() {
    try {
      const { items } = await App.api('/api/admin/password/logs');
      $('#pwd-logs').innerHTML = items.length
        ? items.map((it) => `<div class="row wrap" style="justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid var(--line);font-size:13px">
            <span><span class="tag">${TYPE_LABEL[it.type] || App.esc(it.type)}</span> ${App.esc(it.who || '')}</span>
            <span class="muted mono" style="font-size:11px">${App.fmtTime(it.ts)} · ${App.esc(it.ip || '')}</span>
          </div>`).join('')
        : '<div class="muted" style="font-size:13px">还没有密码相关的操作记录。</div>';
    } catch (_) { /* 忽略 */ }
  }

  async function loadAdminPwdState() {
    try {
      const d = await App.api('/api/admin/password/self');
      $('#admin-pwd-state').textContent = d.custom
        ? `现在用的是你自己在后台设的密码（${d.updatedAt ? App.fmtTime(d.updatedAt) + ' 改的' : '时间不详'}）。`
        : '现在用的是 .env 里的 ADMIN_PASSWORD。';
    } catch (_) { /* 忽略 */ }
  }

  $('#save-admin-pwd').addEventListener('click', async () => {
    const cur = $('#a-cur').value;
    const a = $('#a-new').value;
    const b = $('#a-new2').value;
    if (!cur) return App.toast('请先填当前的后台密码', 'err');
    if (a.length < 6) return App.toast('新密码至少 6 位', 'err');
    if (a !== b) return App.toast('两次输入的新密码不一致', 'err');
    try {
      await App.api('/api/admin/password/self', { method: 'POST', body: { currentPassword: cur, newPassword: a } });
      App.toast('后台密码已更新，请牢记');
      $('#a-cur').value = '';
      $('#a-new').value = '';
      $('#a-new2').value = '';
      loadAdminPwdState();
    } catch (e) { App.toast(e.message, 'err'); }
  });

  $('#reset-admin-pwd').addEventListener('click', async () => {
    const cur = $('#a-cur').value;
    if (!cur) return App.toast('请先填当前的后台密码', 'err');
    if (!confirm('恢复成 .env 里的 ADMIN_PASSWORD？')) return;
    try {
      await App.api('/api/admin/password/self', { method: 'POST', body: { currentPassword: cur, useEnv: true } });
      App.toast('已恢复成 .env 里的密码');
      $('#a-cur').value = '';
      loadAdminPwdState();
    } catch (e) { App.toast(e.message, 'err'); }
  });

  $('#acc-refresh').addEventListener('click', loadAccountsList);
  $('#acc-status').addEventListener('change', loadAccountsList);
  let accTimer = null;
  $('#acc-q').addEventListener('input', () => {
    clearTimeout(accTimer);
    accTimer = setTimeout(loadAccountsList, 350);
  });

  /* ================= 启动 ================= */
  boot();
})();