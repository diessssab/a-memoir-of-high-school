'use strict';
/**
 * 「几几级的谁谁谁」解析。
 * 登录页只给一个输入框，用户写「1995级 3班 张三」「95级张三」「1995 张三」都能认出来，
 * 这样浏览器的密码管理器只要记住这一个框 + 密码就够，自动填充能完整还原身份。
 */
const config = require('./config');

const NAME_OK = /^[\u4e00-\u9fa5A-Za-z·•\s]{1,20}$/;

/** 两位数字年份补全：>=40 当 19xx，否则 20xx */
function normalizeYear(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return null;
  if (num >= 1000) return num;
  return num >= 40 ? 1900 + num : 2000 + num;
}

/**
 * @param {string} input 例如「1995级 3班 张三」
 * @returns {{ok:boolean, year?:number, className?:string, name?:string, label?:string, error?:string}}
 */
function parseWho(input) {
  let s = String(input == null ? '' : input)
    .replace(/[\u3000]/g, ' ')
    .trim();
  if (!s) return { ok: false, error: '请填写「几几级的谁谁谁」，例如：1995级 张三' };

  let year = null;
  // 1. 「1995级 / 95级 / 1800届」：先认带 级/届/年 的数字（2 位补全，3~4 位原样交给范围校验拦下）
  const mG = s.match(/(?<!\d)(\d{2,4})\s*(?:级|届|年)/);
  if (mG) {
    year = mG[1].length === 2 ? normalizeYear(Number(mG[1])) : Number(mG[1]);
    s = s.replace(mG[0], ' ');
  } else {
    // 2. 不带「级」的四位年份，如「1995 张三」
    const m4 = s.match(/(?<!\d)((?:19|20)\d{2})(?!\d)/);
    if (m4) {
      year = Number(m4[1]);
      s = s.replace(m4[0], ' ');
    }
  }

  // 3. 班级：「3班」
  let className = '';
  const mc = s.match(/(\d{1,2})\s*班/);
  if (mc) {
    className = String(Number(mc[1]));
    s = s.replace(mc[0], ' ');
  }

  // 4. 剩下的是姓名
  let name = s
    .replace(/[，,。、；;：:·•\-—_\s]+/g, (m) => (/\s/.test(m) ? ' ' : ''))
    .replace(/[^\u4e00-\u9fa5A-Za-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (year === null) {
    return { ok: false, error: '没看出你是几几级的 —— 请写成「1995级 张三」这样，年份放在前面' };
  }
  if (year < config.GRADE_MIN || year > config.GRADE_MAX + 1) {
    return {
      ok: false,
      error: `级别看起来不太对，请填 ${config.GRADE_MIN} ~ ${config.GRADE_MAX} 之间的年份`,
    };
  }
  if (!name) {
    return { ok: false, error: '没看出你的名字 —— 请写成「1995级 张三」这样' };
  }
  if (!NAME_OK.test(name)) {
    return { ok: false, error: '姓名只能是中文或英文字母' };
  }
  if (className && (Number(className) < 1 || Number(className) > 99)) {
    return { ok: false, error: '班级请填 1 ~ 99 之间的数字' };
  }

  return {
    ok: true,
    year,
    className,
    name,
    label: `${String(year).slice(2)}级${className ? className + '班' : ''}${name}`,
  };
}

module.exports = { parseWho, normalizeYear, NAME_OK };