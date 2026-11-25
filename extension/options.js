'use strict';

// Options page: the pairing code the desktop app shows in Settings → Browser integration.
// Stored only in this browser profile, sent only to the VDM app on 127.0.0.1.
const APP = 'http://127.0.0.1:17842';

const input = document.getElementById('token');
const status = document.getElementById('status');

const show = (text, ok) => {
  status.textContent = text;
  status.className = ok === true ? 'ok' : ok === false ? 'err' : '';
};

chrome.storage.local.get('bridgeToken').then(({ bridgeToken = '' }) => {
  input.value = bridgeToken || '';
});

document.getElementById('save').addEventListener('click', async () => {
  const bridgeToken = input.value.trim();
  await chrome.storage.local.set({ bridgeToken });
  show(bridgeToken ? 'Saved. The extension will send this code with every download.' : 'Cleared. Pairing is off until you paste a code.', true);
});

document.getElementById('test').addEventListener('click', async () => {
  show('Checking…');
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    const r = await fetch(`${APP}/ping`, { signal: ctl.signal });
    clearTimeout(t);
    const j = await r.json();
    if (j && j.app === 'download-manager') {
      show(j.enabled === false ? 'VDM is running, but browser integration is off in its Settings.' : 'VDM is running. Try a download: if it lands in VDM, pairing works.', true);
    } else {
      show('Something answered, but it is not VDM.', false);
    }
  } catch {
    show('VDM is not running. Start the desktop app and try again.', false);
  }
});
