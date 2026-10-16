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

  NM.builder = { captureChain: captureChain, restoreChain: restoreChain, applyExtension: applyExtension, refitObject: refitObject, placeItem: placeItem, addGroupPlaced: addGroupPlaced, addObjectPlaced: addObjectPlaced, buildDemoProject: buildDemoProject };
  if (typeof module !== 'undefined' && module.exports) module.exports = NM.builder;
})(typeof window !== 'undefined' ? window : globalThis);
