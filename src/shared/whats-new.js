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
      version: '0.2.5',
      date: '2026-11-16',
      items: [
        {
          icon: 'star',
          title: { en: 'The logo inside the app uses the new artwork' },
          text: {
            en: 'The title bars, dialogs and Settings now show the new red icon with the yellow swoosh and the Vietnamese flag badge, matching the app icon.',
          },
        },
        {
          icon: 'tool',
          title: { en: 'Full-colour tray icon on Windows and Linux' },
          text: {
            en: 'The system tray now shows the red icon with the white download arrow, clearly visible on light and dark taskbars alike.',
          },
        },
      ],
    },
    {
      version: '0.2.4',
      date: '2026-11-16',
      items: [
        {
          icon: 'tool',
          title: { en: 'Download video button: close it, and it stays out of the way' },
          text: {
            en: 'The button in the browser has a × to close it. It moves to another corner when it would cover a site’s own buttons, and you can turn it off for one website in the extension’s popup. Reload the VDM extension to get this.',
          },
        },
        {
          icon: 'star',
          title: { en: 'The extension stays in Edge and Chrome' },
          text: {
            en: 'VDM now keeps its browser extension in a permanent folder, so the browser no longer forgets it after a restart (this affected the portable version). Settings → Browser integration → Open extension folder shows it. Load that folder in your browser once.',
          },
        },
        {
          icon: 'clock',
          title: { en: 'Update button fixed' },
          text: {
            en: 'The Update Available button works again, and VDM waits for a new release’s files before offering it.',
          },
        },
      ],
    },
    {
      version: '0.2.2',
      date: '2026-11-14',
      items: [
        {
          icon: 'tool',
          title: { en: 'Update button fixed' },
          text: {
            en: 'The Update Available button works again: it installs the new version itself instead of doing nothing. If an update is found while its files are still being uploaded, VDM waits for them.',
          },
        },
      ],
    },
    {
      version: '0.2.1',
      date: '2026-11-14',
      items: [
        {
          icon: 'tool',
          title: { en: 'Download video: the right video' },
          text: {
            en: 'On pages with several videos, the browser button now downloads the video you clicked instead of another one. Reload the VDM extension in your browser to get this fix.',
          },
        },
        {
          icon: 'star',
          title: { en: 'A window when a download finishes' },
          text: {
            en: 'A separate “Download complete” window opens on top of everything, with Open and Open folder.',
          },
        },
        {
          icon: 'globe',
          title: { en: 'Update check fixed' },
          text: {
            en: 'Update checks no longer fail with “GitHub responded 403” on shared networks and VPNs.',
          },
        },
      ],
    },
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
