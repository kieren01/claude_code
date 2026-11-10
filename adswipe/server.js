'use strict';
// Ad Swipe: a local, dependency-free replacement front end for the Facebook Ad Library.
// Run:  node server.js   then open http://localhost:4300

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { parseInput, extractFromHtml, isAllowedMediaUrl } = require('./lib/extract');

const PORT = Number(process.env.PORT) || 4300;
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = process.env.ADSWIPE_DATA || path.join(ROOT, 'data');
const VIDEOS = path.join(DATA, 'videos');
const POSTERS = path.join(DATA, 'posters');
const DB_FILE = path.join(DATA, 'swipe.json');
const SETTINGS_FILE = path.join(DATA, 'settings.json');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const MAX_UPLOAD = 2 * 1024 * 1024 * 1024; // 2 GB

for (const d of [DATA, VIDEOS, POSTERS]) fs.mkdirSync(d, { recursive: true });

// ---------- storage ----------
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, value) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
let db = readJson(DB_FILE, { items: [] });
// A crash mid-download leaves items stuck on "saving"; mark them so the user can retry.
for (const it of db.items) if (it.status === 'saving') { it.status = 'error'; it.error = 'Download was interrupted. Delete and save again.'; }
const saveDb = () => writeJson(DB_FILE, db);
const settings = () => readJson(SETTINGS_FILE, {});
const metaToken = () => process.env.META_TOKEN || settings().token || '';
const newId = () => crypto.randomBytes(6).toString('hex');

// ---------- helpers ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
};
const send = (res, code, body, headers = {}) => {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(code, { 'content-type': isObj ? 'application/json' : 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
};
const fail = (res, code, message, extra = {}) => send(res, code, { error: message, ...extra });

async function readBody(req, limit = 1_000_000) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > limit) throw new Error('Request too large'); chunks.push(c); }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

// Serve a file with HTTP Range support. This is what makes seeking/rewinding instant:
// the browser asks for just the bytes around the spot you jumped to.
function serveFile(req, res, file, { download } = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return fail(res, 404, 'Not found');
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=3600' };
    if (download) headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(download)}`;
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      let start = range[1] === '' ? st.size - Number(range[2]) : Number(range[1]);
      let end = range[1] === '' || range[2] === '' ? st.size - 1 : Math.min(Number(range[2]), st.size - 1);
      if (!(start >= 0) || start > end || start >= st.size) {
        res.writeHead(416, { 'content-range': `bytes */${st.size}` }); return res.end();
      }
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { ...headers, 'content-length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

async function fetchText(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', accept: 'text/html,*/*' }, redirect: 'follow' });
  if (!r.ok) throw new Error(`Facebook answered ${r.status}`);
  return r.text();
}

async function downloadTo(url, dest) {
  if (!isAllowedMediaUrl(url)) throw new Error('Refusing to download from that host');
  const r = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow' });
  if (!r.ok || !r.body) throw new Error(`Download failed (${r.status})`);
  if (!isAllowedMediaUrl(r.url)) throw new Error('Redirected to a host that is not allowed');
  const part = dest + '.part';
  try {
    await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(part));
    fs.renameSync(part, dest);
  } catch (e) { fs.rmSync(part, { force: true }); throw e; }
}

const extFromUrl = (u, fallback) => {
  try { const e = path.extname(new URL(u).pathname).toLowerCase(); return MIME[e] ? e : fallback; } catch { return fallback; }
};

// ---------- ad resolution ----------
const mediaCache = new Map(); // adId -> Promise<result>
function resolveAd({ adId, snapshotUrl }) {
  const key = adId || snapshotUrl;
  if (mediaCache.has(key)) return mediaCache.get(key);
  const p = (async () => {
    const token = metaToken();
    const candidates = [];
    if (snapshotUrl && /^https:\/\/([a-z0-9-]+\.)*facebook\.com\//i.test(snapshotUrl)) candidates.push(snapshotUrl);
    if (adId && token) candidates.push(`https://www.facebook.com/ads/archive/render_ad/?id=${adId}&access_token=${encodeURIComponent(token)}`);
    if (adId) candidates.push(`https://www.facebook.com/ads/library/?id=${adId}`);
    let lastErr;
    for (const url of candidates) {
      try {
        const info = extractFromHtml(await fetchText(url));
        if (info.videoUrl || info.posterUrl) return { adId, adUrl: adId ? `https://www.facebook.com/ads/library/?id=${adId}` : null, ...info };
      } catch (e) { lastErr = e; }
    }
    const err = new Error(lastErr ? lastErr.message : 'Could not find a video for that ad.');
    err.noMedia = true;
    throw err;
  })();
  mediaCache.set(key, p);
  p.catch(() => mediaCache.delete(key)); // do not cache failures
  return p;
}

