'use strict';
/*
 * "What's new" texts shown in the window that opens after an update (and from Settings → About).
 * Newest first. Texts are English.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.WHATS_NEW = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const ENTRIES = [
    {
      version: '0.2.0',
      date: '2026-11-13',
      items: [
        {
          icon: 'globe',
          title: { en: 'Proxy support' },
          text: {
            en: 'Use an HTTP or SOCKS5 proxy, or the one from your system, with an optional login. It works for downloads, video downloads and update checks. Settings → Proxy.',
          },
        },
        {
          icon: 'clock',
          title: { en: '“Last try” column' },
          text: {
            en: 'The compact list shows the date and time of each download’s last attempt, so you can see when something was tried or failed.',
          },
        },
        {
          icon: 'list',
          title: { en: 'A cleaner list' },
          text: {
            en: 'The lines between downloads are gone, so the list looks calmer.',
          },
        },
        {
          icon: 'star',
          title: { en: 'This window' },
          text: {
            en: 'After every update VDM now tells you what changed. You can open it again from Settings → About.',
          },
        },
      ],
    },
    {
      version: '0.1.3',
      date: '2026-11-12',
      items: [
        {
          icon: 'shield',
          title: { en: 'Security update' },
          text: {
            en: 'Browser cookies are encrypted, only VDM’s own extension can send downloads, and the video tools are verified before use.',
          },
        },
      ],
    },
    {
      version: '0.1.2',
      date: '2026-11-12',
      items: [
        {
          icon: 'tool',
          title: { en: 'Fixed old browser downloads reopening' },
          text: {
            en: 'Reopening the browser no longer opens windows for old downloads.',
          },
        },
      ],
    },
    {
      version: '0.1.1',
      date: '2026-11-12',
      items: [
        {
          icon: 'list',
          title: { en: 'Queues and multi-select' },
          text: {
            en: 'Several download queues, selecting many downloads at once, YouTube downloads fixed and a macOS version.',
          },
        },
      ],
    },
  ];

  const cmp = (a, b) => {
    const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
    const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
    for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
    return 0;
  };

  /** Entries newer than `from` up to and including `to` (only `to` itself when `from` is unknown). */
  function between(from, to) {
    return ENTRIES.filter((e) => (from ? cmp(e.version, from) > 0 && cmp(e.version, to) <= 0 : e.version === to));
  }

  return { ENTRIES, between, cmp };
});
