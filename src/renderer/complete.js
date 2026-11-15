'use strict';
/* "Download complete" window: what was saved, where, and how long it took. */
(function () {
  const { t, params, fmtBytes, fmtSpeed, fmtEta, catIcon } = DM;
  const $ = (id) => document.getElementById(id);
  const id = params.get('id');

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') api.invoke('window:close');
    if (e.key === 'Enter' && document.activeElement === document.body) $('cpOpen').click();
  });

  $('cpOpen').addEventListener('click', async () => {
    await api.invoke('downloads:action', { id, action: 'open' });
    api.invoke('window:close');
  });
  $('cpFolder').addEventListener('click', async () => {
    await api.invoke('downloads:action', { id, action: 'openFolder' });
    api.invoke('window:close');
  });
  $('cpClose').addEventListener('click', () => api.invoke('window:close'));
  $('cpNever').addEventListener('change', (e) => api.invoke('settings:set', { showCompleteWindow: !e.target.checked }));

  api.on('downloads:removed', (rid) => rid === id && api.invoke('window:close'));

  (async () => {
    const d = await api.invoke('downloads:detail', id);
    if (!d) return api.invoke('window:close');
    $('cpCat').src = catIcon(d.category, 'max');
    $('cpName').textContent = d.filename;
    $('cpName').title = d.filename;
    $('cpPath').textContent = d.savePath;
    $('cpPath').title = d.savePath;
    const secs = d.completedAt && d.startedAt ? (d.completedAt - d.startedAt) / 1000 : 0;
    const parts = [fmtBytes(d.size > 0 ? d.size : d.downloaded)];
    if (secs >= 1) {
      parts.push(t('in {time}', { time: fmtEta(secs) }));
      if (d.size > 0) parts.push(fmtSpeed(d.size / secs));
    }
    $('cpSub').textContent = parts.join(' · ');
    document.title = d.filename;
  })();
})();
