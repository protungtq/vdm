'use strict';
/*
 * Translations, shared by the main process (require) and the windows (<script>).
 * The English text IS the key: t('Add Link') returns the Persian text when the language is
 * Persian and the key itself otherwise, so a missing translation just shows English.
 * Placeholders look like {name}: t('{n} waiting', { n: 3 }).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.I18N = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // English only for now. Another language is added by registering its texts (register) and listing it here.
  const LANGS = [{ id: 'en', name: 'English', dir: 'ltr' }];
  const dicts = {};
  let lang = 'en';

  const known = (id) => LANGS.some((l) => l.id === id);
  
  /** Picks the language for a system locale such as "fa-IR" or "en-US". */
  function fromLocale(locale) {
    const id = String(locale || '').toLowerCase().split(/[-_]/)[0];
    return known(id) ? id : 'en';
  }

  function register(id, dict) {
    dicts[id] = { ...(dicts[id] || {}), ...dict };
  }

  function setLang(id) {
    lang = known(id) ? id : 'en';
    return lang;
  }

  const getLang = () => lang;
  const dir = () => (LANGS.find((l) => l.id === lang) || LANGS[0]).dir;
  const isRtl = () => dir() === 'rtl';

  function fill(text, vars) {
    return vars ? text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)) : text;
  }

  function t(key, vars) {
    const d = dicts[lang];
    const hit = d && Object.prototype.hasOwnProperty.call(d, key) ? d[key] : key;
    return fill(hit, vars);
  }

  /** True when the current language has a translation for this text. */
  const has = (key) => !!dicts[lang] && Object.prototype.hasOwnProperty.call(dicts[lang], key);

  const digits = (text) => String(text);

  /** A version number such as 0.2.0. */
  const ver = (v) => String(v);

  /** A date + time for "Last try" etc.: Persian uses the Jalali calendar. */
  function dateTime(ms, opts = {}) {
    if (!(ms > 0)) return '—';
    const d = new Date(ms);
    const locale = 'sv-SE'; // prints 2026-11-13 07:26
    const o = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, ...opts };
    try {
      return new Intl.DateTimeFormat(locale, o).format(d);
    } catch {
      return d.toLocaleString();
    }
  }

  return { ver, LANGS, register, setLang, getLang, dir, isRtl, t, has, digits, dateTime, fromLocale, known };
});
