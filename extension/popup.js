const DEFAULTS = { enabled: true, minSizeKB: 512 };
const $ = (id) => document.getElementById(id);

(async () => {
  const cfg = { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
  $('enabled').checked = cfg.enabled;
  $('minSize').value = String(cfg.minSizeKB);
  $('enabled').addEventListener('change', (e) => chrome.storage.local.set({ enabled: e.target.checked }));
  $('minSize').addEventListener('change', (e) => chrome.storage.local.set({ minSizeKB: Number(e.target.value) }));

  const st = await chrome.runtime.sendMessage({ type: 'status' });
  const el = $('status');
  if (st && st.app) {
    el.className = 'status ok';
    $('statusText').textContent = st.enabled ? `Connected · v${st.version}` : 'Connected · integration is off in the app';
  } else {
    el.className = 'status bad';
    $('statusText').textContent = 'App not running — downloads stay in the browser';
  }
  // ---- videos found on this tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const found = tab ? (await chrome.runtime.sendMessage({ type: 'tab-media', tabId: tab.id })) || [] : [];
  $('vCount').textContent = String(found.length);
  const mb = (n) => (n > 0 ? (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`) : '');
  const name = (u) => {
    try {
      return decodeURIComponent(new URL(u).pathname.split('/').pop()) || new URL(u).hostname;
    } catch {
      return u;
    }
  };
  for (const v of found) {
    const row = document.createElement('div');
    row.className = 'v-item';
    row.title = v.url;
    row.innerHTML = `<span class="v-kind ${v.kind}">${v.kind.toUpperCase()}</span><span class="v-name"></span><span class="v-size">${mb(v.size)}</span>`;
    row.querySelector('.v-name').textContent = name(v.url);
    row.addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'grab-tab', tabId: tab.id, preferred: v });
      window.close();
    });
    $('vList').append(row);
  }
  $('grabVideo').addEventListener('click', async () => {
    $('grabVideo').textContent = 'Sending…';
    const ok = tab && (await chrome.runtime.sendMessage({ type: 'grab-tab', tabId: tab.id }));
    if (ok) window.close();
    else $('grabVideo').textContent = 'VDM isn’t running';
  });

  $('grab').addEventListener('click', async () => {
    $('grab').textContent = 'Sending…';
    await chrome.runtime.sendMessage({ type: 'grab' });
    window.close();
  });
})();
