/*
 * Floor plan geometry (no DOM). A floor plan is a map of kind 'floor' whose `floor` object holds
 *   points: [{ id, x, y }]                          integer centimetres, y points down
 *   lines:  [{ id, a, b, kind }]                    a / b are point ids; kind: wall | door | window | furniture
 *   links:  [{ id, kind, refId, x, y, rot, w, d }]  a to-scale symbol for an item (group, rack, socket, device); (x, y) is its
 *                                                   centre, rot degrees clockwise, w x d the footprint in cm
 * Lines meet at shared points: a crossing, a T-junction or a rectangle corner always becomes a point that splits the lines through
 * it, and a new line never overlaps an existing one. Everything is rounded to whole centimetres (tolerance 1 cm).
 */
(function (g) {
  'use strict';
  var NM = g.NetMap = g.NetMap || {};
  var EPS = 1; // cm
  var KINDS = [['wall', 'Wall'], ['door', 'Door'], ['window', 'Window'], ['furniture', 'Furniture (box)']];
  function newId(prefix) {
    return NM.uuid.make(prefix);
  }
  function validKind(k) { return KINDS.some(function (x) { return x[0] === k; }); }

  function ensure(map) {
    var f = map.floor = map.floor || {};
    f.points = f.points || []; f.lines = f.lines || []; f.links = f.links || []; f.labels = f.labels || [];
    return f;
  }
  function pt(f, id) { for (var i = 0; i < f.points.length; i++) if (f.points[i].id === id) return f.points[i]; return null; }
  function lineById(f, id) { for (var i = 0; i < f.lines.length; i++) if (f.lines[i].id === id) return f.lines[i]; return null; }
  function degree(f, pointId) { var n = 0; f.lines.forEach(function (l) { if (l.a === pointId || l.b === pointId) n++; }); return n; }
  function dist(ax, ay, bx, by) { return Math.sqrt((ax - bx) * (ax - bx) + (ay - by) * (ay - by)); }
  function lineLength(f, l) { var a = pt(f, l.a), b = pt(f, l.b); return a && b ? Math.round(dist(a.x, a.y, b.x, b.y)) : 0; }
  /* distance from (x, y) to segment a-b and the position t (0..1) of the closest point on it */
  function toSegment(x, y, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    var t = len2 ? ((x - ax) * dx + (y - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return { d: dist(x, y, ax + t * dx, ay + t * dy), t: t, x: ax + t * dx, y: ay + t * dy };
  }
  function lineBetween(f, p, q) {
    for (var i = 0; i < f.lines.length; i++) { var l = f.lines[i]; if ((l.a === p && l.b === q) || (l.a === q && l.b === p)) return l; }
    return null;
  }

  /* split a line in two at an existing point (which must not be one of its ends) */
  function splitLine(f, l, pointId, newKind) {
    var l2 = { id: newId('fln'), a: pointId, b: l.b, kind: l.kind };
    l.b = pointId;
    f.lines.push(l2);
    return l2;
  }

  /* the point at (x, y): an existing one within 1 cm, or a new one - splitting the line it lies on, if any */
  function addPoint(f, x, y) {
    x = Math.round(x); y = Math.round(y);
    for (var i = 0; i < f.points.length; i++) if (dist(x, y, f.points[i].x, f.points[i].y) <= EPS) return f.points[i];
    for (var j = 0; j < f.lines.length; j++) {
      var l = f.lines[j], a = pt(f, l.a), b = pt(f, l.b);
      if (!a || !b) continue;
      var s = toSegment(x, y, a.x, a.y, b.x, b.y);
      if (s.d <= EPS && s.t > 0 && s.t < 1) {
        var p = { id: newId('fpt'), x: Math.round(s.x), y: Math.round(s.y) };
        f.points.push(p);
        splitLine(f, l, p.id);
        return p;
      }
    }
    var np = { id: newId('fpt'), x: x, y: y };
    f.points.push(np);
    return np;
  }

  /* parameters t (0..1 along A->B) where an existing line crosses, touches or overlaps the segment */
  function crossings(f, ax, ay, bx, by) {
    var out = [], d1x = bx - ax, d1y = by - ay, len = Math.sqrt(d1x * d1x + d1y * d1y);
    f.lines.forEach(function (l) {
      var a = pt(f, l.a), b = pt(f, l.b);
      if (!a || !b) return;
      var d2x = b.x - a.x, d2y = b.y - a.y, len2 = Math.sqrt(d2x * d2x + d2y * d2y);
      if (!len2) return;
      var denom = d1x * d2y - d1y * d2x;
      if (Math.abs(denom) / (len * len2) < 1e-6) { // parallel: only a collinear line matters - its ends split this one
        if (Math.abs((a.x - ax) * d1y - (a.y - ay) * d1x) / len > EPS) return;
        [a, b].forEach(function (e) { var t = ((e.x - ax) * d1x + (e.y - ay) * d1y) / (len * len); if (t > 0 && t < 1) out.push(t); });
        return;
      }
      var t = ((a.x - ax) * d2y - (a.y - ay) * d2x) / denom, u = ((a.x - ax) * d1y - (a.y - ay) * d1x) / denom;
      var tTol = EPS / len, uTol = EPS / len2;
      if (t >= -tTol && t <= 1 + tTol && u >= -uTol && u <= 1 + uTol) out.push(Math.max(0, Math.min(1, t)));
    });
    return out;
  }

  /*
   * Draw a line from (ax, ay) to (bx, by). Wherever it crosses or touches existing lines it gets a point (and they are split there);
   * pieces that already exist (collinear overlap) are not added again. Returns the new lines.
   */
  function addLine(f, ax, ay, bx, by, kind) {
    kind = validKind(kind) ? kind : 'wall';
    var A = addPoint(f, ax, ay), B = addPoint(f, bx, by);
    if (A.id === B.id) return [];
    var cx = crossings(f, A.x, A.y, B.x, B.y), dx = B.x - A.x, dy = B.y - A.y, ts = [0, 1];
    cx.forEach(function (t) { if (t > 0 && t < 1) ts.push(t); });
    ts.sort(function (p, q) { return p - q; });
    var ids = [], i;
    for (i = 0; i < ts.length; i++) {
      if (i === 0) { ids.push(A.id); continue; }
      if (i === ts.length - 1) { ids.push(B.id); continue; }
      ids.push(addPoint(f, A.x + dx * ts[i], A.y + dy * ts[i]).id);
    }
    var made = [];
    for (i = 0; i < ids.length - 1; i++) {
      if (ids[i] === ids[i + 1] || lineBetween(f, ids[i], ids[i + 1])) continue;
      var l = { id: newId('fln'), a: ids[i], b: ids[i + 1], kind: kind };
      f.lines.push(l); made.push(l);
    }
    return made;
  }
  /* rectangle from two opposite corners: four lines that share their corner points */
  function addRect(f, x0, y0, x1, y1, kind) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    if (Math.abs(x1 - x0) <= EPS || Math.abs(y1 - y0) <= EPS) return [];
    var out = [];
    [[x0, y0, x1, y0], [x1, y0, x1, y1], [x1, y1, x0, y1], [x0, y1, x0, y0]].forEach(function (s) { out = out.concat(addLine(f, s[0], s[1], s[2], s[3], kind)); });
    return out;
  }
  function prunePoints(f) {
    f.points = f.points.filter(function (p) { return degree(f, p.id) > 0; });
  }
  function deleteLine(f, id) {
    f.lines = f.lines.filter(function (l) { return l.id !== id; });
    prunePoints(f);
  }
  function setLineKind(f, id, kind) {
    var l = lineById(f, id);
    if (!l) throw new Error('Line not found');
    if (!validKind(kind)) throw new Error('Unknown line type');
    l.kind = kind;
  }
  /* a line whose two ends both meet other lines has its length set by them */
  function lineLocked(f, id) {
    var l = lineById(f, id);
    return !!l && degree(f, l.a) > 1 && degree(f, l.b) > 1;
  }
  var LOCKED = 'Length is defined by the connected lines (both ends are connected): move a point instead.';
  /* which end moves when a length or angle is edited: the free end (the second end when both are free) */
  function movingEnd(f, l) { return degree(f, l.b) === 1 ? { move: l.b, anchor: l.a } : { move: l.a, anchor: l.b }; }
  function setLineLength(f, id, cm) {
    var l = lineById(f, id);
    if (!l) throw new Error('Line not found');
    if (lineLocked(f, id)) throw new Error(LOCKED);
    cm = Math.round(Number(cm));
    if (!(cm >= 1) || cm > 100000) throw new Error('Length must be between 1 cm and 1000 m');
    var e = movingEnd(f, l), a = pt(f, e.anchor), m = pt(f, e.move), cur = dist(a.x, a.y, m.x, m.y) || 1;
    m.x = Math.round(a.x + (m.x - a.x) * cm / cur); m.y = Math.round(a.y + (m.y - a.y) * cm / cur);
    settleAfterMove(f, e.move);
  }
  /* angle in degrees (0 = right, 90 = down) from the first end to the second */
  function lineAngle(f, l) {
    var a = pt(f, l.a), b = pt(f, l.b);
    var deg = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
    return Math.round(((deg % 360) + 360) % 360 * 10) / 10;
  }
  function setLineAngle(f, id, deg) {
    var l = lineById(f, id);
    if (!l) throw new Error('Line not found');
    if (lineLocked(f, id)) throw new Error(LOCKED);
    deg = Number(deg);
    if (!isFinite(deg)) throw new Error('Angle must be a number');
    var e = movingEnd(f, l), a = pt(f, e.anchor), m = pt(f, e.move), len = dist(a.x, a.y, m.x, m.y);
    // the angle is always measured first end -> second end
    var dir = e.move === l.b ? deg : deg + 180, rad = dir * Math.PI / 180;
    m.x = Math.round(a.x + Math.cos(rad) * len); m.y = Math.round(a.y + Math.sin(rad) * len);
    settleAfterMove(f, e.move);
  }
  /* turn a line (one that still has a free end) to the nearest horizontal or vertical direction; the length stays */
  function setLineAxis(f, id, axis) {
    var l = lineById(f, id);
    if (!l) throw new Error('Line not found');
    var cur = lineAngle(f, l), opts = axis === 'v' ? [90, 270] : [0, 180], best = opts[0], bd = 1e9;
    opts.forEach(function (o) { var d = Math.abs(cur - o); d = Math.min(d, 360 - d); if (d < bd) { bd = d; best = o; } });
    setLineAngle(f, id, best);
  }
  function mergePoints(f, keepId, dropId) {
    f.lines.forEach(function (l) { if (l.a === dropId) l.a = keepId; if (l.b === dropId) l.b = keepId; });
    f.points = f.points.filter(function (p) { return p.id !== dropId; });
    var seen = {};
    f.lines = f.lines.filter(function (l) { // lines that collapsed to a point, or now duplicate another, go
      if (l.a === l.b) return false;
      var k = [l.a, l.b].sort().join('|');
      if (seen[k]) return false;
      seen[k] = 1; return true;
    });
  }
  /* take a line out and draw it again between the same points: it is split wherever it now crosses something */
  function reroute(f, id) {
    var l = lineById(f, id);
    if (!l) return;
    var a = pt(f, l.a), b = pt(f, l.b), kind = l.kind;
    f.lines = f.lines.filter(function (x) { return x.id !== id; });
    var made = addLine(f, a.x, a.y, b.x, b.y, kind);
    if (made.length) made[0].id = id; // keep the identity (and so the selection) of the line
  }
  /*
   * After a point has been moved: it joins a point it landed on, splits a line it landed on, and the lines attached to it are split
   * where they now cross other lines - the same rules as drawing. Returns the id of the point that remains.
   */
  function settleAfterMove(f, pid) {
    var p = pt(f, pid), i;
    if (!p) return pid;
    for (i = 0; i < f.points.length; i++) {
      var q = f.points[i];
      if (q.id !== pid && dist(p.x, p.y, q.x, q.y) <= EPS) { mergePoints(f, q.id, pid); pid = q.id; p = q; break; }
    }
    f.lines.slice().forEach(function (l) {
      if (l.a === pid || l.b === pid) return;
      var a = pt(f, l.a), b = pt(f, l.b);
      if (!a || !b) return;
      var s = toSegment(p.x, p.y, a.x, a.y, b.x, b.y);
      if (s.d <= EPS && s.t > 0 && s.t < 1) splitLine(f, l, pid);
    });
    f.lines.filter(function (l) { return l.a === pid || l.b === pid; }).map(function (l) { return l.id; }).forEach(function (id) { reroute(f, id); });
    prunePoints(f);
    return pid;
  }
  function movePoint(f, id, x, y) {
    var p = pt(f, id);
    if (!p) throw new Error('Point not found');
    p.x = Math.round(x); p.y = Math.round(y);
    return settleAfterMove(f, id);
  }

  /* ---------- links: to-scale symbols of real items ---------- */
  function footprintFor(kind, type) {
    if (kind === 'group') return { w: 200, d: 200 };
    switch (type) {
      case 'rack': return { w: 60, d: 100 };
      case 'socket': return { w: 12, d: 12 };
      case 'patchpanel': return { w: 48, d: 12 };
      case 'switch': return { w: 48, d: 30 };
      case 'router': return { w: 30, d: 20 };
      case 'internet': return { w: 40, d: 40 };
      default: return { w: 40, d: 40 };
    }
  }
  /* predefined sizes (cm) offered for a link, by what it stands for */
  function sizePresets(kind, type) {
    if (kind === 'group') return [[200, 200], [300, 200], [300, 300], [400, 300], [500, 400], [600, 400], [800, 500], [1000, 600]];
    if (type === 'rack') return [[60, 100], [60, 120], [80, 100], [80, 120]];
    if (type === 'socket') return [[10, 10], [12, 12], [20, 10]];
    return [[30, 30], [40, 40], [60, 40], [80, 60], [120, 60]];
  }
  /* text labels: a scalable box with a name for a room. size is in pt; one pt is PT_CM of plan, so text scales with the plan like the walls do */
  var PT_CM = 2.5, LABEL_SIZES = [8, 10, 12, 14, 18, 24, 36, 48, 72];
  function addLabel(f, spec) {
    var w = Math.round(spec.w || 200), d = Math.round(spec.d || 60);
    if (!(w >= 10 && d >= 10)) throw new Error('A label box must be at least 10 x 10 cm');
    var lb = { id: newId('flb'), x: Math.round(spec.x || 0), y: Math.round(spec.y || 0), w: w, d: d, rot: ((Math.round(spec.rot || 0) % 360) + 360) % 360,
      text: String(spec.text == null ? 'Label' : spec.text), size: spec.size > 0 ? Math.round(spec.size) : 14, color: spec.color || '#1b2a38' };
    if (spec.box) lb.box = true;
    f.labels.push(lb);
    return lb;
  }
  function removeLabel(f, id) { f.labels = f.labels.filter(function (l) { return l.id !== id; }); }
  function labelById(f, id) { for (var i = 0; i < f.labels.length; i++) if (f.labels[i].id === id) return f.labels[i]; return null; }
  /* corner i (0 top-left, 1 top-right, 2 bottom-right, 3 bottom-left of the unrotated box) dragged to the world point (wx, wy); the opposite corner stays */
  function resizeBox(b, corner, wx, wy, minCm) {
    var rad = b.rot * Math.PI / 180, c = Math.cos(rad), s = Math.sin(rad), sg = [[-1, -1], [1, -1], [1, 1], [-1, 1]][corner], op = [-sg[0], -sg[1]];
    var ax = b.x + (op[0] * b.w / 2) * c - (op[1] * b.d / 2) * s, ay = b.y + (op[0] * b.w / 2) * s + (op[1] * b.d / 2) * c; // anchor (world)
    var dx = wx - ax, dy = wy - ay, lx = dx * c + dy * s, ly = -dx * s + dy * c; // pointer relative to the anchor, in the box's own axes
    var w = Math.max(minCm || 10, Math.abs(lx)), d = Math.max(minCm || 10, Math.abs(ly));
    var sx = lx >= 0 ? 1 : -1, sy = ly >= 0 ? 1 : -1; // keep growing towards the pointer even past the anchor
    var mx = sx * w / 2, my = sy * d / 2;
    b.w = Math.round(w); b.d = Math.round(d);
    b.x = Math.round(ax + mx * c - my * s); b.y = Math.round(ay + mx * s + my * c);
  }
  function linkOf(f, refId) { for (var i = 0; i < f.links.length; i++) if (f.links[i].refId === refId) return f.links[i]; return null; }
  function addLink(f, spec) {
    if (!spec || !spec.refId || (spec.kind !== 'group' && spec.kind !== 'object')) throw new Error('Choose an item to link');
    if (linkOf(f, spec.refId)) throw new Error('That item is already linked on this floor plan');
    var w = Math.round(spec.w), d = Math.round(spec.d);
    if (!(w >= 1 && d >= 1)) throw new Error('The footprint must be at least 1 x 1 cm');
    var l = { id: newId('flk'), kind: spec.kind, refId: spec.refId, x: Math.round(spec.x || 0), y: Math.round(spec.y || 0), rot: ((Math.round(spec.rot || 0) % 360) + 360) % 360, w: w, d: d };
    f.links.push(l);
    return l;
  }
  function removeLink(f, id) { f.links = f.links.filter(function (l) { return l.id !== id; }); }
  function linkById(f, id) { for (var i = 0; i < f.links.length; i++) if (f.links[i].id === id) return f.links[i]; return null; }
  /* corners of a link's (rotated) footprint */
  function linkCorners(l) {
    var rad = l.rot * Math.PI / 180, c = Math.cos(rad), s = Math.sin(rad), hw = l.w / 2, hd = l.d / 2;
    return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(function (q) { return [l.x + q[0] * c - q[1] * s, l.y + q[0] * s + q[1] * c]; });
  }
  function inLink(l, x, y) {
    var rad = -l.rot * Math.PI / 180, dx = x - l.x, dy = y - l.y;
    var lx = dx * Math.cos(rad) - dy * Math.sin(rad), ly = dx * Math.sin(rad) + dy * Math.cos(rad);
    return Math.abs(lx) <= l.w / 2 && Math.abs(ly) <= l.d / 2;
  }

  /* what is under (x, y): a point, a link or a line within tol cm - in that order */
  function hitTest(f, x, y, tol) {
    var i, best = null;
    for (i = 0; i < f.points.length; i++) { var d = dist(x, y, f.points[i].x, f.points[i].y); if (d <= tol && (!best || d < best.d)) best = { type: 'point', id: f.points[i].id, d: d }; }
    if (best) return { type: best.type, id: best.id };
    for (i = f.links.length - 1; i >= 0; i--) if (f.links[i].kind !== 'group' && inLink(f.links[i], x, y)) return { type: 'link', id: f.links[i].id };
    best = null;
    f.lines.forEach(function (l) {
      var a = pt(f, l.a), b = pt(f, l.b); if (!a || !b) return;
      var s = toSegment(x, y, a.x, a.y, b.x, b.y);
      if (s.d <= tol && (!best || s.d < best.d)) best = { type: 'line', id: l.id, d: s.d };
    });
    if (best) return { type: 'line', id: best.id };
    for (i = f.labels.length - 1; i >= 0; i--) if (inLink(f.labels[i], x, y)) return { type: 'label', id: f.labels[i].id };
    for (i = f.links.length - 1; i >= 0; i--) if (inLink(f.links[i], x, y)) return { type: 'link', id: f.links[i].id }; // a group's area sits under walls and equipment
    return null;
  }

  /* ---------- measuring ---------- */
  function fmtLen(cm) {
    cm = Math.round(cm);
    return (cm / 100).toFixed(2) + ' m';
  }
  /* a round scale-bar length (cm) that is between 60 and 160 px wide at `pxPerCm` */
  function niceScale(pxPerCm) {
    var opts = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000];
    for (var i = 0; i < opts.length; i++) if (opts[i] * pxPerCm >= 60) return { cm: opts[i], px: opts[i] * pxPerCm };
    return { cm: opts[opts.length - 1], px: opts[opts.length - 1] * pxPerCm };
  }
  function bounds(f) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    f.points.forEach(function (p) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); });
    f.links.concat(f.labels || []).forEach(function (l) { linkCorners(l).forEach(function (c) { x0 = Math.min(x0, c[0]); y0 = Math.min(y0, c[1]); x1 = Math.max(x1, c[0]); y1 = Math.max(y1, c[1]); }); });
    return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  NM.floor = {
    KINDS: KINDS, EPS: EPS, LOCKED: LOCKED, ensure: ensure, pt: pt, lineById: lineById, linkById: linkById, linkOf: linkOf, degree: degree,
    addPoint: addPoint, addLine: addLine, addRect: addRect, deleteLine: deleteLine, setLineKind: setLineKind, lineLocked: lineLocked,
    setLineLength: setLineLength, setLineAngle: setLineAngle, setLineAxis: setLineAxis, movePoint: movePoint, settleAfterMove: settleAfterMove, mergePoints: mergePoints, lineLength: lineLength, lineAngle: lineAngle,
    footprintFor: footprintFor, sizePresets: sizePresets, PT_CM: PT_CM, LABEL_SIZES: LABEL_SIZES, addLabel: addLabel, removeLabel: removeLabel, labelById: labelById, resizeBox: resizeBox, addLink: addLink, removeLink: removeLink, linkCorners: linkCorners, inLink: inLink,
    hitTest: hitTest, fmtLen: fmtLen, niceScale: niceScale, bounds: bounds, validKind: validKind, toSegment: toSegment, prunePoints: prunePoints
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = NM.floor;
})(typeof window !== 'undefined' ? window : globalThis);
