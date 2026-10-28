/* 账号设置：改密码（浏览器也可在这里记住新密码） */
(() => {
  const $ = (id) => document.getElementById(id);
  const errBox = $('pwd-error');
  const form = $('pwd-form');
  const oldInput = $('old-pwd');
  const newInput = $('new-pwd');
  const new2Input = $('new-pwd2');
  const params = new URLSearchParams(location.search);
  const forced = params.get('must') === '1';

  let me = null;

  function showError(msg) {
    errBox.textContent = msg;
    errBox.classList.add('show');
  }
  function hideError() {
    errBox.classList.remove('show');
    errBox.textContent = '';
  }

  document.querySelectorAll('[data-eye]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const input = $(btn.dataset.eye);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.textContent = show ? '隐藏' : '显示';
    });
  });

  function kv(label, value) {
    return `<div><span>${App.esc(label)}</span><b>${App.esc(value)}</b></div>`;
  }

  async function boot() {
    const who = await App.renderTopbar('account');
    me = who && who.user;
    if (!me) {
      $('signin-panel').classList.remove('hidden');
      return;
    }
    $('who-panel').classList.remove('hidden');
    $('pwd-form').classList.remove('hidden');

    const rows = [
      kv('身份', App.whoLabel(me.year, me.className, me.name)),
      kv('登记时间', me.createdAt ? App.fmtTime(me.createdAt) : '—'),
      kv('密码状态', me.hasPassword ? `已设置（${me.pwdLength || 0} 位）` : '还没设置'),
    ];
    $('who-info').innerHTML = rows.join('');

    if (me.mustChange || forced) {
      const box = $('must-box');
      box.innerHTML = '站长帮你重置过密码，<b>现在请改成自己的密码</b>。';
      box.classList.remove('hidden');
      oldInput.value = '';
      $('old-hint').textContent = '管理员刚给你发过临时密码？先把它填在图上的「现在的密码」里，再设新的。';
      setTimeout(() => oldInput.focus(), 120);
    }
    if (!me.hasPassword) {
      $('old-hint').textContent = '你的账号还没设过密码，这一栏留空。';
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError();
    const oldPassword = oldInput.value;
    const newPassword = newInput.value;
    if (!newPassword) return showError('新密码不能空着');
    if (newPassword !== new2Input.value) return showError('两次输入的新密码不一样');
    if (me && me.hasPassword && newPassword === oldPassword) {
      return showError('新密码不能和原密码一样');
    }

    const btn = $('save-pwd');
    btn.disabled = true;
    btn.textContent = '保存中…';
    try {
      await App.api('/api/password', {
        method: 'POST',
        body: { oldPassword, newPassword, newPassword2: new2Input.value },
      });
      App.toast('密码已更新');
      oldInput.value = '';
      newInput.value = '';
      new2Input.value = '';
      $('must-box').classList.add('hidden');
      if (me) {
        me.hasPassword = true;
        me.pwdLength = newPassword.length;
        me.mustChange = false;
      }
      $('who-info').innerHTML = [
        kv('身份', App.whoLabel(me.year, me.className, me.name)),
        kv('登记时间', me.createdAt ? App.fmtTime(me.createdAt) : '—'),
        kv('密码状态', `已设置（${newPassword.length} 位）`),
      ].join('');
      setTimeout(() => { location.href = '/wall.html'; }, 700);
    } catch (err) {
      showError(err.message);
      btn.disabled = false;
      btn.textContent = '保存新密码';
    }
  });

  $('logout').addEventListener('click', async () => {
    await App.api('/api/logout', { method: 'POST' });
    location.href = '/index.html';
  });

  boot();
})();