// ---------- swipe file ----------
function publicItem(it) { return it; }

async function runDownload(item, { videoUrl, posterUrl }) {
  try {
    if (videoUrl) {
      const name = `${item.id}${extFromUrl(videoUrl, '.mp4')}`;
      await downloadTo(videoUrl, path.join(VIDEOS, name));
      item.videoFile = name;
    }
    if (posterUrl) {
      try {
        const name = `${item.id}${extFromUrl(posterUrl, '.jpg')}`;
        await downloadTo(posterUrl, path.join(POSTERS, name));
        item.posterFile = name;
      } catch { /* poster is optional */ }
    }
    item.status = item.videoFile ? 'ready' : 'error';
    if (!item.videoFile) item.error = 'No video was found for this ad.';
  } catch (e) {
    item.status = 'error'; item.error = e.message;
  }
  saveDb();
}

const cleanTags = (t) => (Array.isArray(t) ? t : String(t || '').split(',')).map((s) => String(s).trim()).filter(Boolean).slice(0, 30);
const cleanMarks = (m) => (Array.isArray(m) ? m : []).filter((x) => x && Number.isFinite(x.t)).map((x) => ({ t: Math.max(0, +x.t), label: String(x.label || '').slice(0, 200) })).slice(0, 200);

async function createFromAd(body) {
  const ad = body.ad || {};
  let { videoUrl, posterUrl } = ad;
  if (!videoUrl && (ad.id || ad.snapshotUrl)) {
    const info = await resolveAd({ adId: ad.id, snapshotUrl: ad.snapshotUrl });
    videoUrl = info.videoUrl; posterUrl = posterUrl || info.posterUrl;
    ad.pageName = ad.pageName || info.pageName; ad.text = ad.text || info.text;
  }
  if (!videoUrl) { const e = new Error('No video found for this ad. Try downloading it manually and dropping the file in.'); e.noMedia = true; throw e; }
  const existing = db.items.find((i) => i.adId && ad.id && i.adId === String(ad.id));
  if (existing) return { item: existing, duplicate: true };
  const item = {
    id: newId(), adId: ad.id ? String(ad.id) : null, title: String(body.title || ad.pageName || 'Untitled ad').slice(0, 200),
    pageName: ad.pageName || '', text: ad.text || '', adUrl: ad.adUrl || (ad.id ? `https://www.facebook.com/ads/library/?id=${ad.id}` : ''),
    videoFile: null, posterFile: null, status: 'saving', error: null,
    folder: String(body.folder || '').slice(0, 80), tags: cleanTags(body.tags), notes: String(body.notes || '').slice(0, 5000),
    marks: cleanMarks(body.marks), savedAt: new Date().toISOString(),
  };
  db.items.unshift(item); saveDb();
  runDownload(item, { videoUrl, posterUrl });
  return { item };
}

function removeFiles(item) {
  if (item.videoFile) fs.rmSync(path.join(VIDEOS, path.basename(item.videoFile)), { force: true });
  if (item.posterFile) fs.rmSync(path.join(POSTERS, path.basename(item.posterFile)), { force: true });
}

