/* Geometry helpers: default sizes, sections and port positions. Independent of the DOM. */
(function (g) {
  'use strict';
  var NM = g.NetMap = g.NetMap || {};
  var HEADER = 20, CELL = 18, MAXCOLS = 16, PADX = 6, SECHEAD = 14, SECGAP = 4, SECPAD = 3;

  var SGAP = 8, LINEMAX = 24;
  if (typeof require === 'function' && !NM.model) require('./model.js');
  var SECTIONED = { patchpanel: true, router: true };
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
  function gridOf(obj, side) {
    var n = sideCount(obj, side);
    if (obj.type !== 'patchpanel') return gridFor(n);
    if (n <= 0) return { rows: 0, cols: 0, perRow: 0, size: 0, nsec: 0 };
    var size = NM.model.effectiveSectionSize(obj, n), nsec = n / size;
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

  function defaultSize(obj) {
    if (obj.type === 'rack') return { w: 340, h: 300 };
    if (obj.type === 'generic') return { w: 120, h: 60 };
    var ks = sidesOf(obj), gs = ks.map(function (k) { return gridOf(obj, k); });
    var front = gs[0] || { rows: 0, cols: 0 }, rear = gs[1] || { rows: 0, cols: 0 };
    var cols = Math.max(front.cols, rear.cols, 4);
    var w = cols * CELL + PADX * 2 + (SECTIONED[obj.type] ? 6 : 0);
    if (obj.type === 'patchpanel') w += (Math.max(front.perRow || 1, rear.perRow || 1) - 1) * SGAP;
    if (obj.type === 'router') w = Math.max(w, 150);
    if (obj.type === 'internet') w = Math.max(w, 130);
    if (SECTIONED[obj.type]) return { w: w, h: panelHeight(obj, {}) };
    return { w: w, h: HEADER + (front.rows + rear.rows) * (CELL + 2) + 8 };
  }
  function defaultGroupSize() { return { w: 420, h: 340 }; }

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
    if (SECTIONED[obj.type]) {
      var chrome = HEADER + sides.length * (SECHEAD + SECGAP) + 4;
      var anyCollapsed = sides.some(function (s) { return collapsed[s]; });
      var rows = 0;
      sides.forEach(function (s) { if (!collapsed[s]) rows += gridOf(obj, s).rows; });
      var rowH = anyCollapsed || !rows ? CELL + 2 : Math.max(10, (h - chrome) / rows);
      var y = HEADER;
      sides.forEach(function (side) {
        var list = inSide(obj, side);
        var gr = gridOf(obj, side), coll = !!collapsed[side];
        var sh = SECHEAD + (coll ? 0 : gr.rows * rowH);
        out.sections.push({ side: side, x: SECPAD, y: y, w: w - SECPAD * 2, h: sh, headH: SECHEAD, collapsed: coll, count: list.length });
        if (coll) {
          list.forEach(function (p) { out.ports[p.id] = { x: w / 2 - 2, y: y, w: 4, h: SECHEAD, side: side, hidden: true }; });
        } else if (obj.type === 'patchpanel') placeSections(side, list, y + SECHEAD, w, rowH, out.ports, gr, out.groups);
        else placeGrid(obj, side, list, 0, y + SECHEAD, w, rowH, out.ports, false);
        y += sh + SECGAP;
      });
      out.h = anyCollapsed ? y + 4 : h;
      return out;
    }
    var grids = sides.map(function (s) { return gridFor(sideCount(obj, s)); });
    var totalRows = grids.reduce(function (a, x) { return a + x.rows; }, 0);
    var rh = Math.max(10, (h - HEADER - 8) / totalRows), y0 = HEADER + 2;
    sides.forEach(function (side, si) {
      placeGrid(obj, side, inSide(obj, side), 0, y0, w, rh, out.ports, false);
      y0 += grids[si].rows * rh;
    });
    return out;
  }
  function layoutPorts(obj, w, h, collapsed) { return computeLayout(obj, w, h, collapsed).ports; }

  NM.layout = { HEADER: HEADER, defaultSize: defaultSize, defaultGroupSize: defaultGroupSize, layoutPorts: layoutPorts, computeLayout: computeLayout, gridOf: gridOf, panelHeight: panelHeight, gridFor: gridFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = NM.layout;
})(typeof window !== 'undefined' ? window : globalThis);
