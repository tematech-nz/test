/* Higher-level helpers that combine the model with layout (placing items on maps) and a demo project. */
(function (g) {
  'use strict';
  var NM = g.NetMap = g.NetMap || {};
  if (typeof require === 'function') { ['model', 'layout'].forEach(function (n) { if (!NM[n]) require('./' + n + '.js'); }); }
  var M = NM.model, L = NM.layout;

  /* grid step of the project (1 when snapping is off); new items get grid-sized boxes and sliding keeps them on the grid */
  function gridStep(p) { return p.settings && p.settings.snapToGrid && p.settings.gridSize > 1 ? p.settings.gridSize : 1; }
  function gridUp(p, v) { var g = gridStep(p); return Math.ceil(v / g - 1e-9) * g; }
  function gridDown(p, v) { var g = gridStep(p); return Math.floor(v / g + 1e-9) * g; }
  function gridSize(p, s) { return { w: gridUp(p, s.w), h: gridUp(p, s.h) }; }
  function sizeOf(p, kind, id) {
    if (kind === 'group') return gridSize(p, L.defaultGroupSize());
    var o = M.buildIndex(p).objects[id];
    return gridSize(p, L.defaultSize(o));
  }

  /* ---------- no-overlap rules ----------
   * Items with the same parent (same rack/group, or top level) must not overlap on a map.
   * resolveDrop(): the item that was just placed/moved slides to the nearest free spot (inside its container's
   * left/top limits; right/bottom grow the container). settle(): after anything grew or resized, parents grow
   * to fit and whatever they now overlap is pushed away (as whole units, contents included), cascading up. */
  var GAP = 0; // boxes may touch (e.g. one grid cell under another); they just must not overlap
  function parentMap(p) {
    var m = {};
    p.groups.forEach(function (g) { m[g.id] = g.parentGroupId || null; });
    p.objects.forEach(function (o) { m[o.id] = o.containerId || null; });
    return m;
  }
  /* drawn height of a placement: equipment with folded sections is shorter than its stored box (the app supplies the fold state) */
  var effH = function (q) { return q.h; };
  function setHeightFn(fn) { effH = fn || function (q) { return q.h; }; }
  function overlaps(a, b) { var ah = effH(a), bh = effH(b); return a.x < b.x + b.w + GAP && b.x < a.x + a.w + GAP && a.y < b.y + bh + GAP && b.y < a.y + ah + GAP; }
  function siblingsOf(p, pm, pl) {
    return p.placements.filter(function (q) {
      return !q.ghost && !pl.ghost && q.mapId === pl.mapId && q.id !== pl.id && Object.prototype.hasOwnProperty.call(pm, q.refId) && pm[q.refId] === pm[pl.refId];
    });
  }
  function boundsFor(p, pm, pl) {
    var par = pm[pl.refId], cp = par ? M.placementOf(p, pl.mapId, par) : null;
    return cp ? { minX: cp.x + M.PAD, minY: cp.y + M.HEADER + 2 } : { minX: -Infinity, minY: -Infinity };
  }
  function nearestFree(p, pm, pl, sibs) {
    var b = boundsFor(p, pm, pl), best = null;
    function free(x, y) {
      var r = { id: pl.id, refId: pl.refId, mapId: pl.mapId, x: x, y: y, w: pl.w, h: pl.h };
      return x >= b.minX && y >= b.minY && !sibs.some(function (s) { return overlaps(r, s); });
    }
    sibs.forEach(function (o) {
      [pl.x, gridUp(p, o.x + o.w + GAP), gridDown(p, o.x - pl.w - GAP)].forEach(function (x) {
        [pl.y, gridUp(p, o.y + effH(o) + GAP), gridDown(p, o.y - effH(pl) - GAP)].forEach(function (y) {
          if (x === pl.x && y === pl.y) return;
          if (!free(x, y)) return;
          var d = Math.abs(x - pl.x) + Math.abs(y - pl.y);
          if (!best || d < best.d) best = { dx: x - pl.x, dy: y - pl.y, d: d };
        });
      });
    });
    if (!best) { // boxed in: go below the lowest sibling
      var low = sibs.reduce(function (m, s) { return Math.max(m, s.y + effH(s)); }, 0);
      best = { dx: Math.max(b.minX, pl.x) - pl.x, dy: gridUp(p, low + GAP) - pl.y };
    }
    return best;
  }
  function ancestorPlacements(p, pm, mapId, refId) {
    var out = [], id = pm[refId], guard = 0;
    while (id && guard++ < 20) {
      var q = M.placementOf(p, mapId, id);
      if (q) out.push(q);
      id = pm[id];
    }
    return out;
  }
  /* equipment flagged fullWidth fills the inner width of its container (never below its readable minimum) */
  /* side margin of full-width equipment: one grid step when the container sits on the grid (so the edge is on the grid too) */
  function fwInset(p, cp) { var g = gridStep(p); return g > 1 && cp.x % g === 0 ? gridUp(p, M.PAD) : M.PAD; }
  function applyFullWidth(p, mapId, containerRefId) {
    var cp = M.placementOf(p, mapId, containerRefId), changed = false;
    if (!cp) return false;
    var inset = fwInset(p, cp);
    M.containerChildren(p, containerRefId).forEach(function (k) {
      if (k.kind !== 'object') return;
      var o = M.findContainer(p, k.id).item;
      if (!o.fullWidth || o.type === 'rack') return;
      var q = M.placementOf(p, mapId, k.id);
      if (!q) return;
      var w = Math.max(L.minWidth(o), cp.w - 2 * inset), x = cp.x + inset, h = Math.max(q.h, L.minSizeAt(o, w).h);
      if (q.w !== w || q.x !== x || q.h !== h) { q.w = w; q.x = x; q.h = h; changed = true; }
    });
    return changed;
  }
  function applyFullWidthFor(p, objectId) {
    var c = M.findContainer(p, objectId);
    if (!c || !c.item.containerId) return;
    p.placements.forEach(function (pl) { if (pl.refId === objectId) { applyFullWidth(p, pl.mapId, c.item.containerId); settle(p, pl); } });
  }
  function settle(p, startPl) {
    var pm = parentMap(p), queue = [startPl].concat(ancestorPlacements(p, pm, startPl.mapId, startPl.refId)), guard = 0;
    while (queue.length && guard++ < 400) {
      var pl = queue.shift();
      applyFullWidth(p, pl.mapId, pl.refId);
      // a container must hold its (possibly just stretched) contents
      var selfBefore = pl.w + 'x' + pl.h;
      M.growToFit(p, pl.mapId, pl.refId);
      if (pl.w + 'x' + pl.h !== selfBefore) ancestorPlacements(p, pm, pl.mapId, pl.refId).forEach(function (q) { queue.push(q); });
      // 1. parents grow to hold this item; grown parents get checked as well
      var chain = ancestorPlacements(p, pm, pl.mapId, pl.refId);
      if (chain.length) {
        var before = chain.map(function (q) { return q.w + 'x' + q.h; });
        M.growToFit(p, pl.mapId, pm[pl.refId]);
        chain.forEach(function (q, i) { if (q.w + 'x' + q.h !== before[i]) queue.push(q); });
      }
      // 2. whatever this item now overlaps is pushed away along the axis of least overlap
      var bd = boundsFor(p, pm, pl);
      siblingsOf(p, pm, pl).forEach(function (s) {
        if (!overlaps(pl, s)) return;
        var ox = gridUp(p, Math.min(pl.x + pl.w, s.x + s.w) - Math.max(pl.x, s.x) + GAP);
        var oy = gridUp(p, Math.min(pl.y + effH(pl), s.y + effH(s)) - Math.max(pl.y, s.y) + GAP);
        var dx = 0, dy = 0;
        if (ox <= oy) { dx = (s.x + s.w / 2 >= pl.x + pl.w / 2) ? ox : -ox; if (s.x + dx < bd.minX) dx = ox; }
        else { dy = (s.y + s.h / 2 >= pl.y + pl.h / 2) ? oy : -oy; if (s.y + dy < bd.minY) dy = oy; }
        M.movePlacement(p, s.id, dx, dy, true);
        queue.push(s);
      });
    }
  }
  /*
   * Magnet: items stacked directly under an item (touching it, or one grid step away) follow it when its drawn height changes
   * (folding or unfolding sections), together with whatever is stacked under them in turn.
   */
  function stackedBelow(p, pl, oldH) {
    var pm = parentMap(p), tol = Math.max(gridStep(p), 8) + 2, out = [], seen = {}, queue = [{ x: pl.x, w: pl.w, bottom: pl.y + oldH }];
    seen[pl.id] = true;
    var sibs = siblingsOf(p, pm, pl);
    while (queue.length) {
      var cur = queue.shift();
      sibs.forEach(function (s) {
        if (seen[s.id] || !(s.x < cur.x + cur.w && cur.x < s.x + s.w)) return;
        var gap = s.y - cur.bottom;
        if (gap < -2 || gap > tol) return;
        seen[s.id] = true; out.push(s);
        queue.push({ x: s.x, w: s.w, bottom: s.y + effH(s) });
      });
    }
    return out;
  }
  function followFold(p, pl, oldH, newH) {
    var moved = stackedBelow(p, pl, oldH), g = gridStep(p), d = newH - oldH;
    d = d > 0 ? gridUp(p, d) : -Math.floor(-d / g + 1e-9) * g;
    if (!moved.length || !d) return moved.length ? moved : [];
    moved.forEach(function (s) { M.movePlacement(p, s.id, 0, d, true); });
    moved.concat([pl]).forEach(function (s) { settle(p, s); });
    return moved;
  }
  /* returns true when the item had to slide away from something it overlapped */
  function resolveDrop(p, plId) {
    var pl = p.placements.filter(function (x) { return x.id === plId; })[0];
    if (!pl) return false;
    var pm = parentMap(p), moved = false, sibs = siblingsOf(p, pm, pl);
    if (sibs.some(function (s) { return overlaps(pl, s); })) {
      var nf = nearestFree(p, pm, pl, sibs);
      M.movePlacement(p, pl.id, nf.dx, nf.dy, true);
      moved = true;
    }
    settle(p, pl);
    return moved;
  }

  /* Place a group/object on a map. Inside its container when that container is on the map. */
  function placeItem(p, mapId, kind, id, x, y, withContents) {
    var existing = M.placementOf(p, mapId, id);
    if (existing) return existing;
    var c = M.findContainer(p, id);
    if (!c) throw new Error('Item not found');
    var size = sizeOf(p, kind, id);
    var contId = kind === 'group' ? c.item.parentGroupId : c.item.containerId;
    var cp = contId ? M.placementOf(p, mapId, contId) : null;
    if (cp) {
      var sibs = M.containerChildren(p, contId).map(function (s) { return M.placementOf(p, mapId, s.id); }).filter(Boolean);
      var bottom = cp.y + M.HEADER + 6;
      sibs.forEach(function (s) { bottom = Math.max(bottom, s.y + s.h + 8); });
      x = cp.x + M.PAD; y = bottom;
    } else if (x == null || y == null) {
      var right = 0, any = false;
      p.placements.forEach(function (q) { if (q.mapId === mapId) { any = true; right = Math.max(right, q.x + q.w); } });
      x = any ? right + 40 : 40; y = 40;
    }
    var pl = M.addPlacement(p, mapId, kind, id, x, y, size.w, size.h);
    if (contId) M.growToFit(p, mapId, contId);
    resolveDrop(p, pl.id);
    if (withContents) {
      M.containerChildren(p, id).forEach(function (k) { placeItem(p, mapId, k.kind, k.id, null, null, true); });
    }
    return pl;
  }

  /* resize helper that keeps visual contents inside parents */
  function addGroupPlaced(p, mapId, o, x, y) {
    var grp = M.addGroup(p, o);
    placeItem(p, mapId, 'group', grp.id, x, y);
    return grp;
  }
  function addObjectPlaced(p, mapId, o, x, y) {
    var obj = M.addObject(p, o);
    placeItem(p, mapId, 'object', obj.id, x, y);
    return obj;
  }

  /* the acceptance-test scenario: two rooms on two maps, fixed link between them, wall socket in the office */
  function buildDemoProject() {
    var p = M.createProject('Demo network');
    var m1 = p.maps[0]; m1.name = 'Server room'; m1.location = 'Building A, floor 1';
    var m2 = { id: M.uid('map'), name: 'Office', location: 'Building B, floor 2', viewport: { x: 0, y: 0, zoom: 1 } };
    p.maps.push(m2);

    var roomA = addGroupPlaced(p, m1.id, { name: 'Server room' }, 40, 40);
    var rackA = addObjectPlaced(p, m1.id, { type: 'rack', name: 'Rack A', containerId: roomA.id });
    var ppA = addObjectPlaced(p, m1.id, { type: 'patchpanel', name: 'PP-A', portCount: 24, straight: true, containerId: rackA.id });
    var swA = addObjectPlaced(p, m1.id, { type: 'switch', name: 'Switch A', portCount: 24, containerId: rackA.id });
    var spare = addObjectPlaced(p, m1.id, { type: 'patchpanel', name: 'PP-Standalone', portCount: 12, straight: true }, 700, 60);

    var roomB = addGroupPlaced(p, m2.id, { name: 'Office' }, 40, 40);
    var rackB = addObjectPlaced(p, m2.id, { type: 'rack', name: 'Rack B', containerId: roomB.id });
    var ppB = addObjectPlaced(p, m2.id, { type: 'patchpanel', name: 'PP-B', portCount: 24, straight: true, containerId: rackB.id });
    var ws = addObjectPlaced(p, m2.id, { type: 'socket', name: 'WS-02', portCount: 2, containerId: roomB.id });

    // PP-A/PP-B visible on the other map as well? Keep each on its own map so the trace must cross maps.
    var swPort = function (o, n) { return o.ports.filter(function (x) { return x.side === 'front' && x.label === String(n); })[0]; };
    var rear = function (o, n) { return o.ports.filter(function (x) { return x.side === 'rear' && x.label === String(n); })[0]; };
    M.addPatchCable(p, { aPortId: swPort(swA, 12).id, bPortId: swPort(ppA, 12).id, color: '#1f77b4' });
    var link = M.addFixedLink(p, { aObjectId: ppA.id, bObjectId: ppB.id, wireCount: 24, mapping: 'sequential', cableType: 'Cat6A', route: 'Riser shaft 2', length: '85 m' });
    M.addPatchCable(p, { aPortId: swPort(ppB, 12).id, bPortId: swPort(ws, 1).id, color: '#2ca02c' });
    void rear; void link; void spare;
    return p;
  }

  /* after the port count or section size changes: resize every placement of the object to its natural size */
  function refitObject(p, objectId) {
    var o = M.buildIndex(p).objects[objectId];
    if (!o) return;
    var size = L.defaultSize(o);
    p.placements.forEach(function (pl) {
      if (pl.refId !== objectId) return;
      pl.w = size.w; pl.h = size.h;
      if (o.containerId) M.growToFit(p, pl.mapId, o.containerId);
      settle(p, pl);
      if (o.containerId && o.fullWidth) applyFullWidth(p, pl.mapId, o.containerId);
    });
  }

  /*
   * Live container extension while dragging an item toward the bottom/right edge of its container.
   * captureChain() remembers the container and its ancestors at drag start; applyExtension() is called on every
   * move: it first restores the originals, then grows the chain to hold the item only while the item's centre is
   * within `ext` of the container's original box. Dragging further away therefore "hides" the extension again.
   */
  function captureChain(p, mapId, refId) {
    var out = [], c = M.findContainer(p, refId), guard = 0;
    if (!c) return out;
    var par = M.parentOf(p, c.kind, c.id);
    while (par && guard++ < 20) {
      var q = M.placementOf(p, mapId, par.id);
      if (q) out.push({ q: q, refId: par.id, ox: q.x, oy: q.y, ow: q.w, oh: q.h });
      par = M.parentOf(p, par.kind, par.id);
    }
    return out;
  }
  function restoreChain(chain) {
    chain.forEach(function (c) { c.q.x = c.ox; c.q.y = c.oy; c.q.w = c.ow; c.q.h = c.oh; });
  }
  function applyExtension(p, mapId, chain, itemPl, ext) {
    restoreChain(chain);
    if (!chain.length) return false;
    var f = chain[0], cx = itemPl.x + itemPl.w / 2, cy = itemPl.y + itemPl.h / 2;
    if (cx >= f.ox && cx <= f.ox + f.ow + ext && cy >= f.oy && cy <= f.oy + f.oh + ext) {
      M.growToFit(p, mapId, f.refId);
      return f.q.w !== f.ow || f.q.h !== f.oh;
    }
    return false;
  }

  /* smallest group/rack on this map whose box contains the dragged item's centre (never the item itself or its contents) */
  function findDropContainer(p, pl) {
    var cx = pl.x + pl.w / 2, cy = pl.y + pl.h / 2, banned = {}, best = null;
    banned[pl.refId] = true;
    M.descendants(p, pl.refId).forEach(function (x) { banned[x.id] = true; });
    p.placements.forEach(function (q) {
      if (q.ghost || q.mapId !== pl.mapId || banned[q.refId]) return;
      var cc = M.findContainer(p, q.refId);
      if (!cc || (cc.kind === 'object' && cc.item.type !== 'rack')) return;
      if (cx >= q.x && cx <= q.x + q.w && cy >= q.y && cy <= q.y + q.h && (!best || q.w * q.h < best.w * best.h)) best = q;
    });
    return best;
  }

  /*
   * Racks stack equipment vertically. While an item is dragged over a rack, dropSlot() says where it would attach:
   * { containerId, index, line: {x, y, w} } - the line is drawn between the neighbours it would sit between.
   */
  function stackSiblings(p, mapId, rackId, exceptRefId) {
    return M.containerChildren(p, rackId).filter(function (c) { return c.id !== exceptRefId; })
      .map(function (c) { return M.placementOf(p, mapId, c.id); }).filter(function (q) { return q && !q.ghost; })
      .sort(function (a, b) { return a.y - b.y; });
  }
  /*
   * fromContainerId: the container the item was dragged out of. Coming from elsewhere, the rack magnet applies anywhere
   * (including both ends). Moving inside its own rack, the magnet only applies at a seam between two items that are
   * stuck together (gap <= SEAM_STUCK), so everything else can be placed freely.
   */
  var SEAM_STUCK = 16, SEAM_BAND = 14;
  function dropSlot(p, dragPl, fromContainerId) {
    var c0 = M.findContainer(p, dragPl.refId);
    if (!c0 || c0.kind !== 'object' || c0.item.type === 'rack') return null;
    var rackPl = findDropContainer(p, dragPl);
    if (!rackPl) return null;
    var rc = M.findContainer(p, rackPl.refId);
    if (!rc || rc.kind !== 'object' || rc.item.type !== 'rack') return null;
    var sibs = stackSiblings(p, dragPl.mapId, rackPl.refId, dragPl.refId), cy = dragPl.y + dragPl.h / 2, index = 0;
    // next to an existing item in the same row (e.g. adding to a row of devices): free placement, no magnet. "Next to" = shares
    // a good part of its height but not its width, so items that stack above/below each other (same width) still magnetise.
    function overlap(a0, a1, b0, b1) { return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)); }
    if (sibs.some(function (s) {
      return overlap(dragPl.y, dragPl.y + dragPl.h, s.y, s.y + s.h) > 0.3 * dragPl.h && overlap(dragPl.x, dragPl.x + dragPl.w, s.x, s.x + s.w) < 0.3 * dragPl.w;
    })) return null;
    if (fromContainerId === rackPl.refId) {
      var best = null;
      for (var i = 1; i < sibs.length; i++) {
        var bottom = sibs[i - 1].y + sibs[i - 1].h, gap = sibs[i].y - bottom;
        if (gap > SEAM_STUCK) continue;
        var mid = (bottom + sibs[i].y) / 2, dist = Math.abs(cy - mid);
        if (dist <= SEAM_BAND + Math.max(0, gap) / 2 && (!best || dist < best.dist)) best = { i: i, dist: dist, y: mid };
      }
      if (!best) return null;
      return { containerId: rackPl.refId, index: best.i, line: { x: rackPl.x + M.PAD / 2, y: best.y, w: rackPl.w - M.PAD } };
    }
    sibs.forEach(function (s) { if (s.y + s.h / 2 < cy) index++; });
    // dropped (or newly placed) into free space between items: nothing to insert between, so it stays exactly where it was put
    // (only a drop touching or close to a neighbour is inserted into the stack; below the last item it still joins the stack)
    var near = 24;
    if (index < sibs.length && !sibs.some(function (s) { return dragPl.x < s.x + s.w + near && s.x < dragPl.x + dragPl.w + near && dragPl.y < s.y + effH(s) + near && s.y < dragPl.y + dragPl.h + near; })) return null;
    var above = sibs.slice(0, index), below = sibs.slice(index);
    var prevBottom = above.reduce(function (m, s) { return Math.max(m, s.y + s.h); }, rackPl.y + M.HEADER);
    var y = below.length ? (prevBottom + Math.min.apply(null, below.map(function (s) { return s.y; }))) / 2 : prevBottom + 4;
    return { containerId: rackPl.refId, index: index, line: { x: rackPl.x + M.PAD / 2, y: y, w: rackPl.w - M.PAD } };
  }
  /* attach: re-stack the rack's equipment top to bottom with the dragged item at `index` */
  function restack(p, mapId, rackId, dragRefId, index) {
    var rackPl = M.placementOf(p, mapId, rackId), dragPl = M.placementOf(p, mapId, dragRefId);
    if (!rackPl || !dragPl) return;
    // Insert at the slot without re-flowing the rack: only the dragged item moves into place and whatever sits at or below the
    // slot is pushed down, so rows of side-by-side devices keep their layout. In a plain stack (everything left-aligned) the
    // item also aligns to it; otherwise it keeps the x where it was dropped.
    var sibs = stackSiblings(p, mapId, rackId, dragRefId), left = rackPl.x + M.PAD;
    var stacked = sibs.every(function (s) { return Math.abs(s.x - left) < 3; });
    var lastBottom = sibs.reduce(function (m, s) { return Math.max(m, s.y + s.h); }, rackPl.y + M.HEADER - 2);
    var prevBottom = index > 0 ? sibs[index - 1].y + effH(sibs[index - 1]) : rackPl.y + M.HEADER - 2;
    var nextTop = index < sibs.length ? sibs[index].y : Infinity;
    // room for it between its neighbours: it sits right under the item above (the rack's usual 8px spacing) and nothing moves;
    // in a tight stack it takes the place of the next item and pushes that one and everything below down
    var fits = nextTop - prevBottom >= dragPl.h + 8 + 8;
    var slotTop = index >= sibs.length ? lastBottom + 8 : (fits ? prevBottom + 8 : nextTop);
    var below = fits || index >= sibs.length ? [] : sibs.filter(function (s) { return s.y >= slotTop - 1; });
    dragPl.y = slotTop;
    dragPl.x = stacked ? left : Math.max(dragPl.x, left);
    below.forEach(function (s) { s.y += dragPl.h + 8; });
    M.growToFit(p, mapId, rackId);
  }

  /* smallest size a placement may have: equipment keeps its labels readable, containers keep their contents inside */
  function minPlacementSize(p, pl) {
    var c = M.findContainer(p, pl.refId);
    if (!c) return { w: 40, h: 30 };
    var base = c.kind === 'object' ? { w: L.minWidth(c.item), h: L.minSizeAt(c.item, pl.w).h } : { w: 100, h: 60 };
    M.containerChildren(p, pl.refId).forEach(function (k) {
      var q = M.placementOf(p, pl.mapId, k.id);
      var kc = M.findContainer(p, k.id);
      if (q) { base.w = Math.max(base.w, (kc && kc.item.fullWidth ? L.minWidth(kc.item) + 2 * fwInset(p, pl) : q.x + q.w + M.PAD - pl.x)); base.h = Math.max(base.h, q.y + q.h + M.PAD - pl.y); }
    });
    return base;
  }
  /*
   * Repair placements that are too small (projects made by older versions or edited by hand): equipment grows to its
   * minimum, containers grow around their contents, and overlaps that creates are resolved. Returns how many changed.
   */
  function normalizeSizes(p) {
    var changed = 0, touched = [];
    p.placements.forEach(function (pl) {
      var c = M.findContainer(p, pl.refId);
      if (pl.ghost || !c || c.kind !== 'object') return;
      var mn = L.minSizeAt(c.item, pl.w);
      if (pl.w < mn.w || pl.h < mn.h) { pl.w = Math.max(pl.w, mn.w); pl.h = Math.max(pl.h, mn.h); changed++; touched.push(pl); }
    });
    touched.forEach(function (pl) { settle(p, pl); });
    // anything the repairs above made overlap (or that overlapped already) slides apart again
    var before = p.placements.map(function (q) { return q.x + ',' + q.y + ',' + q.w + ',' + q.h; });
    p.placements.slice().sort(function (a, b) { return a.y - b.y; }).forEach(function (pl) { if (siblingsOf(p, parentMap(p), pl).some(function (s) { return overlaps(pl, s); })) settle(p, pl); });
    p.placements.forEach(function (q, i) { if (before[i] !== q.x + ',' + q.y + ',' + q.w + ',' + q.h) changed++; });
    // full-width equipment must line up with its container (old files, or an item that was left half a step off)
    p.placements.forEach(function (pl) {
      var c = M.findContainer(p, pl.refId);
      if (!c || c.kind !== 'object' || !c.item.fullWidth || !c.item.containerId || c.item.type === 'rack') return;
      var cp = M.placementOf(p, pl.mapId, c.item.containerId);
      if (!cp) return;
      var x0 = pl.x, w0 = pl.w;
      if (applyFullWidth(p, pl.mapId, c.item.containerId) && (pl.x !== x0 || pl.w !== w0)) { changed++; settle(p, pl); }
    });
    return changed;
  }
  /*
   * Old projects: put every box on the grid (position to the nearest grid line, size rounded up so nothing gets smaller than
   * its readable minimum), then settle so containers hold their contents and nothing overlaps. Runs once automatically per
   * project (settings.gridAligned) unless force is set. Returns how many placements changed.
   */
  function alignToGrid(p, force) {
    var s = p.settings, g = gridStep(p);
    if (!s || g <= 1 || (!force && s.gridAligned)) return 0;
    var pm = parentMap(p), changed = 0;
    function depth(pl) { var d = 0, id = pm[pl.refId], n = 0; while (id && n++ < 20) { d++; id = pm[id]; } return d; }
    var list = p.placements.filter(function (pl) { return !pl.ghost; }).map(function (pl) { return { pl: pl, d: depth(pl) }; }).sort(function (a, b) { return a.d - b.d; });
    list.forEach(function (it) {
      var pl = it.pl, par = pm[pl.refId], cp = par ? M.placementOf(p, pl.mapId, par) : null;
      var fc = M.findContainer(p, pl.refId);
      if (cp && fc && fc.kind === 'object' && fc.item.fullWidth) return; // lined up with its container by applyFullWidth
      var nx = Math.round(pl.x / g) * g, ny = Math.round(pl.y / g) * g;
      if (cp) { nx = Math.max(nx, gridUp(p, cp.x + M.PAD)); ny = Math.max(ny, gridUp(p, cp.y + M.HEADER + 2)); }
      var nw = gridUp(p, pl.w), nh = gridUp(p, pl.h);
      if (nx !== pl.x || ny !== pl.y || nw !== pl.w || nh !== pl.h) { pl.x = nx; pl.y = ny; pl.w = nw; pl.h = nh; changed++; }
    });
    // containers that grew around off-grid contents are rounded up again (deepest first) until nothing changes
    for (var pass = 0; pass < 4; pass++) {
      var again = false;
      list.slice().reverse().forEach(function (it) {
        settle(p, it.pl);
        var q = it.pl, nw = gridUp(p, q.w), nh = gridUp(p, q.h);
        if (nw !== q.w || nh !== q.h) { q.w = nw; q.h = nh; again = true; changed++; }
      });
      if (!again) break;
    }
    s.gridAligned = true;
    return changed;
  }
  /*
   * Add an item that lives on another map to this one, in one of two ways:
   *  - ghost: a semi-transparent, non-editable copy of the item (and, for racks/groups, of what is inside it) that mirrors every
   *    change made on its own map; the real placement stays where it is
   *  - move: the item (with its contents) leaves the map(s) it was on, keeping its layout, and appears here
   * (x, y) is the top-left corner of the item on this map.
   */
  function sourceBox(p, kind, id, fromMapId) {
    var ids = [{ kind: kind, id: id }].concat(M.descendants(p, id).map(function (d) { return { kind: d.kind, id: d.id }; })), root = null, list = [];
    ids.forEach(function (it) {
      var q = fromMapId ? M.placementOf(p, fromMapId, it.id) : M.realPlacement(p, it.id);
      if (q && !q.ghost) { list.push({ it: it, q: q }); if (it.id === id) root = q; }
    });
    return root ? { root: root, list: list } : null;
  }
  function addGhost(p, mapId, kind, id, x, y, withContents) {
    var src = sourceBox(p, kind, id);
    if (!src) throw new Error('This item is not on any map yet, so there is nothing to mirror. Add it normally first.');
    var out = null;
    src.list.forEach(function (e) {
      if (!withContents && e.it.id !== id) return;
      if (M.placementOf(p, mapId, e.it.id)) return;
      var pl = M.addPlacement(p, mapId, e.it.kind, e.it.id, x + e.q.x - src.root.x, y + e.q.y - src.root.y, e.q.w, e.q.h);
      pl.ghost = true;
      if (e.it.id === id) out = pl;
    });
    return out;
  }
  function relocate(p, mapId, kind, id, x, y, fromMapId) {
    var src = sourceBox(p, kind, id, fromMapId);
    if (!src) throw new Error('This item is not on the other map');
    var gone = {}; src.list.forEach(function (e) { gone[e.q.id] = true; });
    var moved = src.list.map(function (e) { return { it: e.it, dx: e.q.x - src.root.x, dy: e.q.y - src.root.y, w: e.q.w, h: e.q.h }; });
    p.placements = p.placements.filter(function (q) { return !gone[q.id]; });
    var rootPl = null;
    moved.forEach(function (m) {
      p.placements = p.placements.filter(function (q) { return !(q.mapId === mapId && q.refId === m.it.id && q.ghost); }); // a ghost of it here becomes the real thing
      var pl = M.addPlacement(p, mapId, m.it.kind, m.it.id, x + m.dx, y + m.dy, m.w, m.h);
      if (m.it.id === id) rootPl = pl;
    });
    var c = M.findContainer(p, id), par = c && (c.kind === 'group' ? c.item.parentGroupId : c.item.containerId);
    if (par && M.placementOf(p, mapId, par) && !M.placementOf(p, mapId, par).ghost) M.growToFit(p, mapId, par);
    resolveDrop(p, rootPl.id);
    return rootPl;
  }
  /*
   * Equipment patched to an item (directly, by patch cable) that sits on the same map: what has to travel with it so that moving the
   * item does not leave cables hanging between two maps. Fixed links are not followed - they stay and are drawn as labelled stubs.
   * Returns [{ kind, id, name, via: [cable names] }].
   */
  function patchedNeighbours(p, kind, id, mapId) {
    var inSet = {}; inSet[id] = true;
    M.descendants(p, id).forEach(function (d) { inSet[d.id] = true; });
    var idx = M.buildIndex(p), out = {}, order = [];
    p.patchCables.forEach(function (c) {
      var a = idx.portObj[c.aPortId], b = idx.portObj[c.bPortId];
      if (!a || !b || !!inSet[a.id] === !!inSet[b.id]) return;
      var o = inSet[a.id] ? b : a, q = M.placementOf(p, mapId, o.id);
      if (!q || q.ghost) return;
      if (!out[o.id]) { out[o.id] = { kind: 'object', id: o.id, name: o.name, via: [] }; order.push(o.id); }
      out[o.id].via.push(c.name);
    });
    return order.map(function (k) { return out[k]; });
  }
  /* relocate several items as one cluster: they keep their positions relative to each other */
  function relocateMany(p, mapId, items, x, y, fromMapId) {
    var boxes = items.map(function (it) { var s = sourceBox(p, it.kind, it.id, fromMapId); return s && { it: it, root: s.root }; }).filter(Boolean);
    if (!boxes.length) throw new Error('Nothing to move: the items are not on that map');
    var minX = Math.min.apply(null, boxes.map(function (b) { return b.root.x; })), minY = Math.min.apply(null, boxes.map(function (b) { return b.root.y; }));
    return boxes.map(function (b) { return relocate(p, mapId, b.it.kind, b.it.id, x + b.root.x - minX, y + b.root.y - minY, fromMapId); });
  }
  /* free spot for a cluster arriving on a map: right of what is there */
  function arrivalSpot(p, mapId) {
    var right = 0, any = false;
    p.placements.forEach(function (q) { if (q.mapId === mapId) { any = true; right = Math.max(right, q.x + q.w); } });
    return { x: any ? Math.ceil((right + 80) / 20) * 20 : 40, y: 40 };
  }
  /* after a label/port change: grow (never shrink) the object's placements to the new minimum */
  function fitMinimum(p, objectId) {
    var o = M.buildIndex(p).objects[objectId];
    if (!o) return;
    p.placements.forEach(function (pl) {
      var mn = L.minSizeAt(o, pl.w);
      if (pl.refId !== objectId || (pl.w >= mn.w && pl.h >= mn.h)) return;
      pl.w = Math.max(pl.w, mn.w); pl.h = Math.max(pl.h, mn.h);
      settle(p, pl);
    });
  }

  /* smallest group (or rack, for equipment) on the map whose box contains the point - where a new item dropped there would live */
  function containerAt(p, mapId, cx, cy, kind, type) {
    var best = null;
    p.placements.forEach(function (q) {
      if (q.ghost || q.mapId !== mapId || !(cx >= q.x && cx <= q.x + q.w && cy >= q.y && cy <= q.y + q.h)) return;
      var c = M.findContainer(p, q.refId);
      if (!c) return;
      var ok = c.kind === 'group' || (c.kind === 'object' && c.item.type === 'rack' && kind === 'object' && type !== 'rack');
      if (ok && (!best || q.w * q.h < best.w * best.h)) best = q;
    });
    return best;
  }
  /*
   * Create a new group/object with its top-left at (x, y) and file it into the container under its centre (racks stack it at the
   * dropped slot). spec: addGroup / addObject options without a container. Returns { id, placement }.
   */
  function placeNewAt(p, mapId, kind, spec, x, y) {
    var item, size, pl;
    if (kind === 'group') { item = M.addGroup(p, { name: spec.name }); size = gridSize(p, L.defaultGroupSize()); }
    else { item = M.addObject(p, spec); size = gridSize(p, L.defaultSize(item)); }
    pl = M.addPlacement(p, mapId, kind, item.id, x, y, size.w, size.h);
    var host = containerAt(p, mapId, x + 2, y + 2, kind, item.type); // the container under the top-left corner (the cursor)
    if (host) {
      try { M.setContainer(p, kind, item.id, host.refId); } catch (e) { host = null; }
    }
    if (host) {
      var hc = M.findContainer(p, host.refId);
      if (hc.kind === 'object') { var slot = dropSlot(p, pl, null); if (slot) restack(p, mapId, host.refId, item.id, slot.index); }
      M.growToFit(p, mapId, host.refId);
    }
    resolveDrop(p, pl.id);
    return { id: item.id, placement: pl };
  }
  /*
   * Copy / paste. A clip is a snapshot of an item (with everything inside a group or rack): settings, ports (labels, sections,
   * port groups, internal mappings) and the layout relative to the item. Connections (patch cables, fixed links) are never
   * copied, and neither are IP addresses (a copy with the same address would clash on the network).
   */
  function copyClip(p, mapId, kind, id) {
    var c = M.findContainer(p, id);
    if (!c || c.kind !== kind) return null;
    var root = M.placementOf(p, mapId, id);
    var ids = [{ kind: kind, id: id }].concat(M.descendants(p, id).map(function (d) { return { kind: d.kind, id: d.id }; }));
    var clip = { kind: kind, rootId: id, type: kind === 'object' ? c.item.type : null, groups: [], objects: [], placements: [], mappings: [] };
    ids.forEach(function (it) {
      var f = M.findContainer(p, it.id);
      if (!f) return;
      var copy = JSON.parse(JSON.stringify(f.item));
      if (it.kind === 'group') clip.groups.push(copy);
      else {
        delete copy.ipAddress; copy.ports.forEach(function (pt) { delete pt.ip; });
        (copy.portGroups || []).forEach(function (g) { delete g.peerId; }); // a copy is not linked to the original's far end
        clip.objects.push(copy);
        p.internalMappings.forEach(function (m) { if (m.objectId === it.id) clip.mappings.push(JSON.parse(JSON.stringify(m))); });
      }
      var q = M.placementOf(p, mapId, it.id);
      if (q) clip.placements.push({ refId: it.id, kind: it.kind, dx: root ? q.x - root.x : 0, dy: root ? q.y - root.y : 0, w: q.w, h: q.h });
    });
    if (!root) { var sz = kind === 'group' ? L.defaultGroupSize() : L.defaultSize(c.item); clip.placements = [{ refId: id, kind: kind, dx: 0, dy: 0, w: sz.w, h: sz.h }]; }
    return clip;
  }
  /* "Switch" -> "Switch (Copy 1)"; copying a copy counts on: "Switch (Copy 2)" */
  function copyName(p, kind, name) {
    var base = String(name).replace(/ \(Copy \d+\)$/, ''), list = (kind === 'group' ? p.groups : p.objects), n = 1;
    function taken(s) { return list.some(function (x) { return x.name === s; }); }
    while (taken(base + ' (Copy ' + n + ')')) n++;
    return base + ' (Copy ' + n + ')';
  }
  function pasteClipAt(p, mapId, clip, x, y) {
    var map = {}, host = containerAt(p, mapId, x + 2, y + 2, clip.kind, clip.type);
    clip.groups.forEach(function (g) { map[g.id] = M.uid('grp'); });
    clip.objects.forEach(function (o) { map[o.id] = M.uid('obj'); o.ports.forEach(function (pt) { map[pt.id] = M.uid('port'); }); });
    clip.groups.forEach(function (g) {
      var n = JSON.parse(JSON.stringify(g));
      n.id = map[g.id]; n.name = copyName(p, 'group', g.name); n.parentGroupId = g.id === clip.rootId ? null : (map[g.parentGroupId] || null);
      p.groups.push(n);
    });
    clip.objects.forEach(function (o) {
      var n = JSON.parse(JSON.stringify(o));
      n.id = map[o.id]; n.name = copyName(p, 'object', o.name); n.containerId = o.id === clip.rootId ? null : (map[o.containerId] || null);
      n.ports.forEach(function (pt) { pt.id = map[pt.id]; });
      (n.portGroups || []).forEach(function (g) { g.id = M.uid('pgp'); g.portIds = g.portIds.map(function (i) { return map[i]; }).filter(Boolean); });
      p.objects.push(n);
    });
    clip.mappings.forEach(function (m) { p.internalMappings.push({ id: M.uid('map_i'), objectId: map[m.objectId], aPortId: map[m.aPortId], bPortId: map[m.bPortId] }); });
    var rootPl = null;
    clip.placements.forEach(function (q) {
      var pl = M.addPlacement(p, mapId, q.kind, map[q.refId], x + q.dx, y + q.dy, q.w, q.h);
      if (q.refId === clip.rootId) rootPl = pl;
    });
    var newRoot = map[clip.rootId];
    if (host) {
      try { M.setContainer(p, clip.kind, newRoot, host.refId); } catch (e) { host = null; }
    }
    if (host) {
      var hc = M.findContainer(p, host.refId);
      if (hc.kind === 'object') { var slot = dropSlot(p, rootPl, null); if (slot) restack(p, mapId, host.refId, newRoot, slot.index); }
      M.growToFit(p, mapId, host.refId);
    }
    resolveDrop(p, rootPl.id);
    return { id: newRoot, placement: rootPl };
  }
  /* 'Switch 1' -> 'Switch 2', 'PC' -> 'PC 2', 'AP-07' -> 'AP-08' */
  function nextName(name) {
    var m = /^(.*?)(\d+)$/.exec(String(name));
    if (!m) return name + ' 2';
    var n = String(+m[2] + 1);
    while (n.length < m[2].length) n = '0' + n;
    return m[1] + n;
  }

  NM.builder = { containerAt: containerAt, placeNewAt: placeNewAt, copyClip: copyClip, pasteClipAt: pasteClipAt, copyName: copyName, nextName: nextName, applyFullWidth: applyFullWidth, applyFullWidthFor: applyFullWidthFor, minPlacementSize: minPlacementSize, normalizeSizes: normalizeSizes, addGhost: addGhost, relocate: relocate, relocateMany: relocateMany, patchedNeighbours: patchedNeighbours, arrivalSpot: arrivalSpot, setHeightFn: setHeightFn, stackedBelow: stackedBelow, followFold: followFold, alignToGrid: alignToGrid, fitMinimum: fitMinimum, resolveDrop: resolveDrop, settle: settle, findDropContainer: findDropContainer, dropSlot: dropSlot, restack: restack, captureChain: captureChain, restoreChain: restoreChain, applyExtension: applyExtension, refitObject: refitObject, placeItem: placeItem, addGroupPlaced: addGroupPlaced, addObjectPlaced: addObjectPlaced, buildDemoProject: buildDemoProject };
  if (typeof module !== 'undefined' && module.exports) module.exports = NM.builder;
})(typeof window !== 'undefined' ? window : globalThis);