// ---------- routes ----------
async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  if (p === '/api/settings' && method === 'GET') {
    const t = metaToken();
    return send(res, 200, { hasToken: !!t, tokenHint: t ? '…' + t.slice(-4) : '', fromEnv: !!process.env.META_TOKEN, country: settings().country || 'US' });
  }
  if (p === '/api/settings' && method === 'POST') {
    const b = await readBody(req); const cur = settings();
    if (typeof b.token === 'string') cur.token = b.token.trim();
    if (typeof b.country === 'string') cur.country = b.country.trim().toUpperCase().slice(0, 40) || 'US';
    writeJson(SETTINGS_FILE, cur);
    return send(res, 200, { ok: true });
  }

  if (p === '/api/search' && method === 'GET') {
    const token = metaToken();
    if (!token) return fail(res, 400, 'Add your Meta access token in Settings to search.', { code: 'no_token' });
    const q = url.searchParams;
    const params = new URLSearchParams({
      access_token: token,
      ad_type: 'ALL',
      ad_active_status: q.get('status') || 'ACTIVE',
      ad_reached_countries: JSON.stringify((q.get('country') || 'US').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)),
      fields: 'id,page_id,page_name,ad_creative_bodies,ad_creative_link_titles,ad_delivery_start_time,ad_snapshot_url,publisher_platforms',
      limit: '24',
    });
    if (q.get('q')) params.set('search_terms', q.get('q'));
    if (q.get('pageId')) params.set('search_page_ids', q.get('pageId'));
    if (q.get('after')) params.set('after', q.get('after'));
    const r = await fetch(`https://graph.facebook.com/v21.0/ads_archive?${params}`);
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) return fail(res, 502, (j.error && j.error.message) || `Meta answered ${r.status}`);
    return send(res, 200, {
      ads: (j.data || []).map((a) => ({
        id: a.id, pageId: a.page_id, pageName: a.page_name, text: (a.ad_creative_bodies || [])[0] || '',
        title: (a.ad_creative_link_titles || [])[0] || '', startedAt: a.ad_delivery_start_time || null,
        platforms: a.publisher_platforms || [], snapshotUrl: a.ad_snapshot_url,
        adUrl: `https://www.facebook.com/ads/library/?id=${a.id}`,
      })),
      next: (j.paging && j.paging.cursors && j.paging.next) ? j.paging.cursors.after : null,
    });
  }

  if (p === '/api/media' && method === 'GET') {
    try {
      const info = await resolveAd({ adId: url.searchParams.get('id'), snapshotUrl: url.searchParams.get('snapshot') });
      return send(res, 200, info);
    } catch (e) { return fail(res, e.noMedia ? 404 : 502, e.message); }
  }

  if (p === '/api/resolve' && method === 'POST') {
    const { input } = await readBody(req);
    const parsed = parseInput(input);
    if (parsed.kind === 'empty' || parsed.kind === 'invalid') return fail(res, 400, 'Paste an Ad Library link, an ad ID, or a video URL.');
    if (parsed.kind === 'library-search') return fail(res, 400, 'That is a search page. Open one ad and copy its link (it ends in ?id=…), or use Search here.');
    if (parsed.kind === 'video') return send(res, 200, { adId: null, videoUrl: parsed.url, posterUrl: null, pageName: '', text: '', adUrl: '' });
    if (parsed.kind === 'page') return fail(res, 400, 'I can only read Facebook Ad Library links or direct video URLs.');
    try { return send(res, 200, await resolveAd({ adId: parsed.adId })); }
    catch (e) {
      return fail(res, 404, `${e.message} Facebook often hides the video from non-browser requests. Download the video yourself and drop the file onto this page instead.`);
    }
  }

  // Stream a remote Facebook video/image to the browser, forwarding Range so you can scrub before saving.
  if (p === '/api/proxy' && method === 'GET') {
    const target = url.searchParams.get('u');
    if (!isAllowedMediaUrl(target)) return fail(res, 400, 'Host not allowed');
    const headers = { 'user-agent': UA };
    if (req.headers.range) headers.range = req.headers.range;
    const r = await fetch(target, { headers, redirect: 'follow' });
    if (!isAllowedMediaUrl(r.url)) return fail(res, 400, 'Host not allowed');
    const out = { 'cache-control': 'private, max-age=600' };
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) if (r.headers.get(h)) out[h] = r.headers.get(h);
    res.writeHead(r.status, out);
    if (!r.body) return res.end();
    const stream = Readable.fromWeb(r.body);
    req.on('close', () => stream.destroy());
    return stream.pipe(res);
  }

  if (p === '/api/swipe' && method === 'GET') return send(res, 200, { items: db.items.map(publicItem) });
  if (p === '/api/swipe' && method === 'POST') {
    try { return send(res, 200, await createFromAd(await readBody(req))); }
    catch (e) { return fail(res, e.noMedia ? 404 : 502, e.message); }
  }

  if (p === '/api/upload' && method === 'POST') {
    const name = (url.searchParams.get('name') || 'video.mp4').replace(/[^\w.\- ]+/g, '_').slice(0, 120);
    const ext = path.extname(name).toLowerCase();
    if (!['.mp4', '.m4v', '.mov', '.webm'].includes(ext)) return fail(res, 400, 'Only mp4, mov, m4v and webm files are supported.');
    if (Number(req.headers['content-length']) > MAX_UPLOAD) return fail(res, 413, 'File is larger than 2 GB.');
    const id = newId(); const file = `${id}${ext}`; const dest = path.join(VIDEOS, file);
    try { await pipeline(req, fs.createWriteStream(dest)); } catch (e) { fs.rmSync(dest, { force: true }); throw e; }
    const item = {
      id, adId: null, title: path.basename(name, ext), pageName: '', text: '', adUrl: '', videoFile: file, posterFile: null, status: 'ready', error: null,
      folder: (url.searchParams.get('folder') || '').slice(0, 80), tags: [], notes: '', marks: [], savedAt: new Date().toISOString(),
    };
    db.items.unshift(item); saveDb();
    return send(res, 200, { item });
  }

  let m;
  if ((m = /^\/api\/swipe\/(\w+)$/.exec(p))) {
    const item = db.items.find((i) => i.id === m[1]);
    if (!item) return fail(res, 404, 'Not found');
    if (method === 'PATCH') {
      const b = await readBody(req);
      if ('title' in b) item.title = String(b.title).slice(0, 200);
      if ('folder' in b) item.folder = String(b.folder).slice(0, 80);
      if ('notes' in b) item.notes = String(b.notes).slice(0, 5000);
      if ('tags' in b) item.tags = cleanTags(b.tags);
      if ('marks' in b) item.marks = cleanMarks(b.marks);
      saveDb();
      return send(res, 200, { item });
    }
    if (method === 'DELETE') {
      removeFiles(item); db.items = db.items.filter((i) => i !== item); saveDb();
      return send(res, 200, { ok: true });
    }
  }

  if ((m = /^\/api\/poster\/(\w+)$/.exec(p)) && method === 'POST') {
    const item = db.items.find((i) => i.id === m[1]);
    if (!item) return fail(res, 404, 'Not found');
    const chunks = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > 5_000_000) return fail(res, 413, 'Too large'); chunks.push(c); }
    const name = `${item.id}.jpg`;
    fs.writeFileSync(path.join(POSTERS, name), Buffer.concat(chunks));
    item.posterFile = name; saveDb();
    return send(res, 200, { item });
  }

  if (p === '/api/export' && method === 'GET') {
    return send(res, 200, JSON.stringify(db, null, 2), { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="swipe-file.json"' });
  }

  return fail(res, 404, 'Unknown endpoint');
}

function handleFiles(req, res, url) {
  const m = /^\/files\/(videos|posters)\/([\w.-]+)$/.exec(url.pathname);
  if (!m) return fail(res, 404, 'Not found');
  const dir = m[1] === 'videos' ? VIDEOS : POSTERS;
  const file = path.join(dir, path.basename(m[2]));
  let download;
  if (url.searchParams.has('download')) {
    const it = db.items.find((i) => i.videoFile === m[2]);
    download = `${(it ? it.title : 'ad').replace(/[^\w\- ]+/g, '').trim() || 'ad'}${path.extname(m[2])}`;
  }
  serveFile(req, res, file, { download });
}

function handleStatic(req, res, url) {
  const rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC)) return fail(res, 403, 'Forbidden');
  serveFile(req, res, file);
}

const server = http.createServer(async (req, res) => {
  try {
    // Only answer requests addressed to this machine, which blocks DNS-rebinding from other sites.
    const host = (req.headers.host || '').replace(/:\d+$/, '');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) return fail(res, 403, 'Forbidden');
    const origin = req.headers.origin;
    if (origin && req.method !== 'GET' && req.method !== 'HEAD') {
      let oh; try { oh = new URL(origin).host; } catch { oh = ''; }
      if (oh !== req.headers.host) return fail(res, 403, 'Cross-origin request blocked');
    }
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname.startsWith('/files/')) return handleFiles(req, res, url);
    return handleStatic(req, res, url);
  } catch (e) {
    if (!res.headersSent) fail(res, 500, e.message || 'Server error'); else res.destroy();
  }
});

if (require.main === module) {
  server.listen(PORT, '127.0.0.1', () => console.log(`Ad Swipe is running → http://localhost:${PORT}`));
}
module.exports = { server };
