/* Geometry helpers: default sizes, sections and port positions. Independent of the DOM. */
(function (g) {
  'use strict';
  var NM = g.NetMap = g.NetMap || {};
  var HEADER = 20, CELL = 18, MAXCOLS = 16, PADX = 6, SECHEAD = 14, SECGAP = 4, SECPAD = 3;

  var SGAP = 8, LINEMAX = 24;
  if (typeof require === 'function' && !NM.model) require('./model.js');
  var SECTIONED = { patchpanel: true, router: true, socket: true };
  var ICONW = 34;
  /* generic equipment drawn with a device icon keeps room for it on the left */
  function iconW(obj) { return obj.type === 'generic' && obj.deviceKind ? ICONW : 0; }
  /* strip key of a port: front/rear on patch panels, wan/lan on routers */
  function keyOf(obj, p) { return obj.type === 'router' ? (p.role === 'wan' ? 'wan' : 'lan') : p.side; }
  function inSide(obj, side) { return obj.ports.filter(function (p) { return keyOf(obj, p) === side; }); }
  function sideCount(obj, side) { return inSide(obj, side).length; }
  function gridFor(n) {
    if (n <= 0) return { rows: 0, cols: 0 };
    var rows = Math.ceil(n / MAXCOLS);
    return { rows: rows, cols: Math.ceil(n / rows) };
  }
  /* patch panels: ports are drawn in equal sections (e.g. 3 x 8) laid out in one line where they fit */
  /* patch panels always use sections (automatic split unless chosen); switches only when a valid split was chosen */
  function usesSections(obj) {
    if (obj.type === 'patchpanel') return true;
    var n = obj.ports.filter(function (x) { return x.role !== 'uplink'; }).length;
    return obj.type === 'switch' && obj.sectionSize > 0 && n > 0 && n % obj.sectionSize === 0;
  }
  function gridOf(obj, side) {
    var n = sideCount(obj, side);
    if (!usesSections(obj)) return gridFor(n);
    if (n <= 0) return { rows: 0, cols: 0, perRow: 0, size: 0, nsec: 0 };
    var size = obj.type === 'switch' ? obj.sectionSize : NM.model.effectiveSectionSize(obj, n), nsec = n / size;
    var perRow = Math.max(1, Math.min(nsec, Math.floor(LINEMAX / size)));
    return { rows: Math.ceil(nsec / perRow), cols: perRow * size, perRow: perRow, size: size, nsec: nsec };
  }
  function sidesOf(obj) { return (obj.type === 'router' ? ['wan', 'lan'] : ['front', 'rear']).filter(function (s) { return sideCount(obj, s) > 0; }); }

  /* natural height of a patch panel: title + one strip per side + port rows of expanded sides */
  function panelHeight(obj, collapsed) {
    collapsed = collapsed || {};
    var sides = sidesOf(obj), rows = 0;
    sides.forEach(function (s) { if (!collapsed[s]) rows += gridOf(obj, s).rows; });
    return HEADER + sides.length * (SECHEAD + SECGAP) + rows * (CELL + 2) + 4;
  }

  /* width of one port cell: wide enough that the longest label is readable (2 chars = the 18px default) */
  function cellFor(obj) {
    var m = 0;
    obj.ports.forEach(function (p) { m = Math.max(m, String(p.label == null ? '' : p.label).length); });
    return Math.max(CELL, Math.min(64, m * 6 + 6));
  }

  /*
   * Switches: access ports in equal sections (rows x columns each, lines of up to 24 ports), optional uplink ports in a
   * block of their own on the left or right, and left/center/right alignment of the whole block when the switch is wider
   * than its natural width. Without a section size the access ports keep the plain grid.
   */
  var LINEGAP = 6;
  function switchSpec(obj) {
    var access = obj.ports.filter(function (x) { return x.role !== 'uplink'; }), u = obj.ports.length - access.length, n = access.length;
    var sec = usesSections(obj), size, nsec, R, C, perRow, order;
    if (sec) {
      size = obj.sectionSize; nsec = n / size;
      R = obj.sectionRows > 0 && size % obj.sectionRows === 0 ? obj.sectionRows : 1; C = size / R;
      perRow = Math.max(1, Math.min(nsec, Math.floor(LINEMAX / size)));
      order = obj.portOrder === 'rows' ? 'rows' : (R > 1 ? 'columns' : 'rows');
    } else {
      var gr = gridFor(n); size = n; nsec = n ? 1 : 0; R = gr.rows; C = gr.cols; perRow = 1; order = 'rows';
    }
    var lines = nsec ? Math.ceil(nsec / perRow) : 0, upRows = u ? Math.max(1, Math.min(R || 1, u, obj.uplinkRows > 0 ? obj.uplinkRows : 1)) : 0, upCols = u ? Math.ceil(u / upRows) : 0;
    var cw = cellFor(obj), secW = C * cw, lineW = nsec ? perRow * secW + (perRow - 1) * SGAP : 0, upW = upCols * cw;
    var contentW = lineW + (u ? (nsec ? SGAP : 0) + upW : 0);
    var rowsAll = Math.max(lines * R, upRows, 1);
    return {
      access: access, uplinks: obj.ports.filter(function (x) { return x.role === 'uplink'; }), sectioned: sec, size: size, nsec: nsec, R: R, C: C, perRow: perRow, order: order,
      lines: lines, upRows: upRows, upCols: upCols, cw: cw, secW: secW, lineW: lineW, upW: upW, contentW: contentW, rowsAll: rowsAll,
      w: Math.max(contentW + PADX * 2 + 2, obj.type === 'switch' ? 60 : 0), h: HEADER + 2 + rowsAll * (CELL + 2) + Math.max(0, lines - 1) * LINEGAP + 6
    };
  }
  function switchLayout(obj, w, h, out) {
    var s = switchSpec(obj), y0 = HEADER + 2;
    var rowH = Math.max(CELL + 2, (h - HEADER - 8 - Math.max(0, s.lines - 1) * LINEGAP) / s.rowsAll);
    var pw = Math.min(s.cw - 2, 26), ph = Math.min(rowH - 2, 22);
    var extra = Math.max(0, w - PADX * 2 - s.contentW), off = obj.align === 'center' ? extra / 2 : (obj.align === 'right' ? extra : 0);
    var x0 = PADX + off, upLeft = obj.uplinkSide === 'left' && s.uplinks.length;
    var upY = y0 + Math.max(0, ((s.lines ? s.R : s.upRows) - s.upRows) * rowH / 2); // uplinks sit vertically centred beside taller sections
    var secX = x0 + (upLeft ? s.upW + SGAP : 0), upX = upLeft ? x0 : x0 + s.lineW + (s.nsec ? SGAP : 0);
    s.access.forEach(function (p, i) {
      var sec = Math.floor(i / s.size), k = i % s.size, line = Math.floor(sec / s.perRow), c = sec % s.perRow, row, col;
      if (s.order === 'columns') { col = Math.floor(k / s.R); row = k % s.R; } else { row = Math.floor(k / s.C); col = k % s.C; }
      var sx = secX + c * (s.secW + SGAP), sy = y0 + line * (s.R * rowH + LINEGAP);
      out.ports[p.id] = { x: sx + col * s.cw + (s.cw - pw) / 2, y: sy + row * rowH + (rowH - ph) / 2, w: pw, h: ph, side: 'front', hidden: false };
      if (s.sectioned && k === 0) out.groups.push({ x: sx - 1, y: sy + 1, w: s.secW + 2, h: s.R * rowH - 2, side: 'front' });
    });
    s.uplinks.forEach(function (p, j) {
      var col = Math.floor(j / s.upRows), row = j % s.upRows;
      out.ports[p.id] = { x: upX + col * s.cw + (s.cw - pw) / 2, y: upY + row * rowH + (rowH - ph) / 2, w: pw, h: ph, side: 'front', hidden: false };
    });
    if (s.uplinks.length) out.groups.push({ x: upX - 1, y: upY + 1, w: s.upW + 2, h: s.upRows * rowH - 2, side: 'uplink' });
    return out;
  }

  function defaultSize(obj) {
    if (obj.type === 'switch' && obj.ports.length) { var sp = switchSpec(obj); return { w: sp.w, h: sp.h }; }
    if (obj.type === 'rack') return { w: 340, h: 300 };
    if (obj.type === 'generic' && !obj.ports.length) return { w: 120, h: obj.deviceKind ? 64 : 60 };
    var ks = sidesOf(obj), gs = ks.map(function (k) { return gridOf(obj, k); });
    var front = gs[0] || { rows: 0, cols: 0 }, rear = gs[1] || { rows: 0, cols: 0 };
    var cols = Math.max(front.cols, rear.cols, 4);
    var w = cols * cellFor(obj) + PADX * 2 + (SECTIONED[obj.type] ? 6 : 0);
    if (obj.type === 'generic') w = Math.max(w, 100) + iconW(obj);
    if (obj.type === 'socket') w = Math.max(w, 96);
    if (usesSections(obj)) w += (Math.max(front.perRow || 1, rear.perRow || 1) - 1) * SGAP;
    if (obj.type === 'router') w = Math.max(w, 150);
    if (obj.type === 'internet') w = Math.max(w, 130);
    if (SECTIONED[obj.type]) return { w: w, h: panelHeight(obj, {}) };
    return { w: w, h: HEADER + Math.max((front.rows + rear.rows) * (CELL + 2), iconW(obj) ? 30 : 0) + 8 };
  }
  function defaultGroupSize() { return { w: 420, h: 340 }; }

  /*
   * Smallest size at which every port label stays readable. Equipment with ports can never be drawn smaller than its
   * natural size (it may be larger); empty equipment and containers have small fixed minimums (containers are also
   * limited by their contents - see builder.minPlacementSize).
   */
  function minSize(obj) {
    if (obj.type === 'rack') return { w: 160, h: 80 };
    if (!obj.ports.length) return obj.deviceKind ? { w: 100, h: 56 } : { w: 80, h: 40 };
    return defaultSize(obj);
  }

  function placeGrid(obj, side, list, x0, y0, w, rowH, out, hidden) {
    var gr = gridFor(list.length);
    var cellW = Math.max(8, (w - PADX * 2) / gr.cols);
    var pw = Math.min(cellW - 2, 26), ph = Math.min(rowH - 2, 22);
    list.forEach(function (p, i) {
      var r = Math.floor(i / gr.cols), c = i % gr.cols;
      out[p.id] = { x: x0 + PADX + c * cellW + (cellW - pw) / 2, y: y0 + r * rowH + (rowH - ph) / 2, w: pw, h: ph, side: side, hidden: !!hidden };
    });
    return gr.rows;
  }

  function placeSections(side, list, y0, w, rowH, out, gr, groups) {
    var usable = w - PADX * 2 - (gr.perRow - 1) * SGAP;
    var cellW = Math.max(6, usable / gr.cols), pw = Math.min(cellW - 2, 26), ph = Math.min(rowH - 2, 22);
    list.forEach(function (p, i) {
      var sec = Math.floor(i / gr.size), k = i % gr.size, r = Math.floor(sec / gr.perRow), c = sec % gr.perRow;
      var sx = PADX + c * (gr.size * cellW + SGAP);
      out[p.id] = { x: sx + k * cellW + (cellW - pw) / 2, y: y0 + r * rowH + (rowH - ph) / 2, w: pw, h: ph, side: side, hidden: false };
      if (k === 0) groups.push({ x: sx - 1, y: y0 + r * rowH + 1, w: gr.size * cellW + 2, h: rowH - 2, side: side });
    });
  }

  /*
   * Full layout of an object in a box of w x h.
   * Returns { ports: {id -> rect}, sections: [{side,x,y,w,h,headH,collapsed}], h: effectiveHeight }.
   * Patch panels get a separate strip per side (front / rear) that can be collapsed.
   * Collapsed ports are anchored to the middle of their strip (hidden: true).
   */
  function computeLayout(obj, w, h, collapsed) {
    collapsed = collapsed || {};
    var out = { ports: {}, sections: [], groups: [], h: h };
    var sides = sidesOf(obj);
    if (!sides.length) return out;
    if (obj.type === 'switch') return switchLayout(obj, w, h, out);
    if (SECTIONED[obj.type]) {
      var chrome = HEADER + sides.length * (SECHEAD + SECGAP) + 4;
      var anyCollapsed = sides.some(function (s) { return collapsed[s]; });
      var rows = 0;
      sides.forEach(function (s) { if (!collapsed[s]) rows += gridOf(obj, s).rows; });
      var rowH = anyCollapsed || !rows ? CELL + 2 : Math.max(CELL + 2, (h - chrome) / rows);
      var y = HEADER;
      sides.forEach(function (side) {
        var list = inSide(obj, side);
        var gr = gridOf(obj, side), coll = !!collapsed[side];
        var sh = SECHEAD + (coll ? 0 : gr.rows * rowH);
        out.sections.push({ side: side, x: SECPAD, y: y, w: w - SECPAD * 2, h: sh, headH: SECHEAD, collapsed: coll, count: list.length });
        if (coll) {
          list.forEach(function (p) { out.ports[p.id] = { x: w / 2 - 2, y: y, w: 4, h: SECHEAD, side: side, hidden: true }; });
        } else if (usesSections(obj)) placeSections(side, list, y + SECHEAD, w, rowH, out.ports, gr, out.groups);
        else placeGrid(obj, side, list, 0, y + SECHEAD, w, rowH, out.ports, false);
        y += sh + SECGAP;
      });
      out.h = anyCollapsed ? y + 4 : h;
      return out;
    }
    var grids = sides.map(function (s) { return gridOf(obj, s); });
    var totalRows = grids.reduce(function (a, x) { return a + x.rows; }, 0);
    var rh = Math.max(CELL + 2, (h - HEADER - 8) / totalRows), y0 = HEADER + 2;
    sides.forEach(function (side, si) {
      if (usesSections(obj)) placeSections(side, inSide(obj, side), y0, w, rh, out.ports, grids[si], out.groups);
      else placeGrid(obj, side, inSide(obj, side), iconW(obj), y0, w - iconW(obj), rh, out.ports, false);
      y0 += grids[si].rows * rh;
    });
    return out;
  }
  function layoutPorts(obj, w, h, collapsed) { return computeLayout(obj, w, h, collapsed).ports; }

  NM.layout = { HEADER: HEADER, defaultSize: defaultSize, defaultGroupSize: defaultGroupSize, layoutPorts: layoutPorts, minSize: minSize, cellFor: cellFor, computeLayout: computeLayout, iconW: iconW, switchSpec: switchSpec, gridOf: gridOf, usesSections: usesSections, panelHeight: panelHeight, gridFor: gridFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = NM.layout;
})(typeof window !== 'undefined' ? window : globalThis);
