'use strict';
/* Per-download window: progress, pause/resume, connection details. */
(function () {
  const { t, params, el, icon, fmtBytes, fmtSpeed, fmtEta, pct, catIcon } = DM;
  const $ = (id) => document.getElementById(id);
  const id = params.get('id');
  // window heights incl. the 32px title bar (Figma: 208 content)
  const COLLAPSED = 240;
  const EXPANDED = 452;

  let d = null;
  let detailsOpen = false;
  let detailTimer = null;

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') api.invoke('window:close');
  });

  // Connection / speed-limit selectors in the details panel
  for (const n of [1, 2, 4, 6, 8, 12, 16, 24, 32]) $('connSel').append(el('option', { value: String(n), text: DM.n(n) }));
  for (const [v, label] of [[0, t('Unlimited')], [128, `128 ${t('KB')}/${t('s')}`], [256, `256 ${t('KB')}/${t('s')}`], [512, `512 ${t('KB')}/${t('s')}`], [1024, `1 ${t('MB')}/${t('s')}`], [2048, `2 ${t('MB')}/${t('s')}`], [5120, `5 ${t('MB')}/${t('s')}`]]) {
    $('limitSel').append(el('option', { value: String(v), text: DM.digits(label) }));
  }
  $('connSel').addEventListener('change', (e) => api.invoke('downloads:action', { id, action: 'connections', value: Number(e.target.value) }));
  $('limitSel').addEventListener('change', (e) => api.invoke('downloads:action', { id, action: 'speedLimit', value: Number(e.target.value) }));

  $('toggle').addEventListener('click', () => api.invoke('downloads:action', { id, action: 'toggle' }));
  $('cancel').addEventListener('click', async () => {
    if (d && d.status === 'completed') return api.invoke('window:close');
    await api.invoke('downloads:action', { id, action: 'cancel' });
  });
  $('openFile').addEventListener('click', async () => {
    await api.invoke('downloads:action', { id, action: 'open' });
    api.invoke('window:close');
  });
  $('openFolder').addEventListener('click', () => api.invoke('downloads:action', { id, action: 'openFolder' }));
  $('detailsBtn').addEventListener('click', () => setDetails(!detailsOpen));

  function setDetails(open) {
    detailsOpen = open;
    $('details').hidden = !open;
    $('detailsBtn').classList.toggle('open', open);
    api.invoke('window:resize', open ? EXPANDED : COLLAPSED);
    clearInterval(detailTimer);
    if (open) {
      refreshDetail();
      detailTimer = setInterval(refreshDetail, 500);
    }
  }

  async function refreshDetail() {
    const det = await api.invoke('downloads:detail', id);
    if (!det) return;
    drawSegments(det);
    drawConnections(det);
    $('connSel').value = String(det.connections);
    $('limitSel').value = String(det.speedLimit || 0);
    $('resumeInfo').textContent = det.resumable ? t('Resume: Yes') : det.size > 0 ? t('Resume: No') : '';
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  /** IDM-style map: every segment's downloaded part in blue, connection heads marked. */
  function drawSegments(det) {
    const c = $('segmap');
    const g = c.getContext('2d');
    const W = c.width;
    const H = c.height;
    g.fillStyle = cssVar('--track');
    g.fillRect(0, 0, W, H);
    if (!(det.size > 0)) {
      $('segCount').textContent = '';
      return;
    }
    const x = (b) => (b / det.size) * W;
    const segs = det.status === 'completed' ? [{ start: 0, end: det.size - 1, pos: det.size }] : det.segments;
    g.fillStyle = det.status === 'completed' ? '#12be42' : '#1e83f1';
    for (const s of segs) {
      const done = Math.max(0, Math.min(s.pos, s.end + 1) - s.start);
      if (done > 0) g.fillRect(x(s.start), 0, Math.max(1, x(s.start + done) - x(s.start)), H);
    }
    // segment boundaries + active heads
    for (const s of segs) {
      g.fillStyle = cssVar('--surface');
      if (s.start > 0) g.fillRect(x(s.start) - 1, 0, 2, H);
      if (s.active && s.pos <= s.end) {
        g.fillStyle = '#9c50ff';
        g.fillRect(Math.min(W - 3, x(s.pos)), 0, 3, H);
      }
    }
    const active = segs.filter((s) => s.active).length;
    $('segCount').textContent = det.status === 'completed' ? '' : t('{a} active / {n} parts', { a: DM.n(active), n: DM.n(segs.length) });
  }

  function drawConnections(det) {
    const table = $('connTable');
    const rows = [el('div', { class: 'tr th' }, el('span', { text: 'N.' }), el('span', { text: 'Downloaded' }), el('span', { text: 'Info' }))];
    det.conns
      .sort((a, b) => a.start - b.start)
      .forEach((c, i) => rows.push(el('div', { class: 'tr' }, el('span', { text: DM.n(i) }), el('span', { text: fmtBytes(c.downloaded) }), el('span', { text: c.status }))));
    if (!det.conns.length) {
      const msg = t(det.status === 'completed' ? 'Download complete' : det.status === 'downloading' || det.status === 'connecting' ? 'Connecting…' : 'No active connections');
      rows.push(el('div', { class: 'none', text: msg }));
    }
    table.replaceChildren(...rows);
  }

  function render() {
    if (!d) return;
    const running = d.status === 'downloading' || d.status === 'connecting';
    const done = d.status === 'completed';
    const p = Math.floor(pct(d));
    document.body.classList.toggle('paused-state', !running && !done);

    $('cat').src = catIcon(d.category, 'max');
    $('name').textContent = d.filename;
    $('name').title = d.savePath;

    const pn = DM.n(p);
    const titleText = done ? t('Download complete') : running ? (d.size > 0 ? t('{p}% Downloading', { p: pn }) : t('Downloading')) : d.status === 'error' ? t('Download error') : d.status === 'queued' ? t('Queued') : d.status === 'canceled' ? t('Canceled') : t('{p}% Paused', { p: pn });
    $('title').textContent = titleText;
    document.title = `${d.size > 0 && !done ? pn + '% ' : ''}${d.filename}`;

    const bar = $('bar');
    bar.className = `at bar big-bar ${done ? 'completed' : running ? '' : d.status}${running && !(d.size > 0) ? ' indeterminate' : ''}`;
    $('fill').style.width = `${done ? 100 : pct(d)}%`;

    const speed = $('speed');
    speed.className = 'at dl-meta speed';
    if (d.status === 'downloading' && d.stage) speed.textContent = d.stage;
    else if (d.status === 'downloading') speed.textContent = fmtSpeed(d.speed);
    else if (d.status === 'connecting') speed.textContent = t('Connecting…');
    else if (d.status === 'error') {
      speed.textContent = d.error || t('Error');
      speed.classList.add('err');
      speed.title = d.error || '';
    } else if (done) {
      speed.textContent = t('Completed');
      speed.classList.add('ok');
    } else if (d.status === 'queued') speed.textContent = t('Waiting in queue');
    else if (d.status === 'canceled') speed.textContent = t('Canceled');
    else speed.textContent = '';

    const eta = $('eta');
    eta.hidden = d.status === 'error';
    if (done) eta.textContent = d.completedAt && d.startedAt && d.completedAt - d.startedAt >= 1000 ? t('in {time}', { time: fmtEta((d.completedAt - d.startedAt) / 1000) }) : '';
    else if (d.status === 'downloading') eta.textContent = fmtEta(d.eta);
    else eta.textContent = d.size > 0 ? `${pn}%` : '';

    const size = $('size');
    size.replaceChildren();
    if (d.size > 0 && !done) size.append(el('span', { class: running ? '' : 'strong', text: fmtBytes(d.downloaded) }), `/${fmtBytes(d.size)}`);
    else size.textContent = fmtBytes(done ? d.size : d.downloaded);

    // Buttons (video downloads have no connection map, so no Details)
    $('detailsBtn').hidden = d.type === 'media';
    $('toggle').hidden = done;
    $('openFile').hidden = !done;
    $('openFolder').hidden = !done;
    const toggle = $('toggle');
    toggle.replaceChildren();
    if (running) {
      toggle.className = 'btn btn-outline blue at';
      toggle.append(icon('btn-pause'), el('span', { text: t('Pause') }));
    } else {
      toggle.className = 'btn btn-outline green at';
      toggle.append(icon('btn-resume', 'only-light'), icon('btn-resume-dark', 'only-dark'), el('span', { text: t(d.status === 'error' ? 'Retry' : 'Resume') }));
    }
    // Cancel sits right after the first button, as in the design.
    requestAnimationFrame(() => {
      const first = done ? $('openFile') : toggle;
      const left = 24 + first.offsetWidth + 8;
      const put = (e, px) => (e.style.left = `${px}px`);
      if (done) {
        put($('openFolder'), left);
        put($('cancel'), left + $('openFolder').offsetWidth + 8);
      } else put($('cancel'), left);
    });
    $('cancel').querySelector('span').textContent = t(done ? 'Close' : d.status === 'canceled' ? 'Remove' : 'Cancel');
  }

  api.on('downloads:progress', (list) => {
    const x = list.find((i) => i.id === id);
    if (x) {
      d = x;
      render();
    }
  });
  api.on('downloads:changed', (x) => {
    if (x.id !== id) return;
    d = x;
    render();
    if (x.status === 'completed' && detailsOpen) refreshDetail();
  });
  api.on('downloads:removed', (rid) => rid === id && api.invoke('window:close'));

  (async () => {
    d = await api.invoke('downloads:detail', id);
    if (!d) return api.invoke('window:close');
    render();
  })();
})();
