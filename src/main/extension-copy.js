'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Keeps a copy of the browser extension in a permanent folder (inside the user's VDM data folder).
 *
 * The browser loads an unpacked extension from the folder you pick and forgets it when that folder disappears.
 * The portable build runs from a temporary folder that is deleted when VDM closes, so an extension loaded from
 * there vanished at the next restart. The copy always lives at the same path, so the browser keeps it, and VDM
 * refreshes the files after an update.
 */
function syncExtension(from, to) {
  fs.mkdirSync(to, { recursive: true });
  const wanted = new Set();
  const walk = (src, dst) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, e.name);
      const d = path.join(dst, e.name);
      wanted.add(path.resolve(d));
      if (e.isDirectory()) walk(s, d);
      else if (!fs.existsSync(d) || fs.statSync(d).size !== fs.statSync(s).size || !fs.readFileSync(d).equals(fs.readFileSync(s))) fs.copyFileSync(s, d);
    }
  };
  walk(from, to);
  // files an older version had and this one doesn't
  const prune = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (!wanted.has(path.resolve(p))) fs.rmSync(p, { recursive: true, force: true });
      else if (e.isDirectory()) prune(p);
    }
  };
  prune(to);
  return to;
}

module.exports = { syncExtension };
