'use strict';
/* "Online Watch": stream the file before (or while) downloading it. */
(function () {
  const { params, toast } = DM;
  DM.setTheme('dark');
  const src = params.get('src') || '';
  const video = document.getElementById('video');
  document.title = params.get('title') || DM.t('Online Watch');

  const fail = (why) => {
    document.getElementById('loading').hidden = true;
    video.hidden = true;
    document.getElementById('msg').hidden = false;
    if (why) document.getElementById('why').textContent = why;
  };
  video.addEventListener('loadeddata', () => (document.getElementById('loading').hidden = true));
  video.addEventListener('error', () => fail());
  video.src = src;

  document.getElementById('external').addEventListener('click', async () => {
    const r = await api.invoke('player:external', { url: src });
    if (!r.ok) toast(DM.t('No external player found — install VLC or PotPlayer'), 3500);
  });
  document.getElementById('copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText(src).catch(() => {});
    toast(DM.t('Link copied'));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === ' ' && document.activeElement !== video) {
      e.preventDefault();
      video.paused ? video.play() : video.pause();
    } else if (e.key === 'f') {
      document.fullscreenElement ? document.exitFullscreen() : video.requestFullscreen();
    } else if (e.key === 'Escape' && document.fullscreenElement) document.exitFullscreen();
  });
})();
