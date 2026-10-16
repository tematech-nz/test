/* Higher-level helpers that combine the model with layout (placing items on maps) and a demo project. */
(function (g) {
  'use strict';
  var NM = g.NetMap = g.NetMap || {};
  if (typeof require === 'function') { ['model', 'layout'].forEach(function (n) { if (!NM[n]) require('./' + n + '.js'); }); }
  var M = NM.model, L = NM.layout;

  function sizeOf(p, kind, id) {
    if (kind === 'group') return L.defaultGroupSize();
    var o = M.buildIndex(p).objects[id];
    return L.defaultSize(o);
  }

  /* ---------- no-overlap rules ----------
   * Items with the same parent (same rack/group, or top level) must not overlap on a map.
   * resolveDrop(): the item that was just placed/moved slides to the nearest free spot (inside its container's
   * left/top limits; right/bottom grow the container). settle(): after anything grew or resized, parents grow
   * to fit and whatever they now overlap is pushed away (as whole units, contents included), cascading up. */
  var GAP = 6;
  function parentMap(p) {
    var m = {};
    p.groups.forEach(function (g) { m[g.id] = g.parentGroupId || null; });
    p.objects.forEach(function (o) { m[o.id] = o.containerId || null; });
    return m;
  }
  function overlaps(a, b) { return a.x < b.x + b.w + GAP && b.x < a.x + a.w + GAP && a.y < b.y + b.h + GAP && b.y < a.y + a.h + GAP; }
  function siblingsOf(p, pm, pl) {
    return p.placements.filter(function (q) {
      return q.mapId === pl.mapId && q.id !== pl.id && Object.prototype.hasOwnProperty.call(pm, q.refId) && pm[q.refId] === pm[pl.refId];
    });
  }
  function boundsFor(p, pm, pl) {
    var par = pm[pl.refId], cp = par ? M.placementOf(p, pl.mapId, par) : null;
    return cp ? { minX: cp.x + M.PAD, minY: cp.y + M.HEADER + 2 } : { minX: -Infinity, minY: -Infinity };
  }
  function nearestFree(p, pm, pl, sibs) {
    var b = boundsFor(p, pm, pl), best = null;
    function free(x, y) {
      var r = { x: x, y: y, w: pl.w, h: pl.h };
      return x >= b.minX && y >= b.minY && !sibs.some(function (s) { return overlaps(r, s); });
    }
    sibs.forEach(function (o) {
      [pl.x, o.x + o.w + GAP, o.x - pl.w - GAP].forEach(function (x) {
        [pl.y, o.y + o.h + GAP, o.y - pl.h - GAP].forEach(function (y) {
          if (x === pl.x && y === pl.y) return;
          if (!free(x, y)) return;
          var d = Math.abs(x - pl.x) + Math.abs(y - pl.y);
          if (!best || d < best.d) best = { dx: x - pl.x, dy: y - pl.y, d: d };
        });
      });
    });
    if (!best) { // boxed in: go below the lowest sibling
      var low = sibs.reduce(function (m, s) { return Math.max(m, s.y + s.h); }, 0);
      best = { dx: Math.max(b.minX, pl.x) - pl.x, dy: low + GAP - pl.y };
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
  function settle(p, startPl) {
    var pm = parentMap(p), queue = [startPl].concat(ancestorPlacements(p, pm, startPl.mapId, startPl.refId)), guard = 0;
    while (queue.length && guard++ < 400) {
      var pl = queue.shift();
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
        var ox = Math.min(pl.x + pl.w, s.x + s.w) - Math.max(pl.x, s.x) + GAP;
        var oy = Math.min(pl.y + pl.h, s.y + s.h) - Math.max(pl.y, s.y) + GAP;
        var dx = 0, dy = 0;
        if (ox <= oy) { dx = (s.x + s.w / 2 >= pl.x + pl.w / 2) ? ox : -ox; if (s.x + dx < bd.minX) dx = ox; }
        else { dy = (s.y + s.h / 2 >= pl.y + pl.h / 2) ? oy : -oy; if (s.y + dy < bd.minY) dy = oy; }
        M.movePlacement(p, s.id, dx, dy, true);
        queue.push(s);
      });
    }
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
      if (q.mapId !== pl.mapId || banned[q.refId]) return;
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
      .map(function (c) { return M.placementOf(p, mapId, c.id); }).filter(Boolean)
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
    var top = rackPl.y + M.HEADER, prevBottom = index ? sibs[index - 1].y + sibs[index - 1].h : top;
    var y = index < sibs.length ? (prevBottom + sibs[index].y) / 2 : prevBottom + 4;
    return { containerId: rackPl.refId, index: index, line: { x: rackPl.x + M.PAD / 2, y: y, w: rackPl.w - M.PAD } };
  }
  /* attach: re-stack the rack's equipment top to bottom with the dragged item at `index` */
  function restack(p, mapId, rackId, dragRefId, index) {
    var rackPl = M.placementOf(p, mapId, rackId), dragPl = M.placementOf(p, mapId, dragRefId);
    if (!rackPl || !dragPl) return;
    var list = stackSiblings(p, mapId, rackId, dragRefId);
    list.splice(Math.min(index, list.length), 0, dragPl);
    var y = rackPl.y + M.HEADER + 6;
    list.forEach(function (q) { q.x = rackPl.x + M.PAD; q.y = y; y += q.h + 8; });
    M.growToFit(p, mapId, rackId);
  }

  /* smallest size a placement may have: equipment keeps its labels readable, containers keep their contents inside */
  function minPlacementSize(p, pl) {
    var c = M.findContainer(p, pl.refId);
    if (!c) return { w: 40, h: 30 };
    var base = c.kind === 'object' ? L.minSize(c.item) : { w: 100, h: 60 };
    M.containerChildren(p, pl.refId).forEach(function (k) {
      var q = M.placementOf(p, pl.mapId, k.id);
      if (q) { base.w = Math.max(base.w, q.x + q.w + M.PAD - pl.x); base.h = Math.max(base.h, q.y + q.h + M.PAD - pl.y); }
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
      if (!c || c.kind !== 'object') return;
      var mn = L.minSize(c.item);
      if (pl.w < mn.w || pl.h < mn.h) { pl.w = Math.max(pl.w, mn.w); pl.h = Math.max(pl.h, mn.h); changed++; touched.push(pl); }
    });
    touched.forEach(function (pl) { settle(p, pl); });
    return changed;
  }
  /* after a label/port change: grow (never shrink) the object's placements to the new minimum */
  function fitMinimum(p, objectId) {
    var o = M.buildIndex(p).objects[objectId];
    if (!o) return;
    var mn = L.minSize(o);
    p.placements.forEach(function (pl) {
      if (pl.refId !== objectId || (pl.w >= mn.w && pl.h >= mn.h)) return;
      pl.w = Math.max(pl.w, mn.w); pl.h = Math.max(pl.h, mn.h);
      settle(p, pl);
    });
  }

  NM.builder = { minPlacementSize: minPlacementSize, normalizeSizes: normalizeSizes, fitMinimum: fitMinimum, resolveDrop: resolveDrop, settle: settle, findDropContainer: findDropContainer, dropSlot: dropSlot, restack: restack, captureChain: captureChain, restoreChain: restoreChain, applyExtension: applyExtension, refitObject: refitObject, placeItem: placeItem, addGroupPlaced: addGroupPlaced, addObjectPlaced: addObjectPlaced, buildDemoProject: buildDemoProject };
  if (typeof module !== 'undefined' && module.exports) module.exports = NM.builder;
})(typeof window !== 'undefined' ? window : globalThis);
