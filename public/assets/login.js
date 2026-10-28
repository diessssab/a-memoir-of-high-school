/* ============================================================
   登录 / 登记页
   —— 用浏览器原生表单提交（不是 fetch），这样 Chrome / Edge /
      Firefox / Safari 才会弹出"是否保存密码"，下次自动填充。
   —— 身份只用一个输入框「几几级的谁谁谁」，浏览器记住这一个框
      就等于记住了完整身份。
   ============================================================ */
(() => {
  const $ = (id) => document.getElementById(id);

  const errBox = $('form-error');
  const hintBox = $('form-hint');
  const loginForm = $('login-form');
  const regForm = $('register-form');
  const loginWho = $('login-who');
  const loginPwd = $('login-password');
  const regWho = $('reg-who');
  const regClass = $('reg-class');
  const regPwd = $('reg-password');
  const regPwd2 = $('reg-password2');
  const viewTitle = $('view-title');
  const viewSub = $('view-sub');
  const LS_WHO = 'mem_who';

  const COPY = {
    login: {
      title: '老同学，请进门',
      sub: '报上你是 <b>几几级</b> 的 <b>谁谁谁</b>，再加上自己的密码。',
    },
    register: {
      title: '第一次来？先登记',
      sub: '留下 <b>几几级</b> 的 <b>谁谁谁</b>，设一个密码，以后凭它进门。',
    },
  };

  let mode = 'login';
  let policy = { minLength: 1, allowSelfChange: true };
  let registrationOpen = true;

  /* ---------------- 提示 ---------------- */
  function showError(msg) {
    errBox.textContent = msg;
    errBox.classList.add('show');
    errBox.style.animation = 'none';
    void errBox.offsetWidth;
    errBox.style.animation = '';
  }
  function hideError() {
    errBox.classList.remove('show');
    errBox.textContent = '';
  }
  function showHint(msg) {
    if (!msg) return;
    hintBox.textContent = msg;
    hintBox.classList.remove('hidden');
  }

  /* ---------------- 身份解析（与服务端 server/who.js 同规则） ---------------- */
  function parseWho(raw) {
    let s = String(raw == null ? '' : raw).replace(/\u3000/g, ' ').trim();
    if (!s) return { ok: false, error: '先写「几几级的谁谁谁」，例如：1995级 张三' };

    let year = null;
    // 先认带「级/届/年」的数字：两位补全，三四位原样交给范围校验拦下
    const mG = s.match(/(?<![0-9])([0-9]{2,4})\s*(?:级|届|年)/);
    if (mG) {
      const d = mG[1];
      if (d.length === 2) {
        const n = Number(d);
        year = n >= 40 ? 1900 + n : 2000 + n;
      } else {
        year = Number(d);
      }
      s = s.replace(mG[0], ' ');
    } else {
      const m4 = s.match(/(?<![0-9])((?:19|20)[0-9]{2})(?![0-9])/);
      if (m4) {
        year = Number(m4[1]);
        s = s.replace(m4[0], ' ');
      }
    }

    let className = '';
    const mc = s.match(/([0-9]{1,2})\s*班/);
    if (mc) {
      className = String(Number(mc[1]));
      s = s.replace(mc[0], ' ');
    }

    const name = s
      .replace(/[，,。、；;：:·•\-—_\s]+/g, ' ')
      .replace(/[^\u4e00-\u9fa5A-Za-z ]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (year === null) return { ok: false, error: '没看出你是几几级的 —— 请写成「1995级 张三」这样' };
    const nowYear = new Date().getFullYear();
    if (year < 1956 || year > nowYear + 1) {
      return { ok: false, error: `级别看起来不太对，请填 1956 ~ ${nowYear} 之间的年份` };
    }
    if (!name) return { ok: false, error: '没看出你的名字 —— 请写成「1995级 张三」这样' };
    if (!/^[\u4e00-\u9fa5A-Za-z·•\s]{1,20}$/.test(name)) {
      return { ok: false, error: '姓名只能是中文或英文字母' };
    }
    return {
      ok: true,
      year,
      className,
      name,
      canonical: `${year}级${className ? className + '班' : ''}${name}`,
      text: `${year} 级${className ? ' · ' + className + ' 班' : ''} · ${name}`,
    };
  }

  const DEFAULT_HINT = {
    'login-who-hint': '格式：届别 + 姓名，例如「1995级 张三」「95级3班张三」。浏览器会把这个框和密码一起记住。',
    'reg-who-hint': '写全一点：届别（哪年入学）+ 姓名。可以带上班级，例如「1995级3班张三」。',
  };

  function bindPreview(input, hintId) {
    const hint = $(hintId);
    input.addEventListener('input', () => {
      const v = input.value.trim();
      if (!v) {
        hint.textContent = DEFAULT_HINT[hintId] || '';
        hint.classList.remove('warn');
        return;
      }
      const p = parseWho(v);
      hint.textContent = p.ok ? `认出：${p.text}` : p.error;
      hint.classList.toggle('warn', !p.ok);
    });
  }
  bindPreview(loginWho, 'login-who-hint');
  bindPreview(regWho, 'reg-who-hint');

  /* ---------------- 模式切换 ---------------- */
  function setMode(next) {
    mode = next === 'register' ? 'register' : 'login';
    const isReg = mode === 'register';
    loginForm.classList.toggle('hidden', isReg);
    regForm.classList.toggle('hidden', !isReg);
    viewTitle.textContent = COPY[mode].title;
    viewSub.innerHTML = COPY[mode].sub;
    document.querySelectorAll('#auth-tabs button').forEach((b) => {
      b.classList.toggle('on', b.dataset.mode === mode);
    });
    hideError();
    const first = isReg ? regWho : loginWho;
    if (first && !first.value) setTimeout(() => first.focus(), 60);
  }

  $('auth-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    if (b.dataset.mode === 'register' && !registrationOpen) {
      return showError('站长暂时关闭了新访客登记，你仍然可以浏览回忆墙。');
    }
    setMode(b.dataset.mode);
  });

  /* ---------------- 显示 / 隐藏密码 ---------------- */
  document.querySelectorAll('[data-eye]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.eye);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? '隐藏' : '显示';
    });
  });

  /* ---------------- 记住上次填的身份（浏览器的自动填充优先级更高） ---------------- */
  function rememberWho(v) {
    try { localStorage.setItem(LS_WHO, v); } catch (_) {}
  }
  function restoreWho() {
    try {
      const v = localStorage.getItem(LS_WHO);
      if (v && !loginWho.value) loginWho.value = v;
    } catch (_) {}
  }

  function busy(form, text) {
    const btn = form.querySelector('button[type="submit"]');
    if (!btn) return;
    btn.textContent = text;
    setTimeout(() => { btn.disabled = true; }, 0);
  }

  /* ---------------- 登录：校验通过后交给浏览器原生提交 ---------------- */
  loginForm.addEventListener('submit', (e) => {
    const p = parseWho(loginWho.value);
    if (!p.ok) {
      e.preventDefault();
      showError(p.error);
      loginWho.focus();
      return;
    }
    if (!loginPwd.value) {
      e.preventDefault();
      showError('请输入密码');
      loginPwd.focus();
      return;
    }
    if (p.canonical.length > 40) {
      e.preventDefault();
      showError('这一栏太长了，写上届别和姓名就够');
      return;
    }
    // 规范成「1995级3班张三」：浏览器存下来的就是这个完整身份
    loginWho.value = p.canonical;
    rememberWho(p.canonical);
    addIntro();
    busy(loginForm, '正在开门…');
  });

  /* ---------------- 登记 ---------------- */
  regForm.addEventListener('submit', (e) => {
    const p = parseWho(regWho.value);
    if (!p.ok) {
      e.preventDefault();
      showError(p.error);
      regWho.focus();
      return;
    }
    const cls = String(regClass.value || '').replace(/[^0-9]/g, '').slice(0, 2);
    if (cls && (Number(cls) < 1 || Number(cls) > 99)) {
      e.preventDefault();
      showError('班级请填 1 ~ 99 之间的数字');
      regClass.focus();
      return;
    }
    if (cls && !p.className) p.canonical = `${p.year}级${cls}班${p.name}`;
    if (regPwd.value.length < policy.minLength) {
      e.preventDefault();
      showError(policy.minLength <= 1 ? '请设置一个密码' : `密码至少 ${policy.minLength} 位`);
      regPwd.focus();
      return;
    }
    if (regPwd.value !== regPwd2.value) {
      e.preventDefault();
      showError('两次输入的密码不一样');
      regPwd2.focus();
      return;
    }
    regWho.value = p.canonical;
    rememberWho(p.canonical);
    addIntro();
    busy(regForm, '正在登记…');
  });

  /* ---------------- 进门的一点点仪式感：墨点扩散 ---------------- */
  function addIntro() {
    if (document.querySelector('.ink-burst')) return;
    const style = document.createElement('style');
    style.textContent = `
      .ink-burst{position:fixed;inset:0;z-index:500;pointer-events:none;display:grid;place-items:center}
      .ink-burst span{width:14px;height:14px;border-radius:50%;background:rgba(47,74,60,.9);
        animation:ink .6s ease-out forwards}
      @keyframes ink{to{width:160vmax;height:160vmax;opacity:0}}`;
    document.head.appendChild(style);
    const burst = document.createElement('div');
    burst.className = 'ink-burst';
    burst.innerHTML = '<span></span>';
    document.body.appendChild(burst);
    setTimeout(() => burst.remove(), 700);
  }

  $('switch-user').addEventListener('click', async () => {
    await App.api('/api/logout', { method: 'POST' });
    location.reload();
  });

  /* ---------------- 处理服务端 303 回来带的提示 ---------------- */
  const params = new URLSearchParams(location.search);
  const paramTab = params.get('tab');
  const paramErr = params.get('err');
  const paramHint = params.get('hint');
  const paramWho = params.get('who');

  setMode(paramTab === 'register' ? 'register' : 'login');
  if (paramWho) {
    const target = mode === 'register' ? regWho : loginWho;
    target.value = paramWho;
    target.dispatchEvent(new Event('input'));
  }
  if (paramErr) showError(paramErr);
  if (paramHint) showHint(paramHint);
  if (paramTab || paramErr || paramWho || paramHint) {
    const clean = mode === 'register' ? '/index.html?tab=register' : '/index.html';
    try { history.replaceState(null, '', clean); } catch (_) {}
  }

  /* ---------------- 联系站长（后台里填的联系方式） ---------------- */
  function copyText(text, btn) {
    const done = () => {
      const old = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(() => { btn.textContent = old; }, 1600);
    };
    const manual = () => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (_) { btn.textContent = '请手动复制'; }
      document.body.removeChild(ta);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, manual);
    } else {
      manual();
    }
  }

  function openContact() {
    const panel = $('contact-panel');
    const btn = $('contact-toggle');
    if (!panel || panel.classList.contains('hidden') === false) return;
    panel.classList.remove('hidden');
    if (btn) {
      btn.setAttribute('aria-expanded', 'true');
      const caret = btn.querySelector('.contact-caret');
      if (caret) caret.textContent = '▴';
    }
  }

  function renderContact(c) {
    const box = $('contact-box');
    const list = $('contact-list');
    if (!box || !list || !c) return;

    const add = (label, value, href) => {
      if (!value) return;
      const row = document.createElement('div');
      row.className = 'contact-row';

      const k = document.createElement('span');
      k.className = 'contact-k';
      k.textContent = label;

      const v = document.createElement('span');
      v.className = 'contact-v';
      if (href) {
        const a = document.createElement('a');
        a.href = href;
        a.textContent = value;
        v.appendChild(a);
      } else {
        v.textContent = value;
      }

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn ghost tiny contact-copy';
      btn.textContent = '复制';
      btn.addEventListener('click', () => copyText(value, btn));

      row.appendChild(k);
      row.appendChild(v);
      row.appendChild(btn);
      list.appendChild(row);
    };

    add('微信', c.wechat);
    add('QQ', c.qq);
    add('邮箱', c.email, c.email ? 'mailto:' + c.email : '');
    add('电话', c.phone, c.phone ? 'tel:' + c.phone.replace(/[^0-9+]/g, '') : '');

    if (c.note) {
      const n = $('contact-note');
      n.textContent = c.note;
      n.classList.remove('hidden');
    }

    box.classList.remove('hidden');
    $('contact-toggle').addEventListener('click', () => {
      const panel = $('contact-panel');
      const isHidden = panel.classList.toggle('hidden');
      $('contact-toggle').setAttribute('aria-expanded', isHidden ? 'false' : 'true');
      const caret = $('contact-toggle').querySelector('.contact-caret');
      if (caret) caret.textContent = isHidden ? '▾' : '▴';
    });
  }

  /* ---------------- 我是谁：已登录直接显示欢迎 ---------------- */
  async function checkMe() {
    let me = null;
    try {
      me = await App.api('/api/me');
    } catch (_) {
      return;
    }
    if (me.password) policy = Object.assign(policy, me.password);
    registrationOpen = !me.settings || me.settings.registrationOpen !== false;

    // 后台能改站名：学校名 / 英文小字 / 站点全称，登录页是别人看到的第一屏
    if (me.settings) {
      const brand = App.applyBrand(me.settings);
      document.title = `${brand.siteTitle} · 入院登记`;
      const desc = document.querySelector('meta[name="description"]');
      if (desc) desc.setAttribute('content', `${brand.schoolName}校友回忆录：写下你的中学时光，找回落在一起的三年。`);
    }

    if (me.settings && me.settings.notice) {
      const p = document.createElement('p');
      p.className = 'hint';
      p.style.marginBottom = '14px';
      p.textContent = me.settings.notice;
      document.querySelector('.login-card').prepend(p);
    }
    if (!registrationOpen) {
      const tab = document.querySelector('#auth-tabs button[data-mode="register"]');
      if (tab) {
        tab.disabled = true;
        tab.textContent = '登记已暂停';
      }
    }
    if (policy.minLength > 1) {
      const h = $('reg-pwd-hint');
      if (h) h.textContent = `至少 ${policy.minLength} 位，没有其他要求。忘了可以找站长重置。`;
      regPwd.setAttribute('minlength', String(policy.minLength));
      regPwd2.setAttribute('minlength', String(policy.minLength));
    }

    if (me.settings && me.settings.contact) {
      renderContact(me.settings.contact);
      // 登录失败 / 需要找人时，直接把联系方式摊开，省得再点一次
      if (paramErr) openContact();
    }

    if (me.user) {
      $('form-view').classList.add('hidden');
      $('welcome-view').classList.remove('hidden');
      $('welcome-who').textContent = App.whoLabel(me.user.year, me.user.className, me.user.name);
      $('welcome-sub').textContent = `你是 ${App.whoLabel(me.user.year, me.user.className, me.user.name)}，直接进去接着写。`;
      if (me.user.mustChange) {
        const box = $('welcome-must');
        box.innerHTML = '站长帮你重置过密码，<b>请先去账号设置里改一个自己的密码</b>。';
        box.classList.remove('hidden');
      }
      return true;
    }
    // 浏览器的自动填充通常晚一点，300ms 后还没填就补上次的身份
    if (!loginWho.value) setTimeout(restoreWho, 300);
    return false;
  }

  /* ---------------- 统计数字 ---------------- */
  function animateStats() {
    App.api('/api/stats').then((s) => {
      const anim = (el, to) => {
        const dur = 700;
        const t0 = performance.now();
        const step = (t) => {
          const p = Math.min(1, (t - t0) / dur);
          el.textContent = Math.round(to * (1 - Math.pow(1 - p, 3)));
          if (p < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      };
      anim($('st-post'), s.postCount);
      anim($('st-user'), s.userCount);
      anim($('st-year'), s.yearCount);
    }).catch(() => {});
  }

  checkMe();
  animateStats();
})();