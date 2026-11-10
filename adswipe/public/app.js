'use strict';
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem('adswipe.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('adswipe.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
  };

  async function api(path, opts = {}) {
    const init = { method: opts.method || 'GET', headers: {} };
    if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); init.headers['content-type'] = 'application/json'; }
    const r = await fetch(path, init);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || `Request failed (${r.status})`); e.code = j.code; e.status = r.status; throw e; }
    return j;
  }
  function toast(msg, bad = false, ms = 3500) {
    const el = document.createElement('div');
    el.className = 'toast' + (bad ? ' bad' : ''); el.textContent = msg;
    $('#toasts').append(el); setTimeout(() => el.remove(), ms);
  }
  const fmt = (t) => {
    if (!Number.isFinite(t)) return '0:00';
    t = Math.max(0, t); const m = Math.floor(t / 60), s = Math.floor(t % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  };
  const fmtDate = (iso) => { if (!iso) return ''; const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); };
  const proxy = (u) => '/api/proxy?u=' + encodeURIComponent(u);

  // ---------- state ----------
  const state = {
    settings: { hasToken: false, country: 'US' },
    ads: [], next: null, loading: false, lastSearch: null,
    items: [], folder: null, pollTimer: null, swipeShown: 60,
  };

  // ---------- tabs ----------
  function showView(name) {
    for (const v of ['discover', 'swipe']) $('#' + v).hidden = v !== name;
    for (const t of document.querySelectorAll('.tab')) t.classList.toggle('is-on', t.dataset.view === name);
    store.set('view', name);
    if (name === 'swipe') loadSwipe();
  }
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showView(t.dataset.view)));

  // ---------- Discover ----------
  // Poster previews resolve a few at a time, only for cards that scroll into view.
  const queue = []; let active = 0;
  function enqueue(fn) { queue.push(fn); pump(); }
  function pump() {
    while (active < 3 && queue.length) {
      const fn = queue.shift(); active++;
      fn().catch(() => {}).finally(() => { active--; pump(); });
    }
  }
  const cardObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      cardObserver.unobserve(e.target);
      const ad = state.ads.find((a) => a.id === e.target.dataset.id);
      if (ad && !ad._media && !ad._tried) enqueue(() => loadAdMedia(ad, e.target));
    }
  }, { rootMargin: '300px' });

  async function ensureMedia(ad) {
    if (ad._media) return ad._media;
    ad._tried = true;
    const q = new URLSearchParams({ id: ad.id });
    if (ad.snapshotUrl) q.set('snapshot', ad.snapshotUrl);
    ad._media = await api('/api/media?' + q);
    return ad._media;
  }
  async function loadAdMedia(ad, card) {
    const thumb = card.querySelector('.thumb');
    try {
      const m = await ensureMedia(ad);
      const src = m.posterUrl;
      if (src) thumb.innerHTML = `<img alt="" decoding="async" src="${esc(proxy(src))}">`;
      else thumb.textContent = 'No preview';
      thumb.insertAdjacentHTML('beforeend', `<span class="badge">${m.videoUrl ? 'Video' : 'Image'}</span>${m.videoUrl ? '<span class="playmark"></span>' : ''}`);
      if (!m.videoUrl) card.dataset.novideo = '1';
    } catch {
      thumb.textContent = 'Preview unavailable';
    }
    applyVideoOnly();
  }
  function applyVideoOnly() {
    const only = $('#videoOnly').checked;
    document.querySelectorAll('#discoverGrid .card').forEach((c) => c.classList.toggle('is-hidden', only && c.dataset.novideo === '1'));
  }
  $('#videoOnly').checked = store.get('videoOnly', false);
  $('#videoOnly').addEventListener('change', () => { store.set('videoOnly', $('#videoOnly').checked); applyVideoOnly(); });

  function adCard(ad) {
    const saved = state.items.some((i) => i.adId === ad.id);
    const el = document.createElement('article');
    el.className = 'card'; el.tabIndex = 0; el.dataset.id = ad.id;
    el.innerHTML = `<div class="thumb">Loading…</div>
      <div class="card-b"><div class="page">${esc(ad.pageName || 'Unknown page')}</div>
      <div class="copy">${esc(ad.text || ad.title || '')}</div>
      <div class="meta"><span>${esc(fmtDate(ad.startedAt))}</span>${saved ? '<span class="pill ok">Saved</span>' : ''}</div></div>`;
    el.addEventListener('click', () => openViewer({ ad }));
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') openViewer({ ad }); });
    return el;
  }

  async function search(append = false) {
    if (state.loading) return;
    const params = append && state.lastSearch ? { ...state.lastSearch } : { q: $('#q').value.trim(), country: $('#country').value.trim() || 'US', status: $('#status').value };
    if (!append && !params.q) { toast('Type something to search for.', true); return; }
    state.loading = true; $('#discoverStatus').textContent = 'Searching…';
    try {
      const q = new URLSearchParams(params);
      if (append && state.next) q.set('after', state.next);
      const r = await api('/api/search?' + q);
      state.lastSearch = params; state.next = r.next;
      if (!append) { state.ads = []; $('#discoverGrid').innerHTML = ''; }
      state.ads.push(...r.ads);
      const frag = document.createDocumentFragment();
      for (const ad of r.ads) { const c = adCard(ad); frag.append(c); cardObserver.observe(c); }
      $('#discoverGrid').append(frag);
      $('#loadMore').hidden = !state.next;
      $('#discoverStatus').textContent = `${state.ads.length} ads`;
      $('#discoverEmpty').innerHTML = state.ads.length ? '' : `<strong>No ads came back</strong>Meta's official API only returns political and social-issue ads, plus every ad shown in EU countries. Try a country like DE or FR, or use “+ Add ad” to paste any ad's link.`;
      applyVideoOnly();
    } catch (e) {
      $('#discoverStatus').textContent = '';
      if (e.code === 'no_token') { toast(e.message, true); openSettings(); } else toast(e.message, true, 6000);
    } finally { state.loading = false; }
  }
  $('#searchForm').addEventListener('submit', (e) => { e.preventDefault(); search(false); });
  $('#loadMore').addEventListener('click', () => search(true));

  function renderDiscoverEmpty() {
    if (state.ads.length) return;
    $('#discoverEmpty').innerHTML = state.settings.hasToken
      ? `<strong>Search the Ad Library</strong>Type a brand or topic above. To save an ad from anywhere on Facebook, use “+ Add ad” and paste its link.`
      : `<strong>Start by adding an ad</strong>Click “+ Add ad” and paste an Ad Library link, or drop a video file here. To search inside this app, add your Meta access token in Settings (⚙).`;
  }

  // ---------- Swipe file ----------
  async function loadSwipe() {
    try { state.items = (await api('/api/swipe')).items; } catch (e) { toast(e.message, true); return; }
    renderSwipe();
    schedulePoll();
  }
  function schedulePoll() {
    clearTimeout(state.pollTimer);
    if (state.items.some((i) => i.status === 'saving')) state.pollTimer = setTimeout(loadSwipe, 1500);
  }
  function filteredItems() {
    const f = $('#swipeFilter').value.trim().toLowerCase(), tag = $('#tagFilter').value;
    return state.items.filter((i) => {
      if (state.folder === '__none' ? i.folder : state.folder && i.folder !== state.folder) return false;
      if (tag && !i.tags.includes(tag)) return false;
      if (!f) return true;
      return [i.title, i.pageName, i.text, i.notes, i.folder, ...i.tags].join(' ').toLowerCase().includes(f);
    });
  }
  function renderSwipe() {
    $('#swipeCount').textContent = state.items.length;
    // folder chips + tag select
    const folders = [...new Set(state.items.map((i) => i.folder).filter(Boolean))].sort();
    const chip = (key, label) => `<button class="chip${state.folder === key ? ' is-on' : ''}" data-f="${esc(key ?? '')}">${esc(label)}</button>`;
    $('#folderChips').innerHTML = state.items.length ? chip(null, `All (${state.items.length})`) + folders.map((f) => chip(f, `${f} (${state.items.filter((i) => i.folder === f).length})`)).join('') + (state.items.some((i) => !i.folder) && folders.length ? chip('__none', 'No folder') : '') : '';
    const tags = [...new Set(state.items.flatMap((i) => i.tags))].sort(); const cur = $('#tagFilter').value;
    $('#tagFilter').innerHTML = '<option value="">All tags</option>' + tags.map((t) => `<option${t === cur ? ' selected' : ''}>${esc(t)}</option>`).join('');

    const list = filteredItems(); const grid = $('#swipeGrid'); grid.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (const it of list.slice(0, state.swipeShown)) {
      const el = document.createElement('article');
      el.className = 'card'; el.tabIndex = 0;
      const poster = it.posterFile ? `<img alt="" loading="lazy" decoding="async" src="/files/posters/${esc(it.posterFile)}">` : '<span>No preview</span>';
      const pill = it.status === 'saving' ? '<span class="pill busy">Downloading…</span>' : it.status === 'error' ? `<span class="pill err" title="${esc(it.error || '')}">Failed</span>` : '';
      el.innerHTML = `<div class="thumb">${poster}${it.status === 'ready' ? '<span class="playmark"></span>' : ''}</div>
        <div class="card-b"><div class="page">${esc(it.title)}</div>
        <div class="copy">${esc(it.text || it.notes || '')}</div>
        <div class="meta">${pill}${it.folder ? `<span class="pill">${esc(it.folder)}</span>` : ''}${it.marks.length ? `<span class="pill">${it.marks.length} mark${it.marks.length > 1 ? 's' : ''}</span>` : ''}</div></div>`;
      const open = () => openViewer({ item: it });
      el.addEventListener('click', open); el.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
      frag.append(el);
    }
    grid.append(frag);
    $('#swipeMore').hidden = list.length <= state.swipeShown;
    $('#swipeEmpty').innerHTML = state.items.length ? (list.length ? '' : '<strong>Nothing matches</strong>Clear the filter to see everything.')
      : '<strong>Your swipe file is empty</strong>Open any ad and press Save (or S). Videos are downloaded to this computer, so they play instantly and never expire.';
  }
  $('#folderChips').addEventListener('click', (e) => {
    const b = e.target.closest('.chip'); if (!b) return;
    state.folder = b.dataset.f === '' ? null : b.dataset.f; state.swipeShown = 60; renderSwipe();
  });
  $('#swipeFilter').addEventListener('input', () => { state.swipeShown = 60; renderSwipe(); });
  $('#tagFilter').addEventListener('change', () => { state.swipeShown = 60; renderSwipe(); });
  $('#swipeMore').addEventListener('click', () => { state.swipeShown += 60; renderSwipe(); });

  // ---------- Viewer / player ----------
  const dlg = $('#viewer'), vid = $('#vid');
  const cur = { ad: null, item: null, marks: [], media: null, token: 0 };
  let scrubbing = false, raf = 0;

  const duration = () => (Number.isFinite(vid.duration) ? vid.duration : 0);
  function setPlayIcon() {
    const b = $('#bPlay'); b.textContent = vid.paused ? '▶' : '❚❚'; b.setAttribute('aria-label', vid.paused ? 'Play' : 'Pause');
  }
  function paintProgress() {
    const d = duration(), t = vid.currentTime;
    $('#played').style.width = d ? (t / d) * 100 + '%' : '0';
    $('#time').textContent = `${fmt(t)} / ${fmt(d)}`;
    $('#scrub').setAttribute('aria-valuenow', Math.round(t));
  }
  function paintBuffered() {
    const d = duration(), b = vid.buffered; let end = 0;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= vid.currentTime + 0.5 && b.end(i) >= end) end = b.end(i);
    $('#buffered').style.width = d ? (end / d) * 100 + '%' : '0';
  }
  function loop() { paintProgress(); if (!vid.paused) raf = requestAnimationFrame(loop); }
  function seekTo(t) {
    const d = duration(); if (!d) return;
    vid.currentTime = Math.min(Math.max(0, t), d); paintProgress();
  }
  const skip = (dt) => seekTo(vid.currentTime + dt);
  function togglePlay() { if (vid.paused) vid.play().catch(() => {}); else vid.pause(); }
  function step(dir) { vid.pause(); skip(dir / 30); }

  vid.addEventListener('play', () => { setPlayIcon(); cancelAnimationFrame(raf); raf = requestAnimationFrame(loop); });
  vid.addEventListener('pause', () => { setPlayIcon(); paintProgress(); });
  vid.addEventListener('ended', () => { setPlayIcon(); });
  vid.addEventListener('timeupdate', paintProgress);
  vid.addEventListener('progress', paintBuffered);
  vid.addEventListener('seeked', paintBuffered);
  vid.addEventListener('loadedmetadata', () => { paintProgress(); renderTicks(); });
  vid.addEventListener('durationchange', () => { paintProgress(); renderTicks(); });
  vid.addEventListener('waiting', () => { $('#spinner').hidden = false; });
  for (const ev of ['playing', 'canplay', 'seeked']) vid.addEventListener(ev, () => { $('#spinner').hidden = true; });
  vid.addEventListener('error', () => {
    if (!vid.getAttribute('src')) return;
    showPlayerMsg('This video could not be played. Facebook links expire; if it was an old link, add the ad again.');
  });
  vid.addEventListener('click', togglePlay);
  vid.addEventListener('dblclick', toggleFull);
  function showPlayerMsg(msg) { const m = $('#playerMsg'); m.textContent = msg || ''; m.hidden = !msg; $('#spinner').hidden = true; }
  function toggleFull() {
    const el = $('#player');
    if (document.fullscreenElement) document.exitFullscreen(); else el.requestFullscreen?.().catch(() => {});
  }

  // scrubbing with pointer events: drag anywhere on the bar, preview time on hover
  const scrub = $('#scrub');
  const fracAt = (e) => { const r = $('.rail', scrub).getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)); };
  scrub.addEventListener('pointerdown', (e) => { scrubbing = true; scrub.classList.add('is-drag'); scrub.setPointerCapture(e.pointerId); seekTo(fracAt(e) * duration()); });
  scrub.addEventListener('pointermove', (e) => {
    const f = fracAt(e), tip = $('#tip'); tip.textContent = fmt(f * duration()); tip.style.left = f * 100 + '%';
    if (scrubbing) seekTo(f * duration());
  });
  const endScrub = () => { scrubbing = false; scrub.classList.remove('is-drag'); };
  scrub.addEventListener('pointerup', endScrub); scrub.addEventListener('pointercancel', endScrub);
  scrub.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft') { skip(-5); e.preventDefault(); e.stopPropagation(); } if (e.key === 'ArrowRight') { skip(5); e.preventDefault(); e.stopPropagation(); } });

  $('#bPlay').addEventListener('click', togglePlay);
  $('#bBack').addEventListener('click', () => skip(-10));
  $('#bFwd').addEventListener('click', () => skip(10));
  $('#bFrameBack').addEventListener('click', () => step(-1));
  $('#bFrameFwd').addEventListener('click', () => step(1));
  $('#bFull').addEventListener('click', toggleFull);
  $('#bMark').addEventListener('click', addMark);
  $('#speed').value = String(store.get('speed', 1));
  const setSpeed = (v) => { vid.playbackRate = v; $('#speed').value = String(v); store.set('speed', v); };
  $('#speed').addEventListener('change', () => setSpeed(+$('#speed').value));
  function nudgeSpeed(dir) {
    const opts = [...$('#speed').options].map((o) => +o.value); const i = opts.indexOf(+$('#speed').value);
    const n = opts[Math.min(opts.length - 1, Math.max(0, i + dir))]; setSpeed(n); toast(`Speed ${n}×`, false, 900);
  }
  $('#bLoop').addEventListener('click', toggleLoop);
  function toggleLoop() { vid.loop = !vid.loop; $('#bLoop').setAttribute('aria-pressed', String(vid.loop)); }
  const setVol = (v) => { vid.volume = v; vid.muted = v === 0; $('#vol').value = v; store.set('vol', v); paintMute(); };
  function paintMute() { $('#bMute').textContent = vid.muted || vid.volume === 0 ? '🔇' : '🔊'; }
  $('#bMute').addEventListener('click', () => { vid.muted = !vid.muted; paintMute(); });
  $('#vol').addEventListener('input', () => setVol(+$('#vol').value));
  setVol(store.get('vol', 1));

  document.addEventListener('keydown', (e) => {
    if (!dlg.open || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && e.target.type !== 'range') return;
    const k = e.key; let used = true;
    if (k === ' ' || k === 'k') togglePlay();
    else if (k === 'j') skip(-10); else if (k === 'l') skip(10);
    else if (k === 'ArrowLeft') skip(-5); else if (k === 'ArrowRight') skip(5);
    else if (k === 'ArrowUp') setVol(Math.min(1, vid.volume + 0.1)); else if (k === 'ArrowDown') setVol(Math.max(0, vid.volume - 0.1));
    else if (k === ',') step(-1); else if (k === '.') step(1);
    else if (k === '[') nudgeSpeed(-1); else if (k === ']') nudgeSpeed(1);
    else if (k === 'm') { vid.muted = !vid.muted; paintMute(); }
    else if (k === 'f') toggleFull(); else if (k === 'r') toggleLoop();
    else if (k === 'n') addMark(); else if (k === 's') saveCurrent();
    else if (/^[0-9]$/.test(k)) seekTo((+k / 10) * duration());
    else if (k === 'Home') seekTo(0); else if (k === 'End') seekTo(duration());
    else used = false;
    if (used) e.preventDefault();
  });

  // marks: timestamped notes ("hook lands at 0:03")
  function renderTicks() {
    const d = duration(); $('#ticks').innerHTML = d ? cur.marks.map((m) => `<span class="tick" style="left:${(m.t / d) * 100}%" title="${esc(fmt(m.t) + ' ' + m.label)}"></span>`).join('') : '';
  }
  let marksTimer;
  function persistMarks() {
    renderTicks();
    if (!cur.item) return;
    clearTimeout(marksTimer);
    const id = cur.item.id, marks = cur.marks;
    marksTimer = setTimeout(() => api('/api/swipe/' + id, { method: 'PATCH', body: { marks } }).catch((e) => toast(e.message, true)), 500);
  }
  function addMark() {
    if (!vid.getAttribute('src')) return;
    cur.marks.push({ t: Math.round(vid.currentTime * 10) / 10, label: '' });
    cur.marks.sort((a, b) => a.t - b.t);
    persistMarks(); renderPanel();
    const idx = cur.marks.findIndex((m) => m.label === '');
    document.querySelectorAll('#marks .mark input')[idx]?.focus();
  }

  // Edits to title/folder/tags/notes merge into one pending save, so quickly
  // tabbing between fields never drops an earlier change.
  let pendingPatch = null, patchTimer;
  function queuePatch(item, body) {
    if (pendingPatch && pendingPatch.item !== item) flushPatch();
    pendingPatch = pendingPatch || { item, body: {} };
    Object.assign(pendingPatch.body, body);
    clearTimeout(patchTimer); patchTimer = setTimeout(flushPatch, 500);
  }
  function flushPatch() {
    clearTimeout(patchTimer);
    if (!pendingPatch) return Promise.resolve();
    const { item, body } = pendingPatch; pendingPatch = null;
    return api('/api/swipe/' + item.id, { method: 'PATCH', body })
      .then((r) => { Object.assign(item, r.item); renderSwipe(); })
      .catch((e) => toast(e.message, true));
  }

  // side panel
  function renderPanel() {
    const it = cur.item, ad = cur.ad || {};
    const folders = [...new Set(state.items.map((i) => i.folder).filter(Boolean))];
    const marksHtml = `<div><label>Marks <span class="muted">(press N while watching)</span></label><div class="marks" id="marks">${cur.marks.map((m, i) =>
      `<div class="mark"><button class="jump" data-i="${i}">${fmt(m.t)}</button><input type="text" data-i="${i}" value="${esc(m.label)}" placeholder="What happens here?" aria-label="Mark note"><button class="del" data-i="${i}" aria-label="Delete mark">✕</button></div>`).join('') || '<span class="muted small">None yet.</span>'}</div></div>`;
    const links = [it?.adUrl || ad.adUrl ? `<a class="btn" href="${esc(it?.adUrl || ad.adUrl)}" target="_blank" rel="noopener">Open original ↗</a>` : '',
      it?.videoFile ? `<a class="btn" href="/files/videos/${esc(it.videoFile)}?download=1">Download</a>` : ''].join('');
    if (it) {
      $('#panel').innerHTML = `
        <div><label for="fTitle">Title</label><input type="text" id="fTitle" value="${esc(it.title)}"></div>
        ${it.status === 'saving' ? '<p class="pill busy">Downloading video to your computer…</p>' : ''}
        ${it.status === 'error' ? `<p class="err">${esc(it.error || 'Download failed')}</p>` : ''}
        <div class="row"><div style="flex:1;min-width:130px"><label for="fFolder">Folder</label><input type="text" id="fFolder" list="folderList" value="${esc(it.folder)}" placeholder="e.g. Hooks"><datalist id="folderList">${folders.map((f) => `<option value="${esc(f)}">`).join('')}</datalist></div>
        <div style="flex:1;min-width:130px"><label for="fTags">Tags</label><input type="text" id="fTags" value="${esc(it.tags.join(', '))}" placeholder="ugc, testimonial"></div></div>
        <div><label for="fNotes">Notes</label><textarea id="fNotes" placeholder="Why does this ad work?">${esc(it.notes)}</textarea></div>
        ${marksHtml}
        ${it.text ? `<div><label>Ad copy</label><div class="adtext">${esc(it.text)}</div></div>` : ''}
        <div class="row">${links}<button class="btn danger" id="pDelete">Remove</button></div>`;
      $('#fTitle').oninput = (e) => queuePatch(it, { title: e.target.value });
      $('#fFolder').oninput = (e) => queuePatch(it, { folder: e.target.value });
      $('#fTags').oninput = (e) => queuePatch(it, { tags: e.target.value });
      $('#fNotes').oninput = (e) => queuePatch(it, { notes: e.target.value });
      $('#pDelete').onclick = async () => {
        if ($('#pDelete').dataset.sure !== '1') { $('#pDelete').dataset.sure = '1'; $('#pDelete').textContent = 'Click again to remove'; return; }
        await api('/api/swipe/' + it.id, { method: 'DELETE' }).catch((e) => toast(e.message, true));
        closeViewer(); loadSwipe(); toast('Removed from swipe file');
      };
    } else {
      $('#panel').innerHTML = `
        <h3>${esc(ad.pageName || 'Ad')}</h3>
        <div class="muted small">${esc(fmtDate(ad.startedAt))} ${ad.platforms?.length ? '· ' + esc(ad.platforms.join(', ')) : ''}</div>
        <div class="row"><button class="btn primary" id="pSave">Save to swipe file (S)</button>${links}</div>
        <div><label for="fFolder">Folder (optional)</label><input type="text" id="fFolder" list="folderList" placeholder="e.g. Hooks"><datalist id="folderList">${folders.map((f) => `<option value="${esc(f)}">`).join('')}</datalist></div>
        ${marksHtml}
        ${ad.text ? `<div><label>Ad copy</label><div class="adtext">${esc(ad.text)}</div></div>` : ''}`;
      $('#pSave').onclick = saveCurrent;
    }
    $('#marks').onclick = (e) => {
      const i = +e.target.dataset.i;
      if (e.target.classList.contains('jump')) { seekTo(cur.marks[i].t); vid.play().catch(() => {}); }
      if (e.target.classList.contains('del')) { cur.marks.splice(i, 1); persistMarks(); renderPanel(); }
    };
    $('#marks').oninput = (e) => { if (e.target.matches('input')) { cur.marks[+e.target.dataset.i].label = e.target.value; persistMarks(); } };
  }

  let saving = false;
  async function saveCurrent() {
    if (cur.item || !cur.ad || saving) return;
    saving = true;
    const btn = $('#pSave'); if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      const ad = { ...cur.ad }; delete ad._media; delete ad._tried;
      const m = cur.media;
      if (m) { ad.videoUrl = m.videoUrl; ad.posterUrl = m.posterUrl; ad.pageName = ad.pageName || m.pageName; ad.text = ad.text || m.text; }
      const r = await api('/api/swipe', { method: 'POST', body: { ad, marks: cur.marks, folder: $('#fFolder')?.value || '' } });
      cur.item = r.item; cur.marks = r.item.marks;
      toast(r.duplicate ? 'Already in your swipe file' : 'Saved. Downloading the video in the background…');
      await loadSwipe(); cur.item = state.items.find((i) => i.id === r.item.id) || r.item; renderPanel();
      document.querySelectorAll('#discoverGrid .card').forEach((c) => { if (c.dataset.id === cur.ad.id && !c.querySelector('.pill.ok')) c.querySelector('.meta').insertAdjacentHTML('beforeend', '<span class="pill ok">Saved</span>'); });
    } catch (e) { toast(e.message, true, 6000); if (btn) { btn.disabled = false; btn.textContent = 'Save to swipe file (S)'; } }
    finally { saving = false; }
  }

  async function openViewer({ ad, item }) {
    const token = ++cur.token;
    cur.ad = ad || null; cur.item = item || null; cur.media = null;
    if (ad && !item) cur.item = state.items.find((i) => ad.id && i.adId === ad.id) || null;
    cur.marks = cur.item ? cur.item.marks.map((m) => ({ ...m })) : [];
    vid.pause(); vid.removeAttribute('src'); vid.load(); vid.loop = false; $('#bLoop').setAttribute('aria-pressed', 'false');
    showPlayerMsg(''); paintProgress(); renderTicks(); setPlayIcon(); vid.playbackRate = store.get('speed', 1);
    if (!dlg.open) dlg.showModal();
    renderPanel();

    if (cur.item && cur.item.videoFile) {
      vid.preload = 'auto'; vid.poster = cur.item.posterFile ? '/files/posters/' + cur.item.posterFile : '';
      vid.src = '/files/videos/' + cur.item.videoFile;
    } else if (cur.item && cur.item.status === 'saving') {
      showPlayerMsg('Still downloading. It will be ready in a moment.');
      const wait = setInterval(async () => {
        if (token !== cur.token || !dlg.open) return clearInterval(wait);
        await loadSwipe(); const fresh = state.items.find((i) => i.id === cur.item.id);
        if (fresh && fresh.status !== 'saving') { clearInterval(wait); if (token === cur.token) openViewer({ item: fresh }); }
      }, 1500);
    } else if (cur.item && cur.item.status === 'error') {
      showPlayerMsg(cur.item.error || 'This video failed to download.');
    } else if (ad) {
      $('#spinner').hidden = false; vid.preload = 'metadata';
      try {
        const m = ad.videoUrl ? ad : await ensureMedia(ad);
        if (token !== cur.token) return;
        cur.media = m;
        if (!cur.ad.pageName && m.pageName) cur.ad.pageName = m.pageName;
        if (!cur.ad.text && m.text) cur.ad.text = m.text;
        if (!m.videoUrl) { showPlayerMsg('This looks like an image ad, so there is no video to play.'); renderPanel(); return; }
        vid.poster = m.posterUrl ? proxy(m.posterUrl) : '';
        vid.src = proxy(m.videoUrl); renderPanel();
      } catch (e) { if (token === cur.token) showPlayerMsg(e.message); }
    }
    if (vid.getAttribute('src')) { vid.playbackRate = store.get('speed', 1); vid.play().catch(() => {}); }
  }
  function closeViewer() {
    flushPatch();
    cur.token++; vid.pause(); vid.removeAttribute('src'); vid.load();
    if (document.fullscreenElement) document.exitFullscreen();
    if (dlg.open) dlg.close();
  }
  dlg.addEventListener('close', () => { flushPatch(); cur.token++; vid.pause(); vid.removeAttribute('src'); vid.load(); renderSwipe(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) closeViewer(); });
  $('#closeViewer').addEventListener('click', closeViewer);

  // ---------- Add (link, id, files) ----------
  const addDlg = $('#addDlg');
  $('#addBtn').addEventListener('click', () => { $('#addErr').hidden = true; $('#addInput').value = ''; addDlg.showModal(); $('#addInput').focus(); });
  $('#addCancel').addEventListener('click', () => addDlg.close());
  $('#addForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = $('#addInput').value.trim(); if (!v) return;
    $('#addGo').disabled = true; $('#addGo').textContent = 'Looking…'; $('#addErr').hidden = true;
    try {
      const m = await api('/api/resolve', { method: 'POST', body: { input: v } });
      addDlg.close();
      const ad = { id: m.adId, pageName: m.pageName, text: m.text, adUrl: m.adUrl, videoUrl: m.videoUrl, posterUrl: m.posterUrl, _media: m };
      openViewer({ ad });
    } catch (err) { $('#addErr').textContent = err.message; $('#addErr').hidden = false; }
    finally { $('#addGo').disabled = false; $('#addGo').textContent = 'Open'; }
  });
  $('#fileInput').addEventListener('change', (e) => { const files = [...e.target.files]; e.target.value = ''; addDlg.close(); uploadFiles(files); });

  function grabPoster(file, id) {
    return new Promise((resolve) => {
      const v = document.createElement('video'); const url = URL.createObjectURL(file);
      const done = () => { URL.revokeObjectURL(url); resolve(); };
      v.muted = true; v.preload = 'auto'; v.src = url;
      v.onerror = done;
      v.onloadeddata = () => { v.currentTime = Math.min(1, (v.duration || 2) * 0.2); };
      v.onseeked = () => {
        try {
          const w = 480, h = Math.round(w * (v.videoHeight / v.videoWidth)) || 600;
          const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(v, 0, 0, w, h);
          c.toBlob((b) => b ? fetch('/api/poster/' + id, { method: 'POST', body: b }).finally(done) : done(), 'image/jpeg', 0.82);
        } catch { done(); }
      };
    });
  }
  function uploadOne(file) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest(); x.open('POST', '/api/upload?name=' + encodeURIComponent(file.name));
      x.onload = () => { try { const j = JSON.parse(x.responseText); x.status < 300 ? resolve(j.item) : reject(new Error(j.error)); } catch { reject(new Error('Upload failed')); } };
      x.onerror = () => reject(new Error('Upload failed')); x.send(file);
    });
  }
  async function uploadFiles(files) {
    files = files.filter((f) => /^video\//.test(f.type) || /\.(mp4|mov|m4v|webm)$/i.test(f.name));
    if (!files.length) { toast('Those do not look like video files.', true); return; }
    for (const f of files) {
      toast(`Adding ${f.name}…`);
      try { const item = await uploadOne(f); await grabPoster(f, item.id); } catch (e) { toast(`${f.name}: ${e.message}`, true, 6000); }
    }
    await loadSwipe(); showView('swipe'); toast('Added to your swipe file');
  }
  let dragDepth = 0;
  addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; $('#dropzone').hidden = false; } });
  addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#dropzone').hidden = true; });
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; $('#dropzone').hidden = true; if (e.dataTransfer?.files?.length) uploadFiles([...e.dataTransfer.files]); });

  // ---------- Settings ----------
  const sDlg = $('#settingsDlg');
  async function loadSettings() {
    state.settings = await api('/api/settings').catch(() => state.settings);
    $('#country').value = $('#country').value || state.settings.country;
    renderDiscoverEmpty();
  }
  function openSettings() {
    $('#tokenInput').value = ''; $('#countryInput').value = state.settings.country || 'US';
    $('#tokenState').textContent = state.settings.hasToken ? `A token is saved (${state.settings.tokenHint}${state.settings.fromEnv ? ', from META_TOKEN' : ''}). Leave blank to keep it.` : 'No token saved yet.';
    sDlg.showModal();
  }
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#settingsCancel').addEventListener('click', () => sDlg.close());
  $('#settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = { country: $('#countryInput').value }; if ($('#tokenInput').value.trim()) body.token = $('#tokenInput').value;
    try { await api('/api/settings', { method: 'POST', body }); sDlg.close(); await loadSettings(); toast('Settings saved'); } catch (err) { toast(err.message, true); }
  });

  // ---------- boot ----------
  (async () => {
    await loadSettings();
    try { state.items = (await api('/api/swipe')).items; renderSwipe(); schedulePoll(); } catch { /* shown later */ }
    renderDiscoverEmpty();
    showView(store.get('view', 'discover') === 'swipe' && state.items.length ? 'swipe' : 'discover');
  })();
})();
