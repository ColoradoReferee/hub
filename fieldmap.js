// fieldmap.js · draws a venue from fieldmaps.json as real pitches, with live state.
// Shared by the Hub (Command Center, game card) and the public map page.
//
//   var m = FieldMap.render(el, layout, { onSelect: fn, you: 'hq' });
//   m.setStatus({ '42': { state: 'alert', chip: '10:30', sub: 'U14 G' }, ... });
//   m.select('42'); m.find('rush');  m.zoom(1.25);
//
// States: ok (nothing to say), live (game in progress), warn (gold), alert (red),
// late (running late, gold dashed), open (no referee, red dashed), done (day over), hl (search hit).
(function () {
  var NS = 'http://www.w3.org/2000/svg';
  function el(tag, attrs, parent) { var e = document.createElementNS(NS, tag); Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); }); if (parent) parent.appendChild(e); return e; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  // "East - Field 40A", "Field 04", "40" all become "40A" / "4" / "40".
  function fieldKey(name) { var m = /([A-Za-z]*\d+\s*[A-Za-z]?|[A-Z])\s*$/.exec(String(name || '').trim()); if (!m) return String(name || '').trim().toUpperCase(); return m[1].replace(/\s+/g, '').replace(/^0+(\d)/, '$1').toUpperCase(); }
  // Size from the rectangle when the layout does not say.
  function sizeOf(f, maxA) { if (f.size) return f.size; var a = f.w * f.h, r = a / maxA; return r >= 0.6 ? '11v11' : r >= 0.33 ? '9v9' : r >= 0.14 ? '7v7' : '4v4'; }

  // The markings of a pitch, scaled to the rectangle. Long side is the touchline.
  function pitch(g, f, size) {
    var x = f.x, y = f.y, w = f.w, h = f.h, land = w >= h, L = land ? w : h, S = land ? h : w;
    el('rect', { x: x, y: y, width: w, height: h, rx: 2, 'class': 'fm-grass' }, g);
    el('rect', { x: x + 1.5, y: y + 1.5, width: w - 3, height: h - 3, 'class': 'fm-line' }, g);
    if (size === '4v4' || size === 'lax') return;
    // halfway line and circle
    if (land) el('line', { x1: x + w / 2, y1: y + 1.5, x2: x + w / 2, y2: y + h - 1.5, 'class': 'fm-line' }, g); else el('line', { x1: x + 1.5, y1: y + h / 2, x2: x + w - 1.5, y2: y + h / 2, 'class': 'fm-line' }, g);
    el('circle', { cx: x + w / 2, cy: y + h / 2, r: Math.max(3, S * 0.11), 'class': 'fm-line' }, g);
    if (size === '7v7') return;
    // penalty areas at both ends, proportional to the FIFA pitch (16.5 of 105 long, 40 of 68 wide)
    var d = L * 0.157, pw = S * 0.59, gd = L * 0.052, gw = S * 0.27;
    if (land) {
      el('rect', { x: x + 1.5, y: y + (h - pw) / 2, width: d, height: pw, 'class': 'fm-line' }, g); el('rect', { x: x + w - 1.5 - d, y: y + (h - pw) / 2, width: d, height: pw, 'class': 'fm-line' }, g);
      if (size === '11v11' || size === 'turf') { el('rect', { x: x + 1.5, y: y + (h - gw) / 2, width: gd, height: gw, 'class': 'fm-line' }, g); el('rect', { x: x + w - 1.5 - gd, y: y + (h - gw) / 2, width: gd, height: gw, 'class': 'fm-line' }, g); }
    } else {
      el('rect', { x: x + (w - pw) / 2, y: y + 1.5, width: pw, height: d, 'class': 'fm-line' }, g); el('rect', { x: x + (w - pw) / 2, y: y + h - 1.5 - d, width: pw, height: d, 'class': 'fm-line' }, g);
      if (size === '11v11' || size === 'turf') { el('rect', { x: x + (w - gw) / 2, y: y + 1.5, width: gw, height: gd, 'class': 'fm-line' }, g); el('rect', { x: x + (w - gw) / 2, y: y + h - 1.5 - gd, width: gw, height: gd, 'class': 'fm-line' }, g); }
    }
  }

  function render(container, layout, opts) {
    opts = opts || {};
    var vb = layout.viewBox || [0, 0, 1200, 800], W = vb[2], H = vb[3];
    container.innerHTML = '';
    var scroller = document.createElement('div'); scroller.className = 'fm-scroll'; container.appendChild(scroller);
    var svg = el('svg', { viewBox: vb.join(' '), 'class': 'fm', role: 'img', 'aria-label': layout.name || '' }, scroller);
    var defs = el('defs', {}, svg);
    var pat = el('pattern', { id: 'fm-park', width: 8, height: 8, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
    el('line', { x1: 0, y1: 0, x2: 0, y2: 8, 'class': 'fm-hatch' }, pat);
    el('rect', { x: vb[0], y: vb[1], width: W, height: H, 'class': 'fm-ground' }, svg);
    // ground: roads, water, zones, labels
    var ground = el('g', { 'class': 'fm-groundlayer' }, svg);
    (layout.zones || []).forEach(function (z) { el('rect', { x: z.x, y: z.y, width: z.w, height: z.h, rx: 10, 'class': 'fm-zone' }, ground); });
    (layout.roads || []).forEach(function (r) { el('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: 3, 'class': 'fm-road' }, ground); });
    (layout.water || []).forEach(function (w) { el('ellipse', { cx: w.cx, cy: w.cy, rx: w.rx, ry: w.ry, 'class': 'fm-water' }, ground); });
    (layout.labels || []).forEach(function (l) {
      var txt = String(l.t).replace(/^[—◇↑\s]+|[—\s]+$/g, '').trim(); if (!txt) return;
      var tt = el('text', { x: l.x, y: l.y, 'class': 'fm-label ' + (l.k || ''), 'text-anchor': 'middle' }, ground);
      tt.textContent = txt.length > 3 && txt === txt.toUpperCase() ? txt.charAt(0) + txt.slice(1).toLowerCase() : txt;
    });
    // fields
    var maxA = Math.max.apply(null, (layout.fields || []).map(function (f) { return f.w * f.h; }).concat([1]));
    var groups = {}, fields = el('g', { 'class': 'fm-fields' }, svg);
    (layout.fields || []).forEach(function (f) {
      var size = sizeOf(f, maxA), g = el('g', { 'class': 'fm-field', 'data-id': f.id, tabindex: 0, role: 'button', 'aria-label': (layout.name || '') + ', field ' + f.id }, fields);
      el('rect', { x: f.x - 4, y: f.y - 4, width: f.w + 8, height: f.h + 8, rx: 6, 'class': 'fm-ring' }, g);
      pitch(g, f, size);
      var small = Math.min(f.w, f.h) < 50, fs = small ? Math.max(12, Math.min(f.w, f.h) * 0.42) : Math.max(16, Math.min(f.w, f.h) * 0.36); fs = Math.min(fs, 40, (f.w - 8) / (String(f.id).length * 0.62));
      var num = el('text', { x: f.x + f.w / 2, y: f.y + f.h / 2 + (f.sub ? -fs * 0.1 : 0), 'class': 'fm-num', 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': fs }, g);
      num.textContent = f.id;
      if (f.sub && !small) { var sub = el('text', { x: f.x + f.w / 2, y: f.y + f.h / 2 + fs * 0.75, 'class': 'fm-sub', 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': Math.max(8, fs * 0.38) }, g); sub.textContent = f.sub; }
      // chip: kickoff or countdown, hidden until status says
      var chip = el('g', { 'class': 'fm-chip', visibility: 'hidden' }, g), cw = Math.min(f.w - 6, 56), ch = 15;
      el('rect', { x: f.x + (f.w - cw) / 2, y: f.y + f.h - ch - 4, width: cw, height: ch, rx: ch / 2, 'class': 'fm-chipbg' }, chip);
      var ct = el('text', { x: f.x + f.w / 2, y: f.y + f.h - ch / 2 - 4, 'class': 'fm-chiptext', 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-size': 10 }, chip);
      groups[f.id] = { g: g, f: f, size: size, chip: chip, chipText: ct };
      var pick = function () { select(f.id); if (opts.onSelect) opts.onSelect(f.id, f); };
      g.addEventListener('click', pick); g.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    });
    // referee HQ: a tent
    (layout.hq || []).forEach(function (h, i) {
      var g = el('g', { 'class': 'fm-hq', 'data-hq': i }, svg), cx = h.x + h.w / 2, cy = h.y + h.h / 2;
      el('rect', { x: h.x, y: h.y, width: h.w, height: h.h, rx: 8, 'class': 'fm-hqbox' }, g);
      el('path', { d: 'M' + (h.x + 10) + ' ' + (h.y + h.h - 8) + ' L' + (h.x + 22) + ' ' + (h.y + 8) + ' L' + (h.x + 34) + ' ' + (h.y + h.h - 8) + ' Z', 'class': 'fm-tent' }, g);
      var tt = el('text', { x: h.x + 42, y: cy, 'class': 'fm-hqlabel', 'dominant-baseline': 'central', 'font-size': 11 }, g);
      tt.textContent = String(h.label || 'Referee HQ').replace(/\bREF HQ\b/i, 'Referee HQ').replace(/\bREFEREE HQ\b/, 'Referee HQ').replace(/^(WEST|EAST|NORTH|SOUTH)\b/i, function (m) { return m.charAt(0) + m.slice(1).toLowerCase(); });
      if (opts.onHQ) g.addEventListener('click', function () { opts.onHQ(h, i); });
    });
    // compass
    var cg = el('g', { 'class': 'fm-compass', transform: 'translate(' + (vb[0] + 34) + ',' + (vb[1] + H - 40) + ')' }, svg);
    el('circle', { cx: 0, cy: 0, r: 16, 'class': 'fm-compassbg' }, cg); el('path', { d: 'M0 -11 L5 4 L0 1 L-5 4 Z', 'class': 'fm-needle' }, cg);
    var nt = el('text', { x: 0, y: 11, 'text-anchor': 'middle', 'font-size': 8, 'class': 'fm-compasstext' }, cg); nt.textContent = 'N';
    // you are here
    var you = el('g', { 'class': 'fm-you', visibility: 'hidden' }, svg);
    el('circle', { cx: 0, cy: 0, r: 14, 'class': 'fm-youhalo' }, you); el('circle', { cx: 0, cy: 0, r: 6, 'class': 'fm-youdot' }, you);
    var yt = el('text', { x: 0, y: 26, 'text-anchor': 'middle', 'font-size': 11, 'class': 'fm-youtext' }, you); yt.textContent = opts.youLabel || 'You are here';
    function placeYou(where) {
      var p = null;
      if (where === 'hq' && layout.hq && layout.hq[0]) p = [layout.hq[0].x + layout.hq[0].w / 2, layout.hq[0].y + layout.hq[0].h + 14];
      else if (/^hq(\d)$/.test(where || '') && layout.hq) { var h = layout.hq[Number(where.slice(2))]; if (h) p = [h.x + h.w / 2, h.y + h.h + 14]; }
      else if (where && groups[fieldKey(where)]) { var f = groups[fieldKey(where)].f; p = [f.x + f.w / 2, f.y - 10]; }
      if (!p) { you.setAttribute('visibility', 'hidden'); return; }
      you.setAttribute('transform', 'translate(' + p[0] + ',' + p[1] + ')'); you.setAttribute('visibility', 'visible');
    }
    if (opts.you) placeYou(opts.you);

    var selected = null;
    function select(id) {
      if (selected && groups[selected]) groups[selected].g.classList.remove('sel');
      selected = id && groups[id] ? id : null;
      if (selected) { groups[selected].g.classList.add('sel'); fields.appendChild(groups[selected].g); scrollTo(groups[selected].f); }
    }
    function scrollTo(f) {
      var sc = scroller, scale = svg.getBoundingClientRect().width / W;
      if (!sc.scrollTo || !sc.clientWidth) return;
      sc.scrollTo({ left: (f.x + f.w / 2) * scale - sc.clientWidth / 2, top: (f.y + f.h / 2) * scale - sc.clientHeight / 2, behavior: 'smooth' });
    }
    function setStatus(map) {
      Object.keys(groups).forEach(function (id) {
        var s = (map || {})[id] || {}, h = groups[id];
        h.g.setAttribute('data-state', s.state || 'ok');
        if (s.chip) { h.chipText.textContent = s.chip; h.chip.setAttribute('visibility', 'visible'); } else h.chip.setAttribute('visibility', 'hidden');
      });
    }
    function highlight(ids) { Object.keys(groups).forEach(function (id) { groups[id].g.classList.toggle('hl', ids.indexOf(id) >= 0); groups[id].g.classList.toggle('dim', ids.length > 0 && ids.indexOf(id) < 0); }); if (ids.length) scrollTo(groups[ids[0]].f); }
    // Phones start zoomed so numbers are readable; the selected field is scrolled into view.
    var zoomLevel = 1; if (container.clientWidth && container.clientWidth < 600) { zoomLevel = 1.8; svg.style.width = '180%'; }
    function zoom(factor) { zoomLevel = Math.max(1, Math.min(4, zoomLevel * factor)); svg.style.width = (zoomLevel * 100) + '%'; }
    function match(name) { var k = fieldKey(name); if (groups[k]) return k; var up = String(name || '').toUpperCase(); var hit = Object.keys(groups).filter(function (id) { return id.length > 1 && up.indexOf(id.toUpperCase()) >= 0; }).sort(function (a, b) { return b.length - a.length; })[0]; return hit || null; }
    return { svg: svg, select: select, match: match, setStatus: setStatus, highlight: highlight, zoom: zoom, you: placeYou, fieldKey: fieldKey, ids: Object.keys(groups), size: function (id) { return groups[id] ? groups[id].size : ''; } };
  }
  window.FieldMap = { render: render, fieldKey: fieldKey, slug: function (venue) { return String(venue || '').toLowerCase().replace(/'/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); } };
})();
