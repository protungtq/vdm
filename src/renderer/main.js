'use strict';
const IS_MAC = document.documentElement.dataset.platform === 'mac';
/* Main window controller. */
(function () {
  const { t, el, icon, fmtBytes, fmtSpeed, fmtEta, fmtSizePair, pct, catIcon, toast, splitUrls } = DM;
  if (IS_MAC) {
    // macOS wording: ⌘ shortcuts, and there is no hibernate
    document.getElementById('addLink').title = t('Add a new download ({key})', { key: '⌘N' });
    document.getElementById('emptySub').textContent = t('Click “Add Link”, paste a link ({key}) or drop one here.', { key: '⌘V' });
    document.querySelector('option[value="hibernate"]')?.remove();
  }
  const $ = (id) => document.getElementById(id);

  const state = {
    items: new Map(), // id -> snapshot
    view: 'all',
    query: '',
    selected: null, // the item clicked last (keyboard and context menu act on it)
    sel: new Set(), // every selected item (Shift / Ctrl / ⌘ click, Select all)
    anchor: null, // start of a Shift+click range
    settings: null,
    queueRunning: false,
    queue: 'main', // queue shown in the Scheduled view
    queueStates: {}, // queue id -> running
    listView: 'cards', // 'cards' (large icons) | 'compact' (list with small icons)
  };
  const rows = new Map(); // id -> { row, divider, parts }

  // ------------------------------------------------------------ boot
  async function init() {
    const [info, settings, list, q, pending] = await Promise.all([
      api.invoke('app:info'),
      api.invoke('settings:get'),
      api.invoke('downloads:list'),
      api.invoke('queue:state'),
      api.invoke('power:state'),
    ]);
    $('version').textContent = t('Version {v}', { v: DM.v(String(info.version).replace(/\.0$/, '')) });
    DM.appInfo = info;
    state.settings = settings;
    state.listView = settings.listView || 'cards';
    state.queueRunning = q.running;
    state.queueStates = q.queues || {};
    for (const d of list) state.items.set(d.id, d);
    renderViewSwitch();
    renderAll();
    renderQueuePanel();
    if (pending) showPower(pending);
    SettingsView.mount($('view-settings'), settings, info);
  }

  api.on('downloads:added', (d) => {
    state.items.set(d.id, d);
    renderAll();
  });
  api.on('downloads:changed', (d) => {
    const prev = state.items.get(d.id);
    state.items.set(d.id, d);
    const reshuffle = !prev || prev.status !== d.status || prev.queued !== d.queued || prev.queueOrder !== d.queueOrder || prev.filename !== d.filename;
    if (reshuffle) renderAll();
    else updateRow(d);
  });
  api.on('downloads:removed', (id) => {
    state.items.delete(id);
    if (state.selected === id) state.selected = null;
    state.sel.delete(id);
    renderAll();
  });
  api.on('downloads:progress', (list) => {
    let speed = 0;
    for (const d of list) {
      state.items.set(d.id, d);
      updateRow(d);
      speed += d.speed;
    }
    setTotalSpeed(speed, list.length);
  });
  api.on('queue:state', (q) => {
    state.queueRunning = q.running;
    state.queueStates = q.queues || {};
    renderQueuePanel();
    updateActions();
  });
  api.on('settings:changed', (s) => {
    if (!(s.queues || []).some((q) => q.id === state.queue)) state.queue = 'main'; // that queue was deleted
    state.settings = s;
    if ((s.listView || 'cards') !== state.listView) {
      state.listView = s.listView || 'cards';
      renderViewSwitch();
      renderAll();
    }
    renderQueuePanel();
    SettingsView.update(s);
  });
  api.on('power:pending', showPower);
  api.on('ui:command', (c) => c === 'search' && focusSearch());

  let speedTimer;
  function setTotalSpeed(speed, n) {
    const box = $('totalSpeed');
    box.hidden = !n;
    box.textContent = `↓ ${fmtSpeed(speed).replace(`/${t('sec')}`, `/${t('s')}`).replace('/sec', '/s')}`;
    clearTimeout(speedTimer);
    speedTimer = setTimeout(() => (box.hidden = true), 1500);
  }

  // ------------------------------------------------------------ list rendering
  function visibleItems() {
    const q = state.query.toLowerCase();
    let arr = [...state.items.values()];
    if (state.view === 'completed') arr = arr.filter((d) => d.status === 'completed');
    if (state.view === 'scheduled') arr = arr.filter((d) => d.queued && d.status !== 'completed' && (d.queueId || 'main') === state.queue);
    if (q) arr = arr.filter((d) => d.filename.toLowerCase().includes(q) || d.url.toLowerCase().includes(q));
    if (state.view === 'scheduled') arr.sort((a, b) => a.queueOrder - b.queueOrder);
    else arr.sort((a, b) => b.createdAt - a.createdAt);
    return arr;
  }

  function renderAll() {
    const all = [...state.items.values()];
    const active = all.filter((d) => ['downloading', 'connecting'].includes(d.status)).length;
    $('badgeAll').textContent = active ? DM.n(active) : '';
    const waiting = all.filter((d) => d.queued && d.status !== 'completed').length;
    $('badgeQueue').textContent = waiting ? DM.n(waiting) : '';

    if (state.view === 'settings') return updateActions();
    const listEl = state.view === 'scheduled' ? $('qlist') : $('list');
    const items = visibleItems();
    listEl.classList.toggle('compact', state.listView === 'compact');
    if (state.selected && !items.some((d) => d.id === state.selected)) state.selected = null;
    // items that left this view (filter, search, finished) drop out of the selection
    const shown = new Set(items.map((d) => d.id));
    for (const sid of [...state.sel]) if (!shown.has(sid)) state.sel.delete(sid);
    // Re-use existing row elements so hover/selection survive updates.
    const frag = document.createDocumentFragment();
    const keep = new Set();
    items.forEach((d, i) => {
      let r = rows.get(d.id);
      if (!r || r.list !== listEl) {
        if (r) {
          r.row.remove();
          r.divider.remove();
        }
        r = buildRow(d);
        r.list = listEl;
        rows.set(d.id, r);
      }
      keep.add(d.id);
      fillRow(r, d);
      frag.append(r.row);
      if (i < items.length - 1) frag.append(r.divider);
      else r.divider.remove();
    });
    for (const [id, r] of rows) {
      if (!keep.has(id)) {
        r.row.remove();
        r.divider.remove();
        rows.delete(id);
      }
    }
    listEl.replaceChildren(frag);

    if (state.view === 'scheduled') {
      $('qempty').hidden = items.length > 0;
      updateQueueStatus();
    } else {
      const empty = $('empty');
      empty.hidden = items.length > 0;
      if (!items.length) {
        if (state.query) {
          $('emptyTitle').textContent = t('Nothing found');
          $('emptySub').textContent = t('No downloads match “{q}”.', { q: state.query });
        } else if (state.view === 'completed') {
          $('emptyTitle').textContent = t('No completed downloads');
          $('emptySub').textContent = t('Finished files will show up here.');
        } else {
          $('emptyTitle').textContent = t('No downloads yet');
          $('emptySub').textContent = t('Click “Add Link”, paste a link ({key}) or drop one here.', { key: IS_MAC ? '⌘V' : 'Ctrl+V' });
        }
      }
    }
    updateActions();
  }

  function buildRow(d) {
    const cat = el('img', { class: 'cat', alt: '' });
    const nameText = el('span');
    const name = el('div', { class: 'name' }, nameText);
    const toggleImg = el('img', { alt: '' });
    const toggle = el('button', { class: 'toggle', title: 'Pause' }, toggleImg);
    const x = el('button', { class: 'x', title: 'Cancel' }, icon('row-x'));
    const acts = el('div', { class: 'acts' }, toggle, x);
    const fill = el('div', { class: 'fill' });
    const bar = el('div', { class: 'bar' }, fill);
    const speed = el('span', { class: 'speed' });
    const eta = el('span', { class: 'eta' });
    const size = el('span', { class: 'size' });
    const meta = el('div', { class: 'meta' }, speed, eta, size);
    const doneMeta = el('div', { class: 'done-meta' });
    const cSize = el('div', { class: 'c-size' });
    const cStat = el('div', { class: 'c-stat' });
    const cTry = el('div', { class: 'c-try' });
    const row = el('div', { class: 'row', tabindex: '-1' }, cat, name, acts, bar, meta, doneMeta, cSize, cStat, cTry);
    const divider = el('div', { class: 'divider' });
    const id = d.id;
    toggle.addEventListener('click', (e) => {
      e.stopPropagation();
      api.invoke('downloads:action', { id, action: 'toggle' });
    });
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      api.invoke('downloads:action', { id, action: 'cancel' });
    });
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.shiftKey && state.anchor) selectRange(state.anchor, id);
      else if (e.ctrlKey || e.metaKey) toggleSelect(id);
      else select(id);
    });
    // keep Shift+click from also selecting the row's text
    row.addEventListener('mousedown', (e) => e.shiftKey && e.preventDefault());
    row.addEventListener('dblclick', () => api.invoke('downloads:action', { id, action: 'open' }));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!state.sel.has(id)) select(id);
      api.invoke('downloads:contextMenu', id);
    });
    return { row, divider, parts: { cat, nameText, name, toggle, toggleImg, x, bar, fill, speed, eta, size, doneMeta, cSize, cStat, cTry }, key: '' };
  }

  function fillRow(r, d) {
    const p = r.parts;
    const done = d.status === 'completed';
    const cls = `row ${done ? 'done' : d.status}${state.sel.has(d.id) ? ' selected' : ''}`;
    if (r.row.className !== cls) r.row.className = cls;
    const catSrc = catIcon(d.category, 'min');
    if (p.cat.getAttribute('src') !== catSrc) p.cat.src = catSrc;
    if (p.nameText.textContent !== d.filename) p.nameText.textContent = d.filename;
    p.name.title = d.filename;
    // compact-list cells
    p.cSize.textContent = d.size > 0 ? fmtBytes(d.size) : d.downloaded > 0 ? fmtBytes(d.downloaded) : '—';
    p.cTry.textContent = d.lastTryAt ? DM.dateTime(d.lastTryAt) : '—';
    p.cTry.title = d.lastTryAt ? `${t('Last try')}: ${DM.dateTime(d.lastTryAt, { second: '2-digit' })}` : '';
    p.cStat.textContent = compactStatus(d);
    p.cStat.className = `c-stat ${d.status}`;
    p.cStat.title = d.status === 'error' ? d.error || '' : '';
    if (done) {
      const when = d.lastTryAt || d.completedAt;
      p.doneMeta.textContent = `${fmtBytes(d.size)}${when ? ' · ' + DM.dateTime(when) : ''}`;
      return;
    }
    const running = d.status === 'downloading' || d.status === 'connecting';
    const toggleSrc = running ? 'assets/icons/row-pause.svg' : 'assets/icons/row-play.svg';
    if (p.toggleImg.getAttribute('src') !== toggleSrc) p.toggleImg.src = toggleSrc;
    p.toggle.title = t(running ? 'Pause' : d.status === 'error' ? 'Retry' : 'Resume');
    p.x.title = t(d.status === 'canceled' ? 'Remove from list' : 'Cancel');
    p.bar.className = `bar ${running ? '' : d.status}${running && !(d.size > 0) ? ' indeterminate' : ''}`;
    p.fill.style.width = `${pct(d)}%`;
    let left = '';
    let mid = '';
    if (d.status === 'downloading' && d.stage) {
      left = d.stage; // e.g. "Merging video and audio…"
      mid = '';
    } else if (d.status === 'downloading') {
      left = fmtSpeed(d.speed);
      mid = fmtEta(d.eta);
    } else if (d.status === 'connecting') left = t('Connecting…');
    else if (d.status === 'queued') {
      left = t('Queued');
      mid = d.size > 0 ? DM.n(`${Math.floor(pct(d))}%`) : '';
    } else if (d.status === 'paused') mid = d.size > 0 ? DM.n(`${Math.floor(pct(d))}%`) : t('Paused');
    else if (d.status === 'canceled') {
      left = t('Canceled');
      mid = d.size > 0 && d.downloaded > 0 ? DM.n(`${Math.floor(pct(d))}%`) : '';
    }
    else if (d.status === 'error') left = d.error || t('Error');
    p.speed.textContent = left;
    p.speed.title = d.status === 'error' ? left : '';
    p.eta.textContent = mid;
    p.size.textContent = fmtSizePair(d);
  }

  function compactStatus(d) {
    const p = d.size > 0 ? DM.n(`${Math.floor(pct(d))}%`) : '';
    switch (d.status) {
      case 'completed': return t('Completed');
      case 'downloading': return d.stage || [p, fmtSpeed(d.speed)].filter(Boolean).join(' · ');
      case 'connecting': return t('Connecting…');
      case 'paused': return [t('Paused'), p].filter(Boolean).join(' · ');
      case 'queued': return t('Queued');
      case 'canceled': return t('Canceled');
      case 'error': return t('Error');
      default: return '';
    }
  }

  function updateRow(d) {
    const r = rows.get(d.id);
    if (r) fillRow(r, d);
    if (state.sel.has(d.id)) updateActions();
  }

  function select(id) {
    state.sel = new Set(id ? [id] : []);
    state.selected = id;
    state.anchor = id;
    applySelection();
  }
  function toggleSelect(id) {
    if (state.sel.has(id)) state.sel.delete(id);
    else state.sel.add(id);
    state.selected = state.sel.has(id) ? id : [...state.sel].pop() || null;
    state.anchor = id;
    applySelection();
  }
  /** Shift+click: everything between the anchor and this row, in the order shown. */
  function selectRange(from, to) {
    const ids = visibleItems().map((d) => d.id);
    let a = ids.indexOf(from);
    const b = ids.indexOf(to);
    if (a < 0) a = b;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    state.sel = new Set(ids.slice(lo, hi + 1));
    state.selected = to;
    applySelection();
  }
  function selectAll(on = true) {
    const ids = visibleItems().map((d) => d.id);
    state.sel = new Set(on ? ids : []);
    state.selected = on ? ids[0] || null : null;
    state.anchor = state.selected;
    applySelection();
  }
  function applySelection() {
    for (const [rid, r] of rows) r.row.classList.toggle('selected', state.sel.has(rid));
    updateActions();
  }
  const selectedItems = () => [...state.sel].map((id) => state.items.get(id)).filter(Boolean);

  // ------------------------------------------------------------ actions toolbar
  const isRunning = (d) => d && (d.status === 'downloading' || d.status === 'connecting');
  const canResume = (d) => ['paused', 'error', 'canceled', 'queued'].includes(d.status);
  const canPause = (d) => isRunning(d) || d.status === 'queued';
  function updateActions() {
    const sel = state.view === 'settings' ? [] : selectedItems();
    const many = sel.length > 1;
    const resume = $('actResume');
    resume.disabled = !sel.some(canResume);
    resume.dataset.tip = !many && sel[0] && sel[0].status === 'error' ? t('Retry') : many ? t('Resume {n}', { n: DM.n(sel.filter(canResume).length) }) : t('Resume');
    $('actPause').disabled = !sel.some(canPause);
    $('actPause').dataset.tip = many ? t('Pause {n}', { n: DM.n(sel.filter(canPause).length) }) : t('Pause');
    $('actStop').disabled = ![...state.items.values()].some((x) => isRunning(x) || (x.status === 'queued' && state.queueRunning));
    $('actDelete').disabled = !sel.length;
    $('actDelete').dataset.tip = many ? t('Delete {n} downloads', { n: DM.n(sel.length) }) : t('Delete');
    const shown = state.view === 'settings' ? 0 : visibleItems().length;
    const all = shown > 0 && sel.length === shown;
    const sa = $('actSelectAll');
    sa.disabled = !shown;
    sa.classList.toggle('on', all);
    sa.dataset.tip = t(all ? 'Deselect all' : 'Select all');
  }
  $('actResume').addEventListener('click', () => {
    for (const d of selectedItems().filter(canResume)) api.invoke('downloads:action', { id: d.id, action: 'start' });
  });
  $('actPause').addEventListener('click', () => {
    for (const d of selectedItems().filter(canPause)) api.invoke('downloads:action', { id: d.id, action: 'pause' });
  });
  $('actStop').addEventListener('click', () => api.invoke('downloads:pauseAll'));
  $('actDelete').addEventListener('click', () => deleteSelected());
  $('actSelectAll').addEventListener('click', () => selectAll(!$('actSelectAll').classList.contains('on')));
  function deleteSelected() {
    const ids = [...state.sel];
    if (ids.length === 1) api.invoke('downloads:action', { id: ids[0], action: 'delete' });
    else if (ids.length > 1) api.invoke('downloads:deleteMany', ids);
  }
  // clicking empty space in a list clears the selection
  for (const id of ['list', 'qlist']) $(id).addEventListener('click', () => select(null));

  // ------------------------------------------------------------ view switch (large icons / compact list)
  function renderViewSwitch() {
    for (const b of document.querySelectorAll('[data-view-mode]')) b.classList.toggle('on', b.dataset.viewMode === state.listView);
  }
  for (const b of document.querySelectorAll('[data-view-mode]')) {
    b.addEventListener('click', () => {
      if (state.listView === b.dataset.viewMode) return;
      state.listView = b.dataset.viewMode;
      renderViewSwitch();
      renderAll();
      api.invoke('settings:set', { listView: state.listView });
    });
  }

  // ------------------------------------------------------------ footer
  $('github').addEventListener('click', async () => {
    const ok = await api.invoke('shell:openProject');
    if (!ok) toast(t('Project link will be added soon'));
  });

  // ------------------------------------------------------------ update button (GitHub Releases)
  function renderUpdate(st) {
    const btn = $('updateBtn');
    window.dispatchEvent(new CustomEvent('vdm-update', { detail: st }));
    const show = st && (['available', 'downloading', 'ready'].includes(st.status) || (st.status === 'error' && st.stage === 'download'));
    btn.hidden = !show;
    if (!show) return;
    btn.classList.toggle('busy', st.status === 'downloading');
    btn.classList.toggle('ready', st.status === 'ready');
    const v = DM.v(st.version);
    let label = t('Update Available!');
    let tip = t('VDM {v} is available. Click to download it.', { v });
    if (st.status === 'available' && (st.portable || !st.asset)) tip = t('VDM {v} is available. Click to open the download page.', { v });
    if (st.status === 'downloading') {
      const p = st.progress && st.progress.total ? Math.min(100, Math.floor((st.progress.received / st.progress.total) * 100)) : 0;
      label = t('Downloading… {p}%', { p: DM.n(p) });
      tip = t('Downloading VDM {v}', { v });
      $('updateFill').style.width = p + '%';
    }
    if (st.status === 'ready') {
      label = t('Restart to Update');
      tip = t('VDM {v} is ready. Click to install it and restart.', { v });
    }
    if (st.status === 'error') {
      label = t('Update failed · Retry');
      tip = st.error || t('The update could not be downloaded.');
    }
    $('updateLabel').textContent = label;
    btn.title = tip;
  }
  $('updateBtn').addEventListener('click', async () => {
    if ($('updateBtn').classList.contains('busy')) return;
    renderUpdate(await api.invoke('update:action'));
  });
  api.on('update:state', renderUpdate);
  api.invoke('update:state').then(renderUpdate);

  // ------------------------------------------------------------ navigation
  $('nav').addEventListener('click', (e) => {
    const b = e.target.closest('.nav-item');
    if (!b) return;
    setView(b.dataset.view);
  });

  function setView(v) {
    state.view = v;
    for (const b of document.querySelectorAll('.nav-item')) b.classList.toggle('active', b.dataset.view === v);
    $('view-list').hidden = !(v === 'all' || v === 'completed');
    $('view-scheduled').hidden = v !== 'scheduled';
    $('view-settings').hidden = v !== 'settings';
    // Settings has no use for search / actions / view switch: the card takes the full height.
    $('content').classList.toggle('settings-mode', v === 'settings');
    renderAll();
  }

  // ------------------------------------------------------------ add link / drop / paste
  const openAdd = (url = '') => api.invoke('dialog:open', { mode: 'add', url });
  $('addLink').addEventListener('click', () => openAdd());

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (++dragDepth === 1) $('dropHint').hidden = false;
  });
  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0;
      $('dropHint').hidden = true;
    }
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('dropHint').hidden = true;
    const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
    const urls = splitUrls(text);
    if (urls.length) openAdd(urls.join('\n'));
  });

  document.addEventListener('paste', (e) => {
    if (e.target.closest('input, textarea')) return;
    const urls = splitUrls(e.clipboardData.getData('text'));
    if (urls.length) openAdd(urls.join('\n'));
  });

  // ------------------------------------------------------------ search (always open)
  const search = $('search');
  const input = $('searchInput');
  function focusSearch() {
    input.focus();
    input.select();
  }
  function setQuery(v) {
    state.query = v.trim();
    search.classList.toggle('has-text', !!input.value);
    renderAll();
  }
  input.addEventListener('input', () => setQuery(input.value));
  $('searchClear').addEventListener('click', () => {
    input.value = '';
    setQuery('');
    input.focus();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = '';
      setQuery('');
      input.blur();
    }
  });

  // ------------------------------------------------------------ scheduled / queue panel
  const DAY = ['S', 'M', 'T', 'W', 'T', 'F', 'S']; // Sunday first
  const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const DAY_ORDER = [0, 1, 2, 3, 4, 5, 6];
  const dayLetter = (i) => DAY[i];
  const maxSel = $('schMax');
  for (let i = 1; i <= 10; i++) maxSel.append(el('option', { value: String(i), text: DM.n(i) }));

  const queues = () => (state.settings && state.settings.queues) || [];
  const currentQueue = () => queues().find((q) => q.id === state.queue) || queues()[0];
  const queueCount = (id) => [...state.items.values()].filter((d) => d.queued && d.status !== 'completed' && (d.queueId || 'main') === id).length;
  let editing = null; // id of the queue tab being renamed

  function renderQueueTabs() {
    const tabs = queues().map((q) => {
      const n = queueCount(q.id);
      const tab = el('button', { class: `q-tab${q.id === state.queue ? ' on' : ''}`, title: q.name });
      tab.dataset.id = q.id;
      if (editing === q.id) {
        const input = el('input', { value: q.name, maxlength: '40', spellcheck: 'false' });
        const finish = (save) => {
          if (editing !== q.id) return;
          editing = null;
          const name = input.value.trim();
          if (save && name && name !== q.name) saveQueue(q.id, { name });
          else renderQueuePanel();
        };
        input.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') finish(true);
          if (e.key === 'Escape') finish(false);
        });
        input.addEventListener('blur', () => finish(true));
        tab.append(input);
        setTimeout(() => {
          input.focus();
          input.select();
        });
      } else {
        if (state.queueStates[q.id]) tab.append(el('i', { class: 'q-dot', title: 'Running' }));
        tab.append(el('span', { class: 'q-name', text: q.name }));
        tab.append(el('span', { class: 'q-count', text: n ? DM.n(n) : '' }));
        tab.addEventListener('click', () => {
          if (state.queue === q.id) return;
          state.queue = q.id;
          select(null);
          renderQueuePanel();
          renderAll();
        });
        tab.addEventListener('dblclick', () => startRename(q.id));
      }
      return tab;
    });
    const add = el('button', { class: 'q-add', title: 'Create another queue with its own schedule', onclick: () => newQueue() });
    add.innerHTML = '<svg viewBox="0 0 12 12" fill="none"><path d="M6 1.5v9M1.5 6h9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
    add.append(document.createTextNode(t('New queue')));
    $('queueTabs').replaceChildren(...tabs, add);
  }

  function startRename(id) {
    editing = id;
    renderQueueTabs();
  }

  function newQueue() {
    const list = queues();
    let n = list.length + 1;
    while (list.some((q) => q.name === t('Queue {n}', { n: DM.n(n) }))) n++;
    const id = `q${Date.now().toString(36)}`;
    const q = { id, name: t('Queue {n}', { n: DM.n(n) }), maxConcurrent: 1 /* one download at a time */, schedule: { enabled: false, startTime: '02:00', stopEnabled: false, stopTime: '08:00', days: [0, 1, 2, 3, 4, 5, 6], afterDone: 'none' } };
    state.queue = id;
    editing = id;
    select(null);
    renderAll(); // the new queue is empty
    api.invoke('settings:set', { queues: [...list, q] });
  }

  function saveQueue(id, patch) {
    const list = queues().map((q) => (q.id === id ? { ...q, ...patch, schedule: { ...q.schedule, ...(patch.schedule || {}) } } : q));
    return api.invoke('settings:set', { queues: list });
  }

  function renderQueuePanel() {
    const s = state.settings;
    if (!s) return;
    const q = currentQueue();
    if (!q) return;
    renderQueueTabs();
    const sch = q.schedule;
    const running = !!state.queueStates[q.id];
    $('queueStart').hidden = running;
    $('queueStop').hidden = !running;
    $('queueStart').querySelector('span').textContent = queues().length > 1 ? t('Start “{name}”', { name: t(q.name) }) : t('Start queue');
    $('queueStop').querySelector('span').textContent = queues().length > 1 ? t('Stop “{name}”', { name: t(q.name) }) : t('Stop queue');
    $('queueDelete').hidden = q.id === 'main';
    $('schEnabled').checked = sch.enabled;
    $('schStart').value = sch.startTime;
    $('schStopEnabled').checked = sch.stopEnabled;
    $('schStop').value = sch.stopTime;
    $('schMax').value = String(q.maxConcurrent);
    $('schAfter').value = sch.afterDone;
    const days = $('schDays');
    days.replaceChildren(
      ...DAY_ORDER.map((i) =>
        el('button', {
          class: `day${sch.days.includes(i) ? ' on' : ''}`,
          text: dayLetter(i),
          title: t(DAY_FULL[i]),
          onclick: () => {
            const set = new Set(currentQueue().schedule.days);
            set.has(i) ? set.delete(i) : set.add(i);
            saveSchedule({ days: [...set].sort() });
          },
        })
      )
    );
    updateQueueStatus();
  }

  function updateQueueStatus() {
    const cur = currentQueue();
    if (!cur) return;
    const q = [...state.items.values()].filter((d) => d.queued && d.status !== 'completed' && (d.queueId || 'main') === cur.id);
    const active = q.filter((d) => ['downloading', 'connecting'].includes(d.status)).length;
    const running = !!state.queueStates[cur.id];
    const sch = cur.schedule;
    let text;
    if (running) text = t('Running · {a} active, {w} waiting', { a: DM.n(active), w: DM.n(q.length - active) });
    else if (!q.length) text = t('Queue is empty');
    else text = t('{n} waiting', { n: DM.n(q.length) });
    if (!running && sch.enabled) text += ` · ${t('starts at {time}', { time: DM.n(sch.startTime) })}`;
    $('queueStatus').textContent = text;
    // counts on the tabs follow the list
    for (const tab of $('queueTabs').querySelectorAll('.q-tab')) {
      const c = tab.querySelector('.q-count');
      if (c) c.textContent = queueCount(tab.dataset.id) ? DM.n(queueCount(tab.dataset.id)) : '';
    }
  }

  const saveSchedule = (patch) => saveQueue(state.queue, { schedule: patch });
  $('queueStart').addEventListener('click', () => api.invoke('queue:start', state.queue));
  $('queueStop').addEventListener('click', () => api.invoke('queue:stop', state.queue));
  $('queueRename').addEventListener('click', () => startRename(state.queue));
  $('queueDelete').addEventListener('click', async () => {
    if (await api.invoke('queue:delete', state.queue)) {
      state.queue = 'main';
      renderQueuePanel();
      renderAll();
    }
  });
  $('schEnabled').addEventListener('change', (e) => saveSchedule({ enabled: e.target.checked }));
  $('schStopEnabled').addEventListener('change', (e) => saveSchedule({ stopEnabled: e.target.checked }));
  $('schStart').addEventListener('change', (e) => e.target.value && saveSchedule({ startTime: e.target.value }));
  $('schStop').addEventListener('change', (e) => e.target.value && saveSchedule({ stopTime: e.target.value }));
  $('schAfter').addEventListener('change', (e) => saveSchedule({ afterDone: e.target.value }));
  $('schMax').addEventListener('change', (e) => saveQueue(state.queue, { maxConcurrent: Number(e.target.value) }));

  // ------------------------------------------------------------ power banner
  function showPower(p) {
    const b = $('powerBanner');
    if (!p) return (b.hidden = true);
    b.hidden = false;
    $('powerText').textContent = p.seconds != null ? t('Queue finished — {label} in {s}s', { label: t(p.label), s: DM.n(p.seconds) }) : t('Queue finished — {action} pending', { action: p.action });
  }
  $('powerCancel').addEventListener('click', () => api.invoke('power:cancel'));

  // ------------------------------------------------------------ keyboard
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input, textarea, select')) return;
    const id = state.selected;
    const mod = e.ctrlKey || e.metaKey; // ⌘ on macOS
    if (mod && e.key.toLowerCase() === 'a' && state.view !== 'settings') {
      e.preventDefault();
      selectAll(true);
      return;
    }
    if (mod && e.key.toLowerCase() === 'n') {
      e.preventDefault();
      openAdd();
    } else if (mod && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      focusSearch();
    } else if (!id) {
      return;
    } else if (e.key === 'Escape') {
      select(null);
    } else if (e.key === 'Delete' || (IS_MAC && e.key === 'Backspace' && e.metaKey)) {
      deleteSelected();
    } else if (e.key === 'Enter') {
      api.invoke('downloads:action', { id, action: 'open' });
    } else if (e.key === ' ') {
      e.preventDefault();
      api.invoke('downloads:action', { id, action: 'toggle' });
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const ids = visibleItems().map((d) => d.id);
      const i = ids.indexOf(id) + (e.key === 'ArrowDown' ? 1 : -1);
      if (ids[i]) {
        select(ids[i]);
        rows.get(ids[i])?.row.scrollIntoView({ block: 'nearest' });
      }
    }
  });

  window.MainUI = { setView };
  init();
})();
