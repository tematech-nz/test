/* Renders one map to SVG markup. Used by the interactive canvas and by SVG/PNG/PDF export. */
(function (g) {
  'use strict';
  var NM = g.NetMap = g.NetMap || {};
  if (typeof require === 'function') { if (!NM.model) require('./model.js'); if (!NM.layout) require('./layout.js'); if (!NM.icons) require('./icons.js'); }
  var M = NM.model, L = NM.layout;

  var STYLE = {
    group: { fill: '#eef4ff', stroke: '#5b82cc', dash: '6 4' },
    rack: { fill: '#e6e6e6', stroke: '#555', dash: '' },
    patchpanel: { fill: '#fdf6e3', stroke: '#b58900', dash: '' },
    'switch': { fill: '#e6f4ea', stroke: '#2e7d32', dash: '' },
    router: { fill: '#e3f2fd', stroke: '#1565c0', dash: '' },
    internet: { fill: '#fff3cd', stroke: '#e65100', dash: '' },
    socket: { fill: '#f3e5f5', stroke: '#7b1fa2', dash: '' },
    generic: { fill: '#ffffff', stroke: '#777', dash: '' }
  };
  var SEL = '#e91e63', HI = '#ff9800';

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function trunc(s, n) { s = String(s); return s.length > n ? s.slice(0, Math.max(1, n - 1)) + '~' : s; }
  function num(v) { return Math.round(v * 10) / 10; }

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
    // ports of the selected fixed link / wire / patch cable are highlighted on both ends
    var selPorts = {};
    if (sel) {
      if (sel.kind === 'link' && idx.links[sel.id]) idx.links[sel.id].wires.forEach(function (w) { if (w.aPortId) selPorts[w.aPortId] = true; if (w.bPortId) selPorts[w.bPortId] = true; });
      else if (sel.kind === 'wire' && idx.wires[sel.id]) { var sw0 = idx.wires[sel.id]; if (sw0.aPortId) selPorts[sw0.aPortId] = true; if (sw0.bPortId) selPorts[sw0.bPortId] = true; }
      else if (sel.kind === 'cable' && idx.cables[sel.id]) { selPorts[idx.cables[sel.id].aPortId] = true; selPorts[idx.cables[sel.id].bPortId] = true; }
    }
    var ringSet = {};
    (opts.ringPorts || []).forEach(function (id) { ringSet[id] = true; });
    var prev = opts.preview || null;
    if (prev) prev.ids.forEach(function (id) { prevSet[id] = true; });
    items.forEach(function (it) {
      var pl = it.pl, coll = (!exporting && !it.isGroup && opts.collapsed && opts.collapsed[pl.id]) || null;
      it.coll = coll;
      // never draw equipment below the size where its port labels are readable (old or hand-edited files)
      var mn = it.isGroup ? { w: 0, h: 0 } : L.minSize(it.ref), bw = Math.max(pl.w, mn.w), bh = Math.max(pl.h, mn.h);
      it.lay = !it.isGroup && it.ref.ports.length ? L.computeLayout(it.ref, bw, bh, coll) : null;
      var anyColl = coll && Object.keys(coll).some(function (k) { return coll[k]; });
      it.box = { x: pl.x, y: pl.y, w: bw, h: it.lay && anyColl ? it.lay.h : bh, id: pl.id };
      byRef[pl.refId] = it.box;
    });

    items.forEach(function (it) {
      var pl = it.box, ref = it.ref, st = STYLE[it.isGroup ? 'group' : ref.type], plId = it.pl.id;
      grow(pl.x, pl.y, pl.w, pl.h);
      var isSel = sel && sel.id === ref.id && (sel.kind === 'group' || sel.kind === 'object');
      var isDrop = opts.drop && opts.drop.containerId === ref.id;
      var container = it.isGroup || ref.type === 'rack';
      var dim = hl && !container && !hl.objects[ref.id];
      var x = [];
      x.push('<g data-kind="' + (it.isGroup ? 'group' : 'object') + '" data-id="' + esc(ref.id) + '"' + (dim ? ' opacity="0.25"' : '') + '>');
      x.push('<rect data-kind="' + (it.isGroup ? 'group' : 'object') + '" data-id="' + esc(ref.id) + '" x="' + num(pl.x) + '" y="' + num(pl.y) + '" width="' + num(pl.w) + '" height="' + num(pl.h) + '" rx="' + (container ? 6 : (ref.type === 'internet' ? 14 : 3)) + '" fill="' + st.fill + '"' +
        (hl && container ? ' fill-opacity="0.6"' : '') + ' stroke="' + (isDrop ? '#00c853' : (isSel ? SEL : st.stroke)) + '" stroke-width="' + (isDrop ? 4 : (isSel ? 3 : 1.5)) + '"' + (st.dash ? ' stroke-dasharray="' + st.dash + '"' : '') + '/>');
      var tx = pl.x + (editing ? 22 : 6);
      var label = ref.name + (!it.isGroup && ref.type === 'rack' && ref.rackHeight ? ' (' + ref.rackHeight + 'U)' : '');
      x.push('<text x="' + num(tx) + '" y="' + num(pl.y + 14) + '" font-size="12" font-weight="bold" fill="#222" font-family="sans-serif" pointer-events="none">' + esc(trunc(label, Math.floor((pl.w - (tx - pl.x) - 4) / 6.5))) + '</text>');
      if (!it.isGroup && ref.type === 'generic' && ref.deviceKind && NM.icons) {
        var isz = ref.ports.length ? 28 : 44;
        x.push(NM.icons.svg(ref.deviceKind, num(pl.x + 6), num(ref.ports.length ? pl.y + 22 : pl.y + 20 + Math.max(0, (pl.h - 20 - isz) / 2)), isz));
      }
      if (!it.isGroup && ref.type === 'switch' && ref.portIsolation) {
        x.push('<text x="' + num(pl.x + pl.w - 5) + '" y="' + num(pl.y + 13) + '" font-size="8" text-anchor="end" fill="#b71c1c" font-family="sans-serif" pointer-events="none">PORT ISOLATION</text>');
      }
      if (!it.isGroup && (ref.type === 'router' || ref.type === 'internet') && ref.ipAddress) {
        x.push('<text x="' + num(pl.x + pl.w - 5) + '" y="' + num(pl.y + 14) + '" font-size="9" text-anchor="end" fill="#0d47a1" font-family="sans-serif" pointer-events="none">' + esc(ref.ipAddress) + '</text>');
      }
      if (it.lay) {
        if (it.lay.sections.length) {
          it.lay.sections.forEach(function (sec) {
            var rear = sec.side === 'rear' || sec.side === 'wan', coll = sec.collapsed;
            var title = { front: 'FRONT', rear: 'REAR', wan: 'WAN', lan: 'LAN' }[sec.side];
            var wanSec = sec.side === 'wan';
            x.push('<rect x="' + num(pl.x + sec.x) + '" y="' + num(pl.y + sec.y) + '" width="' + num(sec.w) + '" height="' + num(sec.h) + '" rx="3" fill="' + (wanSec ? '#fde4e1' : (rear ? '#ffe9cc' : (sec.side === 'lan' ? '#e8f5e9' : '#fffdf0'))) + '" stroke="' + (wanSec ? '#c0504d' : (rear ? '#d38b2c' : (sec.side === 'lan' ? '#4c9a50' : '#d4b44a'))) + '" stroke-width="1"' + (sec.side === 'rear' ? ' stroke-dasharray="4 2"' : '') + ' pointer-events="none"/>');
            x.push('<text x="' + num(pl.x + sec.x + 5) + '" y="' + num(pl.y + sec.y + 10.5) + '" font-size="8.5" font-weight="bold" fill="' + (wanSec ? '#8e2a26' : (rear ? '#8a4b00' : '#444')) + '" font-family="sans-serif" pointer-events="none">' + title + ' (' + sec.count + ')</text>');
            if (!exporting) {
              x.push('<g data-toggle="' + sec.side + '" data-pl="' + esc(plId) + '" style="cursor:pointer"><title>' + (coll ? 'Expand' : 'Collapse') + ' ' + sec.side + ' ports</title>' +
                '<rect data-toggle="' + sec.side + '" data-pl="' + esc(plId) + '" x="' + num(pl.x + sec.x) + '" y="' + num(pl.y + sec.y) + '" width="' + num(sec.w) + '" height="' + sec.headH + '" fill="transparent"/>' +
                '<text x="' + num(pl.x + sec.x + sec.w - 8) + '" y="' + num(pl.y + sec.y + 11) + '" font-size="12" font-weight="bold" text-anchor="middle" fill="#444" font-family="sans-serif" pointer-events="none">' + (coll ? 'v' : '^') + '</text></g>');
            }
          });
        }
        (it.lay.groups || []).forEach(function (gp) {
          x.push('<rect x="' + num(pl.x + gp.x) + '" y="' + num(pl.y + gp.y) + '" width="' + num(gp.w) + '" height="' + num(gp.h) + '" rx="3" fill="#ffffff" fill-opacity="0.7" stroke="' + (gp.side === 'rear' ? '#d9a35a' : (gp.side === 'uplink' ? '#8e6bbf' : '#cdb86a')) + '" stroke-width="' + (gp.side === 'uplink' ? 1.4 : 0.8) + '" pointer-events="none"/>');
        });
        ref.ports.forEach(function (pt) {
          var r = it.lay.ports[pt.id]; if (!r) return;
          var abs = { x: pl.x + r.x, y: pl.y + r.y, w: r.w, h: r.h, objId: ref.id, pl: pl, hidden: r.hidden };
          portGeo[pt.id] = abs;
          if (r.hidden) return;
          var use = idx.portUse[pt.id], mapped = idx.mapByPort[pt.id];
          var fill = use ? (use.kind === 'patch' ? '#bbdefb' : '#ffe0b2') : (mapped ? '#f5f5f5' : '#ffffff');
          if (!use && pt.role === 'wan') fill = '#fff3f1';
          if (!use && pt.role === 'uplink') fill = '#ede7f6';
          var isHi = hl && hl.ports[pt.id], isSelPort = sel && sel.kind === 'port' && sel.id === pt.id, isPending = opts.pendingPortId === pt.id;
          if (isHi) fill = HI;
          var stroke = isPending ? '#d500f9' : (isSelPort ? SEL : '#444'), sw = isPending || isSelPort ? 2.5 : 1;
          if (selPorts[pt.id]) { fill = '#ffeb3b'; stroke = '#e65100'; sw = 2.5; }
          if (groupSet[pt.id]) { fill = '#e1bee7'; stroke = '#8e24aa'; sw = 2.5; }
          if (prevSet[pt.id]) { fill = prev.ok ? '#c8e6c9' : '#ffcdd2'; stroke = prev.ok ? '#2e7d32' : '#c62828'; sw = 2.5; }
          x.push('<g data-kind="port" data-id="' + esc(pt.id) + '"><title>' + esc(ref.name + ' / ' + pt.label + (pt.side === 'rear' ? ' (rear)' : '') + (pt.role ? ' (' + pt.role.toUpperCase() + ')' : '') + (pt.ip ? ' ' + pt.ip : '')) + '</title>' +
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

    // fixed links: each end attaches to the REAR terminations its wires use (a bar under those ports), not to the panel box
    var pairCount = {};
    function linkAnchor(l, objId) {
      var box = byRef[objId];
      if (!box) return null;
      var rects = [];
      l.wires.forEach(function (w) {
        [w.aPortId, w.bPortId].forEach(function (pid) {
          var g = pid && portGeo[pid];
          if (g && g.objId === objId) rects.push(g);
        });
      });
      if (!rects.length) { // nothing mapped yet: use the rear strip of the panel (or its bottom edge)
        var rear = M.rearPorts(idx.objects[objId]).map(function (pt) { return portGeo[pt.id]; }).filter(Boolean);
        if (!rear.length) return { x: box.x + box.w / 2, y: box.y + box.h, bar: null, ticks: [] };
        rects = rear;
      }
      var x0 = Math.min.apply(null, rects.map(function (r) { return r.x + r.w / 2; }));
      var x1 = Math.max.apply(null, rects.map(function (r) { return r.x + r.w / 2; }));
      var y = Math.max.apply(null, rects.map(function (r) { return r.y + r.h; })) + 5;
      return { x: (x0 + x1) / 2, y: y, bar: [x0, x1, y], ticks: rects.map(function (r) { return [r.x + r.w / 2, r.y + r.h, y]; }), hidden: rects.every(function (r) { return r.hidden; }) };
    }
    // A fixed link is drawn "behind" every container/equipment it does not start or end in: only the parts over
    // its own endpoints' groups, racks and panels (or empty canvas) show. Selecting it or tracing it shows its full length.
    var parentOfRef = {};
    p.groups.forEach(function (g0) { parentOfRef[g0.id] = g0.parentGroupId || null; });
    p.objects.forEach(function (o0) { parentOfRef[o0.id] = o0.containerId || null; });
    function hiddenBehind(l) {
      var related = {};
      [l.aObjectId, l.bObjectId].forEach(function (id) {
        var cur = id, guard = 0;
        while (cur && guard++ < 20) { related[cur] = true; cur = parentOfRef[cur]; }
      });
      var holes = items.filter(function (it) {
        var par = parentOfRef[it.pl.refId];
        return !related[it.pl.refId] && (!par || related[par] || !byRef[par]);
      }).map(function (it) { return it.box; });
      if (!holes.length) return '';
      var d = 'M-100000 -100000H100000V100000H-100000Z';
      holes.forEach(function (b) { d += 'M' + num(b.x) + ' ' + num(b.y) + 'h' + num(b.w) + 'v' + num(b.h) + 'h' + num(-b.w) + 'z'; });
      return '<clipPath id="lc_' + esc(l.id) + '"><path clip-rule="evenodd" d="' + d + '"/></clipPath>';
    }
    p.fixedLinks.forEach(function (l) {
      var A = byRef[l.aObjectId], B = byRef[l.bObjectId];
      if (!A && !B) return;
      var isSel = sel && sel.id === l.id && sel.kind === 'link';
      var isHi = hl && (hl.links[l.id]);
      var dim = hl && !isHi;
      var label = l.name + ' x' + l.wires.length;
      var clip = isSel || isHi ? '' : hiddenBehind(l);
      var o = (clip ? '<defs>' + clip + '</defs>' : '') + '<g data-kind="link" data-id="' + esc(l.id) + '"' + (dim ? ' opacity="0.15"' : '') + (clip ? ' clip-path="url(#lc_' + esc(l.id) + ')"' : '') + '>';
      var anchors = [], d, mx, my;
      var aA = linkAnchor(l, l.aObjectId), aB = linkAnchor(l, l.bObjectId);
      if (aA && aB) {
        var key = [l.aObjectId, l.bObjectId].sort().join('|');
        var n = pairCount[key] = (pairCount[key] || 0) + 1;
        var cyc = Math.max(aA.y, aB.y) + 34 + (n - 1) * 16; // both ends leave downward and meet below the lower panel
        d = 'M' + num(aA.x) + ' ' + num(aA.y) + 'C' + num(aA.x) + ' ' + num(cyc) + ' ' + num(aB.x) + ' ' + num(cyc) + ' ' + num(aB.x) + ' ' + num(aB.y);
        mx = (aA.x + aB.x) / 2; my = (aA.y + 6 * cyc + aB.y) / 8 + 6;
        grow(Math.min(aA.x, aB.x), Math.min(aA.y, aB.y), Math.abs(aA.x - aB.x), cyc - Math.min(aA.y, aB.y));
        anchors = [aA, aB];
      } else {
        var an = aA || aB, otherId = aA ? l.bObjectId : l.aObjectId, other = idx.objects[otherId];
        var ocount = pairCount['stub' + (aA ? l.aObjectId : l.bObjectId)] = (pairCount['stub' + (aA ? l.aObjectId : l.bObjectId)] || 0) + 1;
        var sy = an.y + 28 + (ocount - 1) * 14;
        d = 'M' + num(an.x) + ' ' + num(an.y) + 'L' + num(an.x) + ' ' + num(sy);
        mx = an.x; my = sy + 12;
        label = label + ' -> ' + (other ? other.name : '?') + (other ? ' [' + (M.mapsFor(p, 'object', other.id).map(function (m) { return idx.maps[m].name; }).join(', ') || 'not on a map') + ']' : '');
        grow(an.x - 20, an.y, 40, sy - an.y + 20);
        anchors = [an];
      }
      // bar + ticks tie the thick line to the exact rear ports
      anchors.forEach(function (an) {
        if (an.bar) {
          var bar = 'M' + num(an.bar[0]) + ' ' + num(an.bar[2]) + 'H' + num(an.bar[1]);
          an.ticks.forEach(function (t) { bar += 'M' + num(t[0]) + ' ' + num(t[1]) + 'V' + num(t[2]); });
          o += '<path d="' + bar + '" stroke="' + (isSel ? SEL : '#37474f') + '" stroke-width="2" fill="none" stroke-linecap="round" pointer-events="none"/>';
        }
      });
      o += '<path d="' + d + '" stroke="transparent" stroke-width="16" fill="none" data-kind="link" data-id="' + esc(l.id) + '"/>';
      if (isHi) o += '<path d="' + d + '" stroke="' + HI + '" stroke-width="11" fill="none" opacity="0.7" pointer-events="none"/>';
      o += '<path d="' + d + '" stroke="' + (isSel ? SEL : '#37474f') + '" stroke-width="6" fill="none" stroke-linecap="round" pointer-events="none"/>';
      o += '<path d="' + d + '" stroke="#ffffff" stroke-width="1.6" stroke-dasharray="7 5" fill="none" pointer-events="none"/>';
      var tw = label.length * 5.8 + 8;
      o += '<rect x="' + num(mx - tw / 2) + '" y="' + num(my - 9) + '" width="' + num(tw) + '" height="13" rx="3" fill="#fff" stroke="#37474f" stroke-width="0.8" pointer-events="none"/>' +
        '<text x="' + num(mx) + '" y="' + num(my + 1) + '" font-size="10" text-anchor="middle" fill="#222" font-family="sans-serif" pointer-events="none">' + esc(label) + '</text></g>';
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
      o += '<path d="' + d + '" stroke="#37474f" stroke-width="' + (isSel ? 5.5 : 4) + '" fill="none" stroke-linecap="round" opacity="0.55" pointer-events="none"/>'; // outline keeps white/yellow cables visible
      o += '<path d="' + d + '" stroke="' + (isSel ? SEL : esc(c.color)) + '" stroke-width="' + (isSel ? 3.5 : 2.4) + '" fill="none" stroke-linecap="round" pointer-events="none"/>';
      if (exporting || isSel || isHi || !(a && b)) {
        o += '<text x="' + num(mx) + '" y="' + num(my) + '" font-size="9" text-anchor="middle" fill="#111" stroke="#fff" stroke-width="2.5" paint-order="stroke" font-family="sans-serif" pointer-events="none">' + esc(label) + '</text>';
      }
      o += '</g>';
      cableParts.push(o);
    });

    Object.keys(ringSet).forEach(function (pid) {
      var gp = portGeo[pid];
      if (!gp) return;
      var cx = gp.x + gp.w / 2, cy = gp.y + gp.h / 2, rr = Math.max(gp.w, gp.h) / 2 + 6;
      cableParts.push('<g data-ring="' + esc(pid) + '" pointer-events="none"><circle cx="' + num(cx) + '" cy="' + num(cy) + '" r="' + num(rr) + '" fill="none" stroke="#d500f9" stroke-width="3"/>' +
        '<circle cx="' + num(cx) + '" cy="' + num(cy) + '" r="' + num(rr + 4) + '" fill="none" stroke="#d500f9" stroke-width="1.5" stroke-dasharray="3 3"/></g>');
    });
    if (opts.drop && opts.drop.line) {
      var ln = opts.drop.line;
      cableParts.push('<g data-drop="line" pointer-events="none"><path d="M' + num(ln.x) + ' ' + num(ln.y) + 'h' + num(ln.w) + '" stroke="#00c853" stroke-width="4" stroke-linecap="round"/>' +
        '<path d="M' + num(ln.x) + ' ' + num(ln.y - 5) + 'l7 5l-7 5z M' + num(ln.x + ln.w) + ' ' + num(ln.y - 5) + 'l-7 5l7 5z" fill="#00c853"/></g>');
    }
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
