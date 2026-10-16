/* Geometry helpers: default sizes and port positions. Independent of the DOM. */
(function (g) {
  'use strict';
  var NM = g.NetMap = g.NetMap || {};
  var HEADER = 20, CELL = 18, MAXCOLS = 16, PADX = 6;

  function sideCount(obj, side) { return obj.ports.filter(function (p) { return p.side === side; }).length; }
  function gridFor(n) {
    if (n <= 0) return { rows: 0, cols: 0 };
    var rows = Math.ceil(n / MAXCOLS);
    return { rows: rows, cols: Math.ceil(n / rows) };
  }

  function defaultSize(obj) {
    if (obj.type === 'rack') return { w: 340, h: 300 };
    if (obj.type === 'generic') return { w: 120, h: 60 };
    var front = gridFor(sideCount(obj, 'front')), rear = gridFor(sideCount(obj, 'rear'));
    var cols = Math.max(front.cols, rear.cols, 4);
    var rows = front.rows + rear.rows;
    return { w: cols * CELL + PADX * 2, h: HEADER + rows * (CELL + 2) + 8 };
  }
  function defaultGroupSize() { return { w: 420, h: 340 }; }

  /* local port rectangles for a box of size w x h */
  function layoutPorts(obj, w, h) {
    var out = {};
    var sides = ['front', 'rear'].filter(function (s) { return sideCount(obj, s) > 0; });
    if (!sides.length) return out;
    var grids = sides.map(function (s) { return gridFor(sideCount(obj, s)); });
    var totalRows = grids.reduce(function (a, x) { return a + x.rows; }, 0);
    var rowH = Math.max(10, (h - HEADER - 8) / totalRows);
    var y0 = HEADER + 2;
    sides.forEach(function (side, si) {
      var gr = grids[si];
      var cellW = Math.max(8, (w - PADX * 2) / gr.cols);
      var pw = Math.min(cellW - 2, 26), ph = Math.min(rowH - 2, 22);
      var list = obj.ports.filter(function (p) { return p.side === side; });
      list.forEach(function (p, i) {
        var r = Math.floor(i / gr.cols), c = i % gr.cols;
        out[p.id] = { x: PADX + c * cellW + (cellW - pw) / 2, y: y0 + r * rowH + (rowH - ph) / 2, w: pw, h: ph, side: side };
      });
      y0 += gr.rows * rowH;
    });
    return out;
  }

  NM.layout = { HEADER: HEADER, defaultSize: defaultSize, defaultGroupSize: defaultGroupSize, layoutPorts: layoutPorts, gridFor: gridFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = NM.layout;
})(typeof window !== 'undefined' ? window : globalThis);
