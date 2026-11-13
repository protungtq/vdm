'use strict';
/* "What's new" window: the entries between the version the user last saw and the current one. */
(function () {
  const { el, t } = DM;
  const lang = I18N.getLang();
  const pick = (o) => (o && (o[lang] || o.en)) || '';
  const from = DM.params.get('from') || '';
  const to = DM.params.get('to') || '';

  const ICONS = {
    globe: '<circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3Z" />',
    lang: '<path d="M4 6h9M8.5 4v2M5.5 6c.4 2.8 2.3 5.3 5.5 7M11.5 6c-.4 2.8-2.6 5.4-6.2 7.2" /><path d="M13 20l3.5-9 3.5 9M14.2 17h4.6" />',
    clock: '<circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.2 2" />',
    list: '<path d="M5 6.5h14M5 12h14M5 17.5h14" />',
    star: '<path d="M12 3.5l2.5 5.2 5.7.8-4.1 4 1 5.7-5.1-2.7-5.1 2.7 1-5.7-4.1-4 5.7-.8L12 3.5Z" />',
    shield: '<path d="M12 3.5l7 2.6v5.4c0 4.2-2.9 7.3-7 9-4.1-1.7-7-4.8-7-9V6.1l7-2.6Z" /><path d="M9 12l2.2 2.2L15.2 10" />',
    tool: '<path d="M14.5 5.5a4 4 0 0 0-5 5L4 16l4 4 5.5-5.5a4 4 0 0 0 5-5l-2.7 2.7-2.6-.7-.7-2.6 2.7-2.7Z" />',
  };
  const svg = (name) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.7');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.innerHTML = ICONS[name] || ICONS.star; // fixed markup from this file, never user text
    return s;
  };

  const entries = WHATS_NEW.between(from, to);
  const latest = entries[0] || WHATS_NEW.ENTRIES.find((e) => e.version === to) || WHATS_NEW.ENTRIES[0];
  document.getElementById('wnTitle').textContent = t('What’s new in VDM {v}', { v: DM.v(latest ? latest.version : to) });
  document.getElementById('wnSub').textContent = latest && latest.date ? DM.dateTime(Date.parse(latest.date), { hour: undefined, minute: undefined, hour12: undefined }) : '';

  const body = document.getElementById('wnBody');
  const list = entries.length ? entries : latest ? [latest] : [];
  for (const e of list) {
    if (list.length > 1) body.append(el('div', { class: 'wn-version', text: t('Version {v}', { v: DM.v(e.version) }) }));
    for (const it of e.items) {
      body.append(
        el('div', { class: 'wn-item' }, el('span', { class: 'wn-ic' }, svg(it.icon)), el('div', {}, el('div', { class: 'wn-it', text: pick(it.title) }), el('div', { class: 'wn-tx', text: pick(it.text) })))
      );
    }
  }

  document.getElementById('wnOk').addEventListener('click', () => api.invoke('window:close'));
  document.getElementById('wnNotes').addEventListener('click', () => api.invoke('shell:openProject', 'releases'));
  document.addEventListener('keydown', (e) => (e.key === 'Escape' || e.key === 'Enter') && api.invoke('window:close'));
  document.getElementById('wnOk').focus();
})();
