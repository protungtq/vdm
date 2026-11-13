'use strict';

// File categories. Keys match the category badges in the design
// (video / audio / zip / text / exe / other); `folder` is the sub-folder
// created inside the download directory when "Sort into folders" is on.
const CATEGORIES = {
  video: {
    label: 'Video',
    folder: 'Video',
    exts: ['mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm', 'm4v', 'mpg', 'mpeg', '3gp', 'ts', 'm2ts', 'mts', 'vob', 'ogv', 'rmvb', 'f4v'],
  },
  audio: {
    label: 'Music',
    folder: 'Music',
    exts: ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'oga', 'opus', 'wma', 'alac', 'aiff', 'ape', 'mka', 'm4b'],
  },
  zip: {
    label: 'Compressed',
    folder: 'Compressed',
    exts: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'lz', 'lzma', 'cab', 'arj', 'z', 'iso', 'img'],
  },
  text: {
    label: 'Documents',
    folder: 'Documents',
    exts: ['pdf', 'doc', 'docx', 'txt', 'rtf', 'odt', 'xls', 'xlsx', 'csv', 'ppt', 'pptx', 'epub', 'mobi', 'srt', 'ass', 'ssa', 'sub', 'vtt', 'md', 'json', 'xml'],
  },
  exe: {
    label: 'Programs',
    folder: 'Programs',
    exts: ['exe', 'msi', 'msix', 'msixbundle', 'appx', 'apk', 'xapk', 'dmg', 'pkg', 'deb', 'rpm', 'appimage', 'bat', 'cmd', 'jar'],
  },
  other: { label: 'General', folder: 'General', exts: [] },
};

const EXT_TO_CATEGORY = new Map();
for (const [key, c] of Object.entries(CATEGORIES)) for (const e of c.exts) EXT_TO_CATEGORY.set(e, key);

// Extensions that, when seen in a copied link or captured by the browser
// extension, look like "a file to download" rather than a web page.
const DOWNLOADABLE_EXTS = new Set([...EXT_TO_CATEGORY.keys(), 'bin', 'torrent', 'part'].filter(
  (e) => !['json', 'xml', 'md', 'txt', 'csv', 'vtt'].includes(e)
));

const MIME_TO_EXT = {
  'video/mp4': 'mp4', 'video/x-matroska': 'mkv', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'video/x-msvideo': 'avi', 'video/x-flv': 'flv', 'video/mpeg': 'mpg', 'video/mp2t': 'ts',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/flac': 'flac', 'audio/x-flac': 'flac',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/opus': 'opus',
  'application/zip': 'zip', 'application/x-zip-compressed': 'zip', 'application/x-rar-compressed': 'rar',
  'application/vnd.rar': 'rar', 'application/x-7z-compressed': '7z', 'application/gzip': 'gz',
  'application/x-tar': 'tar', 'application/pdf': 'pdf', 'text/plain': 'txt',
  'application/x-msdownload': 'exe', 'application/x-msdos-program': 'exe', 'application/x-msi': 'msi',
  'application/vnd.android.package-archive': 'apk', 'application/x-iso9660-image': 'iso',
  'application/epub+zip': 'epub', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
};

function extOf(filename) {
  const m = /\.([a-z0-9]{1,12})$/i.exec(filename || '');
  return m ? m[1].toLowerCase() : '';
}

function categoryOf(filename) {
  return EXT_TO_CATEGORY.get(extOf(filename)) || 'other';
}

function extForMime(mime) {
  if (!mime) return '';
  return MIME_TO_EXT[String(mime).split(';')[0].trim().toLowerCase()] || '';
}

function looksDownloadable(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return false;
    const last = decodeURIComponent(u.pathname.split('/').pop() || '');
    return DOWNLOADABLE_EXTS.has(extOf(last));
  } catch {
    return false;
  }
}

module.exports = { CATEGORIES, categoryOf, extOf, extForMime, looksDownloadable, DOWNLOADABLE_EXTS };
