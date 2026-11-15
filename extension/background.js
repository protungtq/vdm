// VDM (VN Download Manager) — browser integration (Chrome / Edge / Brave, Manifest V3)
const APP = 'http://127.0.0.1:17842';
const DEFAULTS = { enabled: true, minSizeKB: 512 };
const SKIP_MIME = /^(image\/|text\/(html|css|javascript|plain)|application\/(json|javascript|xml|x-javascript|pdf))/i;
const handedOff = new Set();
// A download only counts if the browser started it just now. When the browser opens, it also reports
// every download from its history (finished, interrupted…); those must never be sent to VDM again.
const FRESH_MS = 60 * 1000;
const isFresh = (item) => {
  const t = Date.parse(item.startTime || '');
  return item.state === 'in_progress' && t > Date.now() - FRESH_MS && t < Date.now() + FRESH_MS;
};
/** Each browser download is handed over at most once, even if the browser reports it again. */
async function firstTime(id) {
  const key = 'handled';
  const { [key]: list = [] } = await chrome.storage.local.get(key);
  if (list.includes(id)) return false;
  await chrome.storage.local.set({ [key]: [...list.slice(-199), id] });
  return true;
}

async function getConfig() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(DEFAULTS)) };
}

async function ping(timeout = 400) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    const r = await fetch(`${APP}/ping`, { signal: ctl.signal });
    clearTimeout(t);
    const j = await r.json();
    return j && j.app === 'download-manager' ? j : null;
  } catch {
    return null;
  }
}

