// Design mock-ups of the Torrents tab, drawn with the app's real HTML/CSS (nothing is added to the app).
const {chromium}=require('playwright');const root='/home/user/download-manager/src/renderer/';const out=process.argv[2];const theme=process.argv[3]||'light';
const MAGNET='<svg class="nav-ic" viewBox="0 0 24 24" aria-hidden="true"><path class="ic-bg" d="M3 8h5v5a4 4 0 0 0 8 0V8h5v5a9 9 0 0 1-18 0Z"/><path class="ic-fg" d="M3 3h5v5H3ZM16 3h5v5h-5Z"/></svg>';
const CSS=`
.tz-chips{display:flex;gap:6px;padding:12px 16px 0;align-items:center}
.chip{height:26px;padding:0 11px;border-radius:13px;border:1px solid var(--stroke);font-size:12px;font-weight:600;color:var(--text-2);display:flex;align-items:center;background:var(--field)}
.chip.on{background:var(--select);color:var(--text);border-color:var(--stroke)}
.tz-sp{flex:1}
.tz-sel{height:26px;padding:0 10px;border-radius:5px;border:1px solid var(--stroke);font-size:12px;color:var(--text-2);display:flex;align-items:center;gap:6px;background:var(--field)}
.tz-seg{display:flex;gap:4px;padding:12px 16px 0}
.seg{height:30px;padding:0 14px;border-radius:6px;font-size:13px;font-weight:600;color:var(--nav-text);display:flex;align-items:center;gap:7px;border:1px solid transparent}
.seg.on{background:var(--surface);border-color:var(--stroke);color:var(--nav-active);box-shadow:0 1px 3px rgba(0,0,0,.05)}
.seg b{font-size:11px;color:var(--text-3)}
.tz-empty{position:absolute;inset:44px 0 0 0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:6px}
.tz-empty .mag{width:64px;height:64px;border-radius:18px;background:color-mix(in srgb,var(--blue) 10%,transparent);display:grid;place-items:center;margin-bottom:8px}
.tz-empty .mag svg{width:34px;height:34px}
.tz-empty .mag .ic-bg{fill:#a4daff}.tz-empty .mag .ic-fg{fill:#158aff}
.tz-empty h3{margin:0;font-size:15px;font-weight:700;color:var(--text)}
.tz-empty p{margin:0;font-size:12px;color:var(--text-3);max-width:380px;line-height:1.5}
.tz-acts{display:flex;gap:8px;margin-top:12px}
.tz-list{padding:6px 8px;position:absolute;inset:78px 0 0 0;overflow:hidden}
.tr{position:relative;height:54px;border-radius:5px;display:flex;align-items:center;gap:10px;padding:0 10px}
.tr.sel{background:var(--select)}
.tr .ci{width:20px;height:13px;border-radius:2px;flex:none}
.tr .nm{font-size:12px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tr .meta{margin-top:3px;font-size:11px;color:var(--text-3);display:flex;gap:10px;font-weight:500}
.tr .meta .s{color:var(--green-text);font-weight:700}.tr .meta .l{color:#e8890c;font-weight:700}
.tr .grow{flex:1;min-width:0}
.dlb{height:26px;padding:0 12px;border-radius:5px;background:var(--blue-btn);color:#fff;font-size:12px;font-weight:600;display:flex;align-items:center;gap:6px;box-shadow:0 0 0 1px var(--btn-ring)}
.dlb.ghost{background:transparent;color:var(--link);box-shadow:none;border:1px solid var(--stroke)}
.pill{height:20px;padding:0 8px;border-radius:10px;font-size:10px;font-weight:700;display:flex;align-items:center}
.pill.dl{background:rgba(30,131,241,.12);color:var(--blue)}.pill.sd{background:rgba(18,190,66,.14);color:var(--green-text)}.pill.pa{background:rgba(127,127,127,.15);color:var(--text-3)}
.tcard{position:relative;height:84px;border-radius:5px;padding:10px 12px}
.tcard .top{display:flex;align-items:center;gap:10px}
.tcard .bar{position:relative;height:4px;margin:10px 0 8px;background:var(--track);border-radius:2px;overflow:hidden}
.tcard .bar i{position:absolute;inset:0 auto 0 0;background:var(--green)}
.tcard .st{display:flex;gap:14px;font-size:11px;font-weight:700;color:var(--text-3)}
.tcard .st .d{color:var(--blue)}.tcard .st .u{color:#9c50ff}
.bar.idle i{background:var(--paused)}
.fl{margin:10px 24px 0;border:1px solid var(--stroke);border-radius:6px;background:var(--field);overflow:hidden}
.fl .r{display:flex;align-items:center;gap:10px;height:30px;padding:0 10px;font-size:12px;color:var(--text);border-top:1px solid var(--line)}
.fl .r:first-child{border-top:0;background:var(--hover);font-weight:700}
.fl .r .sz{margin-left:auto;color:var(--text-3);font-size:11px}
.fl .r.in{padding-left:30px}
.cb{width:14px;height:14px;border-radius:3px;border:1.5px solid var(--stroke);flex:none}.cb.on{background:var(--blue);border-color:var(--blue)}
.note{position:absolute;left:24px;right:24px;font-size:11px;color:var(--text-3);line-height:1.5}
`;
(async()=>{const b=await chromium.launch();
async function page(file,w,h){const p=await b.newPage({viewport:{width:w,height:h},deviceScaleFactor:2});
await p.addInitScript(()=>{window.api={invoke:async(c)=>c==='settings:get'?{theme:'light',queues:[],proxy:{}}:c==='app:info'?{version:'0.2.0'}:c==='downloads:list'?[]:c==='queue:state'?{running:false,queues:{}}:null,on(){}};});
await p.goto('file://'+root+file+'?theme='+theme);await p.waitForTimeout(500);await p.addStyleTag({content:CSS});return p}
const nav=async p=>{await p.evaluate((M)=>{const n=document.querySelector('.nav');const it=document.createElement('button');it.className='nav-item';it.dataset.view='torrents';it.innerHTML=M+'<span>Torrents</span><b class="badge">3</b>';n.insertBefore(it,n.querySelector('[data-view=settings]'));
for(const x of document.querySelectorAll('.nav-item'))x.classList.toggle('active',x.dataset.view==='torrents');document.getElementById('addLink').querySelector('span').textContent='Add Link';
for(const v of document.querySelectorAll('.view'))v.hidden=true;},MAGNET)};
const card=(p,html,placeholder)=>p.evaluate(([h,ph])=>{const c=document.getElementById('card');c.insertAdjacentHTML('beforeend','<div class="view" id="view-torrents">'+h+'</div>');if(ph)document.getElementById('searchInput').placeholder=ph;},[html,placeholder]);
const CAT={video:'#9c50ff',audio:'#fe3440',soft:'#254d78',zip:'#ffc447',book:'#12be42'};
const row=(c,n,sz,s,l,age,src,sel)=>`<div class="tr${sel?' sel':''}"><i class="ci" style="background:${CAT[c]}"></i><div class="grow"><div class="nm">${n}</div><div class="meta"><span>${sz}</span><span class="s">▲ ${s}</span><span class="l">▼ ${l}</span><span>${age}</span><span>${src}</span></div></div>${sel?'<span class="dlb">↓ Download</span>':'<span class="dlb ghost">↓</span>'}</div>`;
const seg=(a,n)=>`<div class="tz-seg"><span class="seg ${a==='s'?'on':''}">Search</span><span class="seg ${a==='m'?'on':''}">My torrents <b>${n}</b></span></div>`;
const chips=(on)=>`<div class="tz-chips">${['All','Video','Music','Software','Books','Games'].map(c=>`<span class="chip ${c===on?'on':''}">${c}</span>`).join('')}<span class="tz-sp"></span><span class="tz-sel">Source: All ▾</span><span class="tz-sel">Sort: Seeders ▾</span></div>`;

// A: search home
let p=await page('main.html',800,480);await nav(p);
await card(p,seg('s',3)+chips('All')+`<div class="tz-empty" style="inset:78px 0 0 0"><div class="mag">${MAGNET}</div><h3>Search for torrents</h3><p>Type a name in the search box above, or paste a magnet link. VDM shows the results from your chosen sources and downloads the files you pick.</p><div class="tz-acts"><span class="dlb ghost">Paste magnet link</span><span class="dlb ghost">Open .torrent file…</span></div></div>`,'Search torrents…');
await p.screenshot({path:`${out}/t1-search-${theme}.png`});await p.close();
// B: results
p=await page('main.html',800,480);await nav(p);
await p.evaluate(()=>{document.getElementById('searchInput').value='ubuntu 24.04'});
await card(p,seg('s',3)+chips('Software')+`<div class="tz-list">${[
 ['soft','ubuntu-24.04.1-desktop-amd64.iso','5.9 GB',2841,63,'2 months ago','Linux distros',1],
 ['soft','ubuntu-24.04.1-live-server-amd64.iso','2.6 GB',1203,21,'2 months ago','Linux distros',0],
 ['soft','ubuntu-24.04-desktop-arm64.iso','5.8 GB',412,9,'5 months ago','Linux distros',0],
 ['soft','Ubuntu 24.04 LTS Noble — all flavours (pack)','28.4 GB',187,34,'6 months ago','Archive',0],
 ['book','Ubuntu Server Guide 24.04 (PDF)','12 MB',64,2,'1 year ago','Archive',0]].map(a=>row(...a)).join('')}</div><div class="note" style="bottom:8px;left:16px">5 of 24 results · searched 2 sources in 1.2 s</div>`,'Search torrents…');
await p.screenshot({path:`${out}/t2-results-${theme}.png`});await p.close();
// C: choose files dialog
p=await page('dialog.html',580,520);
await p.evaluate(()=>{for(const e of document.querySelectorAll('.pane'))e.hidden=true;document.getElementById('title').textContent='Download Torrent';document.title='Download Torrent'});
await p.evaluate(()=>{const d=document.createElement('div');d.className='page';d.style.cssText='position:absolute;inset:32px 0 0 0';d.innerHTML=`
<div style="position:absolute;left:24px;right:24px;top:20px;display:flex;gap:12px;align-items:center"><i class="tr ci" style="display:block;width:50px;height:32px;border-radius:5px;background:#254d78;flex:none"></i><div style="min-width:0"><div style="font-size:14px;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">ubuntu-24.04.1-desktop-amd64.iso</div><div style="font-size:12px;color:var(--text-3);margin-top:3px">5.9 GB · <span style="color:var(--green-text);font-weight:700">▲ 2,841</span> seeders · <span style="color:#e8890c;font-weight:700">▼ 63</span> peers</div></div></div>
<div class="fl" style="position:absolute;left:0;right:0;top:78px;margin:0 24px">
<div class="r"><i class="cb on"></i><span>3 of 4 files selected</span><span class="sz">5.93 GB</span></div>
<div class="r in"><i class="cb on"></i>ubuntu-24.04.1-desktop-amd64.iso<span class="sz">5.90 GB</span></div>
<div class="r in"><i class="cb on"></i>SHA256SUMS<span class="sz">1 KB</span></div>
<div class="r in"><i class="cb on"></i>SHA256SUMS.gpg<span class="sz">1 KB</span></div>
<div class="r in"><i class="cb"></i>README.diskdefines<span class="sz">1 KB</span></div></div>
<div class="folder-field at" style="left:24px;right:24px;top:246px"><img src="assets/icons/folder.svg" alt=""><div class="path">C:\\Users\\You\\Downloads\\Torrents</div><div class="browse">Browse...</div></div>
<div style="position:absolute;left:24px;right:24px;top:292px;display:flex;flex-direction:column;gap:9px;font-size:12px;color:var(--text-2)"><label style="display:flex;gap:9px;align-items:center"><i class="cb on"></i>Keep sharing after the download finishes (seeding)</label><label style="display:flex;gap:9px;align-items:center"><i class="cb"></i>Limit upload speed to <b style="color:var(--text)">200 KB/s</b></label></div>
<div class="note" style="top:368px;color:var(--text-3)">Torrents upload to other people while they download. Only download what you have the right to.</div>
<button class="btn btn-outline text-only at" style="left:24px;bottom:24px">Download Later</button>
<button class="btn btn-primary at" style="right:24px;bottom:24px"><img src="assets/icons/btn-download.svg" alt=""><span>Download</span></button>`;document.body.append(d)});
await p.screenshot({path:`${out}/t3-files-${theme}.png`});await p.close();
// D: my torrents
p=await page('main.html',800,480);await nav(p);
await card(p,seg('m',3)+`<div class="tz-list" style="inset:50px 0 0 0">${[
 ['ubuntu-24.04.1-desktop-amd64.iso','dl',62,'↓ 8.4 MB/s','↑ 1.1 MB/s','184 peers','3.66 / 5.90 GB','00:04:31'],
 ['Blender Open Movie — Sprite Fright (4K)','sd',100,'↓ 0','↑ 640 KB/s','12 peers','Ratio 1.8','Seeding'],
 ['archlinux-2026.11.01-x86_64.iso','pa',27,'↓ 0','↑ 0','Paused','0.77 / 1.10 GB','—']].map((t,i)=>`<div class="tcard${i===0?' tr sel':''}" style="${i===0?'background:var(--select);display:block;height:84px':''}"><div class="top"><i class="ci" style="width:20px;height:13px;border-radius:2px;background:#254d78"></i><div class="nm grow" style="font-size:12px;color:var(--text)">${t[0]}</div><span class="pill ${t[1]}">${t[1]==='dl'?'Downloading':t[1]==='sd'?'Seeding':'Paused'}</span></div><div class="bar ${t[1]==='pa'?'idle':''}"><i style="width:${t[2]}%"></i></div><div class="st"><span class="d">${t[3]}</span><span class="u">${t[4]}</span><span>${t[5]}</span><span style="margin-left:auto">${t[6]}</span><span>${t[7]}</span></div></div>`).join('')}</div>`,'Search torrents…');
await p.screenshot({path:`${out}/t4-mine-${theme}.png`});await p.close();
await b.close();})().catch(e=>{console.error(e);process.exit(1)});
