'use strict';
/* Settings view rendered inside the main card. */
window.SettingsView = (function () {
  const { el, icon, t } = DM;
  let root;
  let s;
  const bind = []; // [{ key, apply(settings) }]

  const save = (patch) => api.invoke('settings:set', patch);

  function group(title, id, ...rows) {
    return el('div', { class: 'set-group', id: id ? `set-${id}` : null }, el('div', { class: 'set-title', text: title }), ...rows);
  }

  function row(label, hint, control) {
    return el('div', { class: 'set-row' }, el('div', { class: 'set-text' }, el('div', { class: 'set-label', text: label }), hint ? el('div', { class: 'set-hint', text: hint }) : null), control);
  }

  function toggle(get, set) {
    const input = el('input', { type: 'checkbox' });
    input.addEventListener('change', () => set(input.checked));
    bind.push({ apply: (x) => (input.checked = !!get(x)) });
    return el('label', { class: 'switch' }, input, el('span'));
  }

  function select(options, get, set, cls = '') {
    const sel = el('select', { class: `field ${cls}` }, ...options.map(([v, t]) => el('option', { value: String(v), text: t })));
    sel.addEventListener('change', () => set(sel.value));
    bind.push({ apply: (x) => (sel.value = String(get(x))) });
    return sel;
  }

  const THEMES = [
    ['light', 'Light'],
    ['dark', 'Dark'],
    ['day', 'Day'],
    ['night', 'Night'],
    ['paper', 'Paper'],
    ['mint', 'Mint'],
    ['ocean', 'Ocean'],
    ['neon', 'Neon'],
    ['jungle', 'Jungle'],
    ['retro', 'Retro 95'],
  ];

  /** A tiny drawing of the main window, coloured by the theme's own tokens. */
  function miniPreview(t) {
    return el(
      'div',
      { class: 'theme-preview', 'data-t': t },
      el('div', { class: 'tp-title' }),
      el('div', { class: 'tp-side' }, el('i', { class: 'tp-add' }), el('i', { class: 'tp-nav on' }), el('i', { class: 'tp-nav' }), el('i', { class: 'tp-nav' })),
      el('div', { class: 'tp-card' }, el('i', { class: 'tp-line' }), el('i', { class: 'tp-bar' }, el('b')), el('i', { class: 'tp-line short' }), el('i', { class: 'tp-bar' }, el('b', { class: 'p' })))
    );
  }

  /** Made by … with links to the developer's Telegram and Instagram. */
  function creator() {
    const svg = (markup) => {
      const t = document.createElement('template');
      t.innerHTML = markup.trim();
      return t.content.firstChild;
    };
    const link = (id, title, icon) => {
      const b = el('button', { class: `social ${id}`, title, onclick: () => api.invoke('shell:openSocial', id) });
      b.append(svg(icon));
      return b;
    };
    const telegram =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="#229ED9"/><path fill="#fff" d="M5.4 11.8l11.6-4.5c.54-.2 1 .13.83.95l-1.98 9.3c-.14.66-.54.82-1.1.51l-3-2.22-1.45 1.4c-.16.16-.3.3-.6.3l.21-3.06 5.56-5.02c.24-.21-.05-.33-.38-.12l-6.87 4.33-2.96-.92c-.64-.2-.66-.64.14-.95z"/></svg>';
    const instagram =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><defs><radialGradient id="igGrad" cx="0.3" cy="1.07" r="1.2"><stop offset="0" stop-color="#FFD776"/><stop offset="0.25" stop-color="#F3A554"/><stop offset="0.5" stop-color="#E1306C"/><stop offset="0.8" stop-color="#C13584"/><stop offset="1" stop-color="#833AB4"/></radialGradient></defs><rect width="24" height="24" rx="7" fill="url(#igGrad)"/><rect x="5.5" y="5.5" width="13" height="13" rx="4" fill="none" stroke="#fff" stroke-width="1.7"/><circle cx="12" cy="12" r="3.1" fill="none" stroke="#fff" stroke-width="1.7"/><circle cx="16.1" cy="7.9" r="1" fill="#fff"/></svg>';
    return el(
      'div',
      { class: 'set-row creator' },
      el('div', { class: 'set-text' }, el('div', { class: 'set-hint', text: 'Made by' }), el('div', { class: 'set-label', text: 'Mojtaba Navade' })),
      el('div', { class: 'socials' }, link('telegram', t('Telegram · t.me/mojtabatn'), telegram), link('instagram', t('Instagram · instagram.com/mojtabanavade'), instagram))
    );
  }

  /** "Check now" plus the result of the last check. */
  function updateRow() {
    const hint = el('div', { class: 'set-hint', text: 'Not checked yet.' });
    const btn = el('button', { class: 'btn btn-outline text-only', style: 'height:30px;padding:0 12px;font-size:13px', text: 'Check now' });
    const show = (st) => {
      if (!st) return;
      const when = st.checkedAt ? new Date(st.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      const text = {
        idle: t('Not checked yet.'),
        checking: t('Checking…'),
        none: when ? t('You have the latest version (checked at {time}).', { time: when }) : t('You have the latest version.'),
        available: t('Version {v} is available. Use the red button in the sidebar.', { v: DM.v(st.version) }),
        downloading: t('Downloading version {v}…', { v: DM.v(st.version) }),
        ready: t('Version {v} is ready. Click “Restart to Update” in the sidebar.', { v: DM.v(st.version) }),
        error: t('Couldn’t check for updates: {e}.', { e: st.error || t('unknown error') }),
      }[st.status];
      hint.textContent = text || '';
      btn.disabled = st.status === 'checking' || st.status === 'downloading';
    };
    btn.addEventListener('click', async () => show(await api.invoke('update:check')));
    window.addEventListener('vdm-update', (e) => show(e.detail));
    api.invoke('update:state').then(show);
    return el('div', { class: 'set-row' }, el('div', { class: 'set-text' }, el('div', { class: 'set-label', text: 'Updates' }), hint), btn);
  }

  function themePicker() {
    const cards = THEMES.map(([id, name]) => {
      const card = el('button', { class: 'theme-card', title: t('{name} theme', { name: t(name) }), onclick: () => save({ theme: id }) }, miniPreview(id), el('span', { text: name }));
      card.dataset.v = id;
      return card;
    });
    bind.push({ apply: (x) => cards.forEach((c) => c.classList.toggle('on', c.dataset.v === x.theme)) });
    return el('div', { class: 'theme-grid' }, ...cards);
  }

  function folderField() {
    const path = el('div', { class: 'path' });
    const f = el('div', { class: 'folder-field', title: 'Choose folder' }, icon('folder'), path, el('div', { class: 'browse', text: 'Browse...' }));
    f.addEventListener('click', async () => {
      const dir = await api.invoke('dialog:pickFolder', s.downloadDir);
      if (dir) save({ downloadDir: dir });
    });
    bind.push({ apply: (x) => ((path.textContent = x.downloadDir), (f.title = x.downloadDir)) });
    return f;
  }

  /** Proxy: none / the system's / manual (HTTP or SOCKS5, optional login) with a Test button. */
  function proxyRows() {
    const px = () => (s && s.proxy) || {};
    const patch = (p) => save({ proxy: p });
    const input = (attrs, key, parse = (v) => v) => {
      const i = el('input', { class: 'field', spellcheck: 'false', autocomplete: 'off', 'data-ltr': '', ...attrs });
      i.addEventListener('change', () => patch({ [key]: parse(i.value) }));
      return i;
    };
    const host = input({ type: 'text', placeholder: '127.0.0.1', style: 'flex:1;min-width:0' }, 'host');
    const port = input({ type: 'number', placeholder: '1080', min: '1', max: '65535', style: 'width:84px' }, 'port', (v) => Number(v) || 0);
    const user = input({ type: 'text', placeholder: t('Username'), style: 'flex:1;min-width:0' }, 'username');
    const pass = input({ type: 'password', placeholder: t('Password'), style: 'flex:1;min-width:0' }, 'password');
    const mode = select(
      [
        ['none', 'No proxy'],
        ['system', 'Use the system proxy'],
        ['manual', 'Manual'],
      ],
      (x) => x.proxy.mode,
      (v) => patch({ mode: v })
    );
    const type = select(
      [
        ['http', 'HTTP / HTTPS'],
        ['socks5', 'SOCKS5'],
      ],
      (x) => x.proxy.type,
      (v) => patch({ type: v }),
      'small'
    );
    type.style.width = '140px';
    const result = el('div', { class: 'set-hint proxy-result' });
    const test = el('button', { class: 'btn btn-outline blue text-only', style: 'height:30px;padding:0 14px;font-size:13px', text: 'Test connection' });
    test.addEventListener('click', async () => {
      test.disabled = true;
      result.className = 'set-hint proxy-result';
      result.textContent = t('Testing…');
      const r = await api.invoke('proxy:test', { mode: px().mode, type: px().type, host: host.value, port: Number(port.value) || 0, username: user.value, password: pass.value });
      test.disabled = false;
      result.className = `set-hint proxy-result ${r.ok ? 'ok' : 'bad'}`;
      result.textContent = r.ok ? t('Working · {ms} ms', { ms: DM.n(r.ms) }) : r.error || t('Could not connect through this proxy.');
    });
    const manual = el(
      'div',
      { class: 'proxy-manual' },
      el('div', { class: 'proxy-line' }, el('span', { class: 'proxy-lbl', text: 'Type' }), type),
      el('div', { class: 'proxy-line' }, el('span', { class: 'proxy-lbl', text: 'Server' }), host, port),
      el('div', { class: 'proxy-line' }, el('span', { class: 'proxy-lbl', text: 'Login' }), user, pass),
      el('div', { class: 'set-hint', style: 'margin:2px 0 0', text: 'Leave the login empty if the proxy doesn’t need one. The password is stored encrypted.' })
    );
    const testRow = el('div', { class: 'proxy-line proxy-test' }, test, result);
    bind.push({
      apply: (x) => {
        const p = x.proxy;
        if (document.activeElement !== host) host.value = p.host || '';
        if (document.activeElement !== port) port.value = p.port ? String(p.port) : '';
        if (document.activeElement !== user) user.value = p.username || '';
        if (document.activeElement !== pass) {
          pass.value = '';
          pass.placeholder = p.hasPassword ? '••••••••' : t('Password');
        }
        manual.hidden = p.mode !== 'manual';
        testRow.hidden = p.mode === 'none';
      },
    });
    return [row('Proxy', 'Used for downloads, video downloads and update checks. A running download uses it the next time it connects.', mode), manual, testRow];
  }

  /** yt-dlp + ffmpeg status with an Install / Update button. */
  function videoTools() {
    const line = el('div', { class: 'set-hint', style: 'font-size:12px' });
    const bar = el('div', { class: 'bar', style: 'height:4px;border-radius:2px;margin-top:8px;width:220px', hidden: true }, el('div', { class: 'fill', style: 'background:var(--blue)' }));
    const btn = el('button', { class: 'btn btn-outline blue text-only', style: 'height:32px;font-size:13px;padding:4px 14px' });
    let ready = false;
    const refresh = async () => {
      const st = await api.invoke('media:status');
      ready = st.ready;
      line.textContent = st.ready
        ? t('Installed · yt-dlp {v} · ffmpeg', { v: st.ytdlp.version || '' })
        : t('Not installed yet · one-time download of about {n} MB (yt-dlp + ffmpeg)', { n: DM.n(st.downloadSize) });
      btn.textContent = t(st.ready ? 'Update' : 'Install');
      btn.disabled = st.installing;
    };
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = t(ready ? 'Updating…' : 'Installing…');
      bar.hidden = ready;
      const off = api.on('media:install-progress', (p) => {
        if (p.total > 0) bar.firstChild.style.width = `${((p.received / p.total) * 100).toFixed(1)}%`;
      });
      const r = await api.invoke(ready ? 'media:update' : 'media:install');
      off();
      bar.hidden = true;
      await refresh();
      if (r && r.error) DM.toast(r.error, 4000);
      else DM.toast(t(ready ? 'Video support is up to date' : 'Video support installed'));
    });
    refresh();
    return el('div', { class: 'set-row' }, el('div', { class: 'set-text' }, el('div', { class: 'set-label', text: 'Video support (yt-dlp + ffmpeg)' }), line, bar), btn);
  }

  function mount(container, settings, info) {
    root = container;
    s = settings;
    const speedLabel = (kb) => (kb === 0 ? t('Unlimited') : DM.digits(kb >= 1024 ? `${kb / 1024} ${t('MB')}/${t('s')}` : `${kb} ${t('KB')}/${t('s')}`));
    const KB = [0, 128, 256, 512, 1024, 2048, 5120, 10240].map((k) => [k, speedLabel(k)]);
    root.append(
      group('Theme', 'theme', themePicker()),
      group(
        'General',
        'general',
        row('Keep running in the tray', 'Closing the window keeps downloads going.', toggle((x) => x.closeToTray, (v) => save({ closeToTray: v }))),
        row(/Macintosh/.test(navigator.userAgent) ? 'Open at login' : 'Launch at Windows startup', /Macintosh/.test(navigator.userAgent) ? 'Starts in the menu bar.' : 'Starts minimized to the tray.', toggle((x) => x.launchAtStartup, (v) => save({ launchAtStartup: v }))),
        row('Notifications', 'Show a notification when a download finishes or fails.', toggle((x) => x.notifications, (v) => save({ notifications: v })))
      ),
      group(
        'Downloads',
        'downloads',
        el('div', { class: 'set-row' }, el('div', { class: 'set-label', text: 'Save to', style: 'width:64px' }), folderField()),
        row('Sort into category folders', 'Video, Music, Compressed, Documents, Programs, General', toggle((x) => x.categorize, (v) => save({ categorize: v }))),
        row(
          'Connections per download',
          'More connections = faster on most servers (IDM uses 8).',
          select([1, 2, 4, 6, 8, 12, 16, 24, 32].map((n) => [n, DM.n(n)]), (x) => x.connections, (v) => save({ connections: Number(v) }), 'small')
        ),
        row('Speed limit', 'Applies to all downloads together.', select(KB, (x) => (KB.some(([k]) => k === x.speedLimit) ? x.speedLimit : 0), (v) => save({ speedLimit: Number(v) }))),
        row('Show progress window', 'Open a small window for each download (like IDM).', toggle((x) => x.showProgressWindow, (v) => save({ showProgressWindow: v }))),
        row('Show “download complete” window', null, toggle((x) => x.showCompleteWindow, (v) => save({ showCompleteWindow: v }))),
        row('Watch clipboard for links', 'Copying a file link opens the Add Link window.', toggle((x) => x.clipboardWatch, (v) => save({ clipboardWatch: v }))),
        row('Prevent sleep while downloading', null, toggle((x) => x.preventSleep, (v) => save({ preventSleep: v })))
      ),
      group('Proxy', 'proxy', ...proxyRows()),
      group(
        'Video downloads',
        'video',
        el('div', { class: 'set-hint', style: 'margin:-2px 0 6px;font-size:12px', text: 'Download videos from YouTube, X, Instagram and 1000+ sites — paste the page link in “Add Link” or use the “Download video” button in the browser. DRM-protected services (Netflix, Spotify…) aren’t supported.' }),
        videoTools(),
        row(
          'Default quality',
          'Pre-selected in the video window; you can always pick another.',
          select([['best', 'Best available'], ['2160', '4K (2160p)'], ['1080', '1080p'], ['720', '720p'], ['480', '480p'], ['360', '360p'], ['audio', 'Audio only (MP3)']], (x) => x.videoQuality || 'best', (v) => save({ videoQuality: v }))
        ),
        row('“Download video” button on web pages', 'Shown by the browser extension when you hover a video.', toggle((x) => x.videoButton !== false, (v) => save({ videoButton: v })))
      ),
      group(
        'Browser integration',
        'browser',
        row('Catch downloads from the browser', 'Chrome / Edge / Brave downloads are sent to VDM.', toggle((x) => x.browserIntegration, (v) => save({ browserIntegration: v }))),
        el(
          'ol',
          { class: 'steps' },
          el('li', {}, DM.rich('Open {a} or {b}', { a: el('code', { text: 'edge://extensions' }), b: el('code', { text: 'chrome://extensions' }) })),
          el('li', { text: 'Turn on “Developer mode”, click “Load unpacked”' }),
          el('li', { text: 'Select the extension folder below' })
        ),
        el('button', { class: 'btn btn-outline blue text-only', text: 'Open extension folder', style: 'height:32px;font-size:13px;margin:4px 0 10px', onclick: () => api.invoke('extension:openFolder') })
      ),
      group(
        'About',
        'about',
        el(
          'div',
          { class: 'about', style: 'padding:4px 0 8px' },
          el('img', { src: 'assets/icons/logo.svg', alt: '' }),
          el('div', {}, el('div', { class: 'set-label', text: `${t('VN Download Manager')} ${DM.v(String(info.version).replace(/\.0$/, ''))}` }), el('div', { class: 'set-hint', text: 'VDM · minimal, multi-connection download manager.' }))
        ),
        creator(),
        el(
          'div',
          { class: 'set-row' },
          el('div', { class: 'set-text' }, el('div', { class: 'set-label', text: 'What’s new' }), el('div', { class: 'set-hint', text: 'See what changed in this version.' })),
          el('button', { class: 'btn btn-outline text-only', style: 'height:30px;padding:0 12px;font-size:13px', text: 'Show', onclick: () => api.invoke('whatsnew:open') })
        ),
        row('Check for updates automatically', 'VDM looks for new versions on GitHub and shows a button when one is ready.', toggle((x) => x.autoUpdate !== false, (v) => save({ autoUpdate: v }))),
        updateRow()
      )
    );
    update(settings);
  }

  function update(settings) {
    s = settings;
    for (const b of bind) b.apply(settings);
  }

  function focus(section) {
    const g = root && root.querySelector(`#set-${section}`);
    if (g) g.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return { mount, update, focus };
})();
