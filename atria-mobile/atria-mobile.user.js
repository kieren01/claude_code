// ==UserScript==
// @name         Atria Mobile
// @namespace    https://github.com/kieren01/claude_code
// @version      0.1.0
// @description  Mobile-friendly layer over Atria: off-canvas sidebar, single-column ad feed, video/image throttling.
// @match        https://*.tryatria.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * Atria Mobile
 * ------------
 * Runs on top of the normal Atria web app and rewrites its layout for phones.
 * It does NOT depend on Atria's class names (those change often and are
 * unknown to the author); it finds structure by geometry instead:
 *
 *   - sidebar : tall, narrow, pinned to the left edge, lots of links
 *   - grid    : a container with 6+ big, similarly sized, media-heavy children
 *   - wide    : fixed-position panels/modals wider than the screen
 *
 * Everything is scoped under `html.am-on` so desktop is untouched.
 * Works as a userscript (Violentmonkey/Tampermonkey) or pasted as a bookmarklet.
 */
(function () {
  'use strict';

  if (window.__atriaMobile) {
    window.__atriaMobile.openPanel();
    return;
  }

  var BP = 820; // px: below this width (or on touch devices) mobile mode is on
  var LS_KEY = 'atriaMobile.v1';
  var DEFAULTS = { drawer: true, grid: true, perf: true, cols: 1, off: false };

  function loadCfg() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { return {}; }
  }
  var cfg = Object.assign({}, DEFAULTS, loadCfg());
  function saveCfg() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch (e) { /* private mode */ }
  }

  var root = document.documentElement;
  var state = {
    sidebar: null,
    grids: [],
    wide: [],
    gridSeen: new WeakMap(), // el -> childElementCount last evaluated
    videoSeen: new WeakSet(),
    io: null,
    drawerOpen: false
  };

  // ---------------------------------------------------------------- styles
  var CSS = [
    // global overflow guard
    'html.am-on{overflow-x:hidden!important;-webkit-text-size-adjust:100%}',
    'html.am-on body{max-width:100vw!important;overflow-x:hidden!important}',
    'html.am-on img,html.am-on video,html.am-on canvas{max-width:100%}',

    // sidebar -> off-canvas drawer
    'html.am-on.am-f-drawer .am-sidebar{position:fixed!important;top:0!important;left:0!important;bottom:0!important;',
    '  height:100vh!important;height:100dvh!important;width:min(84vw,320px)!important;min-width:0!important;max-width:84vw!important;',
    '  z-index:2147483000!important;transform:translateX(-105%)!important;transition:transform .22s ease!important;',
    '  overflow-y:auto!important;overscroll-behavior:contain;box-shadow:0 0 40px rgba(0,0,0,.45)!important;visibility:hidden}',
    'html.am-on.am-f-drawer.am-drawer-open .am-sidebar{transform:none!important;visibility:visible}',
    'html.am-on.am-f-drawer .am-nomargin{margin-left:0!important}',
    'html.am-on.am-f-drawer .am-nopad{padding-left:0!important}',
    'html.am-on.am-f-drawer .am-fullw{width:100%!important;max-width:100vw!important;min-width:0!important;flex:1 1 auto!important;left:0!important;box-sizing:border-box!important}',
    'html.am-on.am-f-drawer .am-block{display:block!important}',

    // ad grid -> feed
    'html.am-on.am-f-grid .am-grid,html.am-on.am-f-grid .am-colwrap{display:flex!important;flex-direction:column!important;',
    '  gap:14px!important;width:100%!important;max-width:100%!important;height:auto!important;min-height:0!important;',
    '  padding-left:0!important;padding-right:0!important;transform:none!important}',
    'html.am-on.am-f-grid[data-am-cols="2"] .am-grid:not(.am-colwrap){display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:8px!important}',
    'html.am-on.am-f-grid .am-grid>*{position:relative!important;inset:auto!important;left:auto!important;top:auto!important;right:auto!important;',
    '  transform:none!important;width:100%!important;max-width:100%!important;min-width:0!important;margin:0!important;height:auto!important;',
    '  content-visibility:auto;contain-intrinsic-size:auto 520px}',
    'html.am-on.am-f-grid .am-grid img,html.am-on.am-f-grid .am-grid video{max-width:100%!important;height:auto!important}',

    // fixed panels/modals wider than the screen
    'html.am-on .am-wide{width:100vw!important;max-width:100vw!important;min-width:0!important;left:0!important;right:0!important}',
    'html.am-on [role=dialog],html.am-on [aria-modal=true]{max-width:100vw!important}',

    // perf: backdrop blur is brutal on phone GPUs
    'html.am-on.am-f-perf *{backdrop-filter:none!important;-webkit-backdrop-filter:none!important}',

    // our own UI
    '.am-ui,.am-ui *{box-sizing:border-box;font:14px/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}',
    '.am-dock{position:fixed;left:12px;bottom:calc(14px + env(safe-area-inset-bottom));z-index:2147483600;display:none;gap:8px}',
    'html.am-on .am-dock{display:flex}',
    '.am-btn{width:46px;height:46px;border-radius:50%;border:0;background:#111c;color:#fff;font-size:20px;',
    '  backdrop-filter:none;box-shadow:0 2px 10px rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;padding:0;cursor:pointer}',
    '.am-btn:active{transform:scale(.94)}',
    '.am-scrim{position:fixed;inset:0;z-index:2147482999;background:rgba(0,0,0,.5);display:none}',
    'html.am-drawer-open .am-scrim{display:block}',
    '.am-panel{position:fixed;left:12px;right:12px;bottom:calc(72px + env(safe-area-inset-bottom));z-index:2147483601;max-width:440px;',
    '  background:#15151c;color:#f2f2f7;border-radius:16px;padding:14px 14px 12px;box-shadow:0 10px 40px rgba(0,0,0,.6);display:none}',
    '.am-panel.open{display:block}',
    '.am-panel h3{margin:0 0 8px;font-size:15px;font-weight:600}',
    '.am-row{display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-top:1px solid #ffffff18}',
    '.am-row:first-of-type{border-top:0}',
    '.am-row input[type=checkbox]{width:22px;height:22px}',
    '.am-seg button{border:1px solid #ffffff30;background:transparent;color:inherit;padding:6px 12px;border-radius:8px;margin-left:6px}',
    '.am-seg button.on{background:#6d5bf6;border-color:#6d5bf6}',
    '.am-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}',
    '.am-actions button{flex:1 1 auto;border:0;border-radius:10px;padding:10px 12px;background:#2a2a36;color:#fff}',
    '.am-note{margin:8px 0 0;color:#a7a7b8;font-size:12px}',
    '.am-report{width:100%;height:110px;margin-top:8px;background:#0b0b10;color:#cfd0ff;border:1px solid #ffffff22;border-radius:8px;font:11px/1.3 ui-monospace,monospace;display:none}'
  ].join('\n');

  function injectStyle() {
    var s = document.createElement('style');
    s.id = 'am-style';
    s.textContent = CSS;
    (document.head || root).appendChild(s);
  }

  function ensureViewport() {
    var m = document.querySelector('meta[name=viewport]');
    if (!m) {
      m = document.createElement('meta');
      m.name = 'viewport';
      document.head.appendChild(m);
    }
    if (!/width=device-width/.test(m.content)) {
      m.content = 'width=device-width, initial-scale=1';
    }
  }

  // ------------------------------------------------------------------ utils
  function isMobile() {
    return innerWidth < BP || (window.matchMedia && matchMedia('(pointer: coarse)').matches);
  }

  // breadth-first walk of the top of the DOM, capped so it stays cheap
  function topElements(maxDepth, cap) {
    var out = [], queue = [[document.body, 0]];
    while (queue.length && out.length < cap) {
      var item = queue.shift(), el = item[0], d = item[1];
      if (el.closest && el.closest('.am-ui')) continue;
      var tag = el.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'SVG' || tag === 'svg') continue;
      out.push(el);
      if (d < maxDepth) {
        for (var i = 0; i < el.children.length; i++) queue.push([el.children[i], d + 1]);
      }
    }
    return out;
  }

  function sel(el) {
    if (!el || el === document.body) return 'body';
    var s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    var cls = (el.getAttribute('class') || '').split(/\s+/).filter(function (c) { return c && c.indexOf('am-') !== 0; }).slice(0, 3);
    if (cls.length) s += '.' + cls.join('.');
    return s;
  }
  function path(el) {
    var parts = [], n = el;
    for (var i = 0; n && n !== document.body && i < 4; i++, n = n.parentElement) parts.unshift(sel(n));
    return parts.join(' > ');
  }

  // --------------------------------------------------------------- sidebar
  function findSidebar() {
    if (state.sidebar && state.sidebar.isConnected) return;
    state.sidebar = null;
    var vw = innerWidth, vh = innerHeight;
    var cands = topElements(6, 1500);
    for (var i = 0; i < cands.length; i++) {
      var el = cands[i];
      if (el.classList.contains('am-sidebar')) { state.sidebar = el; return; }
      var r = el.getBoundingClientRect();
      if (r.width < 48 || r.width > vw * 0.8) continue;
      if (r.left < -4 || r.left > 4) continue;
      if (r.top < -4 || r.top > 80) continue;
      if (r.height < vh * 0.6) continue;
      var cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (el.querySelector('main,[role=main]')) continue;
      if (el.querySelectorAll('a,button,[role=button],[role=menuitem]').length < 3) continue;
      // there must be a content column next to it (or it must be pinned)
      var p = el.parentElement, hasMain = cs.position === 'fixed';
      if (!hasMain && p) {
        for (var k = 0; k < p.children.length; k++) {
          var s = p.children[k];
          if (s === el) continue;
          var sr = s.getBoundingClientRect();
          if (sr.width > 0 && sr.left >= r.right - 6) { hasMain = true; break; }
        }
      }
      if (!hasMain) continue;
      claimSidebar(el, r.width);
      return;
    }
  }

  // does this left offset look like "making room for the sidebar"?
  // (tolerant: sidebar width can include padding/border the content column doesn't)
  function offsetsBy(px, w) {
    px = px || 0;
    return px >= 40 && px >= w * 0.6 && px <= w * 1.3;
  }

  function claimSidebar(el, w) {
    // measure siblings BEFORE the sidebar leaves the flow
    var node = el;
    while (node && node !== document.body) {
      var p = node.parentElement;
      if (!p) break;
      var pcs = getComputedStyle(p);
      if (pcs.display === 'grid' && pcs.gridTemplateColumns.split(' ').length > 1) p.classList.add('am-block');
      for (var i = 0; i < p.children.length; i++) {
        var s = p.children[i];
        if (s === node || s.closest('.am-ui')) continue;
        var cs = getComputedStyle(s), r = s.getBoundingClientRect();
        if (offsetsBy(parseFloat(cs.marginLeft), w)) s.classList.add('am-nomargin');
        if (offsetsBy(parseFloat(cs.paddingLeft), w)) s.classList.add('am-nopad');
        if (r.width > 0 && offsetsBy(r.left, w) && cs.position !== 'fixed') s.classList.add('am-fullw');
      }
      node = p;
    }
    el.classList.add('am-sidebar');
    state.sidebar = el;
  }

  function setDrawer(open) {
    state.drawerOpen = !!open;
    root.classList.toggle('am-drawer-open', state.drawerOpen);
  }

  // ------------------------------------------------------------------ grid
  function evalGrid(el) {
    var kids = Array.prototype.slice.call(el.children, 0, 12);
    var cards = 0, media = 0, minW = Infinity, maxW = 0;
    for (var i = 0; i < kids.length; i++) {
      var r = kids[i].getBoundingClientRect();
      if (r.width >= 110 && r.height >= 110) {
        cards++;
        if (r.width < minW) minW = r.width;
        if (r.width > maxW) maxW = r.width;
      }
      if (kids[i].querySelector('img,video,canvas')) media++;
    }
    return cards >= 5 && cards >= kids.length * 0.8 && media >= kids.length * 0.6 && maxW / minW <= 1.3;
  }

  function findGrids() {
    var all = document.body.getElementsByTagName('*');
    var found = false;
    for (var i = 0; i < all.length; i++) {
      var el = all[i], n = el.childElementCount;
      if (n < 6) continue;
      if (state.gridSeen.get(el) === n) continue;
      state.gridSeen.set(el, n);
      if (el.classList.contains('am-grid') || el.closest('.am-ui') || el.closest('.am-grid')) continue;
      if (!evalGrid(el)) continue;
      el.classList.add('am-grid');
      state.grids.push(el);
      found = true;
    }
    if (found) {
      // masonry built from several column <div>s: stack the columns too
      state.grids.forEach(function (g) {
        var p = g.parentElement;
        if (!p || p.classList.contains('am-colwrap')) return;
        var sibs = Array.prototype.filter.call(p.children, function (c) { return c.classList.contains('am-grid'); });
        if (sibs.length >= 2 && sibs.length === p.childElementCount) p.classList.add('am-colwrap');
      });
    }
    state.grids = state.grids.filter(function (g) { return g.isConnected; });
  }

  // ------------------------------------------------------------- wide fixes
  function fixWide() {
    var cands = topElements(4, 600);
    state.wide = state.wide.filter(function (e) { return e.isConnected; });
    for (var i = 0; i < cands.length; i++) {
      var el = cands[i];
      if (el.classList.contains('am-sidebar') || el.classList.contains('am-wide')) continue;
      var cs = getComputedStyle(el);
      if (cs.position !== 'fixed') continue;
      if (el.getBoundingClientRect().width > innerWidth + 2) {
        el.classList.add('am-wide');
        state.wide.push(el);
      }
    }
  }

  // ------------------------------------------------------------------ perf
  function perfPass() {
    var imgs = document.images;
    for (var i = 0; i < imgs.length; i++) {
      var im = imgs[i];
      if (im.complete) continue;
      if (!im.getAttribute('loading')) im.loading = 'lazy';
      if (!im.getAttribute('decoding')) im.decoding = 'async';
    }
    if (!('IntersectionObserver' in window)) return;
    if (!state.io) {
      state.io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          var v = e.target;
          if (e.isIntersecting && e.intersectionRatio >= 0.5) {
            if (v.dataset.amPaused) { delete v.dataset.amPaused; var pr = v.play(); if (pr && pr.catch) pr.catch(function () {}); }
          } else if (!v.paused) {
            v.dataset.amPaused = '1';
            v.pause();
          }
        });
      }, { threshold: [0, 0.5, 1] });
    }
    var vids = document.getElementsByTagName('video');
    for (var j = 0; j < vids.length; j++) {
      var v = vids[j];
      if (state.videoSeen.has(v)) continue;
      state.videoSeen.add(v);
      if (!v.getAttribute('preload')) v.preload = 'metadata';
      state.io.observe(v);
    }
  }

  // -------------------------------------------------------------------- UI
  var ui = {};
  function buildUI() {
    var dock = document.createElement('div');
    dock.className = 'am-ui am-dock';
    ui.menu = mkBtn('☰', 'Menu', function () { setDrawer(!state.drawerOpen); });
    ui.gear = mkBtn('⚙', 'Atria Mobile settings', function () { togglePanel(); });
    dock.appendChild(ui.menu);
    dock.appendChild(ui.gear);

    var scrim = document.createElement('div');
    scrim.className = 'am-ui am-scrim';
    scrim.addEventListener('click', function () { setDrawer(false); });

    var panel = document.createElement('div');
    panel.className = 'am-ui am-panel';
    panel.innerHTML =
      '<h3>Atria Mobile</h3>' +
      row('Sidebar as drawer', '<input type="checkbox" data-k="drawer">') +
      row('Single-column feed', '<input type="checkbox" data-k="grid">') +
      row('Battery saver (pause off-screen video)', '<input type="checkbox" data-k="perf">') +
      row('Feed columns', '<span class="am-seg"><button data-cols="1">1</button><button data-cols="2">2</button></span>') +
      '<div class="am-actions">' +
      '<button data-act="rescan">Re-scan</button>' +
      '<button data-act="report">Debug report</button>' +
      '<button data-act="off">Turn off</button>' +
      '</div>' +
      '<textarea class="am-report" readonly></textarea>' +
      '<p class="am-note" data-role="status"></p>';
    ui.panel = panel;

    panel.addEventListener('change', function (e) {
      var k = e.target.getAttribute && e.target.getAttribute('data-k');
      if (!k) return;
      cfg[k] = e.target.checked;
      saveCfg(); applyFlags(); scheduleScan(0);
    });
    panel.addEventListener('click', function (e) {
      var t = e.target;
      if (t.getAttribute('data-cols')) {
        cfg.cols = parseInt(t.getAttribute('data-cols'), 10);
        saveCfg(); applyFlags(); syncPanel();
      } else if (t.getAttribute('data-act') === 'rescan') {
        scheduleScan(0);
      } else if (t.getAttribute('data-act') === 'report') {
        showReport();
      } else if (t.getAttribute('data-act') === 'off') {
        cfg.off = true; saveCfg(); applyFlags();
        alert('Atria Mobile is off. Reload the page and open Settings again to turn it on.');
      }
    });

    // clicking a link/button inside the drawer closes it
    document.addEventListener('click', function (e) {
      if (state.drawerOpen && state.sidebar && state.sidebar.contains(e.target) &&
          e.target.closest('a[href],button,[role=button],[role=menuitem]')) {
        setTimeout(function () { setDrawer(false); }, 120);
      }
    }, true);

    document.body.appendChild(dock);
    document.body.appendChild(scrim);
    document.body.appendChild(panel);
    syncPanel();
  }

  function mkBtn(label, aria, fn) {
    var b = document.createElement('button');
    b.className = 'am-btn';
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('aria-label', aria);
    b.addEventListener('click', fn);
    return b;
  }
  function row(label, control) { return '<div class="am-row"><span>' + label + '</span>' + control + '</div>'; }

  function syncPanel() {
    ['drawer', 'grid', 'perf'].forEach(function (k) {
      var i = ui.panel.querySelector('[data-k=' + k + ']');
      if (i) i.checked = !!cfg[k];
    });
    Array.prototype.forEach.call(ui.panel.querySelectorAll('[data-cols]'), function (b) {
      b.classList.toggle('on', parseInt(b.getAttribute('data-cols'), 10) === cfg.cols);
    });
    var st = ui.panel.querySelector('[data-role=status]');
    st.textContent = 'sidebar: ' + (state.sidebar ? 'found' : 'not found') +
      ' · feed lists: ' + state.grids.length +
      ' · videos: ' + document.getElementsByTagName('video').length;
  }

  function togglePanel(force) {
    var open = typeof force === 'boolean' ? force : !ui.panel.classList.contains('open');
    ui.panel.classList.toggle('open', open);
    if (open) syncPanel();
  }

  function report() {
    var r = {
      version: '0.1.0',
      url: location.origin + location.pathname,
      viewport: innerWidth + 'x' + innerHeight,
      dpr: devicePixelRatio,
      ua: navigator.userAgent,
      cfg: cfg,
      mobileMode: root.classList.contains('am-on'),
      scrollWidth: root.scrollWidth,
      sidebar: state.sidebar ? path(state.sidebar) : null,
      grids: state.grids.slice(0, 6).map(function (g) { return { path: path(g), children: g.childElementCount }; }),
      wide: state.wide.slice(0, 6).map(path),
      videos: document.getElementsByTagName('video').length,
      images: document.images.length,
      domNodes: document.getElementsByTagName('*').length,
      // top of the DOM so selectors can be tuned without seeing the real page
      outline: topElements(3, 40).map(function (e) {
        var b = e.getBoundingClientRect();
        return path(e) + '  [' + Math.round(b.left) + ',' + Math.round(b.top) + ' ' + Math.round(b.width) + 'x' + Math.round(b.height) + ' ' + getComputedStyle(e).position + ']';
      })
    };
    return JSON.stringify(r, null, 2);
  }

  function showReport() {
    var ta = ui.panel.querySelector('.am-report');
    ta.value = report();
    ta.style.display = 'block';
    ta.focus(); ta.select();
    var fallback = function () { try { ta.select(); document.execCommand('copy'); } catch (e) { /* long-press to copy */ } };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(ta.value).catch(fallback);
      else fallback();
    } catch (e) { fallback(); }
  }

  // ---------------------------------------------------------- orchestration
  function applyFlags() {
    var on = !cfg.off && isMobile();
    root.classList.toggle('am-on', on);
    root.classList.toggle('am-f-drawer', !!cfg.drawer);
    root.classList.toggle('am-f-grid', !!cfg.grid);
    root.classList.toggle('am-f-perf', !!cfg.perf);
    root.setAttribute('data-am-cols', String(cfg.cols));
    if (!on) setDrawer(false);
    if (ui.menu) ui.menu.style.display = (cfg.drawer && state.sidebar) ? '' : 'none';
  }

  var timer = null;
  function scheduleScan(delay) {
    clearTimeout(timer);
    timer = setTimeout(scan, delay == null ? 800 : delay);
  }

  function scan() {
    applyFlags();
    if (!root.classList.contains('am-on')) return;
    try {
      if (cfg.drawer) findSidebar();
      if (cfg.grid) findGrids();
      fixWide();
      if (cfg.perf) perfPass();
    } catch (err) {
      console.warn('[atria-mobile] scan failed', err);
    }
    applyFlags(); // refresh menu button visibility
    if (ui.panel && ui.panel.classList.contains('open')) syncPanel();
  }

  function init() {
    if (!document.body) { document.addEventListener('DOMContentLoaded', init); return; }
    injectStyle();
    ensureViewport();
    buildUI();
    applyFlags();
    scan();
    new MutationObserver(function () { scheduleScan(); })
      .observe(document.body, { childList: true, subtree: true });
    addEventListener('resize', function () { scheduleScan(200); });
    addEventListener('orientationchange', function () { scheduleScan(300); });
    window.__atriaMobile = {
      openPanel: function () { togglePanel(true); },
      refresh: function () { scheduleScan(0); },
      report: report,
      cfg: cfg
    };
  }

  init();
})();
