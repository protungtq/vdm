'use strict';

const { t, digits: D } = require('../shared/i18n');

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { request } = require('./engine/http');

/**
 * Checks the project's GitHub Releases for a newer version and downloads its installer.
 *
 * States: idle → checking → none | available → downloading → ready, or error.
 * The installed app downloads `VDM-Setup-<v>.exe` and runs it silently; the portable
 * build can't replace itself while running, so it just points to the release page.
 */
class Updater extends EventEmitter {
  constructor({ version, repo, cacheDir, portable = false, assetPattern = null, apiBase = 'https://api.github.com', webBase = 'https://github.com', allowedPrefixes }) {
    super();
    this.version = version;
    this.repo = repo;
    this.cacheDir = cacheDir;
    this.portable = portable;
    this.assetPattern = assetPattern;
    this.apiBase = apiBase.replace(/\/$/, '');
    this.webBase = webBase.replace(/\/$/, '');
    // installers are only ever fetched from this project's own release files
    this.allowed = allowedPrefixes || [`${this.webBase}/${repo}/releases/download/`];
    this.state = { status: 'idle', current: version, portable };
    this.timer = null;
    this.retryAfter = 5 * 60 * 1000;
  }

  set(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  /** Starts periodic checks (first one shortly after launch). */
  start({ enabled, delay = 8000, every = 6 * 3600 * 1000 }) {
    this.stop();
    if (!enabled()) return;
    const tick = () => {
      if (enabled() && !['downloading', 'ready'].includes(this.state.status)) this.check().catch(() => {});
    };
    this.first = setTimeout(tick, delay);
    this.timer = setInterval(tick, every);
  }

  stop() {
    clearTimeout(this.first);
    clearTimeout(this.retry);
    clearInterval(this.timer);
    this.timer = null;
  }

  async check() {
    if (['checking', 'downloading'].includes(this.state.status)) return this.state;
    if (this.state.status === 'ready') return this.state;
    this.set({ status: 'checking', error: null });
    try {
      let rel;
      try {
        rel = await getJson(`${this.apiBase}/repos/${this.repo}/releases/latest`, this.version);
      } catch (e) {
        // The GitHub API limits anonymous requests per IP address (60 an hour), and shared networks, VPNs and
        // proxies hit that limit quickly (HTTP 403 / 429). The release pages on github.com have no such limit.
        if (!e || !['rate-limited', 'api-error'].includes(e.kind)) throw e;
        rel = await this.latestFromWeb().catch(() => {
          throw e;
        });
      }
      const latest = String(rel.tag_name || '').replace(/^v/i, '');
      if (!latest || rel.draft || rel.prerelease || compareVersions(latest, this.version) <= 0) {
        this.set({ status: 'none', checkedAt: Date.now() });
        return this.state;
      }
      // A release is created first and its installers are attached by the build a few minutes later. Offering the
      // update now would only open the web page: wait for the files and look again soon.
      if (!(rel.assets || []).length && !this.assetPattern) {
        this.set({ status: 'none', checkedAt: Date.now(), waitingForFiles: latest });
        clearTimeout(this.retry);
        this.retry = setTimeout(() => this.check().catch(() => {}), this.retryAfter);
        if (this.retry.unref) this.retry.unref();
        return this.state;
      }
      const want = this.assetPattern || (this.portable ? /^VDM-Portable-.*\.exe$/i : /^VDM-Setup-.*\.exe$/i);
      const asset = (rel.assets || []).find((a) => want.test(a.name));
      this.set({
        status: 'available',
        version: latest,
        page: /^https:\/\/github\.com\//.test(rel.html_url || '') ? rel.html_url : `https://github.com/${this.repo}/releases/latest`,
        asset: asset ? { name: path.basename(asset.name), url: asset.browser_download_url, size: asset.size, digest: asset.digest || '' } : null,
        checkedAt: Date.now(),
      });
    } catch (e) {
      this.set({ status: 'error', error: friendly(e), stage: 'check' });
    }
    return this.state;
  }

  /**
   * The same answer as the API's "latest release", read from the public release pages: /releases/latest
   * redirects to /releases/tag/<tag>, and the installer's file name follows from the tag.
   * Without the API there is no checksum to compare, so the size comes from the download's own headers.
   */
  async latestFromWeb() {
    const base = `${this.webBase}/${this.repo}/releases`;
    const headers = { 'User-Agent': `VDM/${this.version}` };
    const { req, res, url } = await request(`${base}/latest`, { timeout: 20000, headers });
    res.resume();
    req.destroy();
    const m = /\/releases\/tag\/([^/?#]+)$/.exec(String(url || ''));
    if (res.statusCode === 404) return { tag_name: '' }; // no releases yet
    if (res.statusCode !== 200 || !m) throw new Error(`GitHub responded ${res.statusCode}`);
    const tag = decodeURIComponent(m[1]);
    const v = tag.replace(/^v/i, '');
    const rel = { tag_name: tag, html_url: `${base}/tag/${encodeURIComponent(tag)}`, assets: [] };
    if (compareVersions(v, this.version) <= 0) return rel;
    const names = this.assetPattern ? [] : [this.portable ? `VDM-Portable-${v}.exe` : `VDM-Setup-${v}.exe`];
    for (const name of names) {
      const r = await request(`${base}/download/${encodeURIComponent(tag)}/${name}`, { timeout: 20000, headers });
      r.res.resume();
      r.req.destroy();
      // not there (yet): the release exists but its files are still being built
      if (r.res.statusCode === 200) rel.assets.push({ name, browser_download_url: `${base}/download/${encodeURIComponent(tag)}/${name}`, size: Number(r.res.headers['content-length']) || 0 });
    }
    if (!this.assetPattern && !rel.assets.length) return { tag_name: '' }; // wait until the installer is published
    return rel;
  }

  /** Downloads the installer into the cache folder and verifies it. */
  async download() {
    const { asset } = this.state;
    if (this.state.status === 'ready') return this.state;
    if (this.downloading) return this.downloading;
    if (!asset || this.portable) throw new Error(t('Nothing to download'));
    // GitHub spells the repository the way it was created, whatever letter case we were told
    if (!this.allowed.some((p) => String(asset.url).toLowerCase().startsWith(p.toLowerCase()))) {
      const e = new Error(t('Unexpected download location'));
      this.set({ status: 'error', error: e.message, stage: 'download' }); // show it on the button instead of doing nothing
      throw e;
    }
    this.downloading = (async () => {
      this.set({ status: 'downloading', progress: { received: 0, total: asset.size || 0 }, error: null });
      const dest = path.join(this.cacheDir, asset.name);
      const part = dest + '.part';
      try {
        await fsp.mkdir(this.cacheDir, { recursive: true });
        const { req, res } = await request(asset.url, { timeout: 60000, headers: { 'User-Agent': `VDM/${this.version}` } });
        if (res.statusCode !== 200) {
          res.resume();
          req.destroy();
          throw new Error(t('Download failed (HTTP {code})', { code: D(res.statusCode) }));
        }
        const total = Number(res.headers['content-length']) || asset.size || 0;
        const hash = crypto.createHash('sha256');
        let received = 0;
        let last = 0;
        const out = fs.createWriteStream(part);
        await new Promise((resolve, reject) => {
          res.on('data', (c) => {
            received += c.length;
            hash.update(c);
            const now = Date.now();
            if (now - last > 150) {
              last = now;
              this.set({ progress: { received, total } });
            }
          });
          res.on('error', reject);
          out.on('error', reject);
          out.on('finish', resolve);
          res.pipe(out);
        });
        if (asset.size && received !== asset.size) throw new Error(t('The download was incomplete'));
        const m = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest || '');
        if (m && hash.digest('hex') !== m[1].toLowerCase()) throw new Error(t('The downloaded file is damaged'));
        await fsp.rename(part, dest);
        this.set({ status: 'ready', file: dest, progress: { received, total: received } });
      } catch (e) {
        await fsp.rm(part, { force: true }).catch(() => {});
        // connection dropped mid-file
        if (e && (e.message === 'aborted' || e.code === 'ECONNRESET')) e = new Error(t('The download was incomplete'));
        this.set({ status: 'error', error: friendly(e), stage: 'download' });
        throw e;
      } finally {
        this.downloading = null;
      }
      return this.state;
    })();
    return this.downloading;
  }

  /** Removes installers left over from earlier updates. */
  async cleanup() {
    try {
      for (const f of await fsp.readdir(this.cacheDir)) await fsp.rm(path.join(this.cacheDir, f), { force: true });
    } catch {
      /* nothing cached */
    }
  }
}

function getJson(url, version) {
  return request(url, {
    timeout: 20000,
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `VDM/${version}`, 'X-GitHub-Api-Version': '2022-11-28' },
  }).then(
    ({ req, res }) =>
      new Promise((resolve, reject) => {
        if (res.statusCode === 404) {
          res.resume();
          return resolve({}); // no releases yet
        }
        if (res.statusCode !== 200) {
          res.resume();
          req.destroy();
          const err = new Error(t('GitHub responded {code}', { code: D(res.statusCode) }));
          err.kind = res.statusCode === 403 || res.statusCode === 429 ? 'rate-limited' : res.statusCode >= 500 ? 'api-error' : 'http';
          return reject(err);
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
          if (body.length > 5_000_000) req.destroy();
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            reject(new Error(t('Unexpected answer from GitHub')));
          }
        });
        res.on('error', reject);
      })
  );
}

/** Compares dotted versions numerically: 0.10.0 > 0.9.2. */
function compareVersions(a, b) {
  const pa = String(a).split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

function friendly(e) {
  const code = e && e.code;
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(code)) return t('No internet connection');
  return (e && e.message) || t('Something went wrong');
}

module.exports = { Updater, compareVersions };