async function cookiesFor(url) {
  try {
    const list = await chrome.cookies.getAll({ url });
    return list.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch {
    return '';
  }
}

async function send(payload) {
  try {
    const r = await fetch(`${APP}/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userAgent: navigator.userAgent, ...payload }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

const baseName = (p) => (p || '').split(/[\\/]/).pop();

// ---------------------------------------------------------------- capture browser downloads
chrome.downloads.onCreated.addListener(async (item) => {
  if (handedOff.has(item.url)) return handedOff.delete(item.url); // our own fallback
  if (item.byExtensionId && item.byExtensionId === chrome.runtime.id) return;
  if (!isFresh(item)) return; // an old download from the browser's history
  const cfg = await getConfig();
  if (!cfg.enabled) return;
  const url = item.finalUrl || item.url;
  if (!/^https?:/i.test(url)) return; // blob:/data: URLs only exist inside the browser
  if (item.mime && SKIP_MIME.test(item.mime)) return;
  const size = item.totalBytes > 0 ? item.totalBytes : item.fileSize > 0 ? item.fileSize : -1;
  if (size > 0 && size < cfg.minSizeKB * 1024) return;

  const app = await ping();
  if (!app || !app.enabled) return; // app closed or integration off: let the browser handle it
  if (!(await firstTime(item.id))) return;

  try {
    await chrome.downloads.cancel(item.id);
    await chrome.downloads.erase({ id: item.id });
  } catch {
    /* already finished — still hand it over */
  }
  const ok = await send({
    url,
    filename: baseName(item.filename),
    referrer: item.referrer || '',
    cookies: await cookiesFor(url),
    size,
  });
  if (!ok) {
    // Couldn't hand it over after all — restart it in the browser.
    handedOff.add(item.url);
    chrome.downloads.download({ url: item.url });
  }
});

// ---------------------------------------------------------------- context menu
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'dm-link', title: 'Download with VDM', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'dm-media', title: 'Download this media with VDM', contexts: ['video', 'audio', 'image'] });
    chrome.contextMenus.create({ id: 'dm-all', title: 'Download all links with VDM', contexts: ['page'] });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'dm-all') return sendAllLinks(tab);
  const url = info.menuItemId === 'dm-link' ? info.linkUrl : info.srcUrl;
  if (!url || !/^https?:/i.test(url)) return;
  const ok = await send({ url, referrer: info.pageUrl || '', cookies: await cookiesFor(url) });
  if (!ok) chrome.downloads.download({ url });
});

const FILE_EXT = /\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v|mpg|mpeg|ts|mp3|m4a|aac|flac|wav|ogg|opus|zip|rar|7z|tar|gz|bz2|xz|iso|exe|msi|apk|dmg|pdf|epub|srt|ass)(\?|#|$)/i;

async function sendAllLinks(tab) {
  if (!tab || !tab.id) return;
  const [res] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => [...document.querySelectorAll('a[href]')].map((a) => a.href),
  });
  const urls = [...new Set((res && res.result) || [])].filter((u) => /^https?:/i.test(u) && FILE_EXT.test(u));
  if (!urls.length) return;
  await send({ urls, referrer: tab.url || '', cookies: await cookiesFor(urls[0]) });
}

// popup messages
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.type === 'status') {
    ping(800).then(reply);
    return true;
  }
  if (msg && msg.type === 'grab') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => sendAllLinks(tab)).then(() => reply(true));
    return true;
  }
  return false;
});

// ================================================================ video grabber
// Watches network traffic for video streams per tab (HLS / DASH / files),
// shows a count on the toolbar badge, and hands videos to VDM on request.
const VIDEO_FILE = /\.(mp4|webm|mkv|mov|m4v|flv|mp3|m4a|ogg|oga|wav)(\?|$)/i;
const SEGMENT = /\.(ts|m4s|aac|vtt|webvtt|key)(\?|$)|[?&](range|rn|rbuf)=|\/videoplayback\b|\/(seg|segment|chunk|frag)[-_]?\d+/i;

const header = (headers, name) => (headers || []).find((h) => h.name.toLowerCase() === name)?.value || '';
const tabKey = (id) => `media:${id}`;

async function getMedia(tabId) {
  const r = await chrome.storage.session.get(tabKey(tabId));
  return r[tabKey(tabId)] || [];
}

// Detections can arrive at the same moment: run each tab's updates one at a time.
const tabLocks = new Map();
function withTab(tabId, fn) {
  const next = (tabLocks.get(tabId) || Promise.resolve()).then(fn, fn);
  tabLocks.set(tabId, next.catch(() => {}));
  return next;
}

async function setMedia(tabId, list) {
  await chrome.storage.session.set({ [tabKey(tabId)]: list });
  chrome.action.setBadgeText({ tabId, text: list.length ? String(list.length) : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#7367F0' }).catch(() => {});
}

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    if (d.tabId < 0 || d.statusCode >= 400 || !/^https?:/i.test(d.url)) return;
    const ct = header(d.responseHeaders, 'content-type').toLowerCase();
    const url = d.url;
    let kind = null;
    if (/mpegurl/.test(ct) || /\.m3u8(\?|$)/i.test(url)) kind = 'hls';
    else if (/dash\+xml/.test(ct) || /\.mpd(\?|$)/i.test(url)) kind = 'dash';
    else if ((/^(video|audio)\//.test(ct) || VIDEO_FILE.test(url)) && !SEGMENT.test(url) && !/mp2t/.test(ct)) kind = 'file';
    if (!kind) return;
    const range = /\/(\d+)\s*$/.exec(header(d.responseHeaders, 'content-range'));
    const size = range ? Number(range[1]) : Number(header(d.responseHeaders, 'content-length')) || -1;
    if (kind === 'file' && size > 0 && size < 300 * 1024) return; // previews, ads, UI sounds
    withTab(d.tabId, async () => {
      const list = await getMedia(d.tabId);
      const dir = (u) => u.split('?')[0].replace(/[^/]*$/, '');
      // a master playlist is fetched first; its variant playlists live next to it
      if (list.some((x) => x.url === url || (kind !== 'file' && x.kind === kind && dir(x.url) === dir(url)))) return;
      list.push({ url, kind, size, mime: ct.split(';')[0], time: Date.now() });
      await setMedia(d.tabId, list.slice(-20));
    });
  },
  { urls: ['<all_urls>'], types: ['media', 'xmlhttprequest', 'other', 'object'] },
  ['responseHeaders']
);

// New page in the tab (including YouTube-style in-page navigation): start over.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url) withTab(tabId, () => setMedia(tabId, []));
});
chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(tabKey(tabId)));

/**
 * Streams that belong to the clicked video. A page can load several videos at once, so "everything the tab
 * requested" would download the wrong one. A stream belongs to a video when it was requested around the time
 * that video started loading.
 */
const MATCH_BEFORE = 4000; // players fetch the playlist a moment before the <video> reports loadstart
const MATCH_AFTER = 10000;
const MATCH_CLUSTER = 1500; // a player's own requests (master playlist, variants) come in a burst
function streamsForVideo(found, since) {
  if (!since) return [];
  const near = found
    .filter((x) => x.time >= since - MATCH_BEFORE && x.time <= since + MATCH_AFTER)
    .sort((a, b) => Math.abs(a.time - since) - Math.abs(b.time - since));
  // only the request nearest to the moment this video started, and the ones that came with it: other
  // videos on the page loaded theirs at other times
  return near.length ? near.filter((x) => Math.abs(x.time - near[0].time) <= MATCH_CLUSTER) : [];
}

/**
 * Sends "download this video" to VDM. Called from the page's button with `target` (what the clicked video
 * is: its own file URL, the link to its page, when it started loading) or, from the toolbar popup, with a
 * stream picked in the list (`preferred`) or nothing (the tab's video).
 */
async function grabVideo(tab, { frameUrl = '', target = null, title = '', preferred = null } = {}) {
  const found = await getMedia(tab.id);
  let streams = preferred ? [preferred, ...found.filter((x) => x.url !== preferred.url)] : [...found];
  let pageUrl = tab.url || '';
  let ordered = false;
  let streamsFirst = false;
  if (target) {
    ordered = !!target.many; // with many videos the list below is already in the right order for THIS one: don't re-sort it
    const direct = /^https?:/i.test(target.src || '') ? [{ url: target.src, kind: 'file', size: -1 }] : [];
    const others = new Set(target.others || []);
    let mine = streamsForVideo(found.filter((x) => !others.has(x.url)), target.since);
    if (!mine.length && !direct.length && !target.permalink && target.many && found.length) {
      // nothing to go on but the clock: the request nearest to when this video started
      const near = target.since ? found.filter((x) => !others.has(x.url)).sort((a, b) => Math.abs(a.time - target.since) - Math.abs(b.time - target.since))[0] : null;
      mine = near ? [near] : [];
    }
    streams = target.many ? [...direct, ...mine.filter((x) => !direct.some((d) => d.url === x.url))] : [...direct, ...found.filter((x) => !direct.some((d) => d.url === x.url))];
    if (target.permalink) pageUrl = target.permalink; // this video's own page, not the feed it is shown in
    // On a page with many videos the page itself is the last thing to try, never the first.
    streamsFirst = !!target.many && !target.permalink;
  }
  return send({
    media: true,
    pageUrl,
    frameUrl: frameUrl && frameUrl !== tab.url ? frameUrl : '',
    title: title || tab.title || '',
    streams,
    ordered,
    streamsFirst,
    referrer: tab.url || '',
    cookies: await cookiesFor(tab.url || (streams[0] && streams[0].url) || ''),
  });
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg) return false;
  if (msg.type === 'grabber-config') {
    Promise.all([getConfig(), ping(600)]).then(([cfg, app]) => reply({ enabled: cfg.videoButton !== false && (!app || app.videoButton !== false) }));
    return true;
  }
  if (msg.type === 'grab-video' && sender.tab) {
    grabVideo(sender.tab, { frameUrl: sender.frameId ? sender.url : '', target: msg.target || null, title: msg.title }).then(reply);
    return true;
  }
  if (msg.type === 'tab-media') {
    getMedia(msg.tabId).then(reply);
    return true;
  }
  if (msg.type === 'grab-tab') {
    chrome.tabs.get(msg.tabId).then((tab) => grabVideo(tab, { preferred: msg.preferred || null })).then(reply);
    return true;
  }
  return false;
});
