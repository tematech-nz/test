/* Connection table, minimal PDF writer, and download helpers. */
(function (g) {
  'use strict';
  var NM = g.NetMap = g.NetMap || {};
  if (typeof require === 'function' && !NM.model) require('./model.js');
  var M = NM.model;

  /* ---------- connection table ---------- */
  function connectionRows(p) {
    var idx = M.buildIndex(p), rows = [];
    p.fixedLinks.forEach(function (l) {
      var a = idx.objects[l.aObjectId], b = idx.objects[l.bObjectId];
      l.wires.forEach(function (w) {
        rows.push({
          id: l.name + ' w' + w.number, category: 'Fixed wire',
          from: a ? a.name + ' / ' + (w.aPortId && idx.ports[w.aPortId] ? idx.ports[w.aPortId].label : '-') : '?',
          to: b ? b.name + ' / ' + (w.bPortId && idx.ports[w.bPortId] ? idx.ports[w.bPortId].label : '-') : '?',
          wire: 'wire ' + w.number + ' (' + w.status + ')', cableType: l.cableType, length: l.length, note: l.route || ''
        });
      });
    });
    p.patchCables.forEach(function (c) {
      rows.push({
        id: c.name, category: 'Patch cable', from: M.portName(p, c.aPortId, idx), to: M.portName(p, c.bPortId, idx),
        wire: '', cableType: c.cableType, length: c.length, note: c.status
      });
    });
    return rows;
  }
  var COLS = [['id', 'ID'], ['category', 'Category'], ['from', 'From'], ['to', 'To'], ['wire', 'Wire mapping'], ['cableType', 'Cable type'], ['length', 'Length']];
  function tableHtml(p) {
    var esc = function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
    var rows = connectionRows(p);
    return '<table class="ctable"><thead><tr>' + COLS.map(function (c) { return '<th>' + c[1] + '</th>'; }).join('') + '</tr></thead><tbody>' +
      rows.map(function (r) { return '<tr class="' + (r.category === 'Fixed wire' ? 'fx' : 'pc') + '">' + COLS.map(function (c) { return '<td>' + esc(r[c[0]]) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody></table>';
  }

  /* ---------- minimal PDF writer (text + JPEG images) ---------- */
  function bytes(s) {
    var u = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255;
    return u;
  }
  function pdfEsc(s) {
    return String(s).replace(/[^\x20-\x7e]/g, '?').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  }
  function fmt(n) { return (Math.round(n * 100) / 100).toString(); }

  /* pages: [{w,h,items:[{t:'text',x,y,size,text,bold}|{t:'line',x1,y1,x2,y2}|{t:'image',jpeg,iw,ih,x,y,w,h}]}], y measured from top */
  function buildPdf(pages) {
    var chunks = [], offsets = [], pos = 0, objCount = 0;
    function push(u) { chunks.push(u); pos += u.length; }
    function pushS(s) { push(bytes(s)); }
    function beginObj(n) { offsets[n] = pos; pushS(n + ' 0 obj\n'); }
    // object numbering: 1 catalog, 2 pages, 3 font, 4 bold font, then per page: page, content, images...
    var next = 5, pageObjs = [];
    pages.forEach(function (pg) {
      var o = { page: next++, content: next++, images: [] };
      pg.items.forEach(function (it) { if (it.t === 'image') { it.obj = next++; o.images.push(it); } });
      pageObjs.push(o);
    });
    objCount = next - 1;
    pushS('%PDF-1.4\n');
    beginObj(1); pushS('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
    beginObj(2); pushS('<< /Type /Pages /Count ' + pages.length + ' /Kids [' + pageObjs.map(function (o) { return o.page + ' 0 R'; }).join(' ') + '] >>\nendobj\n');
    beginObj(3); pushS('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n');
    beginObj(4); pushS('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\nendobj\n');
    pages.forEach(function (pg, i) {
      var o = pageObjs[i], ops = [], n = 0;
      pg.items.forEach(function (it) {
        if (it.t === 'text') {
          ops.push('BT /' + (it.bold ? 'F2' : 'F1') + ' ' + fmt(it.size || 10) + ' Tf ' + fmt(it.x) + ' ' + fmt(pg.h - it.y) + ' Td (' + pdfEsc(it.text) + ') Tj ET');
        } else if (it.t === 'line') {
          ops.push(fmt(it.x1) + ' ' + fmt(pg.h - it.y1) + ' m ' + fmt(it.x2) + ' ' + fmt(pg.h - it.y2) + ' l S');
        } else if (it.t === 'image') {
          ops.push('q ' + fmt(it.w) + ' 0 0 ' + fmt(it.h) + ' ' + fmt(it.x) + ' ' + fmt(pg.h - it.y - it.h) + ' cm /Im' + (n++) + ' Do Q');
        }
      });
      var content = ops.join('\n');
      var xo = o.images.map(function (it, k) { return '/Im' + k + ' ' + it.obj + ' 0 R'; }).join(' ');
      beginObj(o.page);
      pushS('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + fmt(pg.w) + ' ' + fmt(pg.h) + '] /Contents ' + o.content + ' 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> /XObject << ' + xo + ' >> >> >>\nendobj\n');
      beginObj(o.content);
      pushS('<< /Length ' + content.length + ' >>\nstream\n' + content + '\nendstream\nendobj\n');
      o.images.forEach(function (it) {
        beginObj(it.obj);
        pushS('<< /Type /XObject /Subtype /Image /Width ' + it.iw + ' /Height ' + it.ih + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + it.jpeg.length + ' >>\nstream\n');
        push(it.jpeg);
        pushS('\nendstream\nendobj\n');
      });
    });
    var xref = pos;
    pushS('xref\n0 ' + (objCount + 1) + '\n0000000000 65535 f \n');
    for (var i = 1; i <= objCount; i++) {
      var s = String(offsets[i]); while (s.length < 10) s = '0' + s;
      pushS(s + ' 00000 n \n');
    }
    pushS('trailer\n<< /Size ' + (objCount + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
    var out = new Uint8Array(pos), o2 = 0;
    chunks.forEach(function (c) { out.set(c, o2); o2 += c.length; });
    return out;
  }

  /* connection table pages (landscape A4) */
  function tablePages(p, title) {
    var rows = connectionRows(p), W = 842, H = 595, M0 = 30;
    var xs = [30, 100, 160, 330, 500, 600, 700], widths = [14, 10, 34, 34, 20, 14, 10];
    function cut(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '~' : s; }
    var pages = [], pg = null, y = 0;
    function newPage() {
      pg = { w: W, h: H, items: [] }; pages.push(pg);
      pg.items.push({ t: 'text', x: M0, y: 28, size: 13, bold: true, text: title + ' - connection table' });
      COLS.forEach(function (c, i) { pg.items.push({ t: 'text', x: xs[i], y: 50, size: 8, bold: true, text: c[1] }); });
      pg.items.push({ t: 'line', x1: M0, y1: 54, x2: W - M0, y2: 54 });
      y = 66;
    }
    newPage();
    if (!rows.length) pg.items.push({ t: 'text', x: M0, y: y, size: 9, text: 'No cables or fixed links documented.' });
    rows.forEach(function (r) {
      if (y > H - 30) newPage();
      COLS.forEach(function (c, i) { pg.items.push({ t: 'text', x: xs[i], y: y, size: 7.5, bold: r.category === 'Fixed wire' && c[0] === 'category', text: cut(r[c[0]], widths[i] * 1.45) }); });
      y += 11;
    });
    return pages;
  }

  /* ---------- browser helpers ---------- */
  function download(name, data, mime) {
    var blob = new Blob([data], { type: mime });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function svgToCanvas(svgText, scale) {
    return new Promise(function (resolve, reject) {
      var m = /viewBox="[^"]*?([\d.]+) ([\d.]+)"/.exec(svgText);
      var wm = /width="(\d+)"/.exec(svgText), hm = /height="(\d+)"/.exec(svgText);
      var w = parseInt(wm[1], 10), h = parseInt(hm[1], 10);
      var cap = Math.min(scale, 8000 / Math.max(w, h));
      var img = new Image();
      img.onload = function () {
        var c = document.createElement('canvas'); c.width = Math.round(w * cap); c.height = Math.round(h * cap);
        var ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height); resolve(c);
      };
      img.onerror = function () { reject(new Error('Could not rasterise SVG')); };
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
      void m;
    });
  }
  function canvasToBlob(c, type, q) {
    return new Promise(function (res) { c.toBlob(res, type, q); });
  }
  function b64ToBytes(b64) {
    var bin = atob(b64), u = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  /* browser only: map images + connection table */
  function pdfForMaps(p, mapIds) {
    var R = NM.render;
    var jobs = mapIds.map(function (mid) {
      var svg = R.svgDocument(p, mid);
      return svgToCanvas(svg, 2).then(function (c) {
        return { mapId: mid, jpeg: b64ToBytes(c.toDataURL('image/jpeg', 0.92).split(',')[1]), iw: c.width, ih: c.height };
      });
    });
    return Promise.all(jobs).then(function (imgs) {
      var W = 842, H = 595, pages = [];
      imgs.forEach(function (im) {
        var m = p.maps.filter(function (x) { return x.id === im.mapId; })[0];
        var availW = W - 40, availH = H - 70, s = Math.min(availW / im.iw, availH / im.ih);
        var w = im.iw * s, h = im.ih * s;
        pages.push({ w: W, h: H, items: [
          { t: 'text', x: 20, y: 24, size: 13, bold: true, text: p.name + ' - ' + m.name + (m.location ? ' (' + m.location + ')' : '') },
          { t: 'image', jpeg: im.jpeg, iw: im.iw, ih: im.ih, x: 20 + (availW - w) / 2, y: 40, w: w, h: h }
        ] });
      });
      return buildPdf(pages.concat(tablePages(p, p.name)));
    });
  }

  NM.exporters = {
    connectionRows: connectionRows, tableHtml: tableHtml, buildPdf: buildPdf, tablePages: tablePages,
    download: download, svgToCanvas: svgToCanvas, canvasToBlob: canvasToBlob, pdfForMaps: pdfForMaps
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = NM.exporters;
})(typeof window !== 'undefined' ? window : globalThis);
