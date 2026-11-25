// VDM "Download video" button: appears over the video under the mouse.
(() => {
  if (window.__vdmGrabber) return;
  window.__vdmGrabber = true;

  let enabled = true;
  let siteHidden = false; // the user turned the button off for this website (toolbar popup)
  chrome.runtime.sendMessage({ type: 'grabber-config' }, (r) => {
    if (chrome.runtime.lastError) return;
    enabled = !r || r.enabled !== false;
  });
  const readSites = () => {
    try {
      chrome.storage.local.get({ hiddenSites: [] }, (r) => {
        if (chrome.runtime.lastError) return;
        siteHidden = (r.hiddenSites || []).includes(location.hostname);
        if (siteHidden) hide(true);
      });
    } catch {
      /* extension was reloaded: this page's script is orphaned */
    }
  };
  readSites();
  try {
    chrome.storage.onChanged.addListener((ch) => ch.hiddenSites && readSites());
  } catch {
    /* orphaned */
  }

  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:0;left:0;width:0;height:0;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      .bar{position:fixed;display:none;align-items:stretch;border-radius:9px;overflow:hidden;
        background:rgba(20,18,24,.9);color:#fff;font:600 12px/16px system-ui,"Segoe UI",sans-serif;
        box-shadow:0 4px 18px rgba(0,0,0,.35),0 0 0 1px rgba(255,255,255,.08);backdrop-filter:blur(6px);white-space:nowrap;
        touch-action:none;cursor:grab}
      .bar.show{display:flex}
      .bar.dragging,.bar.dragging button{cursor:grabbing}
      button{all:unset;display:flex;align-items:center;cursor:pointer;transition:background .15s}
      .main{gap:7px;padding:7px 8px 7px 8px}
      .main:hover{background:rgba(115,103,240,.95)}
      .x{width:26px;justify-content:center;color:rgba(255,255,255,.65);font:400 16px/1 system-ui,sans-serif;border-left:1px solid rgba(255,255,255,.12)}
      .x:hover{background:rgba(255,255,255,.16);color:#fff}
      svg{width:18px;height:18px;flex:none}
      .main span{padding-right:4px}
    </style>
    <div class="bar">
      <button type="button" class="main" title="Download this video with VDM">
        <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="28" height="28" rx="8" fill="url(#vdm_grad_g)"/><path d="M14 5.5v11" stroke="white" stroke-width="2.6" stroke-linecap="round"/><path d="M8.5 11.5L14 17l5.5-5.5" stroke="white" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M6.5 21.5h15" stroke="white" stroke-width="2.6" stroke-linecap="round"/><defs><linearGradient id="vdm_grad_g" x1="0" y1="0" x2="28" y2="28" gradientUnits="userSpaceOnUse"><stop stop-color="#F87171"/><stop offset="1" stop-color="#DC2626"/></linearGradient></defs></svg>
        <span>Download video</span>
      </button>
      <button type="button" class="x" title="Hide this button">×</button>
    </div>`;
  const btn = root.querySelector('.bar');
  const mainBtn = root.querySelector('.main');
  const closeBtn = root.querySelector('.x');
  const label = root.querySelector('.main span');
  (document.body || document.documentElement).appendChild(host);

  let current = null;
  let hideTimer = null;
  let overButton = false;
  const dismissed = new WeakSet(); // videos whose button the user closed (until the page is reloaded)
  const BTN_W = 190;
  const BTN_H = 34;

  // Anything the page itself lets you click: its own buttons, links and controls.
  const INTERACTIVE = 'a[href],button,input,select,textarea,summary,label,[role=button],[role=link],[role=menuitem],[role=tab],[role=slider],[onclick],[tabindex]';
  const covers = (x, y, video) => {
    for (const el of document.elementsFromPoint(x, y)) {
      if (el === host || el === video) continue;
      if (el.matches && el.matches(INTERACTIVE)) return true;
      if (el.closest && el.closest(INTERACTIVE) && !el.contains(video)) return true;
    }
    return false;
  };
  /** The corner of the video where the button doesn't sit on top of the page's own controls. */
  function spot(v, r) {
    const left = Math.max(6, r.left);
    const right = Math.min(innerWidth, r.right);
    const top = Math.max(6, r.top);
    const bottom = Math.min(innerHeight, r.bottom);
    const candidates = [
      { x: right - BTN_W - 8, y: top + 10 }, // top right
      { x: left + 10, y: top + 10 }, // top left
      { x: left + 10, y: bottom - BTN_H - 56 }, // bottom left, above the player's control bar
      { x: right - BTN_W - 8, y: bottom - BTN_H - 56 }, // bottom right
      { x: left + (right - left - BTN_W) / 2, y: top + 10 }, // top centre
    ];
    for (const c of candidates) {
      const pts = [[0, 0], [BTN_W, 0], [0, BTN_H], [BTN_W, BTN_H], [BTN_W / 2, BTN_H / 2]];
      if (c.y < 0 || c.x < 0 || !pts.some(([dx, dy]) => covers(c.x + dx, c.y + dy, v))) return c;
    }
    return candidates[0];
  }

  let placed = { video: null, key: '', c: null };
  // Where the user dragged the bar to, and for which video: a dragged spot
  // sticks until another video is hovered. The bar is position:fixed, so
  // scrolling never moves it back.
  let manualPos = null;
  let manualVideo = null;
  let curPos = { x: 0, y: 0 };
  let drag = null; // {startX, startY, origX, origY, moved} while dragging
  const placeAt = (x, y) => {
    const w = btn.offsetWidth || BTN_W;
    const h = btn.offsetHeight || BTN_H;
    curPos = {
      x: Math.max(6, Math.min(innerWidth - w - 6, x)),
      y: Math.max(6, Math.min(innerHeight - h - 6, y)),
    };
    btn.style.left = `${curPos.x}px`;
    btn.style.top = `${curPos.y}px`;
  };
  const show = (v) => {
    if (drag) return; // a drag in progress owns the position
    const r = v.getBoundingClientRect();
    if (siteHidden || dismissed.has(v) || r.width < 200 || r.height < 110 || r.bottom < 0 || r.top > innerHeight) return hide();
    current = v;
    if (manualVideo === v && manualPos) {
      placeAt(manualPos.x, manualPos.y);
    } else {
      // working out the corner means asking the page what is under it: only when the video moved or changed
      const key = [r.left, r.top, r.width, r.height].map(Math.round).join(',');
      if (placed.video !== v || placed.key !== key) placed = { video: v, key, c: spot(v, r) };
      curPos = {
        x: Math.max(6, Math.min(innerWidth - BTN_W - 6, placed.c.x)),
        y: Math.max(6, placed.c.y),
      };
      btn.style.top = `${curPos.y}px`;
      btn.style.left = `${curPos.x}px`;
    }
    btn.classList.add('show');
    clearTimeout(hideTimer);
  };
  const hide = (force = false) => {
    if (overButton && !force) return;
    overButton = false;
    btn.classList.remove('show');
    current = null;
  };

  const videoAt = (x, y) => {
    for (const el of document.elementsFromPoint(x, y)) if (el.tagName === 'VIDEO') return el;
    // players often cover the video with controls: fall back to geometry
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return v;
    }
    return null;
  };

  let last = 0;
  document.addEventListener(
    'pointermove',
    (e) => {
      if (!enabled || Date.now() - last < 80) return;
      last = Date.now();
      const v = videoAt(e.clientX, e.clientY);
      if (v) show(v);
      else if (current) {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(hide, 900);
      }
    },
    { passive: true, capture: true }
  );
  addEventListener('scroll', () => current && show(current), { passive: true, capture: true });
  btn.addEventListener('pointerenter', () => (overButton = true));
  btn.addEventListener('pointerleave', () => {
    overButton = false;
    hideTimer = setTimeout(hide, 900);
  });

  // ---- dragging: the bar can be pulled anywhere on screen ----
  // A plain click still works: only a move past 5px counts as a drag, and
  // the click that follows a drag is swallowed so it can't fire the button.
  let suppressClick = false;
  btn.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return; // primary button / touch only
    drag = { startX: e.clientX, startY: e.clientY, origX: curPos.x, origY: curPos.y, moved: false };
    e.preventDefault();
  });
  addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 5) return;
    drag.moved = true;
    btn.classList.add('dragging');
    placeAt(drag.origX + dx, drag.origY + dy);
  }, { passive: true });
  const endDrag = () => {
    if (!drag) return;
    const wasDrag = drag.moved;
    drag = null;
    btn.classList.remove('dragging');
    if (wasDrag && current) {
      manualVideo = current;
      manualPos = { ...curPos };
      suppressClick = true;
      // The drag's own click (if any) arrives within milliseconds; a real
      // click later must not be swallowed if the pointer was released off-button.
      setTimeout(() => { suppressClick = false; }, 500);
    }
  };
  addEventListener('pointerup', endDrag);
  addEventListener('pointercancel', endDrag);
  btn.addEventListener('click', (e) => {
    if (suppressClick) {
      suppressClick = false;
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  // ---- which video was clicked? (a page can have many: feeds, galleries, grids of previews)
  // When each video started loading, so the background script can match it to the network request that fed it.
  const startedAt = new WeakMap();
  for (const ev of ['loadstart', 'play']) {
    document.addEventListener(ev, (e) => e.target && e.target.tagName === 'VIDEO' && startedAt.set(e.target, Date.now()), true);
  }
  const sameAsPage = (u) => u.split('#')[0] === location.href.split('#')[0];
  const isLink = (a) => {
    try {
      const u = new URL(a.href);
      return /^https?:$/.test(u.protocol) && !sameAsPage(u.href);
    } catch {
      return false;
    }
  };
  // Links that usually lead to one video's own page.
  const PERMALINK = /\/(status|statuses|watch|videos?|v|reels?|clips?|p|posts?|view|movie|episode|embed|shorts|tv|film|play|media)([/?#.]|$)|[?&](v|video|video_id|vid)=/i;
  const isBig = (v) => {
    const r = v.getBoundingClientRect();
    return r.width >= 200 && r.height >= 110;
  };

  /** The page of this video: the link around it, or the link in the same card (never one that holds other videos too). */
  function cardOf(v) {
    const own = v.closest('a[href]');
    if (own && isLink(own)) return { link: own.href, box: own };
    let box = v.parentElement;
    for (let depth = 0; box && box !== document.body && depth < 14; depth++, box = box.parentElement) {
      if (box.querySelectorAll('video').length > 1) break; // that's more than this video's card
      const link = [...box.querySelectorAll('a[href]')].find((a) => isLink(a) && PERMALINK.test(new URL(a.href).pathname + new URL(a.href).search));
      if (link) return { link: link.href, box };
    }
    return null;
  }

  // The page itself is this video's page (YouTube watch / Shorts, Facebook
  // Reel, X post, …): the link is the page's own URL. Hunting for a link in
  // the DOM on such a page only finds other videos (YouTube's "Up next"
  // list), because the player has no permalink around it and the walk climbs
  // into containers that hold them.
  const SINGLE_VIDEO_PAGE = /[?&](v|video|video_id|vid)=|\/(watch|shorts|embed|reels?|clips?|status|statuses|v)([/?#.]|$)/i;
  const pageIsVideo = SINGLE_VIDEO_PAGE.test(location.pathname + location.search);

  function describeTarget(v) {
    const card = pageIsVideo ? null : cardOf(v);
    const src = v ? v.currentSrc || v.src || '' : '';
    let title = '';
    if (card) {
      const h = card.box.querySelector && card.box.querySelector('h1,h2,h3,h4');
      title = ((h && h.textContent) || card.box.getAttribute('aria-label') || card.box.title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    }
    return {
      src: /^https?:/i.test(src) ? src : '', // blob: and MediaSource URLs only exist inside the page
      permalink: pageIsVideo ? location.href.split('#')[0] : (card ? card.link : ''),
      title: title || document.title,
      many: [...document.querySelectorAll('video')].filter(isBig).length > 1,
      // files that other videos on the page are playing: those are never this video's
      others: [...document.querySelectorAll('video')].filter((x) => x !== v).map((x) => x.currentSrc || x.src).filter((x) => /^https?:/i.test(x)).slice(0, 50),
      since: (v && startedAt.get(v)) || 0,
    };
  }

  closeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (current) dismissed.add(current);
    hide(true);
  });

  mainBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const target = current ? describeTarget(current) : null;
    label.textContent = 'Sending…';
    chrome.runtime.sendMessage({ type: 'grab-video', target, title: target ? target.title : document.title }, (ok) => {
      label.textContent = chrome.runtime.lastError || !ok ? 'VDM isn’t running' : 'Sent to VDM ✓';
      setTimeout(() => (label.textContent = 'Download video'), 2200);
    });
  });
})();
