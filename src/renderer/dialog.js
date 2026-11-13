'use strict';
/* Add Link → Download File Info / Download Video / several links (batch), plus "Refresh link" mode. */
(function () {
  const { t, params, fmtBytes, catIcon, splitUrls, MEDIA_EXT } = DM;
  const $ = (id) => document.getElementById(id);
  const mode = params.get('mode') || 'add';

  const ctx = {
    url: '',
    referrer: '',
    cookies: '',
    userAgent: '',
    batch: [],
    info: null, // probe result
    ext: '',
    dir: '',
    dirTouched: false,
    nameTouched: false,
    source: params.get('source') || 'manual',
  };

  const setTitle = (text) => {
    text = t(text);
    $('title').textContent = text;
    document.title = text;
  };
  const close = () => api.invoke('window:close');

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });

  // ------------------------------------------------------------ step 1
  const addr = $('address');
  const status = $('addStatus');
  const okBtn = $('addOk');

  function setStatus(text, kind = '') {
    status.className = `status at ${kind}`;
    status.replaceChildren();
    if (kind === 'busy') status.append(DM.el('span', { class: 'spinner dark' }));
    if (text) status.append(DM.el('span', { text: t(text) }));
  }

  addr.addEventListener('paste', (e) => {
    if (mode === 'refresh') return;
    const urls = splitUrls(e.clipboardData.getData('text'));
    if (urls.length > 1) {
      e.preventDefault();
      showBatch(urls);
    }
  });
  addr.addEventListener('input', () => {
    if (status.classList.contains('error')) setStatus('');
  });
  $('addCancel').addEventListener('click', close);

  $('paneAdd').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (okBtn.disabled) return;
    if (mode === 'refresh') return submitRefresh();
    // "file.part[01-12].rar" -> 12 links
    const expanded = expandPatterns(addr.value.trim());
    if (expanded.length > 1) return showBatch(expanded);
    const url = normalizeUrl(addr.value);
    if (!url) return setStatus(t('Please enter a valid http(s) link'), 'error'), addr.focus();
    ctx.url = url;
    // YouTube, X, Instagram… go straight to the video dialog
    if (await api.invoke('media:isVideoPage', url)) return showMedia({ url });
    busy(true);
    setStatus(t('Connecting…'), 'busy');
    const info = await api.invoke('downloads:probe', { url, referrer: ctx.referrer, cookies: ctx.cookies, userAgent: ctx.userAgent });
    busy(false);
    if (info.error) return setStatus(info.error, 'error');
    // A web page instead of a file: maybe there's a video on it
    if (info.isWebPage) return showMedia({ url, fallbackInfo: { ...info, probed: true } });
    showInfo({ ...info, probed: true });
  });

  function busy(on) {
    okBtn.disabled = on;
    addr.disabled = on;
  }

  function normalizeUrl(v) {
    v = String(v || '').trim();
    if (!v) return '';
    if (!/^[a-z]+:\/\//i.test(v) && /^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(v)) v = 'https://' + v;
    try {
      const u = new URL(v);
      return /^https?:$/.test(u.protocol) ? u.toString() : '';
    } catch {
      return '';
    }
  }

  // ------------------------------------------------------------ refresh mode
  async function submitRefresh() {
    const url = normalizeUrl(addr.value);
    if (!url) return setStatus(t('Please enter a valid http(s) link'), 'error');
    busy(true);
    setStatus(t('Checking new link…'), 'busy');
    const [info, detail] = await Promise.all([api.invoke('downloads:probe', { url }), api.invoke('downloads:detail', params.get('id'))]);
    busy(false);
    if (info.error) return setStatus(info.error, 'error');
    if (detail && detail.size > 0 && info.size > 0 && info.size !== detail.size) {
      return setStatus(t('Different file size ({a} vs {b}) — not the same file', { a: fmtBytes(info.size), b: fmtBytes(detail.size) }), 'error');
    }
    await api.invoke('downloads:action', { id: params.get('id'), action: 'refreshUrl', value: url });
    close();
  }

  // ------------------------------------------------------------ step 2
  const nameInput = $('infoName');

  function splitName(filename) {
    const m = /^(.*?)(\.[a-z0-9]{1,12})$/i.exec(filename || '');
    return m && m[1] ? { base: m[1], ext: m[2] } : { base: filename || 'download', ext: '' };
  }

  async function showInfo(info, { pending = false } = {}) {
    ctx.info = info;
    const { base, ext } = splitName(info.filename);
    ctx.ext = ext;
    if (!ctx.nameTouched) nameInput.value = base;
    nameInput.title = info.filename;
    $('infoCat').src = catIcon(info.category, 'max');
    $('infoSize').textContent = pending ? '…' : info.size > 0 ? fmtBytes(info.size) : t('Unknown');
    if (!ctx.dirTouched && info.dir) ctx.dir = info.dir;
    $('infoDir').textContent = ctx.dir;
    $('infoFolder').title = ctx.dir;
    $('infoWatch').hidden = !(MEDIA_EXT.test(info.filename) || /^(video|audio)\//.test(info.contentType || ''));
    const warn = $('infoWarn');
    warn.hidden = !(info.isWebPage || info.warning);
    warn.textContent = info.warning || (info.isWebPage ? t('This link points to a web page, not a file.') : '');
    if ($('paneInfo').hidden) {
      showPane('paneInfo', 265, 'Download File Info'); // 233 content + 32 title bar
      setTimeout(() => $('infoDownload').focus(), 50);
    }
    updateAvailable();
  }

  async function updateAvailable() {
    const free = await api.invoke('disk:free', ctx.dir);
    const el = $('infoAvail');
    el.textContent = free >= 0 ? fmtBytes(free) : '—';
    el.classList.toggle('low', free >= 0 && ctx.info && ctx.info.size > free);
  }

  nameInput.addEventListener('input', () => (ctx.nameTouched = true));
  $('infoFolder').addEventListener('click', async () => {
    const dir = await api.invoke('dialog:pickFolder', ctx.dir);
    if (!dir) return;
    ctx.dir = dir;
    ctx.dirTouched = true;
    $('infoDir').textContent = dir;
    $('infoFolder').title = dir;
    updateAvailable();
  });

  function finalName() {
    let n = nameInput.value.trim() || splitName(ctx.info.filename).base;
    if (ctx.ext && !n.toLowerCase().endsWith(ctx.ext.toLowerCase())) n += ctx.ext;
    return n;
  }

  async function add(modeName, queueId) {
    const info = ctx.info;
    await api.invoke('downloads:add', {
      url: ctx.url,
      filename: finalName(),
      filenameLocked: !!info.probed || ctx.nameTouched,
      dir: ctx.dir,
      size: info.size,
      resumable: info.resumable,
      referrer: ctx.referrer,
      cookies: ctx.cookies,
      userAgent: ctx.userAgent,
      mode: modeName,
      queueId,
      source: ctx.source,
    });
    close();
  }

  $('paneInfo').addEventListener('submit', (e) => {
    e.preventDefault();
    add('now');
  });
  // "Download Later": with more than one queue, a small menu asks which one
  const pickQueue = () => api.invoke('queue:pick');
  $('infoLater').addEventListener('click', async () => {
    const q = await pickQueue();
    if (q) add('queue', q);
  });
  $('infoWatch').addEventListener('click', async () => {
    await api.invoke('player:open', { url: ctx.url, title: finalName(), referrer: ctx.referrer, cookies: ctx.cookies });
  });

  // ------------------------------------------------------------ panes
  const PANES = ['paneAdd', 'paneInfo', 'paneMedia', 'paneBatch'];
  function showPane(id, height, title) {
    for (const p of PANES) $(p).hidden = p !== id;
    setTitle(title);
    api.invoke('window:resize', height);
  }

  const joinPath = (dir, name) => (dir ? dir.replace(/[\\/]+$/, '') + (dir.includes('\\') ? '\\' : '/') + name : name);
  async function defaultDirs() {
    const s = await api.invoke('settings:get');
    return {
      video: s.categorize ? joinPath(s.downloadDir, 'Video') : s.downloadDir, // folder names stay English on disk
      audio: s.categorize ? joinPath(s.downloadDir, 'Music') : s.downloadDir,
      quality: String(s.videoQuality || 'best'),
    };
  }

  // ------------------------------------------------------------ video (yt-dlp)
  const media = { url: '', candidates: [], pageTitle: '', fallbackInfo: null, fileUrl: '', info: null, option: null, dirs: null, dir: '', dirTouched: false };

  function mediaState(which) {
    for (const id of ['mediaLoading', 'mediaInstall', 'mediaError', 'mediaReady']) $(id).hidden = id !== which;
  }

  async function showMedia({ url, candidates = [], title = '', fallbackInfo = null, fileUrl = '' }) {
    Object.assign(media, { url, candidates, pageTitle: title, fallbackInfo, fileUrl });
    media.dirs = await defaultDirs();
    showPane('paneMedia', 440, 'Download Video');
    probeMedia();
  }

  async function probeMedia() {
    mediaState('mediaLoading');
    $('mediaLoadingText').textContent = t('Looking for the video…');
    try {
      $('mediaLoadingSub').textContent = new URL(media.url).hostname.replace(/^www\./, '');
    } catch {
      $('mediaLoadingSub').textContent = '';
    }
    const r = await api.invoke('media:probe', { url: media.url, candidates: media.candidates, referrer: ctx.referrer, cookies: ctx.cookies, userAgent: ctx.userAgent });
    if (r.needsTools) {
      $('mediaInstallSub').textContent = t('Downloading videos from YouTube, X and 1000+ sites needs two free helpers (yt-dlp and ffmpeg). It’s a one-time download of about {n} MB.', { n: DM.n(r.status.downloadSize || 53) });
      return mediaState('mediaInstall');
    }
    if (r.error) {
      $('mediaErrorText').textContent = r.error;
      $('mediaAsFile').hidden = !(media.fallbackInfo || media.fileUrl);
      return mediaState('mediaError');
    }
    renderMedia(r);
  }

  const fmtDur = (s) => {
    s = Math.round(s || 0);
    if (!s) return '';
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return DM.n(h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`);
  };

  function renderMedia(r) {
    media.info = r;
    // For raw streams (no site extractor) the page title is the better name.
    const generic = /\./.test(r.site);
    $('mediaTitle').value = (generic && media.pageTitle) || r.title;
    $('mediaMeta').textContent = [r.site, fmtDur(r.duration)].filter(Boolean).join(' · ');
    const thumb = $('mediaThumb');
    const img = $('mediaThumbImg');
    thumb.classList.add('empty');
    img.hidden = true;
    if (r.thumbnail) {
      // keep the logo placeholder until (unless) the thumbnail actually loads
      img.onload = () => {
        img.hidden = false;
        thumb.classList.remove('empty');
      };
      img.onerror = () => (img.hidden = true);
      img.src = r.thumbnail;
    }
    const pref = media.dirs.quality;
    const opts = r.options;
    let pick = opts[0];
    if (pref === 'audio') pick = opts.find((o) => o.audioOnly) || pick;
    else if (/^\d+$/.test(pref)) pick = opts.find((o) => !o.audioOnly && o.height && o.height <= Number(pref)) || pick;
    const list = $('qualityList');
    list.replaceChildren(
      ...opts.map((o) => {
        const row = DM.el(
          'div',
          { class: 'q-row', role: 'radio', tabindex: '0' },
          DM.el('span', { class: 'q-dot' }),
          DM.el('span', { class: 'q-label', text: o.label }),
          DM.el('span', { class: 'q-detail', text: o.detail }),
          DM.el('span', { class: 'q-size', text: o.size > 0 ? `~${fmtBytes(o.size)}` : '' })
        );
        row.addEventListener('click', () => selectOption(o, row));
        row.addEventListener('dblclick', () => addMedia('now'));
        o.row = row;
        return row;
      })
    );
    selectOption(pick, pick.row);
    mediaState('mediaReady');
    setTimeout(() => $('mediaDownload').focus(), 50);
  }

  function selectOption(o, row) {
    media.option = o;
    for (const r of $('qualityList').children) r.classList.toggle('on', r === row);
    if (!media.dirTouched) media.dir = o.audioOnly ? media.dirs.audio : media.dirs.video;
    $('mediaDir').textContent = media.dir;
    $('mediaFolder').title = media.dir;
  }

  async function addMedia(modeName, queueId) {
    const o = media.option;
    if (!o) return;
    const source = media.info.source;
    await api.invoke('downloads:add', {
      type: 'media',
      url: source,
      title: $('mediaTitle').value.trim() || media.info.title,
      format: o.format,
      audioOnly: o.audioOnly,
      ext: o.ext,
      quality: o.label,
      size: o.size,
      dir: media.dir,
      referrer: ctx.referrer || (source !== media.url ? media.url : ''),
      cookies: ctx.cookies,
      userAgent: ctx.userAgent,
      mode: modeName,
      queueId,
      source: ctx.source,
    });
    close();
  }

  $('paneMedia').addEventListener('submit', (e) => {
    e.preventDefault();
    addMedia('now');
  });
  $('mediaLater').addEventListener('click', async () => {
    const q = await pickQueue();
    if (q) addMedia('queue', q);
  });
  $('mediaErrorClose').addEventListener('click', close);
  $('mediaFolder').addEventListener('click', async () => {
    const dir = await api.invoke('dialog:pickFolder', media.dir);
    if (!dir) return;
    media.dir = dir;
    media.dirTouched = true;
    $('mediaDir').textContent = dir;
  });
  $('mediaAsFile').addEventListener('click', async () => {
    if (media.fallbackInfo) return showInfo(media.fallbackInfo);
    ctx.url = media.fileUrl;
    const info = await api.invoke('downloads:probe', { url: ctx.url, referrer: ctx.referrer, cookies: ctx.cookies, userAgent: ctx.userAgent });
    if (info.error) {
      $('mediaErrorText').textContent = info.error;
      return;
    }
    showInfo({ ...info, probed: true });
  });
  $('mediaInstallBtn').addEventListener('click', async () => {
    const btn = $('mediaInstallBtn');
    btn.disabled = true;
    btn.textContent = t('Installing…');
    $('mediaInstallProgress').hidden = false;
    const off = api.on('media:install-progress', (p) => {
      const pct = p.total > 0 ? (p.received / p.total) * 100 : 0;
      $('mediaInstallFill').style.width = `${pct.toFixed(1)}%`;
      $('mediaInstallText').textContent = p.total > 0 ? `${fmtBytes(p.received)} / ${fmtBytes(p.total)}` : fmtBytes(p.received);
    });
    const r = await api.invoke('media:install');
    off();
    if (r && r.error) {
      btn.disabled = false;
      btn.textContent = t('Try again');
      $('mediaInstallText').textContent = r.error;
      return;
    }
    probeMedia();
  });

  // ------------------------------------------------------------ several links (batch)
  /** Expands "file.part[01-12].rar" / "img[a-f].jpg" into individual links (max 1000). */
  function expandPatterns(text) {
    const m = /\[(\d+)-(\d+)\]|\[([a-z])-([a-z])\]/i.exec(text);
    if (!m) return [text];
    const out = [];
    const put = (v) => out.push(text.slice(0, m.index) + v + text.slice(m.index + m[0].length));
    if (m[1] !== undefined) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      const width = m[1].length > 1 && m[1].startsWith('0') ? m[1].length : 0;
      for (let i = Math.min(a, b); i <= Math.max(a, b) && out.length < 1000; i++) put(width ? String(i).padStart(width, '0') : String(i));
    } else {
      const a = m[3].charCodeAt(0);
      const b = m[4].charCodeAt(0);
      for (let c = Math.min(a, b); c <= Math.max(a, b); c++) put(String.fromCharCode(c));
    }
    return out.flatMap(expandPatterns).slice(0, 1000);
  }

  const batch = { items: [] };
  function nameOf(url) {
    try {
      const u = new URL(url);
      return decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || u.hostname);
    } catch {
      return url;
    }
  }

  function showBatch(urls) {
    const list = [...new Set(urls.map((u) => normalizeUrl(u)).filter(Boolean))];
    batch.items = list.map((url) => ({ url, on: true }));
    const box = $('batchList');
    box.replaceChildren(
      ...batch.items.map((it) => {
        const cb = DM.el('input', { type: 'checkbox', checked: true });
        const name = nameOf(it.url);
        let host = '';
        try {
          host = new URL(it.url).hostname.replace(/^www\./, '');
        } catch {}
        const row = DM.el('label', { class: 'b-row', title: it.url }, cb, DM.el('img', { class: 'b-cat', src: catIcon(categoryFromName(name), 'min'), alt: '' }), DM.el('span', { class: 'b-name', text: name }), DM.el('span', { class: 'b-host', text: host }));
        cb.addEventListener('change', () => {
          it.on = cb.checked;
          row.classList.toggle('off', !cb.checked);
          updateBatch();
        });
        it.cb = cb;
        return row;
      })
    );
    $('batchAll').checked = true;
    updateBatch();
    showPane('paneBatch', 420, t('Add {n} Downloads', { n: DM.n(list.length) }));
    setTimeout(() => $('batchStart').focus(), 50);
  }

  function updateBatch() {
    const n = batch.items.filter((i) => i.on).length;
    $('batchCount').textContent = batch.items.length === 1 ? t('1 link') : t('{n} links', { n: DM.n(batch.items.length) });
    $('batchStatus').textContent = t('{n} of {total} selected', { n: DM.n(n), total: DM.n(batch.items.length) });
    $('batchAll').checked = n === batch.items.length;
    $('batchAll').indeterminate = n > 0 && n < batch.items.length;
    $('batchStart').disabled = $('batchQueue').disabled = n === 0;
  }

  $('batchAll').addEventListener('change', (e) => {
    for (const it of batch.items) {
      it.on = e.target.checked;
      it.cb.checked = it.on;
      it.cb.closest('.b-row').classList.toggle('off', !it.on);
    }
    updateBatch();
  });

  async function addBatch(start, queueId = 'main') {
    for (const it of batch.items) if (it.on) await api.invoke('downloads:add', { url: it.url, mode: 'queue', queueId, source: ctx.source });
    if (start) await api.invoke('queue:start', queueId);
    close();
  }
  $('paneBatch').addEventListener('submit', (e) => {
    e.preventDefault();
    addBatch(true);
  });
  $('batchQueue').addEventListener('click', async () => {
    const q = await pickQueue();
    if (q) addBatch(false, q);
  });
  $('batchCancel').addEventListener('click', close);

  // ------------------------------------------------------------ boot
  (async function boot() {
    if (mode === 'refresh') {
      setTitle('Refresh Download Link');
      const detail = await api.invoke('downloads:detail', params.get('id'));
      $('addrLabel').textContent = t('New address for “{name}”:', { name: detail ? detail.filename : t('download') });
      addr.value = '';
      addr.placeholder = t('Paste the new link (open the download page again and copy the link)');
      setTimeout(() => addr.focus(), 50);
      return;
    }
    if (mode === 'info') {
      // Opened by the browser extension: show what the browser told us
      // right away, then confirm the details with the server.
      const p = (await api.invoke('dialog:payload', params.get('token'))) || {};
      Object.assign(ctx, { url: p.url || '', referrer: p.referrer || '', cookies: p.cookies || '', userAgent: p.userAgent || '', source: 'browser' });
      const guess = p.filename || decodeURIComponent((ctx.url.split('?')[0].split('/').pop() || 'download'));
      const fake = { filename: guess, size: p.size || -1, resumable: false, category: categoryFromName(guess), dir: '' };
      ctx.dir = (await api.invoke('settings:get')).downloadDir;
      showInfo(fake, { pending: true });
      const info = await api.invoke('downloads:probe', { url: ctx.url, referrer: ctx.referrer, cookies: ctx.cookies, userAgent: ctx.userAgent });
      if (info.error) {
        showInfo({ ...fake, warning: t('Couldn’t check the file: {e}', { e: info.error }) });
        $('infoSize').textContent = fake.size > 0 ? fmtBytes(fake.size) : t('Unknown');
      } else {
        // Prefer the browser's file name (it already applied the site's rules).
        showInfo({ ...info, filename: p.filename || info.filename, probed: true, dir: info.dir });
      }
      return;
    }
    if (mode === 'media') {
      // "Download this video" from the browser extension
      const p = (await api.invoke('dialog:payload', params.get('token'))) || {};
      Object.assign(ctx, { referrer: p.referrer || p.pageUrl || '', cookies: p.cookies || '', userAgent: p.userAgent || '', source: 'browser' });
      const rank = { hls: 0, dash: 1, file: 2 };
      const streams = (p.streams || []).slice().sort((a, b) => (rank[a.kind] ?? 3) - (rank[b.kind] ?? 3) || (b.size || 0) - (a.size || 0)).map((x) => x.url);
      const sitePage = p.pageUrl && (await api.invoke('media:isVideoPage', p.pageUrl));
      const order = sitePage ? [p.pageUrl, ...streams, p.frameUrl] : [...streams, p.frameUrl, p.pageUrl];
      const list = [...new Set(order.filter(Boolean))];
      const file = (p.streams || []).find((x) => x.kind === 'file');
      return showMedia({ url: list[0], candidates: list.slice(1), title: p.title || '', fileUrl: file ? file.url : '' });
    }
    const pre = params.get('url') || '';
    const urls = splitUrls(pre);
    if (urls.length > 1) return showBatch(urls);
    addr.value = urls[0] || '';
    setTimeout(() => {
      addr.focus();
      addr.select();
    }, 50);
  })();

  function categoryFromName(n) {
    const ext = (/\.([a-z0-9]+)$/i.exec(n) || [])[1] || '';
    const map = {
      video: /^(mp4|mkv|avi|mov|wmv|flv|webm|m4v|mpg|mpeg|ts)$/i,
      audio: /^(mp3|m4a|aac|flac|wav|ogg|opus|wma)$/i,
      zip: /^(zip|rar|7z|tar|gz|bz2|xz|iso|img)$/i,
      text: /^(pdf|docx?|txt|xlsx?|pptx?|epub|srt|ass)$/i,
      exe: /^(exe|msi|apk|dmg)$/i,
    };
    for (const [k, re] of Object.entries(map)) if (re.test(ext)) return k;
    return 'other';
  }
})();
