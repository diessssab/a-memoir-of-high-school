/* ============================================================
   监控中心：一个页面看「人」和「文件」
   ============================================================ */
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = App.esc;

  const EVT = {
    'login': '登录成功',
    'login-fail': '登录失败',
    'logout': '退出登录',
    'register': '新校友登记',
    'pwd-setup': '补设密码',
    'pwd-change': '自己改了密码',
    'pwd-reset': '站长重置了密码',
    'account-lock': '账号被锁定',
    'account-unlock': '账号解锁',
    'post': '发布回忆',
    'post-delete': '删除回忆',
    'post-hide': '隐藏回忆',
    'comment': '发了评论',
    'doc-upload': '上传了文档',
    'doc-upload-fail': '文档上传失败',
    'doc-publish': '文档发到了墙上',
    'doc-delete': '删掉了文档',
    'import-file': '站长导入文件',
    'import-url': '站长抓了链接',
    'import-commit': '导入写入回忆墙',
    'blocked-request': '请求被拦截',
    'ban-add': '封禁了 IP',
    'ban-remove': '解除封禁',
    'admin-login': '站长登录后台',
    'admin-login-fail': '站长密码错误',
    'admin-settings': '改了站点设置',
    'admin-kick': '踢人下线',
    'monitor-view-file': '查看了文件内容',
    'monitor-download-file': '下载了原文件',
    'monitor-delete-file': '删除了文件记录',
    'visits-clear': '清空了访问日志',
  };

  const STATUS = {
    ready: '已上传未发布',
    published: '已发布上墙',
    imported: '站长导入',
    failed: '解析失败',
  };

  let timer = null;
  let fileTimer = null;
  let current = null;     // 正在弹窗查看的文件
  let lastFiles = [];

  function fmtSize(n) {
    if (!n) return '—';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
  }

  function detailText(e) {
    const d = e.detail || {};
    const bits = [];
    const push = (k, label) => { if (d[k] !== undefined && d[k] !== '' && d[k] !== null) bits.push(`${label}${d[k]}`); };
    switch (e.type) {
      case 'doc-upload':
      case 'doc-upload-fail':
        push('name', '文件：'); push('size', ' · 大小：'); push('entries', ' · 条目：');
        push('sensitive', ' · 敏感词：'); push('error', ' · 原因：');
        break;
      case 'doc-publish': push('name', '文件：'); push('created', ' · 写入：'); push('skipped', ' · 跳过：'); break;
      case 'import-file': push('name', '文件：'); push('format', ' · 格式：'); push('entries', ' · 条目：'); break;
      case 'import-url': push('url', '链接：'); push('entries', ' · 条目：'); break;
      case 'import-commit': push('created', '写入：'); push('skipped', ' · 跳过：'); break;
      case 'login-fail': push('who', '身份：'); push('fails', ' · 已错：'); push('minutes', ' · 锁定：'); break;
      case 'account-lock': push('who', '身份：'); push('minutes', ' · 分钟：'); break;
      case 'blocked-request': push('path', '路径：'); push('reason', ' · 原因：'); break;
      case 'ban-add': push('ip', 'IP：'); push('reason', ' · 原因：'); break;
      case 'monitor-view-file': push('name', '文件：'); break;
      default:
        Object.keys(d).slice(0, 3).forEach((k) => push(k, `${k}：`));
    }
    return bits.join('') || (e.ip ? `IP ${e.ip}` : '');
  }

  /* ------------------------------ 登录门 ------------------------------ */
  async function tryEnter() {
    try {
      await load();
      $('#gate').classList.add('hidden');
      $('#shell').classList.remove('hidden');
      startTimers();
      // 顶栏站名跟着后台设置走（后台改了学校名称，这里也一起变）
      try {
        const me = await App.api('/api/me');
        if (me && me.settings) {
          const brand = App.applyBrand(me.settings);
          const a = document.querySelector('.topbar .brand') || document.querySelector('.brand');
          if (a && a.firstChild && a.firstChild.nodeType === 3) a.firstChild.textContent = brand.siteTitle;
        }
      } catch (_) {}
    } catch (e) {
      if (e.status === 401) {
        $('#gate').classList.remove('hidden');
        $('#shell').classList.add('hidden');
      } else {
        $('#gate-error').textContent = e.message;
        $('#gate-error').classList.add('show');
      }
    }
  }

  $('#gate-btn').addEventListener('click', doLogin);
  $('#admin-pwd').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

  async function doLogin() {
    const pwd = $('#admin-pwd').value;
    const btn = $('#gate-btn');
    if (!pwd) return;
    btn.disabled = true;
    btn.textContent = '验证中…';
    try {
      await App.api('/api/admin/login', { method: 'POST', body: { password: pwd } });
      $('#gate-error').classList.remove('show');
      $('#admin-pwd').value = '';
      await tryEnter();
    } catch (e) {
      $('#gate-error').textContent = e.message;
      $('#gate-error').classList.add('show');
    } finally {
      btn.disabled = false;
      btn.textContent = '进入监控';
    }
  }

  $('#logout-btn').addEventListener('click', async () => {
    await App.api('/api/admin/logout', { method: 'POST' }).catch(() => {});
    location.href = '/admin.html';
  });

  /* ------------------------------ 主面板 ------------------------------ */
  async function load() {
    const data = await App.api('/api/admin/monitor');
    renderStats(data.stats);
    renderOnline(data.online);
    renderActivity(data.activity);
    $('#pulse').textContent = App.fmtClock(data.serverTime);
  }

  function renderStats(s) {
    const cell = (k, v, unit, warn) =>
      `<div class="stat${warn ? ' warn' : ''}"><div class="k">${esc(k)}</div><div class="v">${esc(v)}<small>${esc(unit || '')}</small></div></div>`;
    $('#m-stats').innerHTML = [
      cell('此刻在线', s.online, '人'),
      cell('登录用户在线', s.onlineUsers, '人'),
      cell('未发布的文档', s.pending, '份', s.pending > 0),
      cell('今日上传', s.filesToday, '份'),
      cell('今日文档', s.docsToday, '份'),
      cell('命中敏感词', s.flagged, '份', s.flagged > 0),
      cell('今日登录失败', s.failsToday, '次'),
      cell('今日被拦截', s.blockedToday, '次', s.blockedToday > 0),
      cell('累计占用空间', fmtSize(s.bytesTotal), ''),
    ].join('');
  }

  function renderOnline(list) {
    $('#online-count').textContent = list.length;
    if (!list.length) {
      $('#online-list').innerHTML = '<div class="empty">此刻没有人在线。</div>';
      return;
    }
    $('#online-list').innerHTML = list.map((u) => `
      <div class="on-item" data-uid="${esc(u.uid || '')}">
        <div class="on-head">
          <span class="avatar">${esc((u.who || '客').slice(0, 1))}</span>
          <b>${esc(u.who)}</b>
          ${u.banned ? '<span class="tag red">已封禁</span>' : ''}
          <span class="spacer"></span>
          <span class="muted mono" style="font-size:11px">${esc(u.lastLabel)}</span>
        </div>
        <div class="on-meta">
          <span class="mono">${esc(u.ip)}</span>
          · ${u.device === 'mobile' ? '手机' : '电脑'}
          · 点了 ${u.hits} 次
          ${u.uid ? `· 发过 ${u.postCount} 条回忆` : '· 未登录'}
        </div>
        <div class="on-path">${(u.paths || []).slice(-4).map((p) => `<span>${esc(p)}</span>`).join('')}</div>
        <div class="on-actions">
          ${u.uid ? `<button class="btn ghost tiny" data-kick="${esc(u.uid)}">踢下线</button>` : ''}
          <button class="btn ghost tiny" data-ban="${esc(u.ip)}">封禁此 IP</button>
        </div>
      </div>`).join('');
  }

  function renderActivity(list) {
    if (!list.length) {
      $('#activity').innerHTML = '<div class="empty">还没有记录。</div>';
      return;
    }
    $('#activity').innerHTML = list.map((e) => `
      <div class="evt${e.type.includes('fail') || e.type === 'blocked-request' || e.type === 'account-lock' ? ' bad' : ''}">
        <span class="evt-t mono">${App.fmtClock(e.ts)}</span>
        <span class="evt-name">${esc(EVT[e.type] || e.type)}</span>
        <span class="evt-d">${esc(detailText(e))}</span>
        ${e.ip ? `<span class="evt-ip mono">${esc(e.ip)}</span>` : ''}
      </div>`).join('');
  }

  /* ------------------------------ 文件列表 ------------------------------ */
  async function loadFiles() {
    const q = $('#f-q').value.trim();
    const status = $('#f-status').value;
    const qs = new URLSearchParams();
    if (q) qs.set('q', q);
    if (status) qs.set('status', status);
    try {
      const data = await App.api(`/api/admin/monitor/files?${qs.toString()}`);
      lastFiles = data.items;
      $('#f-count').textContent = `共 ${data.total} 份${data.total > data.items.length ? `，显示最近 ${data.items.length} 份` : ''}`;
      renderFiles(data.items);
    } catch (e) {
      $('#file-body').innerHTML = `<tr><td colspan="7" class="empty">${esc(e.message)}</td></tr>`;
    }
  }

  function renderFiles(items) {
    if (!items.length) {
      $('#file-body').innerHTML = '<tr><td colspan="7" class="empty">还没有文件。等校友上传，或者你自己在「导入回忆」里传一份。</td></tr>';
      return;
    }
    $('#file-body').innerHTML = items.map((f) => `
      <tr data-id="${esc(f.id)}">
        <td>
          <b>${esc(f.title || f.name || '未命名')}</b>
          ${f.title ? `<div class="muted" style="font-size:12px">${esc(f.name)}</div>` : ''}
          ${f.sensitive && f.sensitive.length ? `<span class="tag red">敏感词 ${f.sensitive.length}</span>` : ''}
        </td>
        <td>${esc(f.uploaderLabel || '—')}<div class="muted mono" style="font-size:11px">${esc(f.ip || '')}</div></td>
        <td class="mono">${fmtSize(f.size)}</td>
        <td>${f.flex ? `<span class="tag">整篇</span>${f.imageCount ? ` <span class="muted" style="font-size:11px">${f.imageCount} 张照片</span>` : ''}` : (f.entries || 0)}</td>
        <td><span class="tag ${f.status === 'ready' ? 'gray' : f.status === 'failed' ? 'red' : ''}">${esc(f.statusText || STATUS[f.status] || f.status)}</span></td>
        <td class="muted" style="font-size:12px">${App.fmtTime(f.ts)}</td>
        <td>
          <button class="btn ghost tiny" data-view="${esc(f.id)}">看内容</button>
          <button class="btn ghost tiny" data-del="${esc(f.id)}">删除</button>
        </td>
      </tr>`).join('');
  }

  /* ------------------------------ 文件详情 ------------------------------ */
  async function openFile(id) {
    let d;
    try {
      d = await App.api(`/api/admin/monitor/files/${id}`);
    } catch (e) {
      App.toast(e.message, 'err');
      return;
    }
    current = d;
    $('#fm-title').textContent = d.title || d.name || '文件内容';
    $('#fm-meta').innerHTML = [
      `上传人：<b>${esc(d.uploaderLabel || '—')}</b>`,
      `IP ${esc(d.ip || '—')}`,
      fmtSize(d.size),
      `${d.entries || 0} 条`,
      App.fmtTime(d.ts),
      d.ua ? `<div class="muted" style="font-size:11px;margin-top:4px">${esc(d.ua)}</div>` : '',
    ].join(' · ');

    const warn = [];
    if (d.sensitive && d.sensitive.length) {
      warn.push(`<div class="form-hint-box hint-warn">命中敏感词：<b>${d.sensitive.map(esc).join('、')}</b>。请仔细看下面内容再决定。</div>`);
    }
    if (d.parseError) warn.push(`<div class="form-hint-box hint-warn">重新解析时出错：${esc(d.parseError)}</div>`);
    if (d.noteBig) warn.push(`<div class="form-hint-box">${esc(d.noteBig)}</div>`);
    if (d.note) warn.push(`<div class="form-hint-box">上传者留言：${esc(d.note)}</div>`);
    $('#fm-warn').innerHTML = warn.join('');

    const acts = [];
    if (d.postId) acts.push(`<a class="btn ghost" href="/post/${esc(d.postId)}" target="_blank" rel="noopener">看这条回忆 ↗</a>`);
    if (d.hasFile) acts.push(`<a class="btn ghost" href="/api/admin/monitor/files/${esc(d.id)}/download">下载原文件</a>`);
    acts.push('<button class="btn ghost red" id="fm-delete">删除这份文档</button>');
    acts.push(`<span class="muted" style="font-size:12px">状态：${esc(d.statusText || d.status)}。校友传的文档会立刻发到回忆墙上，觉得不合适就在这里删掉。</span>`);
    $('#fm-actions').innerHTML = acts.join('');

    const body = [];
    if (d.entriesSample && d.entriesSample.length) {
      body.push(`<div class="fm-sec">解析出的条目（预览前 ${d.entriesSample.length} 条）</div>`);
      body.push('<div class="fm-entries">' + d.entriesSample.map((en, i) => `
        <div class="fm-entry">
          <div class="fm-entry-h">
            <span class="tag gray">${i + 1}</span>
            <b>${esc(App.whoLabel(en.year, en.className, en.name) || '佚名')}</b>
            ${en.title ? `<span class="muted">· ${esc(en.title)}</span>` : ''}
          </div>
          <div class="fm-entry-c">${highlight(en.content || '', d.sensitive || [])}</div>
        </div>`).join('') + '</div>');
    }
    if (d.fullText) {
      body.push(`<div class="fm-sec">原文${d.contentTruncated ? '（只显示前 2 万字）' : ''}</div>`);
      body.push(`<pre class="fm-raw">${highlight(d.fullText, d.sensitive || [])}</pre>`);
    }
    if (!body.length) body.push('<div class="empty">没有可展示的内容。</div>');
    $('#fm-body').innerHTML = body.join('');

    bindModalActions(d);
    App.openModal('file-modal');
  }

  function highlight(text, words) {
    let html = esc(String(text || ''));
    for (const w of words) {
      if (!w) continue;
      const re = new RegExp(esc(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
      html = html.replace(re, `<mark>$&</mark>`);
    }
    return html;
  }

  function bindModalActions(d) {
    const del = $('#fm-delete');
    if (del) del.addEventListener('click', () => removeFile(d.id, d.name));
  }

  async function removeFile(id, name) {
    if (!confirm(`删除「${name}」？这条记录、原文件，以及从它发到墙上的回忆都会一起删掉。`)) return;
    try {
      await App.api(`/api/admin/monitor/files/${id}`, { method: 'DELETE' });
      App.toast('已删除');
      App.closeModal('file-modal');
      loadFiles();
    } catch (e) { App.toast(e.message, 'err'); }
  }

  async function kick(uid) {
    if (!confirm('让这个人所有设备立刻掉线？他会需要重新输密码。')) return;
    try {
      const r = await App.api(`/api/admin/monitor/users/${uid}/kick`, { method: 'POST' });
      App.toast(r.kicked ? `已踢下线（${r.kicked} 个会话）` : '这个人本来就没有会话');
      load();
    } catch (e) { App.toast(e.message, 'err'); }
  }

  async function banIp(ip) {
    const reason = prompt(`封禁 ${ip}？填个理由（记给自己看，可留空）\n\n注意：如果你自己也在同一个网络里，你会一起被挡在外面。`) ;
    if (reason === null) return;
    try {
      await App.api('/api/admin/bans', { method: 'POST', body: { ip, reason } });
      App.toast(`已封禁 ${ip}`);
      load();
    } catch (e) { App.toast(e.message, 'err'); }
  }

  /* ------------------------------ 事件绑定 ------------------------------ */
  document.addEventListener('click', (e) => {
    const view = e.target.closest('[data-view]');
    if (view) { openFile(view.dataset.view); return; }
    const dl = e.target.closest('[data-del]');
    if (dl) {
      const f = lastFiles.find((x) => x.id === dl.dataset.del);
      removeFile(dl.dataset.del, (f && f.name) || '这份文档');
      return;
    }
    const kk = e.target.closest('[data-kick]');
    if (kk && kk.dataset.kick) { kick(kk.dataset.kick); return; }
    const bn = e.target.closest('[data-ban]');
    if (bn && bn.dataset.ban) { banIp(bn.dataset.ban); }
  });

  $('#refresh-btn').addEventListener('click', () => { load().catch(() => {}); loadFiles(); });
  $('#f-status').addEventListener('change', loadFiles);
  $('#f-q').addEventListener('input', App.debounce(loadFiles, 350));
  App.bindModalClosers();

  /* ------------------------------ 轮询 ------------------------------ */
  function startTimers() {
    stopTimers();
    loadFiles();
    timer = setInterval(() => {
      if (!$('#auto-refresh').checked || document.hidden) return;
      load().catch((e) => { if (e.status === 401) stopTimers(); });
    }, 5000);
    fileTimer = setInterval(() => {
      if (!$('#auto-refresh').checked || document.hidden) return;
      if ($('#file-modal').classList.contains('show')) return;
      loadFiles();
    }, 15000);
  }
  function stopTimers() {
    if (timer) clearInterval(timer);
    if (fileTimer) clearInterval(fileTimer);
    timer = null;
    fileTimer = null;
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && $('#shell') && !$('#shell').classList.contains('hidden')) {
      load().catch(() => {});
    }
  });

  tryEnter();
})();