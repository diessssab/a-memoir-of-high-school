/* ============================================================
   公共工具：请求封装、提示条、时间格式化、顶部导航、图片灯箱
   ============================================================ */

const App = (() => {
  async function api(path, options = {}) {
    const opts = {
      method: options.method || 'GET',
      headers: { ...(options.headers || {}) },
      credentials: 'same-origin',
    };
    if (options.body instanceof FormData) {
      opts.body = options.body;
    } else if (options.body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(options.body);
    }
    const res = await fetch(path, opts);
    let data = null;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      data = await res.json().catch(() => null);
    } else {
      data = await res.text().catch(() => '');
    }
    if (!res.ok) {
      const msg = (data && data.error) || (typeof data === 'string' && data) || `请求失败（${res.status}）`;
      const err = new Error(msg);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /* ---------- 提示条 ---------- */
  function ensureToasts() {
    let box = document.querySelector('.toasts');
    if (!box) {
      box = document.createElement('div');
      box.className = 'toasts';
      document.body.appendChild(box);
    }
    return box;
  }
  function toast(message, type = 'ok', ms = 2600) {
    const box = ensureToasts();
    const el = document.createElement('div');
    el.className = 'toast' + (type === 'err' ? ' err' : '');
    el.textContent = message;
    box.appendChild(el);
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 320);
    }, ms);
  }

  /* ---------- 时间 ---------- */
  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function fmtClock(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  function fmtAgo(ts) {
    if (!ts) return '从未';
    const diff = Date.now() - ts;
    if (diff < 60_000) return '刚刚';
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`;
    if (diff < 30 * 86400_000) return `${Math.floor(diff / 86400_000)} 天前`;
    return fmtTime(ts);
  }

  /* ---------- 身份 ---------- */
  function gradeLabel(year) {
    if (!year) return '';
    const s = String(year);
    return `${s.length === 4 ? s.slice(2) : s}级`;
  }
  function whoLabel(year, className, name) {
    if (!year && !className && !name) return '佚名校友';
    return `${gradeLabel(year)}${className ? className + '班' : ''}${name || ''}`;
  }

  /* ---------- 站名（后台可改） ---------- */
  // 默认值只用于 JS 还没拿到 /api/me 的那一瞬间
  const BRAND = {
    schoolName: '廊坊一中',
    siteTitle: '廊坊一中回忆录',
    schoolEn: 'LANGFANG NO.1 MIDDLE SCHOOL',
  };

  /**
   * 把后台设置的站名铺到当前页面上：
   *   .seal            印章（墙、详情、账号页右上角）
   *   [data-site-foot] 页脚那行字
   *   [data-school]    任何要显示学校名的地方
   *   .kicker          登录页那行英文小字（后台留空就隐藏）
   *   <html data-page> 控制浏览器标签页标题
   */
  function applyBrand(settings) {
    if (settings) {
      if (settings.schoolName) BRAND.schoolName = settings.schoolName;
      if (settings.siteTitle) BRAND.siteTitle = settings.siteTitle;
      if (settings.schoolEn !== undefined) BRAND.schoolEn = settings.schoolEn || '';
    }
    document.querySelectorAll('.seal').forEach((el) => { el.textContent = BRAND.schoolName; });
    document.querySelectorAll('[data-school]').forEach((el) => { el.textContent = BRAND.schoolName; });
    document.querySelectorAll('[data-site-foot]').forEach((el) => {
      el.textContent = `${BRAND.siteTitle} · 由校友共同守护`;
    });
    document.querySelectorAll('.kicker').forEach((el) => {
      if (BRAND.schoolEn) {
        el.textContent = BRAND.schoolEn;
        el.style.display = '';
      } else {
        el.style.display = 'none';
      }
    });
    const page = document.documentElement.dataset.page || '';
    document.title = page ? `${page} · ${BRAND.siteTitle}` : BRAND.siteTitle;
    return BRAND;
  }

  /* ---------- 顶部导航 ---------- */
  async function renderTopbar(active) {
    const bar = document.querySelector('.topbar');
    if (!bar) return null;
    let me = null;
    try { me = await api('/api/me'); } catch (_) {}
    if (!me) return null;
    applyBrand(me.settings);
    const u = me.user;
    const title = BRAND.siteTitle;
    bar.innerHTML = `
      <a class="brand" href="/wall.html">${esc(title)}<small>MEMOIR</small></a>
      <nav>
        <a href="/wall.html" class="${active === 'wall' ? 'active' : ''}">回忆墙</a>
        ${u ? `<a href="/wall.html?mine=1" class="${active === 'mine' ? 'active' : ''}">我的回忆</a>` : ''}
        ${u ? `<a href="/account.html" class="${active === 'account' ? 'active' : ''}">账号</a>` : ''}
        <a href="/index.html">${u ? '登记信息' : '登记'}</a>
      </nav>
      <span class="spacer"></span>
      <div class="me">
        ${u
          ? `<span class="avatar">${esc((u.name || '客').slice(0, 1))}</span>
             <span>${esc(whoLabel(u.year, u.className, u.name))}</span>
             <button class="btn ghost small" data-logout>退出</button>`
          : `<a class="btn small" href="/index.html">去登记</a>`}
      </div>`;
    const out = bar.querySelector('[data-logout]');
    if (out) {
      out.addEventListener('click', async () => {
        await api('/api/logout', { method: 'POST' });
        location.href = '/index.html';
      });
    }
    return me;
  }

  /* ---------- 转义 ---------- */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /* ---------- 图片灯箱 ---------- */
  function initLightbox() {
    let box = document.querySelector('.lightbox');
    if (!box) {
      box = document.createElement('div');
      box.className = 'lightbox';
      box.innerHTML = '<img alt="图片">';
      document.body.appendChild(box);
      box.addEventListener('click', () => box.classList.remove('show'));
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') box.classList.remove('show');
      });
    }
    document.addEventListener('click', (e) => {
      const img = e.target.closest('[data-zoom]');
      if (!img) return;
      // 包在超链接里的图（Word 域代码里的那种图标）：让链接自己跳转，别被灯箱吃掉
      if (img.closest('a')) return;
      e.preventDefault();
      const src = img.dataset.zoom || img.src;
      box.querySelector('img').src = src;
      box.classList.add('show');
    });
  }

  /* ---------- 弹窗 ---------- */
  function openModal(id) {
    const m = document.getElementById(id);
    if (m) {
      m.classList.add('show');
      document.body.style.overflow = 'hidden';
      const first = m.querySelector('input, textarea, select');
      if (first) setTimeout(() => first.focus(), 80);
    }
  }
  function closeModal(id) {
    const m = document.getElementById(id);
    if (m) {
      m.classList.remove('show');
      document.body.style.overflow = '';
    }
  }
  function bindModalClosers() {
    document.querySelectorAll('.modal-mask').forEach((mask) => {
      mask.addEventListener('click', (e) => {
        if (e.target === mask || e.target.closest('[data-close]')) closeModal(mask.id);
      });
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal-mask.show').forEach((m) => closeModal(m.id));
      }
    });
  }

  /* ---------- 防抖 ---------- */
  function debounce(fn, ms = 300) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  return {
    api, toast, fmtTime, fmtClock, fmtAgo, gradeLabel, whoLabel,
    renderTopbar, esc, initLightbox, openModal, closeModal, bindModalClosers, debounce,
    applyBrand, brand: () => BRAND,
  };
})();