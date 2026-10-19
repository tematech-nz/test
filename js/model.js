/* NetMap data model: pure data + rules, no DOM, no canvas. */
(function (g) {
  'use strict';
  var NM = g.NetMap = g.NetMap || {};

  var SCHEMA_VERSION = 5;
  /* equipment that terminates installed (fixed) cabling on a rear side and presents front jacks */
  var TERMINATIONS = { patchpanel: true, socket: true };
  function isTermination(o) { return !!(o && TERMINATIONS[o.type]); }
  /* generic equipment can be drawn with an icon */
  var DEVICE_KINDS = [['other', 'Other', 'Device'], ['pc', 'PC / workstation', 'PC'], ['laptop', 'Laptop', 'Laptop'], ['ap', 'Wi-Fi access point', 'AP'],
    ['camera', 'Camera', 'Camera'], ['printer', 'Printer', 'Printer'], ['phone', 'IP phone', 'IP phone'], ['server', 'Server', 'Server']];
  function deviceKindInfo(k) { for (var i = 0; i < DEVICE_KINDS.length; i++) if (DEVICE_KINDS[i][0] === k) return DEVICE_KINDS[i]; return DEVICE_KINDS[0]; }
  function typeLabel(o) { return o.type === 'generic' && o.deviceKind ? deviceKindInfo(o.deviceKind)[1] : TYPE_LABELS[o.type]; }
  var OBJECT_TYPES = ['rack', 'patchpanel', 'switch', 'router', 'internet', 'socket', 'generic'];
  var TYPE_LABELS = { rack: 'Rack', patchpanel: 'Patch panel', switch: 'Switch', router: 'Router', internet: 'Internet / ISP', socket: 'Wall socket', generic: 'Generic' };
  var CABLE_STATUS = ['planned', 'active', 'faulty', 'spare'];
  var WIRE_STATUS = ['connected', 'spare', 'unused', 'faulty'];
  var LINK_STATUS = ['planned', 'installed', 'faulty', 'decommissioned'];
  var CABLE_COLORS = [['white', '#ffffff'], ['grey', '#8a8f98'], ['green', '#2ca02c'], ['yellow', '#f2c200'], ['blue', '#1f77b4'], ['orange', '#ff7f0e'], ['red', '#d62728'], ['black', '#111111']];
  var PAD = 10;
  var HEADER = 20;

  function now() { return new Date().toISOString(); }

  function uid(prefix) {
    var s = '';
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      s = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    } else {
      for (var i = 0; i < 16; i++) s += Math.floor(Math.random() * 16).toString(16);
    }
    return prefix + '_' + s;
  }

  function pad3(n) { var s = String(n); while (s.length < 3) s = '0' + s; return s; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function createProject(name) {
    return {
      schemaVersion: SCHEMA_VERSION,
      id: uid('prj'),
      name: name || 'Untitled project',
      createdAt: now(),
      updatedAt: now(),
      settings: { gridSize: 20, snapToGrid: true },
      counters: { patch: 0, fixed: 0 },
      maps: [{ id: uid('map'), name: 'Main map', location: '', viewport: { x: 0, y: 0, zoom: 1 } }],
      groups: [],
      objects: [],
      placements: [],
      fixedLinks: [],
      patchCables: [],
      internalMappings: []
    };
  }

  /* ---------- index ---------- */
  function buildIndex(p) {
    var idx = {
      maps: {}, groups: {}, objects: {}, ports: {}, portObj: {}, cables: {}, links: {},
      wires: {}, wireLink: {}, portUse: {}, mapByPort: {}, placements: {}, placementsByRef: {}
    };
    p.maps.forEach(function (m) { idx.maps[m.id] = m; });
    p.groups.forEach(function (x) { idx.groups[x.id] = x; });
    p.objects.forEach(function (o) {
      idx.objects[o.id] = o;
      o.ports.forEach(function (pt) { idx.ports[pt.id] = pt; idx.portObj[pt.id] = o; });
    });
    p.placements.forEach(function (pl) {
      idx.placements[pl.id] = pl;
      var k = pl.refType + ':' + pl.refId;
      (idx.placementsByRef[k] = idx.placementsByRef[k] || []).push(pl);
    });
    p.patchCables.forEach(function (c) {
      idx.cables[c.id] = c;
      if (c.aPortId && c.bPortId) {
        if (!idx.portUse[c.aPortId]) idx.portUse[c.aPortId] = { kind: 'patch', id: c.id, other: c.bPortId };
        if (!idx.portUse[c.bPortId]) idx.portUse[c.bPortId] = { kind: 'patch', id: c.id, other: c.aPortId };
      }
    });
    p.fixedLinks.forEach(function (l) {
      idx.links[l.id] = l;
      l.wires.forEach(function (w) {
        idx.wires[w.id] = w; idx.wireLink[w.id] = l;
        if (w.aPortId && w.bPortId) {
          if (!idx.portUse[w.aPortId]) idx.portUse[w.aPortId] = { kind: 'wire', id: w.id, linkId: l.id, other: w.bPortId };
          if (!idx.portUse[w.bPortId]) idx.portUse[w.bPortId] = { kind: 'wire', id: w.id, linkId: l.id, other: w.aPortId };
        }
      });
    });
    p.internalMappings.forEach(function (m) {
      if (m.aPortId && !idx.mapByPort[m.aPortId]) idx.mapByPort[m.aPortId] = { id: m.id, other: m.bPortId };
      if (m.bPortId && !idx.mapByPort[m.bPortId]) idx.mapByPort[m.bPortId] = { id: m.id, other: m.aPortId };
    });
    return idx;
  }

  /* ---------- names ---------- */
  function portName(p, portId, idx) {
    idx = idx || buildIndex(p);
    var pt = idx.ports[portId], o = idx.portObj[portId];
    if (!pt || !o) return '(missing port)';
    return o.name + ' / ' + pt.label + (pt.side === 'rear' ? ' (rear)' : (isTermination(o) ? ' (front)' : '')) + (pt.description ? ' - ' + pt.description : '') + (portGroupOf(o, portId) ? ' [' + portGroupOf(o, portId).name + ']' : '');
  }
  function wireName(link, wire) { return link.name + ' w' + wire.number; }

  /* ---------- containment ---------- */
  function findContainer(p, id) {
    if (!id) return null;
    for (var i = 0; i < p.groups.length; i++) if (p.groups[i].id === id) return { kind: 'group', id: id, item: p.groups[i] };
    for (var j = 0; j < p.objects.length; j++) if (p.objects[j].id === id) return { kind: 'object', id: id, item: p.objects[j] };
    return null;
  }
  /* nearest group an object sits in (directly or through a rack); null when it is not in any group */
  function groupOf(p, objectId) {
    var c = findContainer(p, objectId), guard = 0;
    while (c && guard++ < 20) {
      var par = findContainer(p, c.kind === 'group' ? c.item.parentGroupId : c.item.containerId);
      if (!par) return null;
      if (par.kind === 'group') return par.item;
      c = par;
    }
    return null;
  }
  function parentOf(p, kind, id) {
    var c = findContainer(p, id);
    if (!c) return null;
    return findContainer(p, kind === 'group' ? c.item.parentGroupId : c.item.containerId);
  }
  function containerChildren(p, id) {
    var out = [];
    p.groups.forEach(function (x) { if (x.parentGroupId === id) out.push({ kind: 'group', id: x.id }); });
    p.objects.forEach(function (o) { if (o.containerId === id) out.push({ kind: 'object', id: o.id }); });
    return out;
  }
  function descendants(p, id) {
    var out = [], stack = containerChildren(p, id), seen = {};
    while (stack.length) {
      var c = stack.pop();
      if (seen[c.id]) continue;
      seen[c.id] = true; out.push(c);
      stack = stack.concat(containerChildren(p, c.id));
    }
    return out;
  }
  function checkContainerRule(p, kind, itemType, containerId, selfId) {
    if (!containerId) return;
    var c = findContainer(p, containerId);
    if (!c) throw new Error('Container does not exist');
    if (selfId && (containerId === selfId || descendants(p, selfId).some(function (d) { return d.id === containerId; }))) {
      throw new Error('A container cannot be placed inside itself');
    }
    if (c.kind === 'object') {
      if (c.item.type !== 'rack') throw new Error('Only groups and racks can contain equipment');
      if (kind === 'group' || itemType === 'rack') throw new Error('Groups and racks cannot be placed inside a rack');
    }
  }

  /* ---------- placements ---------- */
  function addPlacement(p, mapId, refType, refId, x, y, w, h) {
    var pl = { id: uid('pl'), mapId: mapId, refType: refType, refId: refId, x: x, y: y, w: w, h: h };
    p.placements.push(pl);
    return pl;
  }
  function placementOf(p, mapId, refId) {
    for (var i = 0; i < p.placements.length; i++) {
      var pl = p.placements[i];
      if (pl.mapId === mapId && pl.refId === refId) return pl;
    }
    return null;
  }
  /*
   * Ghost placements: a semi-transparent, non-editable copy of an item on another map. It shows the same record, so every change
   * made on the item's own map shows here; its size follows the real placement (position is its own). Ghosts take no part in
   * layout (overlaps, containers, racks).
   */
  function realPlacement(p, refId) {
    for (var i = 0; i < p.placements.length; i++) if (p.placements[i].refId === refId && !p.placements[i].ghost) return p.placements[i];
    return null;
  }
  /*
   * The automatic "All items" map (map.auto === 'all'): once a project has two or more ordinary maps it shows a ghost copy of every
   * item that lives on them, so rooms kept on separate maps can be seen together (with the cables between them). The ghosts can be
   * moved around (positions are the overview's own) but nothing about the items can be edited there. Each ordinary map gets a block
   * of the overview (map.allAt / map.allFrom remember where its items were laid out) so items added later land in the same block.
   */
  function realMaps(p) { return p.maps.filter(function (m) { return !m.auto; }); }
  /* two kinds of map: equipment maps (racks, panels, cables...) and floor plans (walls and to-scale links; see js/floor.js) */
  function isFloorMap(m) { return !!m && m.kind === 'floor'; }
  function equipmentMaps(p) { return p.maps.filter(function (m) { return !m.auto && !isFloorMap(m); }); }
  function floorMaps(p) { return p.maps.filter(isFloorMap); }
  function addMap(p, spec) {
    var m = { id: uid('map'), name: String(spec.name || '').trim() || 'Map ' + (realMaps(p).length + 1), location: spec.location || '', viewport: { x: 0, y: 0, zoom: 1 } };
    if (spec.kind === 'floor') { m.kind = 'floor'; m.floor = { points: [], lines: [], links: [] }; }
    p.maps.push(m);
    return m;
  }
  function allMap(p) { for (var i = 0; i < p.maps.length; i++) if (p.maps[i].auto === 'all') return p.maps[i]; return null; }
  /* put a map at position `index` among the ordinary maps (the overview map always stays out of the way, at the end of the list) */
  function moveMap(p, mapId, index) {
    var me = p.maps.filter(function (m) { return m.id === mapId && !m.auto; })[0];
    if (!me) throw new Error('Map not found');
    var eq = equipmentMaps(p), fl = floorMaps(p), group = isFloorMap(me) ? fl : eq, from = group.indexOf(me);
    index = Math.max(0, Math.min(group.length - 1, index));
    group.splice(from, 1); group.splice(index, 0, me);
    // equipment maps, then floor plans, then the overview; each group keeps its own order
    p.maps = eq.concat(fl).concat(p.maps.filter(function (x) { return x.auto; }));
  }
  function syncAllMap(p) {
    var reals = equipmentMaps(p), am = allMap(p);
    if (reals.length < 2) return false; // not shown (and not kept up to date) until there is something to combine
    var changed = false;
    if (!am) { am = { id: uid('map'), name: 'All items', location: 'Every map together (overview)', auto: 'all', viewport: { x: 0, y: 0, zoom: 1 } }; p.maps.push(am); changed = true; }
    var want = {}, srcMap = {}; // refId -> real placement of the first ordinary map that holds it
    reals.forEach(function (m) {
      p.placements.forEach(function (pl) { if (pl.mapId === m.id && !pl.ghost && !want[pl.refId]) { want[pl.refId] = pl; srcMap[pl.refId] = m; } });
    });
    var before = p.placements.length;
    p.placements = p.placements.filter(function (pl) { return pl.mapId !== am.id || (pl.ghost && want[pl.refId]); });
    if (p.placements.length !== before) changed = true;
    var have = {}; p.placements.forEach(function (pl) { if (pl.mapId === am.id) have[pl.refId] = pl; });
    reals.forEach(function (m) {
      var mine = Object.keys(want).filter(function (r) { return srcMap[r] === m && !have[r]; });
      if (!mine.length) return;
      if (!m.allAt) { // first time this map appears in the overview: a block to the right of what is there
        var right = 0, any = false;
        p.placements.forEach(function (pl) { if (pl.mapId === am.id) { any = true; right = Math.max(right, pl.x + pl.w); } });
        var minX = Infinity, minY = Infinity;
        Object.keys(want).forEach(function (r) { if (srcMap[r] === m) { minX = Math.min(minX, want[r].x); minY = Math.min(minY, want[r].y); } });
        m.allFrom = { x: minX, y: minY }; m.allAt = { x: any ? right + 120 : 40, y: 40 };
      }
      mine.forEach(function (r) {
        var src = want[r], pl = addPlacement(p, am.id, src.refType, r, src.x - m.allFrom.x + m.allAt.x, src.y - m.allFrom.y + m.allAt.y, src.w, src.h);
        pl.ghost = true; have[r] = pl; changed = true;
      });
    });
    syncGhosts(p);
    return changed;
  }
  /*
   * One editable placement per item: an item that sits on several ordinary maps keeps its real placement on the first of them (in map
   * order) and is a ghost (live copy) everywhere else. Older files could hold several real placements of the same item.
   * Returns how many placements were turned into ghosts.
   */
  function normalizeGhosts(p) {
    var order = {}, n = 0, seen = {};
    p.maps.forEach(function (m, i) { order[m.id] = i; });
    var real = p.placements.filter(function (pl) { return !pl.ghost && p.maps.some(function (m) { return m.id === pl.mapId && !m.auto; }); });
    real.sort(function (a, b) { return (order[a.mapId] - order[b.mapId]); });
    real.forEach(function (pl) {
      if (!seen[pl.refId]) { seen[pl.refId] = true; return; }
      pl.ghost = true; n++;
    });
    return n;
  }
  function syncGhosts(p) {
    p.placements.forEach(function (pl) {
      if (!pl.ghost) return;
      var r = realPlacement(p, pl.refId);
      if (r) { pl.w = r.w; pl.h = r.h; }
    });
  }
  /* the placement itself plus placements of its visual contents on the same map */
  function placementGroup(p, placementId) {
    var pl = p.placements.filter(function (x) { return x.id === placementId; })[0];
    if (!pl) return [];
    var list = [pl];
    descendants(p, pl.refId).forEach(function (d) {
      var q = placementOf(p, pl.mapId, d.id);
      if (q && !!q.ghost === !!pl.ghost) list.push(q);
    });
    return list;
  }
  function movePlacement(p, placementId, dx, dy, moveChildren) {
    var list = moveChildren === false ? p.placements.filter(function (x) { return x.id === placementId; }) : placementGroup(p, placementId);
    list.forEach(function (q) { q.x += dx; q.y += dy; });
  }
  function growToFit(p, mapId, containerId) {
    var guard = 0;
    while (containerId && guard++ < 20) {
      var cp = placementOf(p, mapId, containerId);
      if (cp && !cp.ghost) {
        var maxR = 0, maxB = 0, any = false;
        containerChildren(p, containerId).forEach(function (c) {
          var q = placementOf(p, mapId, c.id);
          if (q && !q.ghost) { any = true; maxR = Math.max(maxR, q.x + q.w); maxB = Math.max(maxB, q.y + q.h); }
        });
        if (any) {
          cp.w = Math.max(cp.w, maxR + PAD - cp.x);
          cp.h = Math.max(cp.h, maxB + PAD - cp.y);
        }
      }
      var par = parentOf(p, findContainer(p, containerId).kind, containerId);
      containerId = par ? par.id : null;
    }
  }
  /* ---------- named port groups: colour-coded sets of ports on one piece of equipment ("to rack office", "L1") ---------- */
  function findPortGroup(p, groupId) {
    for (var i = 0; i < p.objects.length; i++) {
      var gs = p.objects[i].portGroups || [];
      for (var j = 0; j < gs.length; j++) if (gs[j].id === groupId) return { obj: p.objects[i], group: gs[j] };
    }
    return null;
  }
  function prunePortGroups(o) {
    if (!o.portGroups) return;
    var ids = {};
    o.ports.forEach(function (pt) { ids[pt.id] = true; });
    o.portGroups.forEach(function (g) { g.portIds = g.portIds.filter(function (x) { return ids[x]; }); });
    o.portGroups = o.portGroups.filter(function (g) { return g.portIds.length; });
    if (!o.portGroups.length) delete o.portGroups;
  }
  /* "7-14, 17" -> port ids on `side` (any side when omitted) whose numeric label is in range or whose label matches */
  function parsePortRange(o, text, side) {
    var ports = o.ports.filter(function (pt) { return !side || pt.side === side; }), out = [], errors = [];
    String(text || '').split(/[,;\s]+/).filter(Boolean).forEach(function (tok) {
      var m = /^(\d+)-(\d+)$/.exec(tok), hit = [];
      if (m) {
        var a = Math.min(+m[1], +m[2]), b = Math.max(+m[1], +m[2]);
        hit = ports.filter(function (pt) { return /^\d+$/.test(pt.label) && +pt.label >= a && +pt.label <= b; });
      } else hit = ports.filter(function (pt) { return String(pt.label).toLowerCase() === tok.toLowerCase(); });
      if (!hit.length) errors.push('No port "' + tok + '"' + (side ? ' on the ' + side + ' side' : ''));
      hit.forEach(function (pt) { if (out.indexOf(pt.id) < 0) out.push(pt.id); });
    });
    var order = {}; o.ports.forEach(function (pt, i) { order[pt.id] = i; });
    out.sort(function (x, y) { return order[x] - order[y]; });
    return { ids: out, errors: errors };
  }
  /* spec: {name, color, portIds | (portsText + side)}; ports already in another group of the object move to this one */
  /*
   * Pseudo-devices: a port group can stand for equipment that is plugged into those ports without being modelled one by one
   * ("Cameras", 16 ports). group.deviceKind (a DEVICE_KINDS id) marks it; the ports count as occupied and the topology graph
   * shows one endpoint "Cameras x16" hanging off the equipment.
   */
  function checkPseudo(p, o, ids, kind) {
    if (!kind) return;
    if (isTermination(o) || o.type === 'rack' || o.type === 'internet') throw new Error('Only switches, routers and generic devices can have devices plugged into their ports');
    var idx = buildIndex(p);
    ids.forEach(function (id) { if (idx.portUse[id]) throw new Error('Port ' + portName(p, id, idx) + ' already has a cable; remove it before marking the port as occupied by a device'); });
  }
  function validKind(k) { return !k || DEVICE_KINDS.some(function (d) { return d[0] === k; }); }
  /* the pseudo-device group a port belongs to, or null */
  function pseudoOf(o, portId) { var g = portGroupOf(o, portId); return g && g.deviceKind ? g : null; }
  /* [{ obj, group, count }] for every pseudo-device group in the project */
  function pseudoDevices(p) {
    var out = [];
    p.objects.forEach(function (o) { (o.portGroups || []).forEach(function (g) { if (g.deviceKind) out.push({ obj: o, group: g, count: g.portIds.length }); }); });
    return out;
  }
  function addPortGroup(p, objectId, spec) {
    var o = buildIndex(p).objects[objectId];
    if (!o) throw new Error('Object not found');
    var ids = spec.portIds;
    if (!ids) { var r = parsePortRange(o, spec.portsText, spec.side); if (r.errors.length) throw new Error(r.errors.join('; ')); ids = r.ids; }
    var own = {}; o.ports.forEach(function (pt) { own[pt.id] = true; });
    ids = ids.filter(function (x, i) { return own[x] && ids.indexOf(x) === i; });
    if (!ids.length) throw new Error('Choose at least one port for the group');
    var name = String(spec.name || '').trim();
    if (!name) throw new Error('Give the group a name');
    if (!validKind(spec.deviceKind)) throw new Error('Unknown device type');
    checkPseudo(p, o, ids, spec.deviceKind);
    o.portGroups = o.portGroups || [];
    o.portGroups.forEach(function (g) { g.portIds = g.portIds.filter(function (x) { return ids.indexOf(x) < 0; }); });
    var grp = { id: uid('pgp'), name: name, color: spec.color || '#1f77b4', portIds: ids };
    if (spec.deviceKind) grp.deviceKind = spec.deviceKind;
    o.portGroups.push(grp);
    prunePortGroups(o);
    return grp;
  }
  function updatePortGroup(p, groupId, patch) {
    var f = findPortGroup(p, groupId);
    if (!f) throw new Error('Port group not found');
    var g = f.group, o = f.obj;
    if (patch.name !== undefined) { if (!String(patch.name).trim()) throw new Error('Give the group a name'); g.name = String(patch.name).trim(); }
    if (patch.color !== undefined) g.color = patch.color;
    if (patch.deviceKind !== undefined) {
      if (!validKind(patch.deviceKind)) throw new Error('Unknown device type');
      checkPseudo(p, o, g.portIds, patch.deviceKind);
      if (patch.deviceKind) g.deviceKind = patch.deviceKind; else delete g.deviceKind;
    }
    if (patch.portsText !== undefined) {
      var r = parsePortRange(o, patch.portsText, patch.side);
      if (r.errors.length) throw new Error(r.errors.join('; '));
      if (!r.ids.length) throw new Error('A group needs at least one port (delete it to remove it)');
      checkPseudo(p, o, r.ids, g.deviceKind);
      o.portGroups.forEach(function (x) { if (x !== g) x.portIds = x.portIds.filter(function (i) { return r.ids.indexOf(i) < 0; }); });
      g.portIds = r.ids;
      prunePortGroups(o);
    }
    return g;
  }
  /*
   * Linked groups: the two ends of a fixed link made from a group ("to rack office" on panel A / "from rack 1" on panel B) are
   * port groups that point at each other (peerId). Each end keeps its own name and colour; hovering one names the other, and
   * clicking it can jump to the other end, even on another map.
   */
  function peerGroup(p, groupId) {
    var f = findPortGroup(p, groupId);
    if (!f || !f.group.peerId) return null;
    var q = findPortGroup(p, f.group.peerId);
    return q && q.group.peerId === groupId ? q : null;
  }
  function linkPortGroups(p, aGroupId, bGroupId) {
    var a = findPortGroup(p, aGroupId), b = findPortGroup(p, bGroupId);
    if (!a || !b || aGroupId === bGroupId) throw new Error('Port group not found');
    unlinkPortGroup(p, aGroupId); unlinkPortGroup(p, bGroupId);
    a.group.peerId = bGroupId; b.group.peerId = aGroupId;
  }
  function unlinkPortGroup(p, groupId) {
    var f = findPortGroup(p, groupId);
    if (!f) return;
    var q = f.group.peerId && findPortGroup(p, f.group.peerId);
    delete f.group.peerId;
    if (q && q.group.peerId === groupId) delete q.group.peerId;
  }
  /* a fixed link's label can be dragged on each map separately: link.labelAt = { mapId: [dx, dy] } offsets from its default spot */
  function setLinkLabelOffset(p, linkId, mapId, dx, dy) {
    var l = p.fixedLinks.filter(function (x) { return x.id === linkId; })[0];
    if (!l) throw new Error('Fixed link not found');
    dx = Math.round(dx); dy = Math.round(dy);
    if (!dx && !dy) { if (l.labelAt) { delete l.labelAt[mapId]; if (!Object.keys(l.labelAt).length) delete l.labelAt; } return; }
    l.labelAt = l.labelAt || {}; l.labelAt[mapId] = [dx, dy];
  }
  function deletePortGroup(p, groupId) {
    var f = findPortGroup(p, groupId);
    if (!f) return;
    unlinkPortGroup(p, groupId);
    f.obj.portGroups = f.obj.portGroups.filter(function (g) { return g.id !== groupId; });
    if (!f.obj.portGroups.length) delete f.obj.portGroups;
  }
  function portGroupOf(o, portId) {
    var gs = o.portGroups || [];
    for (var i = 0; i < gs.length; i++) if (gs[i].portIds.indexOf(portId) >= 0) return gs[i];
    return null;
  }

  function mapsFor(p, kind, id) {
    var idx = buildIndex(p), out = [];
    function add(ref) {
      (p.placements || []).forEach(function (pl) { if (pl.refId === ref && out.indexOf(pl.mapId) < 0) out.push(pl.mapId); });
    }
    if (kind === 'map') return [id];
    if (kind === 'group' || kind === 'object') add(id);
    else if (kind === 'pgroup') { var fg = findPortGroup(p, id); if (fg) add(fg.obj.id); }
    else if (kind === 'port') { var o = idx.portObj[id]; if (o) add(o.id); }
    else if (kind === 'cable') { var c = idx.cables[id]; if (c) [c.aPortId, c.bPortId].forEach(function (pid) { if (idx.portObj[pid]) add(idx.portObj[pid].id); }); }
    else if (kind === 'link') { var l = idx.links[id]; if (l) { add(l.aObjectId); add(l.bObjectId); } }
    else if (kind === 'wire') { var lk = idx.wireLink[id]; if (lk) { add(lk.aObjectId); add(lk.bObjectId); } }
    var autoMaps = {}; p.maps.forEach(function (m) { if (m.auto) autoMaps[m.id] = true; });
    out = out.filter(function (m) { return !autoMaps[m]; }); // the overview is not where an item "lives"
    return out;
  }

  /* ---------- groups & objects ---------- */
  function addGroup(p, o) {
    o = o || {};
    checkContainerRule(p, 'group', null, o.parentGroupId);
    if (o.parentGroupId && !p.groups.some(function (x) { return x.id === o.parentGroupId; })) throw new Error('Parent must be a group');
    var grp = { id: uid('grp'), name: o.name || ('Group ' + (p.groups.length + 1)), description: o.description || '', location: o.location || '', parentGroupId: o.parentGroupId || null };
    p.groups.push(grp);
    return grp;
  }

  /* patch panel sections: equal parts only, so the section size must divide the per-side port count */
  function validSectionSizes(n) {
    var out = [];
    for (var d = 1; d <= n; d++) if (n % d === 0 && (d >= 2 || n === 1)) out.push(d);
    return out;
  }
  /* default: largest divisor between 4 and 8 (24 -> 8, 12 -> 6, 16 -> 8, 15 -> 5); otherwise one section */
  function defaultSectionSize(n) {
    if (n <= 8) return Math.max(n, 1);
    for (var d = 8; d >= 4; d--) if (n % d === 0) return d;
    return n;
  }
  function effectiveSectionSize(obj, n) {
    var s = obj && obj.sectionSize;
    return s && n % s === 0 ? s : defaultSectionSize(n);
  }
  /* switch ports that are not uplinks */
  function accessPorts(o) { return o.ports.filter(function (x) { return x.role !== 'uplink'; }); }
  function setSectionSize(p, objectId, size) {
    var o = buildIndex(p).objects[objectId];
    if (!o || (o.type !== 'patchpanel' && o.type !== 'switch')) throw new Error('Sections apply to patch panels and switches');
    var n = o.ports.filter(function (x) { return x.side === 'front' && x.role !== 'uplink'; }).length;
    if (o.type === 'switch' && !size) { delete o.sectionSize; delete o.sectionRows; return; } // switches default to plain rows
    if (!(size >= 1) || size !== Math.floor(size) || n % size !== 0) {
      throw new Error('Sections must be equal: ' + n + ' ports cannot be split into sections of ' + size + ' (valid: ' + validSectionSizes(n).join(', ') + ')');
    }
    o.sectionSize = size;
    if (o.sectionRows && size % o.sectionRows !== 0) delete o.sectionRows;
  }

  /* ---- switch layout and uplinks ---- */
  function validSectionRows(size) {
    var out = [];
    for (var d = 1; d <= Math.min(size, 8); d++) if (size % d === 0) out.push(d);
    return out;
  }
  function setUplinkPorts(p, objectId, n) {
    var idx = buildIndex(p), o = idx.objects[objectId];
    if (!o || o.type !== 'switch') throw new Error('Uplink ports apply to switches');
    if (!(n >= 0 && n <= 16) || n !== Math.floor(n)) throw new Error('Uplink ports: 0-16');
    var list = o.ports.filter(function (x) { return x.role === 'uplink'; });
    if (n > list.length) {
      for (var i = list.length + 1; i <= n; i++) o.ports.push({ id: uid('prt'), label: 'U' + i, side: 'front', role: 'uplink', portType: '', speed: '', media: '' });
    } else if (n < list.length) {
      var drop = list.slice(n);
      drop.forEach(function (pt) { if (idx.portUse[pt.id]) throw new Error('Uplink ' + pt.label + ' is in use; disconnect it first'); });
      o.ports = o.ports.filter(function (pt) { return drop.indexOf(pt) < 0; });
      prunePortGroups(o);
    }
  }
  /* patch: sectionRows, portOrder ('rows'|'columns'), align ('left'|'center'|'right'), uplinkSide ('left'|'right'), portIsolation */
  function setSwitchLayout(p, objectId, patch) {
    var o = buildIndex(p).objects[objectId];
    if (!o || o.type !== 'switch') throw new Error('Not a switch');
    if (patch.sectionRows !== undefined) {
      var r = patch.sectionRows;
      if (!o.sectionSize) throw new Error('Choose ports per section first');
      if (!(r >= 1) || r !== Math.floor(r) || o.sectionSize % r !== 0) throw new Error('Rows must divide the section evenly (valid: ' + validSectionRows(o.sectionSize).join(', ') + ')');
      if (r === 1) delete o.sectionRows; else o.sectionRows = r;
    }
    if (patch.portOrder !== undefined) {
      if (patch.portOrder !== 'rows' && patch.portOrder !== 'columns') throw new Error('Port order is rows or columns');
      o.portOrder = patch.portOrder;
    }
    if (patch.align !== undefined) {
      if (['left', 'center', 'right'].indexOf(patch.align) < 0) throw new Error('Align is left, center or right');
      if (patch.align === 'left') delete o.align; else o.align = patch.align;
    }
    if (patch.uplinkSide !== undefined) {
      if (patch.uplinkSide !== 'left' && patch.uplinkSide !== 'right') throw new Error('Uplinks sit on the left or right');
      if (patch.uplinkSide === 'right') delete o.uplinkSide; else o.uplinkSide = 'left';
    }
    if (patch.uplinkRows !== undefined) {
      if (!(patch.uplinkRows >= 1 && patch.uplinkRows <= 8) || patch.uplinkRows !== Math.floor(patch.uplinkRows)) throw new Error('Uplink rows: 1-8');
      if (patch.uplinkRows === 1) delete o.uplinkRows; else o.uplinkRows = patch.uplinkRows;
    }
    if (patch.portIsolation !== undefined) { if (patch.portIsolation) o.portIsolation = true; else delete o.portIsolation; }
  }
  /* equipment in a rack/group can be stretched to the container's full inner width */
  function setDeviceKind(p, objectId, kind) {
    var o = buildIndex(p).objects[objectId];
    if (!o || o.type !== 'generic') throw new Error('Device icons apply to generic equipment');
    if (deviceKindInfo(kind)[0] !== kind) throw new Error('Unknown device kind');
    if (kind === 'other') delete o.deviceKind; else o.deviceKind = kind;
  }
  function setFullWidth(p, objectId, on) {
    var o = buildIndex(p).objects[objectId];
    if (!o || o.type === 'rack') throw new Error('Full width applies to equipment');
    if (on) o.fullWidth = true; else delete o.fullWidth;
  }

  /* routers: WAN ports first, then LAN ports; each port has a role and an optional IP address */
  function routerPorts(wan, lan) {
    var ports = [], i;
    for (i = 1; i <= wan; i++) ports.push({ id: uid('prt'), label: 'W' + i, side: 'front', role: 'wan', ip: '' });
    for (i = 1; i <= lan; i++) ports.push({ id: uid('prt'), label: 'L' + i, side: 'front', role: 'lan', ip: '' });
    return ports;
  }
  function makePorts(type, count, labels) {
    var ports = [], i;
    if (type === 'patchpanel' || type === 'socket') {
      for (i = 1; i <= count; i++) ports.push({ id: uid('prt'), label: String(i), side: 'front' });
      for (i = 1; i <= count; i++) ports.push({ id: uid('prt'), label: String(i), side: 'rear' });
    } else if (type === 'rack') {
      return [];
    } else {
      for (i = 1; i <= count; i++) {
        var pt = { id: uid('prt'), label: String(i), side: 'front' };
        if (type === 'switch') { pt.portType = ''; pt.speed = ''; pt.media = ''; }
        ports.push(pt);
      }
    }
    return ports;
  }
  function defaultPortCount(type) { return { patchpanel: 24, 'switch': 24, socket: 2, generic: 0, rack: 0, internet: 1 }[type] || 0; }

  function addObject(p, o) {
    if (OBJECT_TYPES.indexOf(o.type) < 0) throw new Error('Unknown object type');
    checkContainerRule(p, 'object', o.type, o.containerId);
    var n = o.portCount == null ? defaultPortCount(o.type) : o.portCount;
    var wan = o.wanPorts == null ? 1 : o.wanPorts, lan = o.lanPorts == null ? 4 : o.lanPorts;
    if (o.type === 'router') {
      if (!(wan >= 0 && lan >= 0 && wan + lan <= 96) || wan !== Math.floor(wan) || lan !== Math.floor(lan)) throw new Error('Router needs 0-96 ports in total');
      n = 0;
    }
    if (n < 0 || n > 96 || n !== Math.floor(n)) throw new Error('Port count must be 0-96');
    var same = p.objects.filter(function (x) { return x.type === o.type; }).length;
    var kind = o.type === 'generic' && o.deviceKind && deviceKindInfo(o.deviceKind)[0] === o.deviceKind && o.deviceKind !== 'other' ? o.deviceKind : null;
    if (o.type === 'generic') same = p.objects.filter(function (x) { return x.type === 'generic' && (x.deviceKind || null) === kind; }).length;
    var defName = o.type === 'internet' ? (same ? 'INTERNET ' + (same + 1) : 'INTERNET') : (kind ? deviceKindInfo(kind)[2] : TYPE_LABELS[o.type]) + ' ' + (same + 1);
    var obj = {
      id: uid('obj'), type: o.type, name: o.name || defName,
      location: o.location || '', description: o.description || '',
      containerId: o.containerId || null, ports: o.type === 'router' ? routerPorts(wan, lan) : makePorts(o.type, n)
    };
    if (o.type === 'router' || o.type === 'internet' || (hasDeviceIp(o) && o.ipAddress)) {
      if (!isValidIp(o.ipAddress)) throw new Error(IP_ERROR);
      obj.ipAddress = String(o.ipAddress || '').trim();
    }
    if (kind) obj.deviceKind = kind;
    if (o.type === 'rack') obj.rackHeight = o.rackHeight || 42;
    p.objects.push(obj);
    if (o.type === 'switch') {
      if (o.uplinkPorts) setUplinkPorts(p, obj.id, o.uplinkPorts);
      if (o.portIsolation) obj.portIsolation = true;
    }
    if ((o.type === 'patchpanel' || o.type === 'switch') && o.sectionSize) {
      var sz = o.sectionSize;
      if (!(sz >= 1) || sz !== Math.floor(sz) || n % sz !== 0) { p.objects.pop(); throw new Error('Sections must be equal: ' + n + ' ports cannot be split into sections of ' + sz + ' (valid: ' + validSectionSizes(n).join(', ') + ')'); }
      obj.sectionSize = sz;
      if (o.sectionRows > 1) { try { setSwitchLayout(p, obj.id, { sectionRows: o.sectionRows }); } catch (e) { p.objects.pop(); throw e; } }
    }
    var straight = o.straight === undefined ? o.type === 'socket' : o.straight; // wall sockets are straight-through unless told otherwise
    if (isTermination(obj) && straight) autoMapPanel(p, obj.id);
    return obj;
  }

  function setContainer(p, kind, id, containerId) {
    var c = findContainer(p, id);
    if (!c) throw new Error('Item not found');
    checkContainerRule(p, kind, kind === 'object' ? c.item.type : null, containerId, id);
    if (kind === 'group') {
      if (containerId && !p.groups.some(function (x) { return x.id === containerId; })) throw new Error('A group can only be inside another group');
      c.item.parentGroupId = containerId || null;
    } else c.item.containerId = containerId || null;
  }

  function setPortCount(p, objectId, n) {
    var idx = buildIndex(p), o = idx.objects[objectId];
    if (!o) throw new Error('Object not found');
    if (o.type === 'rack') throw new Error('Racks have no ports');
    if (o.type === 'router') throw new Error('Use setRouterPorts for routers');
    if (n < 0 || n > 96 || n !== Math.floor(n)) throw new Error('Port count must be 0-96');
    function used(pt) { return idx.portUse[pt.id]; }
    function adjust(side) {
      var list = o.ports.filter(function (pt) { return pt.side === side && pt.role !== 'uplink'; });
      if (n > list.length) {
        for (var i = list.length + 1; i <= n; i++) {
          var pt = { id: uid('prt'), label: String(i), side: side };
          if (o.type === 'switch') { pt.portType = ''; pt.speed = ''; pt.media = ''; }
          o.ports.push(pt);
        }
      } else if (n < list.length) {
        var drop = list.slice(n);
        drop.forEach(function (pt) { if (used(pt)) throw new Error('Port ' + pt.label + ' is in use; disconnect it first'); });
        var gone = {}; drop.forEach(function (pt) { gone[pt.id] = true; });
        p.internalMappings = p.internalMappings.filter(function (m) { return !gone[m.aPortId] && !gone[m.bPortId]; });
        o.ports = o.ports.filter(function (pt) { return drop.indexOf(pt) < 0; });
      }
    }
    if (isTermination(o)) {
      adjust('front'); adjust('rear');
      if (o.sectionSize && n % o.sectionSize !== 0) delete o.sectionSize;
    } else {
      adjust('front');
      if (o.sectionSize && n % o.sectionSize !== 0) { delete o.sectionSize; delete o.sectionRows; }
    }
    prunePortGroups(o);
    o.ports.sort(function (a, b) { return (a.side === b.side ? (a.role === 'uplink' ? 1 : 0) - (b.role === 'uplink' ? 1 : 0) : (a.side === 'front' ? -1 : 1)); });
  }

  /* routers: set WAN and LAN counts independently; ports in use cannot be removed */
  function setRouterPorts(p, objectId, wan, lan) {
    var idx = buildIndex(p), o = idx.objects[objectId];
    if (!o || o.type !== 'router') throw new Error('Not a router');
    if (!(wan >= 0 && lan >= 0 && wan + lan <= 96) || wan !== Math.floor(wan) || lan !== Math.floor(lan)) throw new Error('Router needs 0-96 ports in total');
    function adjust(role, n, prefix) {
      var list = o.ports.filter(function (pt) { return pt.role === role; });
      if (n > list.length) {
        for (var i = list.length + 1; i <= n; i++) o.ports.push({ id: uid('prt'), label: prefix + i, side: 'front', role: role, ip: '' });
      } else if (n < list.length) {
        var drop = list.slice(n);
        drop.forEach(function (pt) { if (idx.portUse[pt.id]) throw new Error('Port ' + pt.label + ' is in use; disconnect it first'); });
        o.ports = o.ports.filter(function (pt) { return drop.indexOf(pt) < 0; });
      }
    }
    adjust('wan', wan, 'W'); adjust('lan', lan, 'L');
    prunePortGroups(o);
    o.ports.sort(function (a, b) { return (a.role === b.role ? 0 : (a.role === 'wan' ? -1 : 1)); });
  }

  /* ---------- patch cables ---------- */
  function canConnectPatch(p, aPortId, bPortId, ignoreCableId, idx) {
    idx = idx || buildIndex(p);
    var a = idx.ports[aPortId], b = idx.ports[bPortId];
    if (!a || !b) return 'Port does not exist';
    if (aPortId === bPortId) return 'Cannot connect a port to itself';
    if (a.side === 'rear' || b.side === 'rear') return 'Rear panel terminations take fixed links, not patch cables';
    var ids = [aPortId, bPortId];
    for (var k = 0; k < 2; k++) {
      var po = idx.portObj[ids[k]], pg = po && pseudoOf(po, ids[k]);
      if (pg) return 'Port ' + portName(p, ids[k], idx) + ' is marked as occupied by "' + pg.name + '"; remove it from that group first';
    }
    for (var i = 0; i < 2; i++) {
      var u = idx.portUse[ids[i]];
      if (u && !(u.kind === 'patch' && u.id === ignoreCableId)) return 'Port ' + portName(p, ids[i], idx) + ' is already occupied';
    }
    return null;
  }
  function addPatchCable(p, o) {
    var err = canConnectPatch(p, o.aPortId, o.bPortId, null);
    if (err) throw new Error(err);
    p.counters.patch++;
    var c = {
      id: uid('pc'), name: o.name || ('PC-' + pad3(p.counters.patch)), aPortId: o.aPortId, bPortId: o.bPortId,
      cableType: o.cableType || 'Cat6', color: o.color || '#1f77b4', length: o.length || '', status: o.status || 'active'
    };
    p.patchCables.push(c);
    return c;
  }
  function updatePatchCable(p, id, patch) {
    var c = p.patchCables.filter(function (x) { return x.id === id; })[0];
    if (!c) throw new Error('Cable not found');
    var a = patch.aPortId || c.aPortId, b = patch.bPortId || c.bPortId;
    if (a !== c.aPortId || b !== c.bPortId) {
      var err = canConnectPatch(p, a, b, id);
      if (err) throw new Error(err);
    }
    ['name', 'cableType', 'color', 'length', 'status'].forEach(function (k) { if (patch[k] !== undefined) c[k] = patch[k]; });
    c.aPortId = a; c.bPortId = b;
    return c;
  }
  function deletePatchCable(p, id) {
    p.patchCables = p.patchCables.filter(function (c) { return c.id !== id; });
  }

  /* ---------- internal mappings ---------- */
  function addInternalMapping(p, objectId, aPortId, bPortId) {
    var idx = buildIndex(p), o = idx.objects[objectId];
    if (!isTermination(o)) throw new Error('Internal mappings belong to patch panels and wall sockets');
    var a = idx.ports[aPortId], b = idx.ports[bPortId];
    if (!a || !b || idx.portObj[aPortId] !== o || idx.portObj[bPortId] !== o) throw new Error('Ports must belong to the panel');
    if (a.side === b.side) throw new Error('A mapping joins a front port to a rear port');
    if (idx.mapByPort[aPortId] || idx.mapByPort[bPortId]) throw new Error('A port is already mapped');
    var m = { id: uid('map_i'), objectId: objectId, aPortId: aPortId, bPortId: bPortId };
    p.internalMappings.push(m);
    return m;
  }
  function removeInternalMapping(p, id) {
    p.internalMappings = p.internalMappings.filter(function (m) { return m.id !== id; });
  }
  /* explicit straight-through action: front N <-> rear N for unmapped pairs */
  function autoMapPanel(p, objectId) {
    var o = p.objects.filter(function (x) { return x.id === objectId; })[0];
    if (!isTermination(o)) throw new Error('Not a patch panel or wall socket');
    var idx = buildIndex(p), n = 0;
    var front = o.ports.filter(function (x) { return x.side === 'front'; });
    var rear = o.ports.filter(function (x) { return x.side === 'rear'; });
    front.forEach(function (f, i) {
      var r = rear[i];
      if (r && !idx.mapByPort[f.id] && !idx.mapByPort[r.id]) {
        p.internalMappings.push({ id: uid('map_i'), objectId: o.id, aPortId: f.id, bPortId: r.id });
        n++;
      }
    });
    return n;
  }

  /* ---------- fixed links ---------- */
  function rearPorts(o) { return o.ports.filter(function (pt) { return pt.side === 'rear'; }); }

  /* pick n free rear ports on each panel in order; this is the explicit "sequential" action */
  function sequentialPorts(p, aObj, bObj, n, usedPorts) {
    var idx = buildIndex(p);
    usedPorts = usedPorts || {};
    function free(o) {
      return rearPorts(o).filter(function (pt) { return !idx.portUse[pt.id] && !usedPorts[pt.id]; });
    }
    var fa = free(aObj), fb = free(bObj);
    if (fa.length < n || fb.length < n) throw new Error('Not enough free rear ports for ' + n + ' wires');
    var out = [];
    for (var i = 0; i < n; i++) out.push([fa[i].id, fb[i].id]);
    return out;
  }

  function addFixedLink(p, o) {
    var idx = buildIndex(p), a = idx.objects[o.aObjectId], b = idx.objects[o.bObjectId];
    if (!isTermination(a) || !isTermination(b)) throw new Error('Fixed links join patch panels and wall sockets');
    if (a === b) throw new Error('A fixed link needs two different panels');
    var pairs = null, n;
    if (o.pairs) {
      pairs = o.pairs; n = pairs.length;
      var usedPorts = {};
      pairs.forEach(function (pr) {
        [[pr[0], a], [pr[1], b]].forEach(function (x) {
          var pt = idx.ports[x[0]];
          if (!pt || idx.portObj[x[0]] !== x[1] || pt.side !== 'rear') throw new Error('Wires must join rear ports of the two panels');
          if (idx.portUse[x[0]] || usedPorts[x[0]]) throw new Error('Port ' + portName(p, x[0], idx) + ' is already occupied');
          usedPorts[x[0]] = true;
        });
      });
    } else {
      n = o.wireCount;
      pairs = o.mapping === 'sequential' ? sequentialPorts(p, a, b, n) : null;
    }
    if (!(n >= 1 && n <= 288) || n !== Math.floor(n)) throw new Error('Wire count must be 1-288');
    p.counters.fixed++;
    var link = {
      id: uid('fl'), name: o.name || ('FL-' + pad3(p.counters.fixed)), aObjectId: a.id, bObjectId: b.id,
      cableType: o.cableType || 'Cat6', length: o.length || '', route: o.route || '', status: o.status || 'installed', wires: []
    };
    for (var i = 0; i < n; i++) {
      link.wires.push({ id: uid('wir'), number: i + 1, aPortId: pairs ? pairs[i][0] : null, bPortId: pairs ? pairs[i][1] : null, status: pairs ? 'connected' : 'unused' });
    }
    p.fixedLinks.push(link);
    return link;
  }
  function updateLinkMeta(p, id, patch) {
    var l = p.fixedLinks.filter(function (x) { return x.id === id; })[0];
    if (!l) throw new Error('Link not found');
    ['name', 'cableType', 'length', 'route', 'status'].forEach(function (k) { if (patch[k] !== undefined) l[k] = patch[k]; });
  }
  function updateWireStatus(p, wireId, status) {
    var idx = buildIndex(p);
    if (!idx.wires[wireId]) throw new Error('Wire not found');
    if (WIRE_STATUS.indexOf(status) < 0) throw new Error('Unknown status');
    idx.wires[wireId].status = status;
  }

  /* draft = { aObjectId, bObjectId, wires:[{id?,number,aPortId,bPortId,status}] } */
  function validateLinkDraft(p, linkId, draft) {
    var idx = buildIndex(p), errs = [];
    var a = idx.objects[draft.aObjectId], b = idx.objects[draft.bObjectId];
    if (!isTermination(a) || !isTermination(b)) errs.push('Both endpoints must be patch panels or wall sockets');
    if (a && b && a === b) errs.push('Endpoints must be different panels');
    if (!draft.wires.length) errs.push('A link needs at least one wire');
    var nums = {}, used = {};
    var own = {};
    var cur = linkId ? idx.links[linkId] : null;
    if (cur) cur.wires.forEach(function (w) { own[w.id] = true; });
    draft.wires.forEach(function (w) {
      if (nums[w.number]) errs.push('Duplicate wire number ' + w.number);
      nums[w.number] = true;
      [['aPortId', a], ['bPortId', b]].forEach(function (pair) {
        var pid = w[pair[0]], obj = pair[1];
        if (!pid) return;
        var pt = idx.ports[pid];
        if (!pt) { errs.push('Wire ' + w.number + ': port does not exist'); return; }
        if (obj && idx.portObj[pid] !== obj) errs.push('Wire ' + w.number + ': port ' + portName(p, pid, idx) + ' is not on the selected panel');
        if (pt.side !== 'rear') errs.push('Wire ' + w.number + ': ' + portName(p, pid, idx) + ' is not a rear termination');
        if (used[pid]) errs.push('Wire ' + w.number + ': port ' + portName(p, pid, idx) + ' is used by another wire in this link');
        used[pid] = true;
        var u = idx.portUse[pid];
        if (u && !(u.kind === 'wire' && own[u.id])) errs.push('Wire ' + w.number + ': port ' + portName(p, pid, idx) + ' is already occupied');
      });
    });
    return errs;
  }

  function diffLinkDraft(p, linkId, draft) {
    var idx = buildIndex(p), old = idx.links[linkId], out = [];
    if (old.aObjectId !== draft.aObjectId || old.bObjectId !== draft.bObjectId) {
      out.push('ENDPOINTS: ' + idx.objects[old.aObjectId].name + ' <-> ' + idx.objects[old.bObjectId].name +
        '  =>  ' + idx.objects[draft.aObjectId].name + ' <-> ' + idx.objects[draft.bObjectId].name);
    }
    var byId = {};
    draft.wires.forEach(function (w) { if (w.id) byId[w.id] = w; });
    function desc(w) {
      return (w.aPortId ? portName(p, w.aPortId, idx) : '(unmapped)') + ' <-> ' + (w.bPortId ? portName(p, w.bPortId, idx) : '(unmapped)');
    }
    old.wires.forEach(function (w) {
      var n = byId[w.id];
      if (!n) out.push('DELETE wire ' + w.number + ': ' + desc(w));
      else if (n.aPortId !== w.aPortId || n.bPortId !== w.bPortId) out.push('CHANGE wire ' + w.number + ': ' + desc(w) + '  =>  ' + desc(n));
      else if (n.number !== w.number) out.push('RENUMBER wire ' + w.number + ' => ' + n.number);
    });
    draft.wires.forEach(function (w) { if (!w.id) out.push('ADD wire ' + w.number + ': ' + desc(w)); });
    return out;
  }

  function applyLinkEdit(p, linkId, draft) {
    var errs = validateLinkDraft(p, linkId, draft);
    if (errs.length) throw new Error(errs.join('; '));
    var l = p.fixedLinks.filter(function (x) { return x.id === linkId; })[0];
    l.aObjectId = draft.aObjectId; l.bObjectId = draft.bObjectId;
    l.wires = draft.wires.map(function (w) {
      return { id: w.id || uid('wir'), number: w.number, aPortId: w.aPortId || null, bPortId: w.bPortId || null, status: w.status || 'unused' };
    }).sort(function (x, y) { return x.number - y.number; });
    return l;
  }
  function deleteFixedLink(p, id) {
    p.fixedLinks = p.fixedLinks.filter(function (l) { return l.id !== id; });
  }

  /* ---------- deletion ---------- */
  function dropFloorLinks(p, refId) { p.maps.forEach(function (m) { if (m.floor) m.floor.links = (m.floor.links || []).filter(function (l) { return l.refId !== refId; }); }); }
  function removeObjectCore(p, id) {
    dropFloorLinks(p, id);
    var o = p.objects.filter(function (x) { return x.id === id; })[0];
    if (!o) return;
    var pids = {};
    o.ports.forEach(function (pt) { pids[pt.id] = true; });
    p.patchCables = p.patchCables.filter(function (c) { return !pids[c.aPortId] && !pids[c.bPortId]; });
    p.fixedLinks = p.fixedLinks.filter(function (l) { return l.aObjectId !== id && l.bObjectId !== id; });
    p.internalMappings = p.internalMappings.filter(function (m) { return m.objectId !== id; });
    p.placements = p.placements.filter(function (pl) { return pl.refId !== id; });
    p.objects = p.objects.filter(function (x) { return x.id !== id; });
  }
  function removeGroupCore(p, id) {
    dropFloorLinks(p, id);
    p.placements = p.placements.filter(function (pl) { return pl.refId !== id; });
    p.groups = p.groups.filter(function (x) { return x.id !== id; });
  }
  function deleteImpact(p, kind, id, mode) {
    var copy = clone(p), before = { cables: copy.patchCables.length, links: copy.fixedLinks.length, objects: copy.objects.length, groups: copy.groups.length };
    deleteContainerOrObject(copy, kind, id, mode || 'delete');
    return {
      cables: before.cables - copy.patchCables.length, links: before.links - copy.fixedLinks.length,
      objects: before.objects - copy.objects.length, groups: before.groups - copy.groups.length
    };
  }
  /* mode 'keep': children move to the parent container; 'delete': children are deleted too */
  function deleteContainerOrObject(p, kind, id, mode) {
    var c = findContainer(p, id);
    if (!c) return;
    var kids = containerChildren(p, id);
    if (mode === 'delete') {
      kids.forEach(function (k) { deleteContainerOrObject(p, k.kind, k.id, 'delete'); });
    } else {
      var par = parentOf(p, kind, id);
      kids.forEach(function (k) {
        var kc = findContainer(p, k.id);
        if (k.kind === 'group') kc.item.parentGroupId = par && par.kind === 'group' ? par.id : null;
        else kc.item.containerId = par ? par.id : null;
      });
    }
    if (kind === 'group') removeGroupCore(p, id); else removeObjectCore(p, id);
  }

  /* plain IPv4 only: four numbers 0-255 (no /prefix, no IPv6 for now); empty is fine */
  /* device-level address: routers (LAN), switches (management / web interface), generic devices, Internet; per-port addresses: routers, generic devices, Internet */
  function hasDeviceIp(o) { return !!o && (o.type === 'router' || o.type === 'internet' || o.type === 'switch' || o.type === 'generic'); }
  function hasPortIp(o) { return !!o && (o.type === 'router' || o.type === 'internet' || o.type === 'generic'); }
  var IP_ERROR = 'Not a valid IPv4 address: use four numbers 0-255 such as 192.168.1.1 (no /prefix)';
  function isValidIp(s) {
    s = String(s == null ? '' : s).trim();
    if (!s) return true;
    var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
    return !!m && [m[1], m[2], m[3], m[4]].every(function (x) { return +x <= 255 && String(+x) === x.replace(/^0+(?=\d)/, ''); });
  }
  /* address a port answers to: its own, else the device address (routers: LAN ports only; generic devices: every port without its own) */
  function effectivePortIp(o, pt) {
    var ip = pt.ip || '';
    if (!ip && o.type === 'router' && pt.role === 'lan') ip = o.ipAddress || '';
    if (!ip && o.type === 'generic') ip = o.ipAddress || '';
    return String(ip).trim();
  }
  /* every address shown for a piece of equipment: [{ label, ip, inherited }] */
  function ipList(o) {
    var out = [];
    if (o.type === 'switch' || o.type === 'internet') { if (o.ipAddress) out.push({ label: o.type === 'switch' ? 'management' : 'public', ip: o.ipAddress }); }
    o.ports.forEach(function (pt) {
      var ip = effectivePortIp(o, pt);
      if (ip) out.push({ label: 'port ' + pt.label, ip: ip, inherited: !pt.ip });
    });
    if (!out.length && o.ipAddress) out.push({ label: 'device', ip: o.ipAddress });
    return out;
  }
  function setDeviceIp(p, objectId, ip) {
    var o = buildIndex(p).objects[objectId];
    if (!o || !hasDeviceIp(o)) throw new Error('This equipment has no IP address (routers, switches, generic devices and the Internet object do)');
    if (!isValidIp(ip)) throw new Error(IP_ERROR);
    o.ipAddress = String(ip || '').trim();
  }
  function setPortIp(p, portId, ip) {
    var idx = buildIndex(p), o = idx.portObj[portId];
    if (!o || !hasPortIp(o)) throw new Error('Ports of this equipment have no IP address (routers, generic devices and the Internet object do)');
    if (!isValidIp(ip)) throw new Error(IP_ERROR);
    idx.ports[portId].ip = String(ip || '').trim();
  }

  /* ---------- search ---------- */
  function search(p, query, limit) {
    var q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    var idx = buildIndex(p), out = [];
    limit = limit || 80;
    function has() {
      for (var i = 0; i < arguments.length; i++) if (arguments[i] && String(arguments[i]).toLowerCase().indexOf(q) >= 0) return true;
      return false;
    }
    p.maps.forEach(function (m) { if (has(m.name, m.location, m.id)) out.push({ kind: 'map', id: m.id, title: m.name, sub: 'Map' + (m.location ? ' - ' + m.location : '') }); });
    p.groups.forEach(function (x) { if (has(x.name, x.location, x.description, x.id)) out.push({ kind: 'group', id: x.id, title: x.name, sub: 'Group' + (x.location ? ' - ' + x.location : '') }); });
    p.objects.forEach(function (o) {
      if (has(o.name, o.location, o.description, o.id, typeLabel(o), o.ipAddress)) out.push({ kind: 'object', id: o.id, title: o.name, sub: typeLabel(o) + (o.location ? ' - ' + o.location : '') });
    });
    p.objects.forEach(function (o) {
      (o.portGroups || []).forEach(function (g) { if (has(g.name, g.id)) out.push({ kind: 'pgroup', id: g.id, title: g.name, sub: 'Port group on ' + o.name + ' (' + g.portIds.length + ' ports)' }); });
      o.ports.forEach(function (pt) {
        if (has(pt.label, pt.id, pt.ip, pt.role, pt.description)) out.push({ kind: 'port', id: pt.id, title: o.name + ' / ' + pt.label + (pt.side === 'rear' ? ' (rear)' : ''), sub: 'Port' + (pt.description ? ' - ' + pt.description : '') + (pt.ip ? ' - ' + pt.ip : '') });
      });
    });
    p.patchCables.forEach(function (c) { if (has(c.name, c.id)) out.push({ kind: 'cable', id: c.id, title: c.name, sub: 'Patch cable: ' + portName(p, c.aPortId, idx) + ' <-> ' + portName(p, c.bPortId, idx) }); });
    p.fixedLinks.forEach(function (l) {
      if (has(l.name, l.id, l.route)) out.push({ kind: 'link', id: l.id, title: l.name, sub: 'Fixed link, ' + l.wires.length + ' wires' });
      l.wires.forEach(function (w) {
        if (has(w.id, l.name + ' w' + w.number, l.name + ' wire ' + w.number)) out.push({ kind: 'wire', id: w.id, title: wireName(l, w), sub: 'Fixed wire' });
      });
    });
    return out.slice(0, limit);
  }

  /* ---------- validation ---------- */
  function validateProject(p) {
    var issues = [];
    function add(sev, code, msg, kind, id) { issues.push({ severity: sev, code: code, message: msg, target: kind ? { kind: kind, id: id } : null }); }
    var idCount = {};
    function seen(id, what) { if (!id) { add('error', 'NO_ID', 'A ' + what + ' has no ID'); return; } (idCount[id] = idCount[id] || []).push(what); }
    p.maps.forEach(function (x) { seen(x.id, 'map'); });
    p.groups.forEach(function (x) { seen(x.id, 'group'); });
    p.placements.forEach(function (x) { seen(x.id, 'placement'); });
    p.objects.forEach(function (o) { seen(o.id, 'object'); o.ports.forEach(function (pt) { seen(pt.id, 'port'); }); });
    p.patchCables.forEach(function (x) { seen(x.id, 'patch cable'); });
    p.fixedLinks.forEach(function (l) { seen(l.id, 'fixed link'); l.wires.forEach(function (w) { seen(w.id, 'wire'); }); });
    p.internalMappings.forEach(function (x) { seen(x.id, 'internal mapping'); });
    Object.keys(idCount).forEach(function (id) { if (idCount[id].length > 1) add('error', 'DUP_ID', 'Duplicate ID ' + id + ' (' + idCount[id].join(', ') + ')'); });

    var idx = buildIndex(p);
    p.groups.forEach(function (x) {
      if (x.parentGroupId && !idx.groups[x.parentGroupId]) add('error', 'BAD_PARENT', 'Group "' + x.name + '" has a missing parent group', 'group', x.id);
      else if (descendants(p, x.id).some(function (d) { return d.id === x.id; })) add('error', 'CYCLE', 'Group "' + x.name + '" is inside itself', 'group', x.id);
    });
    p.objects.forEach(function (o) {
      if (OBJECT_TYPES.indexOf(o.type) < 0) add('error', 'BAD_TYPE', 'Object "' + o.name + '" has unknown type ' + o.type, 'object', o.id);
      if (o.containerId) {
        var c = findContainer(p, o.containerId);
        if (!c) add('error', 'BAD_CONTAINER', 'Object "' + o.name + '" refers to a missing container', 'object', o.id);
        else if (c.kind === 'object' && c.item.type !== 'rack') add('error', 'BAD_CONTAINER', 'Object "' + o.name + '" is inside a non-container object', 'object', o.id);
      }
      if (!isValidIp(o.ipAddress)) add('warning', 'BAD_IP', '"' + o.name + '" has an invalid IP address: ' + o.ipAddress, 'object', o.id);
      o.ports.forEach(function (pt) { if (!isValidIp(pt.ip)) add('warning', 'BAD_IP', o.name + ' / ' + pt.label + ' has an invalid IP address: ' + pt.ip, 'port', pt.id); });
      if (o.portIsolation && !o.ports.some(function (pt) { return pt.role === 'uplink'; })) add('warning', 'ISOLATION_NO_UPLINK', 'Switch "' + o.name + '" has port isolation on but no uplink ports, so its devices can talk to nothing through it', 'object', o.id);
      (o.portGroups || []).forEach(function (g) {
        var own = {}; o.ports.forEach(function (pt) { own[pt.id] = true; });
        if (g.portIds.some(function (x) { return !own[x]; })) add('warning', 'BAD_PORT_GROUP', 'Port group "' + g.name + '" on "' + o.name + '" refers to a missing port', 'object', o.id);
        if (g.peerId && !findPortGroup(p, g.peerId)) add('warning', 'BAD_PEER', 'Port group "' + g.name + '" on "' + o.name + '" is linked to a group that no longer exists', 'object', o.id);
        if (g.deviceKind && g.portIds.some(function (x) { return idx.portUse[x]; })) add('warning', 'PSEUDO_CABLED', 'Port group "' + g.name + '" on "' + o.name + '" stands for plugged-in devices but some of its ports also have cables', 'object', o.id);
      });
      var unused = o.ports.filter(function (pt) { return !idx.portUse[pt.id] && !idx.mapByPort[pt.id]; }).length;
      if (o.ports.length && unused) add('info', 'UNUSED_PORTS', unused + ' of ' + o.ports.length + ' terminations on "' + o.name + '" are unused', 'object', o.id);
    });
    p.maps.forEach(function (mp) { // floor plans: every line joins two existing points; every link points at an existing item, once
      if (!mp.floor) return;
      var pts = {}, seenLink = {};
      mp.floor.points.forEach(function (q) { pts[q.id] = true; });
      mp.floor.lines.forEach(function (l) { if (!pts[l.a] || !pts[l.b] || l.a === l.b) add('error', 'BAD_FLOOR_LINE', 'Floor plan "' + mp.name + '" has a line with a missing or identical end point'); });
      mp.floor.links.forEach(function (lk) {
        if (!findContainer(p, lk.refId)) add('warning', 'BAD_FLOOR_LINK', 'Floor plan "' + mp.name + '" links an item that no longer exists');
        else if (seenLink[lk.refId]) add('warning', 'DUP_FLOOR_LINK', 'Floor plan "' + mp.name + '" links "' + findContainer(p, lk.refId).item.name + '" more than once', lk.kind, lk.refId);
        seenLink[lk.refId] = true;
      });
    });
    p.placements.forEach(function (pl) {
      if (!idx.maps[pl.mapId]) add('error', 'BAD_PLACEMENT', 'A placement refers to a missing map');
      var ok = pl.refType === 'group' ? idx.groups[pl.refId] : idx.objects[pl.refId];
      if (!ok) add('error', 'BAD_PLACEMENT', 'A placement refers to a missing ' + pl.refType);
    });

    var use = {};
    function count(pid, what) { (use[pid] = use[pid] || []).push(what); }
    p.patchCables.forEach(function (c) {
      var okA = idx.ports[c.aPortId], okB = idx.ports[c.bPortId];
      if (!okA || !okB) { add('error', 'MISSING_PORT', 'Patch cable ' + c.name + ' refers to a missing port', 'cable', c.id); return; }
      if (c.aPortId === c.bPortId) add('error', 'SELF_LOOP', 'Patch cable ' + c.name + ' joins a port to itself', 'cable', c.id);
      if (okA.side === 'rear' || okB.side === 'rear') add('error', 'INCOMPATIBLE', 'Patch cable ' + c.name + ' is connected to a rear termination', 'cable', c.id);
      count(c.aPortId, c.name); count(c.bPortId, c.name);
    });
    p.fixedLinks.forEach(function (l) {
      var a = idx.objects[l.aObjectId], b = idx.objects[l.bObjectId];
      if (!a || !b) { add('error', 'MISSING_ENDPOINT', 'Fixed link ' + l.name + ' has a missing endpoint', 'link', l.id); return; }
      if (!isTermination(a) || !isTermination(b)) add('error', 'INCOMPATIBLE', 'Fixed link ' + l.name + ' must join patch panels or wall sockets', 'link', l.id);
      var nums = {};
      l.wires.forEach(function (w) {
        if (nums[w.number]) add('error', 'DUP_WIRE', l.name + ': duplicate wire number ' + w.number, 'wire', w.id);
        nums[w.number] = true;
        var okA = !w.aPortId || (idx.ports[w.aPortId] && idx.portObj[w.aPortId] === a);
        var okB = !w.bPortId || (idx.ports[w.bPortId] && idx.portObj[w.bPortId] === b);
        if (!okA || !okB) add('error', 'BAD_WIRE', wireName(l, w) + ' has a termination that is missing or on the wrong panel', 'wire', w.id);
        [w.aPortId, w.bPortId].forEach(function (pid) {
          if (pid && idx.ports[pid]) {
            if (idx.ports[pid].side !== 'rear') add('error', 'INCOMPATIBLE', wireName(l, w) + ' ends on a non-rear termination', 'wire', w.id);
            count(pid, wireName(l, w));
          }
        });
        if ((w.aPortId && !w.bPortId) || (!w.aPortId && w.bPortId)) add('warning', 'HALF_WIRE', wireName(l, w) + ' is mapped at one end only', 'wire', w.id);
      });
    });
    Object.keys(use).forEach(function (pid) {
      if (use[pid].length > 1) add('error', 'OCCUPIED', 'Port ' + portName(p, pid, idx) + ' is used by ' + use[pid].join(', '), 'port', pid);
    });
    var mapped = {};
    p.internalMappings.forEach(function (m) {
      var o = idx.objects[m.objectId];
      if (!o || !idx.ports[m.aPortId] || !idx.ports[m.bPortId] || idx.portObj[m.aPortId] !== o || idx.portObj[m.bPortId] !== o) {
        add('error', 'BAD_MAPPING', 'An internal mapping refers to a nonexistent port', o ? 'object' : null, o && o.id);
        return;
      }
      if (idx.ports[m.aPortId].side === idx.ports[m.bPortId].side) add('error', 'BAD_MAPPING', 'Internal mapping on "' + o.name + '" does not join front to rear', 'object', o.id);
      [m.aPortId, m.bPortId].forEach(function (pid) {
        if (mapped[pid]) add('error', 'BAD_MAPPING', 'Port ' + portName(p, pid, idx) + ' appears in two internal mappings', 'port', pid);
        mapped[pid] = true;
      });
    });
    return issues;
  }

  /* ---------- migration ---------- */
  var MIGRATIONS = {
    0: function (d) { // files written before schemaVersion existed
      d.settings = d.settings || { gridSize: 20, snapToGrid: true };
      d.counters = d.counters || { patch: d.patchCables ? d.patchCables.length : 0, fixed: d.fixedLinks ? d.fixedLinks.length : 0 };
      ['maps', 'groups', 'objects', 'placements', 'fixedLinks', 'patchCables', 'internalMappings'].forEach(function (k) { d[k] = d[k] || []; });
      d.schemaVersion = 1;
      return d;
    }
  };
  /* v2: wall sockets get rear terminations (for installed cabling) with straight-through internal mappings */
  MIGRATIONS[1] = function (d) {
    d.objects.forEach(function (o) {
      if (o.type !== 'socket') return;
      o.ports = o.ports || [];
      var front = o.ports.filter(function (x) { return x.side !== 'rear'; });
      if (o.ports.some(function (x) { return x.side === 'rear'; })) return;
      front.forEach(function (f) {
        var r = { id: uid('prt'), label: f.label, side: 'rear' };
        o.ports.push(r);
        d.internalMappings.push({ id: uid('map_i'), objectId: o.id, aPortId: f.id, bPortId: r.id });
      });
    });
    d.schemaVersion = 2;
    return d;
  };
  /* v3: IP addresses are plain IPv4 now; drop any /prefix that earlier versions allowed */
  MIGRATIONS[2] = function (d) {
    function strip(ip) { return /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(String(ip || '')) ? String(ip).split('/')[0] : ip; }
    d.objects.forEach(function (o) {
      if (o.ipAddress) o.ipAddress = strip(o.ipAddress);
      (o.ports || []).forEach(function (pt) { if (pt.ip) pt.ip = strip(pt.ip); });
    });
    d.schemaVersion = 3;
    return d;
  };
  /* v5: floor plan maps (map.kind 'floor' with map.floor); nothing to convert - older files simply have none */
  MIGRATIONS[4] = function (d) { d.schemaVersion = 5; return d; };
  /* v4: the file form is compact (see compactProject); nothing to convert - older files simply have everything spelled out */
  MIGRATIONS[3] = function (d) { d.schemaVersion = 4; return d; };

  /*
   * Compact file form (what is written to files and to the browser autosave; the app itself always works on the expanded form):
   *  - a panel or wall socket whose internal mappings are exactly "front N <-> rear N" for every label present on both sides is written
   *    with `straight: true` instead of listing them (other mappings stay explicit; panels with duplicate labels stay explicit)
   *  - optional fields that are empty ("" or null) are left out
   * expandProject() is the exact inverse and is applied on every load, so both forms (and old files) open the same way.
   */
  var DROP_EMPTY = {
    maps: ['location'], groups: ['description', 'location', 'parentGroupId'], objects: ['location', 'description', 'containerId', 'ipAddress'],
    patchCables: ['length'], fixedLinks: ['length', 'route']
  };
  var PORT_EMPTY = ['portType', 'speed', 'media', 'ip', 'description', 'networkColor'];
  function straightPairs(o) {
    var front = {}, rear = {}, dup = false;
    o.ports.forEach(function (pt) {
      var side = pt.side === 'rear' ? rear : front;
      if (side[pt.label] !== undefined) dup = true;
      side[pt.label] = pt.id;
    });
    if (dup) return null;
    var out = [];
    Object.keys(front).forEach(function (l) { if (rear[l] !== undefined) out.push([front[l], rear[l]]); });
    return out;
  }
  function straightId(frontPortId) { return 'map_i_' + String(frontPortId).replace(/^prt_/, ''); }
  function compactProject(p) {
    var d = clone(p);
    Object.keys(DROP_EMPTY).forEach(function (k) {
      (d[k] || []).forEach(function (x) { DROP_EMPTY[k].forEach(function (f) { if (x[f] === '' || x[f] === null) delete x[f]; }); });
    });
    d.fixedLinks.forEach(function (l) { l.wires.forEach(function (w) { if (w.aPortId === null) delete w.aPortId; if (w.bPortId === null) delete w.bPortId; }); });
    d.objects.forEach(function (o) {
      o.ports.forEach(function (pt) { PORT_EMPTY.forEach(function (f) { if (pt[f] === '' || pt[f] === null) delete pt[f]; }); });
      if (!isTermination(o)) return;
      var pairs = straightPairs(o);
      if (!pairs || !pairs.length) return;
      var mine = d.internalMappings.filter(function (m) { return m.objectId === o.id; }), key = {};
      pairs.forEach(function (pr) { key[pr[0] + '|' + pr[1]] = true; key[pr[1] + '|' + pr[0]] = true; });
      var isStraight = function (m) { return key[m.aPortId + '|' + m.bPortId]; };
      var covered = {};
      mine.forEach(function (m) { if (isStraight(m)) covered[[m.aPortId, m.bPortId].sort().join('|')] = true; });
      if (Object.keys(covered).length !== pairs.length) return; // only a part of the straight pairs is mapped: keep them all explicit
      o.straight = true;
      d.internalMappings = d.internalMappings.filter(function (m) { return !(m.objectId === o.id && isStraight(m)); });
    });
    return d;
  }
  function expandProject(d) {
    (d.maps || []).forEach(function (m) {
      if (m.location === undefined) m.location = '';
      if (m.kind === 'floor') { m.floor = m.floor || {}; m.floor.points = m.floor.points || []; m.floor.lines = m.floor.lines || []; m.floor.links = m.floor.links || []; }
    });
    (d.groups || []).forEach(function (g) { if (g.description === undefined) g.description = ''; if (g.location === undefined) g.location = ''; if (g.parentGroupId === undefined) g.parentGroupId = null; });
    (d.objects || []).forEach(function (o) {
      if (o.location === undefined) o.location = ''; if (o.description === undefined) o.description = ''; if (o.containerId === undefined) o.containerId = null;
    });
    (d.patchCables || []).forEach(function (c) { if (c.length === undefined) c.length = ''; });
    (d.fixedLinks || []).forEach(function (l) {
      if (l.length === undefined) l.length = ''; if (l.route === undefined) l.route = '';
      (l.wires || []).forEach(function (w) { if (w.aPortId === undefined) w.aPortId = null; if (w.bPortId === undefined) w.bPortId = null; });
    });
    d.internalMappings = d.internalMappings || [];
    (d.objects || []).forEach(function (o) {
      if (!o.straight) return;
      var have = {};
      d.internalMappings.forEach(function (m) { if (m.objectId === o.id) { have[m.aPortId] = true; have[m.bPortId] = true; } });
      (straightPairs(o) || []).forEach(function (pr) {
        if (have[pr[0]] || have[pr[1]]) return;
        d.internalMappings.push({ id: straightId(pr[0]), objectId: o.id, aPortId: pr[0], bPortId: pr[1] });
      });
      delete o.straight;
    });
    return d;
  }
  function migrate(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Not a NetMap project file');
    var d = clone(data), v = d.schemaVersion || 0, from = v;
    if (v > SCHEMA_VERSION) throw new Error('File uses schema version ' + v + ', newer than this app (' + SCHEMA_VERSION + ')');
    while (v < SCHEMA_VERSION) { d = MIGRATIONS[v](d); v = d.schemaVersion; }
    expandProject(d);
    normalizeGhosts(d);
    if (!d.id) d.id = uid('prj');
    if (!d.maps.length) d.maps.push({ id: uid('map'), name: 'Main map', location: '', viewport: { x: 0, y: 0, zoom: 1 } });
    d.maps.forEach(function (m) { m.viewport = m.viewport || { x: 0, y: 0, zoom: 1 }; });
    d.objects.forEach(function (o) { o.ports = o.ports || []; });
    d.fixedLinks.forEach(function (l) { l.wires = l.wires || []; });
    return { project: d, migratedFrom: from };
  }
  function importProject(text) {
    var data;
    try { data = JSON.parse(text); } catch (e) { throw new Error('File is not valid JSON'); }
    var m = migrate(data);
    return { project: m.project, migratedFrom: m.migratedFrom, issues: validateProject(m.project) };
  }
  function exportProject(p) {
    p.updatedAt = now();
    return JSON.stringify(compactProject(p), null, 2) + '\n'; // readable (indented) but compact: no empty fields, straight panels as a flag
  }
  /* what the browser autosave stores: the same compact form, without indentation */
  function serializeProject(p) { return JSON.stringify(compactProject(p)); }

  NM.model = {
    SCHEMA_VERSION: SCHEMA_VERSION, CABLE_COLORS: CABLE_COLORS, OBJECT_TYPES: OBJECT_TYPES, TYPE_LABELS: TYPE_LABELS,
    CABLE_STATUS: CABLE_STATUS, WIRE_STATUS: WIRE_STATUS, LINK_STATUS: LINK_STATUS, PAD: PAD, HEADER: HEADER,
    uid: uid, clone: clone, createProject: createProject, buildIndex: buildIndex, portName: portName, wireName: wireName,
    findContainer: findContainer, groupOf: groupOf, parentOf: parentOf, containerChildren: containerChildren, descendants: descendants,
    addPlacement: addPlacement, placementOf: placementOf, placementGroup: placementGroup, movePlacement: movePlacement,
    growToFit: growToFit, mapsFor: mapsFor, addGroup: addGroup, addObject: addObject, setContainer: setContainer,
    setPortCount: setPortCount, findPortGroup: findPortGroup, parsePortRange: parsePortRange, addPortGroup: addPortGroup, updatePortGroup: updatePortGroup, deletePortGroup: deletePortGroup, portGroupOf: portGroupOf, prunePortGroups: prunePortGroups, hasDeviceIp: hasDeviceIp, isFloorMap: isFloorMap, equipmentMaps: equipmentMaps, floorMaps: floorMaps, addMap: addMap, moveMap: moveMap, normalizeGhosts: normalizeGhosts, setLinkLabelOffset: setLinkLabelOffset, realMaps: realMaps, allMap: allMap, syncAllMap: syncAllMap, peerGroup: peerGroup, linkPortGroups: linkPortGroups, unlinkPortGroup: unlinkPortGroup, realPlacement: realPlacement, syncGhosts: syncGhosts, pseudoOf: pseudoOf, pseudoDevices: pseudoDevices, hasPortIp: hasPortIp, setDeviceIp: setDeviceIp, effectivePortIp: effectivePortIp, ipList: ipList, setPortIp: setPortIp, IP_ERROR: IP_ERROR, setDeviceKind: setDeviceKind, isTermination: isTermination, DEVICE_KINDS: DEVICE_KINDS, deviceKindInfo: deviceKindInfo, typeLabel: typeLabel, accessPorts: accessPorts, validSectionRows: validSectionRows, setUplinkPorts: setUplinkPorts, setSwitchLayout: setSwitchLayout, setFullWidth: setFullWidth, setSectionSize: setSectionSize, validSectionSizes: validSectionSizes, defaultSectionSize: defaultSectionSize, effectiveSectionSize: effectiveSectionSize, setRouterPorts: setRouterPorts, isValidIp: isValidIp, canConnectPatch: canConnectPatch, addPatchCable: addPatchCable,
    updatePatchCable: updatePatchCable, deletePatchCable: deletePatchCable, addInternalMapping: addInternalMapping,
    removeInternalMapping: removeInternalMapping, autoMapPanel: autoMapPanel, rearPorts: rearPorts,
    sequentialPorts: sequentialPorts, addFixedLink: addFixedLink, updateLinkMeta: updateLinkMeta,
    updateWireStatus: updateWireStatus, validateLinkDraft: validateLinkDraft, diffLinkDraft: diffLinkDraft,
    applyLinkEdit: applyLinkEdit, deleteFixedLink: deleteFixedLink, deleteImpact: deleteImpact,
    deleteContainerOrObject: deleteContainerOrObject, search: search, validateProject: validateProject,
    migrate: migrate, importProject: importProject, exportProject: exportProject, serializeProject: serializeProject, compactProject: compactProject, expandProject: expandProject
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = NM.model;
})(typeof window !== 'undefined' ? window : globalThis);
