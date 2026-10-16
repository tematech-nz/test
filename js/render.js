/* Renders one map to SVG markup. Used by the interactive canvas and by SVG/PNG/PDF export. */
(function (g) {
  'use strict';
  var NM = g.NetMap = g.NetMap || {};
  if (typeof require === 'function') { if (!NM.model) require('./model.js'); if (!NM.layout) require('./layout.js'); }
  var M = NM.model, L = NM.layout;

  var STYLE = {
    group: { fill: '#eef4ff', stroke: '#5b82cc', dash: '6 4' },
    rack: { fill: '#e6e6e6', stroke: '#555', dash: '' },
    patchpanel: { fill: '#fdf6e3', stroke: '#b58900', dash: '' },
    'switch': { fill: '#e6f4ea', stroke: '#2e7d32', dash: '' },
    socket: { fill: '#f3e5f5', stroke: '#7b1fa2', dash: '' },
    generic: { fill: '#ffffff', stroke: '#777', dash: '' }
  };
  var SEL = '#e91e63', HI = '#ff9800';

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function trunc(s, n) { s = String(s); return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '~' : s; }
  function num(v) { return Math.round(v * 10) / 10; }

  function clipToRect(pl, tx, ty) {
    var cx = pl.x + pl.w / 2, cy = pl.y + pl.h / 2, dx = tx - cx, dy = ty - cy;
    if (!dx && !dy) return { x: cx, y: cy };
    var sx = dx ? (pl.w / 2) / Math.abs(dx) : Infinity, sy = dy ? (pl.h / 2) / Math.abs(dy) : Infinity;
    var s = Math.min(sx, sy);
    return { x: cx + dx * s, y: cy + dy * s };
  }

  function containerDepth(p, id) {
    var d = 0, c = M.findContainer(p, id), guard = 0;
    while (c && guard++ < 20) {
      var par = M.parentOf(p, c.kind, c.id);
      if (!par) break;
      d++; c = par;
    }
    return d;
  }

  function renderMap(p, mapId, opts) {
    opts = opts || {};
    var idx = M.buildIndex(p);
    var mode = opts.mode || 'view', editing = mode === 'edit', exporting = mode === 'export';
    var hl = opts.highlight || null, sel = opts.selection || null;
    var pls = p.placements.filter(function (x) { return x.mapId === mapId; });
    var byRef = {};
    var portGeo = {}; // portId -> absolute rect
    var parts = [], cableParts = [], bounds = null;

    function grow(x, y, w, h) {
      if (!bounds) bounds = { x0: x, y0: y, x1: x + w, y1: y + h };
      else { bounds.x0 = Math.min(bounds.x0, x); bounds.y0 = Math.min(bounds.y0, y); bounds.x1 = Math.max(bounds.x1, x + w); bounds.y1 = Math.max(bounds.y1, y + h); }
    }

    // draw order: containers by depth, then equipment
    var items = pls.map(function (pl) {
      var isGroup = pl.refType === 'group', ref = isGroup ? idx.groups[pl.refId] : idx.objects[pl.refId];
      return { pl: pl, ref: ref, isGroup: isGroup, rank: !ref ? 99 : (isGroup ? 0 : (ref.type === 'rack' ? 1 : 2)), depth: ref ? containerDepth(p, pl.refId) : 0 };
    }).filter(function (it) { return it.ref; });
    items.sort(function (a, b) { return a.rank - b.rank || a.depth - b.depth; });
    // effective box: collapsed patch-panel sections shrink the drawn height (view state only, never stored)
    var groupSet = {}, prevSet = {};
    (opts.groupPorts || []).forEach(function (id) { groupSet[id] = true; });
    var prev = opts.preview || null;
    if (prev) prev.ids.forEach(function (id) { prevSet[id] = true; });
    items.forEach(function (it) {
      var pl = it.pl, coll = (!exporting && !it.isGroup && opts.collapsed && opts.collapsed[pl.id]) || null;
      it.coll = coll;
      it.lay = !it.isGroup && it.ref.ports.length ? L.computeLayout(it.ref, pl.w, pl.h, coll) : null;
      var anyColl = coll && (coll.front || coll.rear);
      it.box = { x: pl.x, y: pl.y, w: pl.w, h: it.lay && anyColl ? it.lay.h : pl.h, id: pl.id };
      byRef[pl.refId] = it.box;
    });

    items.forEach(function (it) {
      var pl = it.box, ref = it.ref, st = STYLE[it.isGroup ? 'group' : ref.type], plId = it.pl.id;
      grow(pl.x, pl.y, pl.w, pl.h);
      var isSel = sel && sel.id === ref.id && (sel.kind === 'group' || sel.kind === 'object');
      var container = it.isGroup || ref.type === 'rack';
      var dim = hl && !container && !hl.objects[ref.id];
      var x = [];
      x.push('<g data-kind="' + (it.isGroup ? 'group' : 'object') + '" data-id="' + esc(ref.id) + '"' + (dim ? ' opacity="0.25"' : '') + '>');
      x.push('<rect data-kind="' + (it.isGroup ? 'group' : 'object') + '" data-id="' + esc(ref.id) + '" x="' + num(pl.x) + '" y="' + num(pl.y) + '" width="' + num(pl.w) + '" height="' + num(pl.h) + '" rx="' + (container ? 6 : 3) + '" fill="' + st.fill + '"' +
        (hl && container ? ' fill-opacity="0.6"' : '') + ' stroke="' + (isSel ? SEL : st.stroke) + '" stroke-width="' + (isSel ? 3 : 1.5) + '"' + (st.dash ? ' stroke-dasharray="' + st.dash + '"' : '') + '/>');
      var tx = pl.x + (editing ? 22 : 6);
      var label = ref.name + (!it.isGroup && ref.type === 'rack' && ref.rackHeight ? ' (' + ref.rackHeight + 'U)' : '');
      x.push('<text x="' + num(tx) + '" y="' + num(pl.y + 14) + '" font-size="12" font-weight="bold" fill="#222" font-family="sans-serif" pointer-events="none">' + esc(trunc(label, Math.floor((pl.w - (tx - pl.x) - 4) / 6.5))) + '</text>');
      if (it.lay) {
        if (it.lay.sections.length) {
          it.lay.sections.forEach(function (sec) {
            var rear = sec.side === 'rear', coll = sec.collapsed;
            x.push('<rect x="' + num(pl.x + sec.x) + '" y="' + num(pl.y + sec.y) + '" width="' + num(sec.w) + '" height="' + num(sec.h) + '" rx="3" fill="' + (rear ? '#ffe9cc' : '#fffdf0') + '" stroke="' + (rear ? '#d38b2c' : '#d4b44a') + '" stroke-width="1"' + (rear ? ' stroke-dasharray="4 2"' : '') + ' pointer-events="none"/>');
            x.push('<text x="' + num(pl.x + sec.x + 5) + '" y="' + num(pl.y + sec.y + 10.5) + '" font-size="8.5" font-weight="bold" fill="' + (rear ? '#8a4b00' : '#7a6200') + '" font-family="sans-serif" pointer-events="none">' + (rear ? 'REAR' : 'FRONT') + ' (' + sec.count + ')</text>');
            if (!exporting) {
              x.push('<g data-toggle="' + sec.side + '" data-pl="' + esc(plId) + '" style="cursor:pointer"><title>' + (coll ? 'Expand' : 'Collapse') + ' ' + sec.side + ' ports</title>' +
                '<rect data-toggle="' + sec.side + '" data-pl="' + esc(plId) + '" x="' + num(pl.x + sec.x) + '" y="' + num(pl.y + sec.y) + '" width="' + num(sec.w) + '" height="' + sec.headH + '" fill="transparent"/>' +
                '<text x="' + num(pl.x + sec.x + sec.w - 8) + '" y="' + num(pl.y + sec.y + 11) + '" font-size="12" font-weight="bold" text-anchor="middle" fill="#444" font-family="sans-serif" pointer-events="none">' + (coll ? 'v' : '^') + '</text></g>');
            }
          });
        }
        ref.ports.forEach(function (pt) {
          var r = it.lay.ports[pt.id]; if (!r) return;
          var abs = { x: pl.x + r.x, y: pl.y + r.y, w: r.w, h: r.h, objId: ref.id, pl: pl, hidden: r.hidden };
          portGeo[pt.id] = abs;
          if (r.hidden) return;
          var use = idx.portUse[pt.id], mapped = idx.mapByPort[pt.id];
          var fill = use ? (use.kind === 'patch' ? '#bbdefb' : '#ffe0b2') : (mapped ? '#f5f5f5' : '#ffffff');
          var isHi = hl && hl.ports[pt.id], isSelPort = sel && sel.kind === 'port' && sel.id === pt.id, isPending = opts.pendingPortId === pt.id;
          if (isHi) fill = HI;
          var stroke = isPending ? '#d500f9' : (isSelPort ? SEL : '#444'), sw = isPending || isSelPort ? 2.5 : 1;
          if (groupSet[pt.id]) { fill = '#e1bee7'; stroke = '#8e24aa'; sw = 2.5; }
          if (prevSet[pt.id]) { fill = prev.ok ? '#c8e6c9' : '#ffcdd2'; stroke = prev.ok ? '#2e7d32' : '#c62828'; sw = 2.5; }
          x.push('<g data-kind="port" data-id="' + esc(pt.id) + '"><title>' + esc(ref.name + ' / ' + pt.label + (pt.side === 'rear' ? ' (rear)' : '')) + '</title>' +
            '<rect data-kind="port" data-id="' + esc(pt.id) + '" x="' + num(abs.x) + '" y="' + num(abs.y) + '" width="' + num(abs.w) + '" height="' + num(abs.h) + '" rx="2" fill="' + fill + '" stroke="' + stroke + '" stroke-width="' + sw + '"' + (pt.side === 'rear' ? ' stroke-dasharray="3 1"' : '') + '/>' +
            '<text x="' + num(abs.x + abs.w / 2) + '" y="' + num(abs.y + abs.h / 2 + 3) + '" font-size="' + num(Math.min(9, abs.h * 0.55)) + '" text-anchor="middle" fill="#111" font-family="sans-serif" pointer-events="none">' + esc(trunc(pt.label, Math.max(1, Math.floor(abs.w / 5.5)))) + '</text></g>');
        });
      }
      if (editing) {
        x.push('<rect data-handle="move" data-pl="' + esc(plId) + '" x="' + num(pl.x + 3) + '" y="' + num(pl.y + 3) + '" width="16" height="14" rx="2" fill="#37474f" style="cursor:move"/>' +
          '<path d="M' + num(pl.x + 6) + ' ' + num(pl.y + 8) + 'h10M' + num(pl.x + 6) + ' ' + num(pl.y + 12) + 'h10" stroke="#fff" stroke-width="1.5" pointer-events="none"/>');
        x.push('<rect data-handle="resize" data-pl="' + esc(plId) + '" x="' + num(pl.x + pl.w - 12) + '" y="' + num(pl.y + pl.h - 12) + '" width="12" height="12" fill="#37474f" opacity="0.7" style="cursor:nwse-resize"/>');
      }
      x.push('</g>');
      parts.push(x.join(''));
    });

    function portCenter(pid) {
      var a = portGeo[pid]; return a ? { x: a.x + a.w / 2, y: a.y + a.h / 2, dir: (a.y + a.h / 2) < (a.pl.y + a.pl.h / 2) ? -1 : 1 } : null;
    }
    function otherEndLabel(pid) {
      var o = idx.portObj[pid], ms = o ? M.mapsFor(p, 'object', o.id) : [];
      return (o ? o.name + ' / ' + idx.ports[pid].label : '?') + (ms.length ? ' [' + ms.map(function (m) { return idx.maps[m] ? idx.maps[m].name : '?'; }).join(', ') + ']' : ' [not on a map]');
    }

    // fixed links
    var pairCount = {};
    p.fixedLinks.forEach(function (l) {
      var A = byRef[l.aObjectId], B = byRef[l.bObjectId];
      if (!A && !B) return;
      var isSel = sel && sel.id === l.id && sel.kind === 'link';
      var isHi = hl && (hl.links[l.id]);
      var dim = hl && !isHi;
      var label = l.name + ' x' + l.wires.length;
      var o = '<g data-kind="link" data-id="' + esc(l.id) + '"' + (dim ? ' opacity="0.15"' : '') + '>';
      var x1, y1, x2, y2, ox = 0, oy = 0;
      if (A && B) {
        var key = [A.id, B.id].sort().join('|');
        var n = pairCount[key] = (pairCount[key] || 0) + 1;
        var acx = A.x + A.w / 2, acy = A.y + A.h / 2, bcx = B.x + B.w / 2, bcy = B.y + B.h / 2;
        var len = Math.sqrt((bcx - acx) * (bcx - acx) + (bcy - acy) * (bcy - acy)) || 1;
        ox = -(bcy - acy) / len * (n - 1) * 12; oy = (bcx - acx) / len * (n - 1) * 12;
        var pa = clipToRect(A, bcx, bcy), pb = clipToRect(B, acx, acy);
        x1 = pa.x + ox; y1 = pa.y + oy; x2 = pb.x + ox; y2 = pb.y + oy;
      } else {
        var P = A || B, otherId = A ? l.bObjectId : l.aObjectId, other = idx.objects[otherId];
        var ocount = pairCount['stub' + P.id] = (pairCount['stub' + P.id] || 0) + 1;
        x1 = P.x + P.w; y1 = P.y + P.h / 2 + (ocount - 1) * 14; x2 = x1 + 70; y2 = y1;
        label = label + ' -> ' + (other ? other.name : '?') + (other ? ' [' + (M.mapsFor(p, 'object', other.id).map(function (m) { return idx.maps[m].name; }).join(', ') || 'not on a map') + ']' : '');
      }
      grow(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      var d = 'M' + num(x1) + ' ' + num(y1) + 'L' + num(x2) + ' ' + num(y2);
      o += '<path d="' + d + '" stroke="transparent" stroke-width="16" fill="none" data-kind="link" data-id="' + esc(l.id) + '"/>';
      if (isHi) o += '<path d="' + d + '" stroke="' + HI + '" stroke-width="11" fill="none" opacity="0.7" pointer-events="none"/>';
      o += '<path d="' + d + '" stroke="' + (isSel ? SEL : '#37474f') + '" stroke-width="6" fill="none" stroke-linecap="round" pointer-events="none"/>';
      o += '<path d="' + d + '" stroke="#ffffff" stroke-width="1.6" stroke-dasharray="7 5" fill="none" pointer-events="none"/>';
      var mx = (x1 + x2) / 2, my = (y1 + y2) / 2, tw = label.length * 5.8 + 8;
      o += '<rect x="' + num(mx - tw / 2) + '" y="' + num(my - 16) + '" width="' + num(tw) + '" height="13" rx="3" fill="#fff" stroke="#37474f" stroke-width="0.8" pointer-events="none"/>' +
        '<text x="' + num(mx) + '" y="' + num(my - 6) + '" font-size="10" text-anchor="middle" fill="#222" font-family="sans-serif" pointer-events="none">' + esc(label) + '</text></g>';
      cableParts.push(o);
    });

    // patch cables
    p.patchCables.forEach(function (c) {
      var a = portCenter(c.aPortId), b = portCenter(c.bPortId);
      if (!a && !b) return;
      var isSel = sel && sel.id === c.id && sel.kind === 'cable';
      var isHi = hl && hl.cables[c.id], dim = hl && !isHi;
      var d, mx, my, label = c.name;
      if (a && b) {
        var dist = Math.abs(a.x - b.x) + Math.abs(a.y - b.y), off = 22 + Math.min(70, dist * 0.15);
        d = 'M' + num(a.x) + ' ' + num(a.y) + 'C' + num(a.x) + ' ' + num(a.y + a.dir * off) + ' ' + num(b.x) + ' ' + num(b.y + b.dir * off) + ' ' + num(b.x) + ' ' + num(b.y);
        mx = (a.x * 4 + b.x * 4) / 8; my = (a.y + 3 * (a.y + a.dir * off) + 3 * (b.y + b.dir * off) + b.y) / 8;
        grow(Math.min(a.x, b.x), Math.min(a.y, b.y) - off, Math.abs(a.x - b.x), Math.abs(a.y - b.y) + 2 * off);
      } else {
        var e = a || b, other = a ? c.bPortId : c.aPortId;
        var ex = e.x, ey = e.y + e.dir * 36;
        d = 'M' + num(e.x) + ' ' + num(e.y) + 'L' + num(ex) + ' ' + num(ey);
        mx = ex; my = ey + (e.dir > 0 ? 10 : -4);
        label = c.name + ' -> ' + otherEndLabel(other);
        grow(ex - 20, Math.min(e.y, ey) - 14, 40, Math.abs(ey - e.y) + 28);
      }
      var o = '<g data-kind="cable" data-id="' + esc(c.id) + '"' + (dim ? ' opacity="0.12"' : '') + '>';
      o += '<path d="' + d + '" stroke="transparent" stroke-width="12" fill="none" data-kind="cable" data-id="' + esc(c.id) + '"/>';
      if (isHi) o += '<path d="' + d + '" stroke="' + HI + '" stroke-width="8" fill="none" opacity="0.7" pointer-events="none"/>';
      o += '<path d="' + d + '" stroke="' + (isSel ? SEL : esc(c.color)) + '" stroke-width="' + (isSel ? 3.5 : 2.2) + '" fill="none" stroke-linecap="round" pointer-events="none"/>';
      if (exporting || isSel || isHi || !(a && b)) {
        o += '<text x="' + num(mx) + '" y="' + num(my) + '" font-size="9" text-anchor="middle" fill="#111" stroke="#fff" stroke-width="2.5" paint-order="stroke" font-family="sans-serif" pointer-events="none">' + esc(label) + '</text>';
      }
      o += '</g>';
      cableParts.push(o);
    });

    var pad = 40;
    if (!bounds) bounds = { x0: 0, y0: 0, x1: 400, y1: 300 };
    var b = { x: bounds.x0 - pad, y: bounds.y0 - pad, w: bounds.x1 - bounds.x0 + pad * 2, h: bounds.y1 - bounds.y0 + pad * 2 };
    var legend = '';
    if (exporting) {
      var lx = b.x + 8, ly = b.y + 6, m = idx.maps[mapId];
      b.y -= 36; b.h += 36;
      legend = '<text x="' + num(lx) + '" y="' + num(ly - 12) + '" font-size="16" font-weight="bold" font-family="sans-serif" fill="#111">' + esc((p.name || '') + ' - ' + (m ? m.name : '')) + '</text>' +
        '<path d="M' + num(lx) + ' ' + num(ly + 6) + 'h40" stroke="#1f77b4" stroke-width="2.2"/><text x="' + num(lx + 46) + '" y="' + num(ly + 10) + '" font-size="10" font-family="sans-serif">Patch cable</text>' +
        '<path d="M' + num(lx + 130) + ' ' + num(ly + 6) + 'h40" stroke="#37474f" stroke-width="6"/><path d="M' + num(lx + 130) + ' ' + num(ly + 6) + 'h40" stroke="#fff" stroke-width="1.6" stroke-dasharray="7 5"/><text x="' + num(lx + 176) + '" y="' + num(ly + 10) + '" font-size="10" font-family="sans-serif">Fixed link (installed)</text>';
    }
    return { content: parts.join('') + cableParts.join('') + legend, bounds: b, portGeo: portGeo };
  }

  function svgDocument(p, mapId) {
    var r = renderMap(p, mapId, { mode: 'export' });
    var b = r.bounds;
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + num(b.x) + ' ' + num(b.y) + ' ' + num(b.w) + ' ' + num(b.h) + '" width="' + Math.ceil(b.w) + '" height="' + Math.ceil(b.h) + '">' +
      '<rect x="' + num(b.x) + '" y="' + num(b.y) + '" width="' + num(b.w) + '" height="' + num(b.h) + '" fill="#ffffff"/>' + r.content + '</svg>';
  }

  NM.render = { renderMap: renderMap, svgDocument: svgDocument, esc: esc, STYLE: STYLE };
  if (typeof module !== 'undefined' && module.exports) module.exports = NM.render;
})(typeof window !== 'undefined' ? window : globalThis);
