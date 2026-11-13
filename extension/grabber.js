// VDM "Download video" button: appears over the video under the mouse.
(() => {
  if (window.__vdmGrabber) return;
  window.__vdmGrabber = true;

  let enabled = true;
  chrome.runtime.sendMessage({ type: 'grabber-config' }, (r) => {
    if (chrome.runtime.lastError) return;
    enabled = !r || r.enabled !== false;
  });

  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:0;left:0;width:0;height:0;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      button{all:unset;position:fixed;display:none;align-items:center;gap:7px;padding:7px 12px 7px 8px;border-radius:9px;
        background:rgba(20,18,24,.9);color:#fff;font:600 12px/16px system-ui,"Segoe UI",sans-serif;cursor:pointer;
        box-shadow:0 4px 18px rgba(0,0,0,.35),0 0 0 1px rgba(255,255,255,.08);backdrop-filter:blur(6px);transition:background .15s;white-space:nowrap}
      button:hover{background:rgba(115,103,240,.95)}
      button.show{display:flex}
      svg{width:18px;height:18px;flex:none}
    </style>
    <button type="button" title="Download this video with VDM">
      <svg width="28" height="28" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="28" height="28" rx="8" fill="url(#vdm_grad_g)"/><path d="M14 5.5v11" stroke="white" stroke-width="2.6" stroke-linecap="round"/><path d="M8.5 11.5L14 17l5.5-5.5" stroke="white" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M6.5 21.5h15" stroke="white" stroke-width="2.6" stroke-linecap="round"/><defs><linearGradient id="vdm_grad_g" x1="0" y1="0" x2="28" y2="28" gradientUnits="userSpaceOnUse"><stop stop-color="#F87171"/><stop offset="1" stop-color="#DC2626"/></linearGradient></defs></svg>
      <span>Download video</span>
    </button>`;
  const btn = root.querySelector('button');
  const label = root.querySelector('span');
  (document.body || document.documentElement).appendChild(host);

  let current = null;
  let hideTimer = null;
  let overButton = false;

  const show = (v) => {
    const r = v.getBoundingClientRect();
    if (r.width < 200 || r.height < 110 || r.bottom < 0 || r.top > innerHeight) return hide();
    current = v;
    btn.style.top = `${Math.max(6, r.top + 10)}px`;
    btn.style.left = `${Math.max(6, Math.min(innerWidth - 160, r.right - 152))}px`;
    btn.classList.add('show');
    clearTimeout(hideTimer);
  };
  const hide = () => {
    if (overButton) return;
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

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const src = current ? current.currentSrc || current.src : '';
    label.textContent = 'Sending…';
    chrome.runtime.sendMessage({ type: 'grab-video', src, title: document.title }, (ok) => {
      label.textContent = chrome.runtime.lastError || !ok ? 'VDM isn’t running' : 'Sent to VDM ✓';
      setTimeout(() => (label.textContent = 'Download video'), 2200);
    });
  });
})();
