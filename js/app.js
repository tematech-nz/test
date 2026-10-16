/* NetMap application: state, canvas interaction, panels and dialogs. */
(function () {
  'use strict';
  const NM = window.NetMap, M = NM.model, L = NM.layout, T = NM.trace, R = NM.render, X = NM.exporters, B = NM.builder;
  const $ = (id) => document.getElementById(id);
  const esc = R.esc;
  const KEY = 'netmap.autosave.v1', KEY_EXPORT = 'netmap.lastExport', KEY_COLL = 'netmap.collapsed.v1', KEY_DIRTY = 'netmap.fileDirty';
  const POLL_MS = 60000;

  const S = {
    p: null, mapId: null, mode: 'view', sel: null, trace: null, tool: null,
    undo: [], redo: [], unsaved: false, saveErr: null, savedAt: null, lastExport: null,
    drag: null, geo: null, query: '', showIssues: false, issues: [],
    collapsed: {}, pgroup: null, hoverPort: null, preview: null, drop: null, cableColor: 'auto', customColorFor: null, ring: null,
    fileDirty: false, newVersion: null, updateHidden: false, place: null, rev: 0, netRev: -1, netCache: [], view: 'map', graph: { from: '', to: '', via: false }
  };
  NM.app = { S: S, M: M }; // exposed for tests

  /* ---------------------------------------------------------------- utils */
  let toastT = null;
  function toast(msg, bad) {
    const t = $('toast'); t.textContent = msg; t.className = 'show' + (bad ? ' bad' : '');
    clearTimeout(toastT); toastT = setTimeout(() => { t.className = ''; }, bad ? 5000 : 2500);
  }
  const curMap = () => S.p.maps.find((m) => m.id === S.mapId) || S.p.maps[0];
  const isEdit = () => S.mode === 'edit';
  const opts = (list, sel) => list.map((o) => '<option value="' + esc(o[0]) + '"' + (String(o[0]) === String(sel) ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('');
  const time = (d) => d.toTimeString().slice(0, 5);
  const slug = (s) => String(s || 'project').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';

  /* ---------------------------------------------------------------- persistence */
  function setStatus() {
    const el = $('saveStatus');
    let cls = '', txt;
    if (S.saveErr) { cls = 'err'; txt = 'SAVE ERROR - export a JSON backup now'; }
    else if (S.unsaved) { cls = 'dirty'; txt = 'Unsaved changes...'; }
    else {
      txt = 'Autosaved ' + (S.savedAt ? time(S.savedAt) : '') + ' (browser only)';
      txt += S.lastExport ? ' - file backup ' + S.lastExport : ' - no file backup yet';
      if (S.fileDirty && S.lastExport) txt += ' (changed since)';
    }
    el.className = cls; el.textContent = txt;
  }
  let saveT = null;
  /* "dirty" = changed since the last export/import: the browser autosave is not a backup, so closing asks first */
  function markDirty(on) {
    S.fileDirty = on;
    try { localStorage.setItem(KEY_DIRTY, on ? '1' : '0'); } catch (_) { /* ignore */ }
  }
  function scheduleSave(quiet) { if (!quiet) { S.unsaved = true; markDirty(true); setStatus(); } clearTimeout(saveT); saveT = setTimeout(saveNow, 600); }
  function saveNow() {
    clearTimeout(saveT);
    try { localStorage.setItem(KEY, JSON.stringify(S.p)); S.unsaved = false; S.saveErr = null; S.savedAt = new Date(); }
    catch (e) { S.saveErr = e.message || 'storage error'; }
    setStatus();
  }
  function loadSaved() {
    try {
      const txt = localStorage.getItem(KEY);
      if (!txt) return null;
      return M.migrate(JSON.parse(txt)).project;
    } catch (e) { return null; }
  }

  /* collapsed patch-panel sections are view state: kept in this browser, never in the project file */
  function loadCollapsed() { try { S.collapsed = JSON.parse(localStorage.getItem(KEY_COLL) || '{}') || {}; } catch (e) { S.collapsed = {}; } }
  function toggleCollapse(plId, side) {
    const c = S.collapsed[plId] = S.collapsed[plId] || {};
    c[side] = !c[side];
    if (!c.front && !c.rear) delete S.collapsed[plId];
    try { localStorage.setItem(KEY_COLL, JSON.stringify(S.collapsed)); } catch (e) { /* ignore */ }
    renderCanvas();
  }

  /* ---------------------------------------------------------------- store */
  function commit(label, fn) {
    const snap = JSON.stringify(S.p);
    let r;
    try { r = fn(S.p); }
    catch (e) { S.p = JSON.parse(snap); toast(e.message, true); renderAll(); return false; }
    S.undo.push({ label: label, snap: snap }); if (S.undo.length > 100) S.undo.shift();
    S.redo = [];
    S.rev++;
    scheduleSave(); afterChange();
    return r === undefined ? true : r;
  }
  function restore(from, to) {
    const e = from.pop();
    if (!e) return;
    to.push({ label: e.label, snap: JSON.stringify(S.p) });
    S.p = JSON.parse(e.snap); S.rev++;
    toast((from === S.undo ? 'Undid: ' : 'Redid: ') + e.label);
    scheduleSave(); afterChange();
  }
  const undo = () => restore(S.undo, S.redo);
  const redo = () => restore(S.redo, S.undo);

  function selExists() {
    if (!S.sel) return true;
    const idx = M.buildIndex(S.p), k = S.sel.kind, id = S.sel.id;
    if (k === 'pgroup') return !!M.findPortGroup(S.p, id);
    const t = { group: idx.groups, object: idx.objects, port: idx.ports, cable: idx.cables, link: idx.links, wire: idx.wires }[k];
    return !!(t && t[id]);
  }
  function afterChange() {
    if (!S.p.maps.some((m) => m.id === S.mapId)) S.mapId = S.p.maps[0].id;
    if (!selExists()) S.sel = null;
    if (S.pgroup && !M.buildIndex(S.p).objects[S.pgroup.objId]) clearPgroup();
    if (S.trace) {
      const t = S.trace.target;
      const idx = M.buildIndex(S.p);
      const ok = { port: idx.ports, cable: idx.cables, link: idx.links, wire: idx.wires }[t.kind];
      S.trace = ok && ok[t.id] ? T.traceTarget(S.p, t) : null;
    }
    S.issues = S.showIssues ? allIssues() : S.issues;
    renderAll();
  }

  /* ---------------------------------------------------------------- viewport */
  function vpState() { const m = curMap(); return m.viewport; }
  function applyVp() {
    const v = vpState();
    const tf = 'translate(' + v.x + ' ' + v.y + ') scale(' + v.zoom + ')';
    $('vp').setAttribute('transform', tf);
    $('ghost').setAttribute('transform', tf);
  }
  function stageSize() { const r = $('canvas').getBoundingClientRect(); return { w: r.width, h: r.height, left: r.left, top: r.top }; }
  function toMap(cx, cy) { const s = stageSize(), v = vpState(); return { x: (cx - s.left - v.x) / v.zoom, y: (cy - s.top - v.y) / v.zoom }; }
  function zoomAt(factor, cx, cy) {
    const v = vpState(), s = stageSize();
    const px = cx == null ? s.w / 2 : cx - s.left, py = cy == null ? s.h / 2 : cy - s.top;
    const nz = Math.min(4, Math.max(0.1, v.zoom * factor)), f = nz / v.zoom;
    v.x = px - (px - v.x) * f; v.y = py - (py - v.y) * f; v.zoom = nz;
    applyVp(); scheduleSave(true);
  }
  function fitMap() {
    const r = R.renderMap(S.p, curMap().id, { mode: 'view' }), b = r.bounds, s = stageSize(), v = vpState();
    const z = Math.min(s.w / b.w, s.h / b.h, 1.5);
    v.zoom = z; v.x = -b.x * z + (s.w - b.w * z) / 2; v.y = -b.y * z + (s.h - b.h * z) / 2;
    applyVp(); scheduleSave(true);
  }
  function focusRect(rc) {
    const v = vpState(), s = stageSize();
    let z = Math.max(0.5, Math.min(v.zoom, 2));
    if (rc.w * z > s.w * 0.9 || rc.h * z > s.h * 0.8) z = Math.min(s.w * 0.9 / rc.w, s.h * 0.8 / rc.h);
    v.zoom = z; v.x = s.w / 2 - (rc.x + rc.w / 2) * z; v.y = s.h / 2 - (rc.y + rc.h / 2) * z;
    applyVp(); scheduleSave(true);
  }
  function rectOfTarget(kind, id) {
    const idx = M.buildIndex(S.p), mid = curMap().id;
    const pls = (ref) => M.placementOf(S.p, mid, ref);
    let rects = [];
    const add = (r) => { if (r) rects.push(r); };
    if (kind === 'group' || kind === 'object') add(pls(id));
    else if (kind === 'port') add(S.geo && S.geo.portGeo[id]);
    else if (kind === 'pgroup') { const f = M.findPortGroup(S.p, id); if (f) f.group.portIds.forEach((pid) => add(S.geo && S.geo.portGeo[pid])); }
    else if (kind === 'cable') { const c = idx.cables[id]; if (c) [c.aPortId, c.bPortId].forEach((pid) => add(S.geo && S.geo.portGeo[pid])); }
    else if (kind === 'link') { const l = idx.links[id]; if (l) { add(pls(l.aObjectId)); add(pls(l.bObjectId)); } }
    else if (kind === 'wire') { const l = idx.wireLink[id]; if (l) { add(pls(l.aObjectId)); add(pls(l.bObjectId)); } }
    if (!rects.length) return null;
    const x0 = Math.min.apply(null, rects.map((r) => r.x)), y0 = Math.min.apply(null, rects.map((r) => r.y));
    const x1 = Math.max.apply(null, rects.map((r) => r.x + r.w)), y1 = Math.max.apply(null, rects.map((r) => r.y + r.h));
    return { x: x0 - 20, y: y0 - 20, w: x1 - x0 + 40, h: y1 - y0 + 40 };
  }

  /* navigate: switch to a map where the target lives, select it, centre on it */
  function goTo(kind, id, mapId, keepTab) {
    let maps = M.mapsFor(S.p, kind, id);
    if (kind === 'map') { switchMap(id); return; }
    if (mapId && maps.indexOf(mapId) >= 0) maps = [mapId];
    else if (maps.indexOf(S.mapId) >= 0) maps = [S.mapId];
    if (!maps.length) toast('This item is not placed on any map yet', true);
    else if (maps[0] !== S.mapId) switchMap(maps[0], true);
    select({ kind: kind, id: id });
    if (keepTab) showTab('trace');
    renderCanvas();
    const rc = maps.length ? rectOfTarget(kind, id) : null;
    if (rc) focusRect(rc);
    closeLeft();
  }
  function switchMap(id, keepSel) {
    S.mapId = id; clearPgroup(); if (!keepSel) { S.sel = null; }
    if (S.place) { S.place = null; $('ghostInner').innerHTML = ''; $('ghost').style.display = 'none'; }
    renderAll();
    const v = vpState();
    if (v.zoom === 1 && v.x === 0 && v.y === 0 && S.p.placements.some((p) => p.mapId === id)) fitMap();
    closeLeft();
  }

  /* ---------------------------------------------------------------- selection and tools */
  function select(sel) {
    S.sel = sel; renderAll();
    if (sel) { showTab('details'); openRight(); }
  }
  function setTool(t) { S.tool = t; renderAll(); }
  function cancelTool() { if (S.tool) { S.tool = null; renderAll(); } }

  /* ports of the cable end being reconnected are circled (hover over "Reconnect end A/B" or while the tool is active) */
  function netAlertMap() {
    const m = {};
    netIssues().forEach((i) => (i.objectIds || []).forEach((id) => { m[id] = (m[id] ? m[id] + '\n' : '') + i.message; }));
    return m;
  }
  function ringPorts() {
    if (S.tool && S.tool.type === 'reconnect') { const c = S.p.patchCables.find((x) => x.id === S.tool.cableId); return c ? [S.tool.end === 'a' ? c.aPortId : c.bPortId] : []; }
    return S.ring ? [S.ring] : [];
  }
  /* returns a confirmation text when the two ports are in different groups (both must be in a group) */
  function crossGroupWarning(aPortId, bPortId) {
    const idx = M.buildIndex(S.p), oa = idx.portObj[aPortId], ob = idx.portObj[bPortId];
    if (!oa || !ob) return null;
    const ga = M.groupOf(S.p, oa.id), gb = M.groupOf(S.p, ob.id);
    if (!ga || !gb || ga.id === gb.id) return null;
    return '<p><b>' + esc(oa.name) + '</b> is in group <b>' + esc(ga.name) + '</b> and <b>' + esc(ob.name) + '</b> is in group <b>' + esc(gb.name) + '</b>. A patch cable normally stays inside one group.</p>';
  }
  /* network problems (see topology.networkIssues) memoised per project revision */
  function netIssues() {
    if (S.netRev !== S.rev) { S.netCache = NM.topology.networkIssues(S.p); S.netRev = S.rev; }
    return S.netCache;
  }
  const allIssues = () => M.validateProject(S.p).concat(netIssues());
  /* issues a prospective change would introduce (computed on a copy of the project) */
  function newNetworkIssues(mutate) {
    const trial = M.clone(S.p);
    try { mutate(trial); } catch (e) { return []; }
    const before = netIssues().map((i) => i.message);
    return NM.topology.networkIssues(trial).filter((i) => before.indexOf(i.message) < 0);
  }
  /* html describing everything worth a second look before connecting aPortId to bPortId (cableId: the cable being reconnected) */
  function connectionWarnings(aPortId, bPortId, cableId) {
    const parts = [];
    const cg = crossGroupWarning(aPortId, bPortId);
    if (cg) parts.push(cg);
    const ni = newNetworkIssues((trial) => {
      if (cableId) M.updatePatchCable(trial, cableId, { aPortId: aPortId, bPortId: bPortId });
      else M.addPatchCable(trial, { aPortId: aPortId, bPortId: bPortId });
    });
    ni.forEach((i) => parts.push('<p class="err-text"><b>Network:</b> ' + esc(i.message) + '</p>'));
    return parts.length ? parts.join('') + '<p>Do you want to continue?</p>' : null;
  }
  /*
   * 'W' / "Patch cable from here": with a free port selected, start a one-shot wire from it (the tool ends after the
   * second click and the new cable stays selected so colour etc. can be adjusted); otherwise toggle the repeating tool.
   */
  function startWire(fromPortId) {
    if (!isEdit()) { toast('Switch to edit mode to draw patch cables', true); return; }
    const pid = fromPortId || (S.sel && S.sel.kind === 'port' ? S.sel.id : null);
    if (!fromPortId && S.tool && S.tool.type === 'patch') { cancelTool(); return; }
    if (pid) {
      const idx = M.buildIndex(S.p), pt = idx.ports[pid];
      if (!pt) return;
      if (pt.side === 'rear') { toast('Rear terminations take fixed links, not patch cables', true); return; }
      if (idx.portUse[pid]) { toast('That port is already occupied', true); return; }
      S.tool = { type: 'patch', pending: pid, cableType: 'Cat6', once: true };
      renderAll(); return;
    }
    setTool({ type: 'patch', pending: null, cableType: 'Cat6' });
  }
  /* 'G' after Ctrl+selecting ports: name and colour them as a port group */
  async function nameSelectedPorts() {
    const g = S.pgroup;
    if (!g || !g.ids.length) return;
    const o = M.buildIndex(S.p).objects[g.objId];
    const v = await formDlg('Name port group', [
      { k: 'name', label: 'Name', v: '', hint: g.ids.length + ' port(s) on ' + o.name + '. Examples: "to rack office", "L1".' },
      { k: 'color', label: 'Colour', type: 'select', opts: M.CABLE_COLORS.filter((c) => c[0] !== 'white').map((c) => [c[1], c[0]]), v: '#1f77b4' }
    ], 'Create group', '', (vals) => (vals.name.trim() ? null : 'Give the group a name'));
    if (!v) return;
    const created = commit('Add port group', (p) => M.addPortGroup(p, g.objId, { name: v.name, color: v.color, portIds: g.ids }));
    clearPgroup();
    if (created && created !== true) { S.sel = { kind: 'pgroup', id: created.id }; showTab('details'); openRight(); }
    renderAll();
  }
  function clearPgroup() { S.pgroup = null; S.hoverPort = null; S.preview = null; }

  /* Ctrl+click builds a group of free rear ports on one patch panel (Shift extends a range) */
  function pickGroupPort(id, shift) {
    const idx = M.buildIndex(S.p), pt = idx.ports[id], o = idx.portObj[id];
    if (!M.isTermination(o) || pt.side !== 'rear') { toast('Ctrl+click rear ports of a patch panel or wall socket to group them for a fixed link', true); return; }
    if (idx.portUse[id]) { toast('That port already has a fixed wire', true); return; }
    if (!S.pgroup || S.pgroup.objId !== o.id) S.pgroup = { objId: o.id, ids: [], last: null };
    const rear = M.rearPorts(o), g = S.pgroup;
    let add = [id];
    if (shift && g.last) {
      const a = rear.findIndex((x) => x.id === g.last), b = rear.findIndex((x) => x.id === id);
      add = rear.slice(Math.min(a, b), Math.max(a, b) + 1).filter((x) => !idx.portUse[x.id]).map((x) => x.id);
    }
    if (!shift && g.ids.indexOf(id) >= 0) g.ids = g.ids.filter((x) => x !== id);
    else add.forEach((x) => { if (g.ids.indexOf(x) < 0) g.ids.push(x); });
    g.ids.sort((x, y) => rear.findIndex((r) => r.id === x) - rear.findIndex((r) => r.id === y));
    g.last = id;
    if (!g.ids.length) clearPgroup();
    S.hoverPort = null; S.preview = null;
    renderAll();
  }

  /* the same number of rear ports on another panel, starting at the hovered port */
  function previewFor(hoverId) {
    const g = S.pgroup, idx = M.buildIndex(S.p), o = idx.portObj[hoverId], pt = idx.ports[hoverId];
    if (!g || !o || !M.isTermination(o) || pt.side !== 'rear' || o.id === g.objId) return null;
    const rear = M.rearPorts(o), start = rear.findIndex((x) => x.id === hoverId), n = g.ids.length;
    const ids = rear.slice(start, start + n).map((x) => x.id);
    let ok = true, text = idx.objects[g.objId].name + ' -> ' + o.name + ': ' + n + ' wire(s), rear ' + rear[start].label + (n > 1 ? '..' + rear[Math.min(start + n, rear.length) - 1].label : '');
    if (ids.length < n) { ok = false; text = 'Not enough ports on ' + o.name + ' after rear ' + rear[start].label + ' (need ' + n + ')'; }
    else if (ids.some((x) => idx.portUse[x])) { ok = false; text = 'Some target ports on ' + o.name + ' are already occupied'; }
    return { ids: ids, ok: ok, text: text, objId: o.id };
  }
  function createLinkFromGroup() {
    const pv = S.preview, g = S.pgroup;
    if (!pv || !pv.ok) { toast(pv ? pv.text : 'Hover the ports of another patch panel first', true); return; }
    const pairs = g.ids.map((x, i) => [x, pv.ids[i]]);
    clearPgroup();
    const r = commit('Create fixed link', (p) => M.addFixedLink(p, { aObjectId: g.objId, bObjectId: pv.objId, pairs: pairs }).id);
    if (r && r !== true) { toast('Created fixed link - edit its properties on the right'); select({ kind: 'link', id: r }); }
  }

  function handleTap(target, ev) {
    if (S.place && ev) { placeHere(ev); return; }
    const tg = target.closest ? target.closest('[data-toggle]') : null;
    if (tg) { toggleCollapse(tg.dataset.pl, tg.dataset.toggle); return; }
    const el = target.closest ? target.closest('[data-kind]') : null;
    if (isEdit() && !S.tool && ev && (ev.ctrlKey || ev.metaKey) && el && el.dataset.kind === 'port') { pickGroupPort(el.dataset.id, ev.shiftKey); return; }
    if (S.pgroup) {
      if (el && el.dataset.kind === 'port' && el.dataset.id !== undefined) {
        const pv = previewFor(el.dataset.id);
        if (pv) { S.preview = pv; createLinkFromGroup(); return; }
      }
      clearPgroup(); renderAll();
      if (!el) return;
    }
    const kind = el && el.dataset.kind, id = el && el.dataset.id;
    if (S.tool && S.tool.type === 'patch') {
      if (kind !== 'port') { if (!el) cancelTool(); else select({ kind: kind, id: id }); return; }
      if (!S.tool.pending) {
        const idx = M.buildIndex(S.p);
        if (idx.ports[id].side === 'rear') { toast('Rear terminations take fixed links, not patch cables', true); return; }
        if (idx.portUse[id]) { toast('That port is already occupied', true); return; }
        S.tool.pending = id; renderAll(); return;
      }
      const a = S.tool.pending;
      if (a === id) { S.tool.pending = null; renderAll(); return; }
      const tool = S.tool, warn = connectionWarnings(a, id);
      const make = () => {
        // 'auto': the colour of the network the cable extends from (router port network colour), else the default blue
        const color = S.cableColor === 'auto' ? (NM.topology.networkColorFor(S.p, [a, id]) || '#1f77b4') : S.cableColor;
        const cable = commit('Add patch cable', (p) => M.addPatchCable(p, { aPortId: a, bPortId: id, color: color, cableType: tool.cableType }));
        tool.pending = null;
        if (tool.once) S.tool = null; // one-shot wire: leave the tool, the new cable stays selected for colour/type edits
        if (cable) { toast('Added ' + cable.name + (tool.once ? ' - adjust colour and type in the panel' : '')); S.sel = { kind: 'cable', id: cable.id }; showTab('details'); openRight(); renderAll(); } else renderAll();
      };
      if (warn) confirmDlg('Check this connection', warn, 'Connect anyway').then((ok) => { if (ok) make(); else { tool.pending = null; renderAll(); } });
      else make();
      return;
    }
    if (S.tool && S.tool.type === 'reconnect') {
      if (kind !== 'port') { toast('Tap a port to reconnect to, or press Esc', true); return; }
      const t = S.tool, cab = S.p.patchCables.find((c) => c.id === t.cableId);
      const other = cab && (t.end === 'a' ? cab.bPortId : cab.aPortId), warn = other && connectionWarnings(t.end === 'a' ? id : other, t.end === 'a' ? other : id, t.cableId);
      const go = () => { S.tool = null; commit('Reconnect patch cable', (p) => M.updatePatchCable(p, t.cableId, t.end === 'a' ? { aPortId: id } : { bPortId: id })); };
      if (warn) confirmDlg('Check this connection', warn, 'Reconnect anyway').then((ok) => { if (ok) go(); });
      else go();
      return;
    }
    if (!el) { S.sel = null; closeRight(); renderAll(); return; }
    select({ kind: kind, id: id });
  }

  /* ---------------------------------------------------------------- canvas interaction */
  const pointers = new Map();
  let gesture = null, pinch = null, rafPending = false;
  function scheduleRender() { if (!rafPending) { rafPending = true; requestAnimationFrame(() => { rafPending = false; renderCanvas(); }); } }
  const EXTEND_ZONE = 60; // map units past a container's edge in which it keeps growing to hold a dragged item
  const snap = (v) => (S.p.settings.snapToGrid ? Math.round(v / S.p.settings.gridSize) * S.p.settings.gridSize : v);

  function bindCanvas() {
    const cv = $('canvas');
    cv.addEventListener('pointerdown', (e) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { cv.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      if (pointers.size === 2) {
        const pts = Array.from(pointers.values());
        pinch = { d: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) };
        gesture = null; S.drag = null; return;
      }
      const h = isEdit() && !S.place && e.target.closest ? e.target.closest('[data-handle]') : null;
      if (h) {
        const q = S.p.placements.find((x) => x.id === h.dataset.pl);
        if (!q) return;
        const kind = h.dataset.handle, start = toMap(e.clientX, e.clientY);
        const items = kind === 'move' ? M.placementGroup(S.p, q.id).map((x) => ({ q: x, ox: x.x, oy: x.y })) : [{ q: q, ow: q.w, oh: q.h }];
        S.drag = { kind: kind, plId: q.id, start: start, snap: JSON.stringify(S.p), items: items, moved: false, chain: kind === 'move' ? B.captureChain(S.p, q.mapId, q.refId) : [], from: (() => { const c = M.findContainer(S.p, q.refId); return c ? (c.kind === 'group' ? c.item.parentGroupId : c.item.containerId) : null; })() };
        return;
      }
      gesture = { x: e.clientX, y: e.clientY, vx: vpState().x, vy: vpState().y, target: e.target, moved: false };
    });
    cv.addEventListener('pointerleave', () => { if (S.place) $('ghost').style.display = 'none'; });
    cv.addEventListener('pointermove', (e) => {
      if (S.place && !pointers.size) { moveGhost(e); return; }
      if (S.pgroup && isEdit() && !pointers.size) {
        const pe = e.target.closest ? e.target.closest('[data-kind="port"]') : null;
        const hid = pe ? pe.dataset.id : null;
        if (hid !== S.hoverPort) { S.hoverPort = hid; S.preview = hid ? previewFor(hid) : null; scheduleRender(); }
        return;
      }
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size === 2) {
        const pts = Array.from(pointers.values()), d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (pinch.d > 0) zoomAt(d / pinch.d, (pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2);
        pinch.d = d; return;
      }
      if (S.drag) {
        const pt = toMap(e.clientX, e.clientY), d = S.drag;
        let dx = pt.x - d.start.x, dy = pt.y - d.start.y;
        if (Math.abs(dx) + Math.abs(dy) < 2 && !d.moved) return;
        d.moved = true;
        if (d.kind === 'move') {
          const p0 = d.items[0];
          dx = snap(p0.ox + dx) - p0.ox; dy = snap(p0.oy + dy) - p0.oy;
          d.items.forEach((it) => { it.q.x = it.ox + dx; it.q.y = it.oy + dy; });
          B.applyExtension(S.p, d.items[0].q.mapId, d.chain, d.items[0].q, EXTEND_ZONE);
          S.drop = B.dropSlot(S.p, d.items[0].q, d.from);
        } else {
          const it = d.items[0];
          const mn = B.minPlacementSize(S.p, it.q);
          it.q.w = Math.max(mn.w, snap(it.ow + dx)); it.q.h = Math.max(mn.h, snap(it.oh + dy));
        }
        scheduleRender(); return;
      }
      if (gesture) {
        const dx = e.clientX - gesture.x, dy = e.clientY - gesture.y;
        if (!gesture.moved && Math.hypot(dx, dy) > 6) gesture.moved = true;
        if (gesture.moved) { const v = vpState(); v.x = gesture.vx + dx; v.y = gesture.vy + dy; applyVp(); }
      }
    });
    const up = (e) => {
      pointers.delete(e.pointerId);
      if (pinch) { if (pointers.size < 2) { pinch = null; scheduleSave(true); } return; }
      if (S.drag) { finishDrag(); return; }
      if (gesture) {
        const g = gesture; gesture = null;
        if (!g.moved) handleTap(g.target, e); else scheduleSave(true);
      }
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); gesture = null; pinch = null; S.drop = null; if (S.drag) { S.p = JSON.parse(S.drag.snap); S.drag = null; renderAll(); } });
    cv.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY); }, { passive: false });
  }

  function finishDrag() {
    const d = S.drag; S.drag = null;
    const slot = S.drop; S.drop = null;
    if (!d.moved) return;
    S.undo.push({ label: d.kind === 'move' ? 'Move' : 'Resize', snap: d.snap }); S.redo = [];
    if (d.kind === 'move') {
      reassignContainer(d.plId, d);
      const q = S.p.placements.find((x) => x.id === d.plId), c = q && M.findContainer(S.p, q.refId);
      if (slot && q && c && c.item.containerId === slot.containerId) B.restack(S.p, q.mapId, slot.containerId, q.refId, slot.index);
      if (q && B.resolveDrop(S.p, d.plId)) toast('Moved to avoid overlapping another item');
    } else {
      const q = S.p.placements.find((x) => x.id === d.plId);
      if (q) B.settle(S.p, q);
    }
    scheduleSave(); afterChange();
  }
  /* dropping an item with its centre inside another container changes containment (data only; connections untouched) */
  function reassignContainer(plId, d) {
    const pl = S.p.placements.find((x) => x.id === plId);
    if (!pl) return;
    const c = M.findContainer(S.p, pl.refId);
    if (!c) return;
    const best = B.findDropContainer(S.p, pl);
    const cur = c.kind === 'group' ? c.item.parentGroupId : c.item.containerId;
    const want = best ? best.refId : null;
    if (want === cur) { if (cur) M.growToFit(S.p, pl.mapId, cur); return; }
    if (d) B.restoreChain(d.chain); // leaving the container: its temporary extension goes away
    try {
      M.setContainer(S.p, c.kind, c.id, want);
      if (want) M.growToFit(S.p, pl.mapId, want);
      toast(want ? 'Moved into ' + M.findContainer(S.p, want).item.name : 'Removed from container');
    } catch (e) { if (cur) M.growToFit(S.p, pl.mapId, cur); toast(e.message + ' (position kept, containment unchanged)', true); }
  }

  /* ---------------------------------------------------------------- rendering */
  function renderAll() {
    renderTop(); renderCanvas(); renderLeft(); renderRight(); renderToolbar();
    document.body.className = 'mode-' + S.mode + (S.view === 'graph' ? ' view-graph' : '');
    renderGraph();
  }
  function renderGraph() {
    const gv = $('graphView'), on = S.view === 'graph';
    gv.hidden = !on;
    $('btnGraph').classList.toggle('active', on);
    $('btnGraph').textContent = on ? 'Map' : 'Graph';
    if (!on) return;
    const top = gv.scrollTop;
    gv.innerHTML = NM.graphview.render(S.p, S.graph);
    gv.scrollTop = top;
  }
  function setView(v) { S.view = v; clearPgroup(); renderAll(); if (v === 'map' && S.p.placements.some((q) => q.mapId === S.mapId)) applyVp(); }
  function renderTop() {
    $('projTitle').textContent = S.p.name;
    $('mapSelect').innerHTML = opts(S.p.maps.map((m) => [m.id, m.name]), S.mapId);
    $('btnMode').textContent = isEdit() ? 'Done editing' : 'Edit';
    const na = netIssues(), ab = $('btnAlerts');
    ab.hidden = !na.length; ab.textContent = 'Network warnings (' + na.length + ')'; ab.title = na.slice(0, 5).map((i) => i.message).join('\n');
    $('btnUndo').disabled = !S.undo.length; $('btnRedo').disabled = !S.redo.length;
    $('btnUndo').title = S.undo.length ? 'Undo: ' + S.undo[S.undo.length - 1].label : 'Nothing to undo';
    setStatus();
  }
  function renderCanvas() {
    const map = curMap();
    const r = R.renderMap(S.p, map.id, {
      mode: S.mode, selection: S.sel, highlight: S.trace && S.trace.highlight,
      pendingPortId: S.tool && S.tool.pending, collapsed: S.collapsed, drop: S.place && S.place.host ? { containerId: S.place.host } : S.drop, alerts: netAlertMap(), ringPorts: ringPorts(),
      groupPorts: S.pgroup ? S.pgroup.ids : null, preview: S.preview
    });
    S.geo = r;
    $('vp').innerHTML = r.content;
    applyVp();
    const none = !S.p.placements.some((q) => q.mapId === map.id);
    const eh = $('emptyHint');
    eh.hidden = !none;
    if (none) {
      eh.innerHTML = '<div><strong>This map is empty.</strong></div><div>' + (isEdit() ? 'Use the toolbar to add groups, racks and equipment.' : 'Tap "Edit" to start documenting, or load the demo project.') + '</div>' +
        (S.p.objects.length ? '' : '<button data-act="demo">Load demo project</button>');
    }
    const th = $('toolHint');
    if (S.tool && S.tool.type === 'patch') { th.hidden = false; th.textContent = S.tool.pending ? 'Tap the destination port (Esc to cancel)' : 'Patch cable: tap the first port (W or Esc to stop)'; }
    else if (S.place) { th.hidden = false; th.textContent = 'Click to place ' + (S.place.name || M.TYPE_LABELS[S.place.type] || 'item') + ' - hold Ctrl to place more copies (names count up), Esc to cancel'; }
    else if (S.pgroup) {
      th.hidden = false;
      const pv = S.preview;
      th.textContent = pv ? (pv.ok ? 'Click to create a fixed link: ' + pv.text : pv.text) : S.pgroup.ids.length + ' rear port(s) selected - hover another panel and click to link, G names them as a group (Ctrl+click adds, Esc cancels)';
    }
    else if (S.tool && S.tool.type === 'reconnect') { th.hidden = false; th.textContent = 'Tap the new port for end ' + S.tool.end.toUpperCase() + ' (Esc to cancel)'; }
    else th.hidden = true;
  }
  function renderToolbar() {
    const tb = $('toolbar');
    if (!isEdit()) { tb.innerHTML = ''; return; }
    const pc = S.tool && S.tool.type === 'patch';
    tb.innerHTML =
      ['group:Group', 'rack:Rack', 'patchpanel:Patch panel', 'switch:Switch', 'router:Router', 'internet:Internet / ISP', 'socket:Wall socket', 'generic:Generic'].map((s) => {
        const a = s.split(':'); return '<button data-add="' + a[0] + '" title="Create a new ' + a[1].toLowerCase() + ' on this map">+ ' + a[1] + '</button>';
      }).join('') + '<span class="sep"></span>' +
      '<button data-act="patchTool" title="' + esc(TIPS.patchTool) + '" class="' + (pc ? 'active' : '') + '">Patch cable tool (W)</button>' +
      (pc ? ' <span class="cable-colour">' + colorPicker('toolPreset', 'toolColor', S.cableColor, '__tool', { value: 'auto', label: 'Auto (network colour)', swatch: '#1f77b4' }) + '</span>' : '') +
      '<button data-act="newLink" title="' + esc(TIPS.newLink) + '">+ Fixed link</button>' +
      '<button data-act="addMapItems" title="' + esc(TIPS.addMapItems) + '">Add existing here...</button>';
  }

  /* ---- left drawer ---- */
  function renderLeft() {
    const res = $('searchResults');
    if (S.query) {
      const r = M.search(S.p, S.query);
      res.innerHTML = '<h3>Search results (' + r.length + ')</h3>' + (r.length ? r.map((x) =>
        '<div class="list-item" data-act="goto" data-kind="' + x.kind + '" data-id="' + esc(x.id) + '"><div class="grow">' + esc(x.title) + '<div class="sub">' + esc(x.sub) + '</div></div></div>').join('') : '<div class="sub">No matches</div>');
      res.style.display = '';
    } else res.style.display = 'none';

    $('mapList').innerHTML = '<h3>Maps' + (isEdit() ? ' <button data-act="newMap" style="float:right;padding:0 6px">+ Add</button>' : '') + '</h3>' +
      S.p.maps.map((m) => '<div class="list-item ' + (m.id === S.mapId ? 'active' : '') + '" data-act="goto" data-kind="map" data-id="' + esc(m.id) + '"><div class="grow">' + esc(m.name) +
        (m.location ? '<div class="sub">' + esc(m.location) + '</div>' : '') + '</div>' +
        (isEdit() ? '<button data-act="editMap" data-id="' + esc(m.id) + '" style="padding:0 6px">Edit</button>' : '') + '</div>').join('');

    const idx = M.buildIndex(S.p), mid = curMap().id;
    const onMap = (id) => !!M.placementOf(S.p, mid, id);
    function node(kind, item, depth) {
      const isG = kind === 'group';
      let h = '<div class="list-item ' + (S.sel && S.sel.id === item.id ? 'active' : '') + '" style="margin-left:' + depth * 14 + 'px" data-act="goto" data-kind="' + kind + '" data-id="' + esc(item.id) + '">' +
        '<div class="grow">' + esc(item.name) + '</div><span class="tag">' + (isG ? 'group' : M.typeLabel(item)) + '</span>' +
        (onMap(item.id) ? '' : '<span class="tag" title="Not drawn on the current map">other map</span>') + '</div>';
      M.containerChildren(S.p, item.id).forEach((k) => {
        h += node(k.kind, k.kind === 'group' ? idx.groups[k.id] : idx.objects[k.id], depth + 1);
      });
      return h;
    }
    let ol = '<h3>Equipment</h3>';
    S.p.groups.filter((g) => !g.parentGroupId).forEach((g) => { ol += node('group', g, 0); });
    S.p.objects.filter((o) => !o.containerId).forEach((o) => { ol += node('object', o, 0); });
    if (!S.p.groups.length && !S.p.objects.length) ol += '<div class="sub">Nothing documented yet.</div>';
    $('objectList').innerHTML = ol;

    const il = $('issueList');
    const errs = S.issues.filter((i) => i.severity !== 'info'), infos = S.issues.length - errs.length;
    il.innerHTML = '<h3>Validation <button data-act="validate" style="float:right;padding:0 6px">Run</button></h3>' +
      (!S.showIssues ? '<div class="sub">Not run yet.</div>' :
        (errs.length ? errs.map((i) => '<div class="list-item" ' + (i.target ? 'data-act="goto" data-kind="' + i.target.kind + '" data-id="' + esc(i.target.id) + '"' : '') + '><div class="grow sev-' + i.severity + '">' + esc(i.message) + '</div></div>').join('') : '<div class="sub" style="color:#2e7d32">No errors or warnings.</div>') +
        '<div class="sub">' + infos + ' informational note(s) about unused ports.</div>');
  }

  /* ---- right pane ---- */
  function showTab(name) {
    $('tabDetails').classList.toggle('active', name === 'details');
    $('tabTrace').classList.toggle('active', name === 'trace');
    $('detailsPane').hidden = name !== 'details';
    $('tracePane').hidden = name !== 'trace';
  }
  const openRight = () => $('right').classList.add('open');
  const closeRight = () => $('right').classList.remove('open');
  const openLeft = () => $('left').classList.add('open');
  const closeLeft = () => $('left').classList.remove('open');

  /* preset cable colours plus "Custom..." which reveals the RGB picker */
  /* special: optional first choice {value, label, swatch[, dt]} for "no colour" / "auto"; dt = data-t of the port being edited */
  function colorPicker(presetField, colorField, value, ownerId, special) {
    const isSpecial = !!special && !special.noOption && value === special.value;
    const preset = M.CABLE_COLORS.find((c) => c[1].toLowerCase() === String(value).toLowerCase());
    const custom = S.customColorFor === ownerId || (!isSpecial && !preset);
    const o = (special && !special.noOption ? [[special.value, special.label]] : []).concat(M.CABLE_COLORS.map((c) => [c[1], c[0]]), [['custom', 'Custom...']]);
    const dt = special && special.dt ? ' data-t="' + esc(special.dt) + '"' : '';
    const hex = /^#[0-9a-f]{6}$/i.test(value) ? value : '#1f77b4';
    return '<span class="swatch" role="button" data-act="customColor" data-owner="' + esc(ownerId) + '" title="Click to choose any colour" style="background:' + esc(isSpecial ? (special.swatch || 'transparent') : value) + '"></span> <select data-f="' + presetField + '"' + dt + '>' +
      opts(o, custom ? 'custom' : (isSpecial ? special.value : preset[1])) + '</select>' +
      (custom ? ' <input type="color" data-f="' + colorField + '"' + dt + ' value="' + esc(hex) + '" title="Custom colour">' : '');
  }
  function fld(label, html) { return '<div class="field"><label>' + label + '</label><div>' + html + '</div></div>'; }
  function inp(label, f, val, t, extra) {
    if (!isEdit()) return fld(label, '<div class="ro">' + esc(val) + '</div>');
    return fld(label, '<input type="text" data-f="' + f + '"' + (t ? ' data-t="' + esc(t) + '"' : '') + ' value="' + esc(val) + '" ' + (extra || '') + '>');
  }
  const lnk = (kind, id, text) => '<a class="lnk" data-act="select" data-kind="' + kind + '" data-id="' + esc(id) + '">' + esc(text) + '</a>';
  /* tooltips for action buttons, keyed by data-act (reconnect also by end) */
  const TIPS = {
    trace: 'Highlight the complete physical path through this item, across patch panels, fixed links and maps',
    'reconnect:a': 'Move end A of this patch cable to a different port: click this, then click the new port on the map. The circled port is the end that moves.',
    'reconnect:b': 'Move end B of this patch cable to a different port: click this, then click the new port on the map. The circled port is the end that moves.',
    deleteSel: 'Delete the selected item (you will be asked to confirm and shown what else is removed)',
    deleteCable: 'Remove this patch cable; both ports become free',
    editWiring: 'Change installed wiring: endpoints, wire mappings, add or delete wires. Changes are reviewed before they are applied.',
    automap: 'Document a straight-through panel: map every unmapped front port N to rear port N',
    newLinkFrom: 'Create a fixed link (installed multi-wire cable) from this patch panel to another one',
    mapPort: 'Document which port on the other side of the panel this one is physically wired to',
    unmap: 'Remove the documented front-to-rear mapping of this port',
    applyPortCount: 'Set the number of ports (ports in use cannot be removed)',
    applyRouterPorts: 'Set the number of WAN and LAN ports (ports in use cannot be removed)',
    addToMap: 'Show this item on the current map (the same record, not a copy)',
    removeFromMap: 'Hide this item from the current map only; the equipment and its connections stay in the project',
    startPatchFrom: 'Start one patch cable at this port (hotkey W): click the other port on the map; the new cable then stays selected so you can set its colour',
    clearTrace: 'Remove the trace highlight and return to the normal map',
    fitTrace: 'Zoom the map to the parts of the trace that are on this map',
    patchTool: 'Draw patch cables: click one port, then another (hotkey W). Select a port first and press W to draw a single cable from it. Esc stops.',
    newLink: 'Create a fixed link between two patch panels',
    addMapItems: 'Show equipment that exists in the project but is not drawn on this map',
    help: 'How NetMap works'
  };
  const tipFor = (act, extra) => { const m = /data-end="(\w)"/.exec(extra || ''); return (m && TIPS[act + ':' + m[1]]) || TIPS[act] || ''; };
  const btn = (act, label, extra, cls) => '<button data-act="' + act + '" ' + (extra || '') + ' class="' + (cls || '') + '"' + (tipFor(act, extra) ? ' title="' + esc(tipFor(act, extra)) + '"' : '') + '>' + esc(label) + '</button>';

  function renderRight() {
    const pane = $('detailsPane');
    if (!S.sel) {
      pane.innerHTML = '<h3>Nothing selected</h3><div class="sub">Tap an object, port, cable or fixed link on the map to see details. Use the search box to find a port, cable or wire by label or ID.</div>' +
        '<div class="btn-row">' + btn('help', 'Help') + '</div>';
    } else {
      const d = { group: detGroup, object: detObject, port: detPort, cable: detCable, link: detLink, wire: detWire, pgroup: detPGroup }[S.sel.kind];
      pane.innerHTML = d(S.sel.id);
    }
    renderTracePane();
    $('tabTrace').textContent = S.trace ? 'Trace *' : 'Trace';
  }

  const hasIp = (o) => M.hasPortIp(o); // per-port addresses (router, generic device, Internet); switches have one management address
  function containerOptions(forKind, forType, selfId) {
    const out = [['', '(none - standalone)']];
    S.p.groups.forEach((g) => {
      if (g.id === selfId || (forKind === 'group' && M.descendants(S.p, selfId).some((d) => d.id === g.id))) return;
      out.push([g.id, 'Group: ' + g.name]);
    });
    if (forKind === 'object' && forType !== 'rack') S.p.objects.filter((o) => o.type === 'rack').forEach((r) => {
      // label racks with their top-level container (e.g. "NAD: Rack 1"); standalone racks keep "Rack: name"
      let top = M.parentOf(S.p, 'object', r.id), guard = 0;
      while (top && guard++ < 20) { const up = M.parentOf(S.p, top.kind, top.id); if (!up) break; top = up; }
      out.push([r.id, (top ? top.item.name : 'Rack') + ': ' + r.name]);
    });
    return out;
  }
  function mapsLine(kind, id) {
    const ms = M.mapsFor(S.p, kind, id).map((m) => S.p.maps.find((x) => x.id === m)).filter(Boolean);
    return ms.length ? ms.map((m) => '<a class="lnk" data-act="goto" data-kind="' + kind + '" data-id="' + esc(id) + '" data-map="' + esc(m.id) + '">' + esc(m.name) + '</a>').join(', ') : '<span class="sev-warning">not placed on any map</span>';
  }

  function detGroup(id) {
    const g = S.p.groups.find((x) => x.id === id), idx = M.buildIndex(S.p);
    const kids = M.containerChildren(S.p, id);
    let h = '<h3>Group</h3>' + inp('Name', 'name', g.name) + inp('Location', 'location', g.location) + inp('Description', 'description', g.description);
    h += isEdit() ? fld('Inside', '<select data-f="container">' + opts(containerOptions('group', null, id), g.parentGroupId || '') + '</select>') :
      fld('Inside', g.parentGroupId ? esc(idx.groups[g.parentGroupId].name) : '-');
    h += fld('On maps', mapsLine('group', id));
    h += '<h3>Contents (' + kids.length + ')</h3>' + (kids.map((k) => '<div class="list-item" data-act="goto" data-kind="' + k.kind + '" data-id="' + esc(k.id) + '">' + esc((k.kind === 'group' ? idx.groups[k.id] : idx.objects[k.id]).name) + '</div>').join('') || '<div class="sub">Empty. Groups only organise equipment; they never connect ports.</div>');
    if (isEdit()) h += '<div class="btn-row">' + placeButtons(id, 'group') + btn('deleteSel', 'Delete group...', '', 'danger') + '</div>';
    return h;
  }
  function placeButtons(id, kind) {
    const on = !!M.placementOf(S.p, curMap().id, id);
    return on ? btn('removeFromMap', 'Remove from this map', 'data-id="' + esc(id) + '"') : btn('addToMap', 'Add to this map', 'data-id="' + esc(id) + '" data-kind="' + kind + '"');
  }

  function portState(o, pt, idx) {
    const u = idx.portUse[pt.id], m = idx.mapByPort[pt.id], parts = [];
    if (u && u.kind === 'patch') { const c = idx.cables[u.id]; parts.push(lnk('cable', c.id, c.name) + ' -> ' + esc(M.portName(S.p, u.other, idx))); }
    if (u && u.kind === 'wire') { const l = idx.links[u.linkId], w = idx.wires[u.id]; parts.push(lnk('wire', w.id, l.name + ' w' + w.number) + ' -> ' + esc(M.portName(S.p, u.other, idx))); }
    if (m) parts.push('<span class="tag">mapped to ' + esc(idx.ports[m.other].side + ' ' + idx.ports[m.other].label) + '</span>');
    return parts.length ? parts.join('<br>') : '<span class="sub">free</span>';
  }

  /* switch port layout, uplinks and isolation */
  function switchBlock(o) {
    const per = M.accessPorts(o).length, up = o.ports.length - per;
    const cur = o.sectionSize > 0 && per % o.sectionSize === 0 ? o.sectionSize : 0;
    const rows = cur && o.sectionRows > 0 && cur % o.sectionRows === 0 ? o.sectionRows : 1;
    const order = o.portOrder === 'rows' ? 'rows' : 'columns', align = o.align || 'left', side = o.uplinkSide === 'left' ? 'left' : 'right';
    const sel = (f, list, v) => '<select data-f="' + f + '">' + opts(list, v) + '</select>';
    if (!isEdit()) {
      return fld('Sections', cur ? per / cur + ' x (' + rows + ' x ' + cur / rows + ')' : 'none') + (up ? fld('Uplink ports', up) : '') + (o.portIsolation ? fld('Port isolation', 'on: access ports only reach uplinks') : '');
    }
    let h = fld('Sections', sel('sectionSize', [[0, 'None (plain rows)']].concat(M.validSectionSizes(per).map((d) => [d, d + ' per section (' + per / d + ' x ' + d + ')'])), cur) + '<div class="sub">Equal sections only.</div>');
    if (cur) h += fld('Section shape', sel('sectionRows', M.validSectionRows(cur).map((d) => [d, d + (d === 1 ? ' row' : ' rows') + ' x ' + cur / d + ' columns']), rows));
    if (cur && rows > 1) h += fld('Port order', sel('portOrder', [['columns', 'down, then across (1 above 2)'], ['rows', 'across, then down']], order));
    h += fld('Align', sel('align', [['left', 'left'], ['center', 'center'], ['right', 'right']], align) + '<div class="sub">Where the ports sit when the switch is wider than its ports (e.g. full width).</div>');
    h += fld('Uplink ports', '<input type="number" id="upInput" min="0" max="16" value="' + up + '" style="width:60px"> ' + btn('applyUplinks', 'Apply') + '<div class="sub">Extra ports next to the sections (SFP, trunk...).</div>');
    if (up) h += fld('Uplinks on', sel('uplinkSide', [['right', 'right'], ['left', 'left']], side));
    if (up > 1) h += fld('Uplink rows', sel('uplinkRows', [1, 2, 3, 4].filter((d) => d <= up).map((d) => [d, d === 1 ? '1 (in line)' : d + ' rows']), o.uplinkRows || 1));
    h += fld('Port isolation', '<label><input type="checkbox" data-f="portIsolation"' + (o.portIsolation ? ' checked' : '') + '> access ports cannot reach each other, only uplinks</label>');
    return h;
  }

  function detObject(id) {
    const idx = M.buildIndex(S.p), o = idx.objects[id];
    let h = '<h3>' + esc(M.typeLabel(o)) + '</h3>' + inp('Name', 'name', o.name) + inp('Location', 'location', o.location) + inp('Description', 'description', o.description);
    if (o.type === 'generic') h += isEdit() ? fld('Device type', '<select data-f="deviceKind">' + opts(M.DEVICE_KINDS.map((k) => [k[0], k[1]]), o.deviceKind || 'other') + '</select>') : fld('Device type', esc(M.typeLabel(o)));
    if (o.type === 'rack') h += inp('Height (U)', 'rackHeight', o.rackHeight || '');
    if (M.hasDeviceIp(o)) {
      h += inp(o.type === 'internet' ? 'Public IP' : (o.type === 'switch' ? 'Management IP' : 'IP address'), 'ipAddress', o.ipAddress || '');
      if (isEdit() && o.type === 'switch') h += '<div class="sub">Address of the switch\'s web interface (managed switch). It joins the network of the switch, not its ports.</div>';
      if (isEdit() && o.type === 'generic') h += '<div class="sub">Used for its port when it has just one; with several ports (e.g. a PC with two NICs) give each port its own IP below - a device never joins its networks together.</div>';
    }
    const par = o.containerId ? M.findContainer(S.p, o.containerId) : null;
    h += isEdit() ? fld('Inside', '<select data-f="container">' + opts(containerOptions('object', o.type, id), o.containerId || '') + '</select>') : fld('Inside', par ? lnk(par.kind, par.id, par.item.name) : '-');
    h += fld('On maps', mapsLine('object', id)) + fld('ID', '<span class="sub">' + esc(o.id) + '</span>');
    if (o.type === 'rack') {
      const kids = M.containerChildren(S.p, id);
      h += '<h3>Contents (' + kids.length + ')</h3>' + (kids.map((k) => '<div class="list-item" data-act="goto" data-kind="object" data-id="' + esc(k.id) + '">' + esc(idx.objects[k.id].name) + '</div>').join('') || '<div class="sub">Empty rack.</div>');
    } else if (o.type !== 'generic' || o.ports.length) {
      const per = M.isTermination(o) ? o.ports.length / 2 : (o.type === 'switch' ? M.accessPorts(o).length : o.ports.length);
      const used = o.ports.filter((p) => idx.portUse[p.id]).length;
      h += '<h3>Ports (' + per + (M.isTermination(o) ? ' front + ' + per + ' rear' : '') + (o.type === 'switch' && o.ports.length > per ? ' + ' + (o.ports.length - per) + ' uplink' : '') + ', ' + used + ' cabled)</h3>';
    }
    if (o.type === 'switch') h += switchBlock(o);
    if (o.type !== 'rack' && o.type !== 'internet' && o.containerId) {
      h += isEdit() ? fld('Full width', '<label><input type="checkbox" data-f="fullWidth"' + (o.fullWidth ? ' checked' : '') + '> stretch to the width of its ' + (M.findContainer(S.p, o.containerId).kind === 'group' ? 'group' : 'rack') + '</label>') : (o.fullWidth ? fld('Full width', 'yes') : '');
    }
    if (o.type === 'patchpanel') {
      const per = o.ports.length / 2, cur = M.effectiveSectionSize(o, per);
      h += isEdit() ? fld('Sections', '<select data-f="sectionSize">' + opts(M.validSectionSizes(per).map((d) => [d, d + ' per section (' + per / d + ' x ' + d + ')']), cur) + '</select><div class="sub">Equal sections only.</div>') :
        fld('Sections', per / cur + ' x ' + cur);
    }
    if (isEdit() && o.type === 'router') {
      const nw = o.ports.filter((x) => x.role === 'wan').length, nl = o.ports.length - nw;
      h += fld('Ports', 'WAN <input type="number" id="wanInput" min="0" max="96" value="' + nw + '" style="width:60px"> LAN <input type="number" id="lanInput" min="0" max="96" value="' + nl + '" style="width:60px"> ' + btn('applyRouterPorts', 'Apply'));
    } else if (isEdit() && o.type !== 'rack') {
      h += fld('Port count', '<input type="number" id="pcInput" min="0" max="96" value="' + (M.isTermination(o) ? o.ports.length / 2 : (o.type === 'switch' ? M.accessPorts(o).length : o.ports.length)) + '" style="width:70px"> ' + btn('applyPortCount', 'Apply') +
        (o.type === 'switch' ? '<div class="sub">Presets: ' + [8, 16, 24, 48].map((n) => '<a class="lnk" data-act="presetPorts" data-n="' + n + '">' + n + '</a>').join(' ') + '</div>' : ''));
    }
    if (o.ports.length) {
      h += '<table class="t"><tr><th>Port</th><th>Connection</th><th></th></tr>' + o.ports.map((pt) =>
        '<tr><td>' + (isEdit() ? '<input type="text" data-f="plabel" data-t="' + esc(pt.id) + '" value="' + esc(pt.label) + '" style="width:5em">' : '<a class="lnk" data-act="select" data-kind="port" data-id="' + esc(pt.id) + '">' + esc(pt.label) + '</a>') +
        (M.isTermination(o) ? ' <span class="tag">' + pt.side + '</span>' : '') + ((o.type === 'router' || pt.role === 'uplink') ? ' <span class="tag">' + esc(pt.role) + '</span>' : '') + '</td><td>' +
        (isEdit() ? '<input type="text" data-f="pdesc" data-t="' + esc(pt.id) + '" value="' + esc(pt.description || '') + '" placeholder="Label (shown on hover)" style="width:100%;margin-bottom:2px">' : (pt.description ? '<div><b>' + esc(pt.description) + '</b></div>' : '')) +
        (hasIp(o) ? (isEdit() ? '<input type="text" data-f="pip" data-t="' + esc(pt.id) + '" value="' + esc(pt.ip || '') + '" placeholder="IP" style="width:100%;margin-bottom:2px">' : (pt.ip ? '<div>' + esc(pt.ip) + '</div>' : '')) : '') +
        portState(o, pt, idx) + '</td><td>' +
        '<button data-act="trace" data-kind="port" data-id="' + esc(pt.id) + '" title="Trace connection">Trace</button></td></tr>').join('') + '</table>';
    }
    h += pgroupSection(o);
    if (isEdit()) {
      h += '<div class="btn-row">' + placeButtons(id, 'object') + (M.isTermination(o) ? btn('automap', 'Map front N <-> rear N') + btn('newLinkFrom', 'Fixed link from here...') : '') +
        btn('deleteSel', 'Delete...', '', 'danger') + '</div>';
      if (M.isTermination(o)) h += '<div class="sub">Internal mappings: ' + S.p.internalMappings.filter((m) => m.objectId === id).length + ' documented. Tracing only follows documented mappings.</div>';
    }
    return h;
  }

  /* "7-14, 17" style text for a group's ports (numeric labels in runs) */
  function portsText(o, g, side) {
    const list = o.ports.filter((pt) => g.portIds.indexOf(pt.id) >= 0 && (!side || pt.side === side)), out = [];
    let i = 0;
    while (i < list.length) {
      const a = list[i]; let j = i;
      while (/^\d+$/.test(list[j].label) && j + 1 < list.length && /^\d+$/.test(list[j + 1].label) && +list[j + 1].label === +list[j].label + 1) j++;
      out.push(j > i ? a.label + '-' + list[j].label : a.label); i = j + 1;
    }
    return out.join(', ');
  }
  const groupSide = (o, g) => { const sides = Array.from(new Set(o.ports.filter((pt) => g.portIds.indexOf(pt.id) >= 0).map((pt) => pt.side))); return M.isTermination(o) && sides.length === 1 ? sides[0] : null; };
  function pgroupRows(o) {
    return (o.portGroups || []).map((g) => '<div class="list-item" data-act="select" data-kind="pgroup" data-id="' + esc(g.id) + '"><span class="swatch" style="background:' + esc(g.color) + '"></span><div class="grow"><b>' + esc(g.name) + '</b> <span class="sub">' +
      (groupSide(o, g) ? groupSide(o, g) + ' ' : '') + esc(portsText(o, g, groupSide(o, g))) + '</span></div></div>').join('');
  }
  function detPGroup(id) {
    const f = M.findPortGroup(S.p, id), o = f.obj, g = f.group, side = groupSide(o, g);
    let h = '<h3>Port group</h3>' + fld('On', lnk('object', o.id, o.name)) + inp('Name', 'pgName', g.name, g.id);
    h += isEdit() ? fld('Colour', colorPicker('pgPreset', 'pgColor', g.color, 'pg:' + g.id, { noOption: true, dt: g.id })) : fld('Colour', '<span class="swatch" style="background:' + esc(g.color) + '"></span>');
    h += inp('Ports', 'pgPorts', portsText(o, g, side), g.id, 'placeholder="7-14, 17"') + fld('Count', g.portIds.length + (side ? ' (' + side + ')' : ''));
    if (isEdit()) h += '<div class="sub">Ports as numbers and ranges, e.g. 7-14, 17. A port belongs to one group.</div>';
    h += '<div class="btn-row">';
    if (isEdit()) {
      const rear = o.ports.filter((pt) => g.portIds.indexOf(pt.id) >= 0 && pt.side === 'rear');
      if (M.isTermination(o) && rear.length) h += btn('linkFromGroup', 'Fixed link from this group...', 'data-id="' + esc(g.id) + '"');
      h += btn('deletePGroup', 'Delete group', 'data-id="' + esc(g.id) + '"', 'danger');
    }
    return h + '</div>';
  }
  function pgroupSection(o) {
    let h = '';
    if (!o.ports.length) return h;
    h += '<h3>Port groups (' + (o.portGroups || []).length + ')</h3>' + (pgroupRows(o) || '<div class="sub">None. Name and colour a set of ports, e.g. "to rack office".</div>');
    if (isEdit()) {
      h += '<div class="sub" style="margin-top:6px">New group: <input type="text" id="pgNewName" placeholder="name" style="width:9em"> ports <input type="text" id="pgNewPorts" placeholder="7-14, 17" style="width:7em">' +
        (M.isTermination(o) ? ' <select id="pgNewSide"><option value="rear">rear</option><option value="front">front</option></select>' : '') +
        ' <select id="pgNewColor">' + opts(M.CABLE_COLORS.filter((c) => c[0] !== 'white').map((c) => [c[1], c[0]]), '#1f77b4') + '</select> ' + btn('addPGroup', 'Add') + '</div>';
      h += '<div class="sub">Tip: Ctrl+click ports, then press G to name them as a group.</div>';
    }
    return h;
  }
  function detPort(id) {
    const idx = M.buildIndex(S.p), pt = idx.ports[id], o = idx.portObj[id];
    let h = '<h3>Port</h3>' + fld('Equipment', lnk('object', o.id, o.name)) + inp('Number', 'plabel', pt.label, pt.id) + inp('Label', 'pdesc', pt.description || '', pt.id, 'placeholder="shown on hover"');
    if (M.isTermination(o)) h += fld('Side', pt.side);
    if (o.type === 'router') h += fld('Role', esc((pt.role || '').toUpperCase()));
    if (hasIp(o)) h += inp('IP address', 'pip', pt.ip || '', pt.id);
    if (o.type === 'router') h += isEdit() ? fld('Network colour', colorPicker('netPreset', 'pnet', pt.networkColor || '', 'net:' + pt.id, { value: '', label: 'none', swatch: 'transparent', dt: pt.id }) + '<div class="sub">New patch cables extending from this port default to this colour.</div>') : (pt.networkColor ? fld('Network colour', '<span class="swatch" style="background:' + esc(pt.networkColor) + '"></span>') : '');
    if (o.type === 'switch') h += inp('Type', 'ptype', pt.portType || '', pt.id) + inp('Speed', 'pspeed', pt.speed || '', pt.id) + inp('Media', 'pmedia', pt.media || '', pt.id);
    h += fld('Connection', portState(o, pt, idx));
    h += '<div class="btn-row">' + btn('trace', 'Trace connection', 'data-kind="port" data-id="' + esc(id) + '"', 'primary');
    if (isEdit()) {
      const u = idx.portUse[id];
      if (pt.side !== 'rear' && !u) h += btn('startPatchFrom', 'Patch cable from here', 'data-id="' + esc(id) + '"');
      if (o.type === 'router' && pt.networkColor) h += btn('recolorNet', 'Recolour this network\'s cables', 'data-id="' + esc(id) + '"');
      if (u && u.kind === 'patch') h += btn('deleteCable', 'Remove cable ' + idx.cables[u.id].name, 'data-id="' + esc(u.id) + '"', 'danger');
      const mp = S.p.internalMappings.find((m) => m.aPortId === id || m.bPortId === id);
      if (M.isTermination(o) && mp) h += btn('unmap', 'Remove internal mapping', 'data-id="' + esc(mp.id) + '"');
      else if (M.isTermination(o)) h += btn('mapPort', 'Map to ' + (pt.side === 'front' ? 'rear' : 'front') + ' port...', 'data-id="' + esc(id) + '"');
    }
    return h + '</div>';
  }

  function detCable(id) {
    const idx = M.buildIndex(S.p), c = idx.cables[id];
    let h = '<h3>Patch cable</h3>' + inp('ID', 'name', c.name) +
      fld('End A', lnk('port', c.aPortId, M.portName(S.p, c.aPortId, idx))) + fld('End B', lnk('port', c.bPortId, M.portName(S.p, c.bPortId, idx)));
    h += inp('Cable type', 'cableType', c.cableType) + inp('Length', 'length', c.length);
    h += isEdit() ? fld('Colour', colorPicker('colorPreset', 'color', c.color, c.id)) : fld('Colour', '<span style="display:inline-block;width:30px;height:12px;background:' + esc(c.color) + ';border:1px solid #888"></span>');
    h += isEdit() ? fld('Status', '<select data-f="status">' + opts(M.CABLE_STATUS.map((s) => [s, s]), c.status) + '</select>') : fld('Status', esc(c.status));
    h += '<div class="btn-row">' + btn('trace', 'Trace connection', 'data-kind="cable" data-id="' + esc(id) + '"', 'primary');
    if (isEdit()) h += btn('reconnect', 'Reconnect end A', 'data-end="a"') + btn('reconnect', 'Reconnect end B', 'data-end="b"') + btn('deleteSel', 'Remove cable', '', 'danger');
    return h + '</div>';
  }

  function detLink(id) {
    const idx = M.buildIndex(S.p), l = idx.links[id], a = idx.objects[l.aObjectId], b = idx.objects[l.bObjectId];
    let h = '<h3>Fixed link (installed cabling)</h3>' + inp('ID', 'name', l.name) +
      fld('Panel A', a ? lnk('object', a.id, a.name) : '?') + fld('Panel B', b ? lnk('object', b.id, b.name) : '?') + fld('Wires', l.wires.length);
    h += inp('Cable type', 'cableType', l.cableType) + inp('Length', 'length', l.length) + inp('Route', 'route', l.route);
    h += isEdit() ? fld('Status', '<select data-f="status">' + opts(M.LINK_STATUS.map((s) => [s, s]), l.status) + '</select>') : fld('Status', esc(l.status));
    h += fld('On maps', mapsLine('link', id));
    h += '<div class="btn-row">' + btn('trace', 'Trace all wires', 'data-kind="link" data-id="' + esc(id) + '"', 'primary');
    if (isEdit()) h += btn('editWiring', 'Edit installed wiring...') + btn('deleteSel', 'Delete link...', '', 'danger');
    h += '</div><h3>Wires</h3><table class="t"><tr><th>#</th><th>A port</th><th>B port</th><th>Status</th><th></th></tr>' +
      l.wires.map((w) => '<tr><td>' + lnk('wire', w.id, w.number) + '</td><td>' + esc(w.aPortId ? idx.ports[w.aPortId].label : '-') + '</td><td>' + esc(w.bPortId ? idx.ports[w.bPortId].label : '-') + '</td><td>' +
        (isEdit() ? '<select data-f="wstatus" data-t="' + esc(w.id) + '">' + opts(M.WIRE_STATUS.map((s) => [s, s]), w.status) + '</select>' : esc(w.status)) + '</td><td><button data-act="trace" data-kind="wire" data-id="' + esc(w.id) + '">Trace</button></td></tr>').join('') + '</table>';
    if (isEdit()) h += '<div class="sub">Endpoints and wire mappings are changed only through "Edit installed wiring". Moving objects on the map never changes them.</div>';
    return h;
  }
  function detWire(id) {
    const idx = M.buildIndex(S.p), w = idx.wires[id], l = idx.wireLink[id];
    return '<h3>Fixed wire</h3>' + fld('Link', lnk('link', l.id, l.name)) + fld('Wire', w.number) +
      fld('A termination', w.aPortId ? lnk('port', w.aPortId, M.portName(S.p, w.aPortId, idx)) : '(unmapped)') +
      fld('B termination', w.bPortId ? lnk('port', w.bPortId, M.portName(S.p, w.bPortId, idx)) : '(unmapped)') +
      fld('Status', esc(w.status)) + '<div class="btn-row">' + btn('trace', 'Trace connection', 'data-kind="wire" data-id="' + esc(id) + '"', 'primary') + '</div>';
  }

  /* ---- trace pane ---- */
  function startTrace(kind, id) {
    S.trace = T.traceTarget(S.p, { kind: kind, id: id });
    if (!S.trace.traces.length) { S.trace = null; toast('Nothing to trace: no mapped terminations', true); return; }
    showTab('trace'); openRight(); renderAll(); showTab('trace');
  }
  function clearTrace() { S.trace = null; renderAll(); showTab('details'); }
  function renderTracePane() {
    const pane = $('tracePane');
    if (!S.trace) { pane.innerHTML = '<h3>No trace</h3><div class="sub">Select a port, cable, fixed link or wire and press "Trace connection". Only documented connections are followed.</div>'; return; }
    const idx = M.buildIndex(S.p);
    const t = S.trace.target;
    const title = t.kind === 'port' ? M.portName(S.p, t.id, idx) : t.kind === 'cable' ? idx.cables[t.id].name : t.kind === 'link' ? idx.links[t.id].name + ' (all wires)' : M.wireName(idx.wireLink[t.id], idx.wires[t.id]);
    let h = '<h3>Trace: ' + esc(title) + '</h3><div class="btn-row">' + btn('clearTrace', 'Clear trace', '', 'primary') + btn('fitTrace', 'Fit to path') + '</div>';
    const many = S.trace.traces.length > 1;
    S.trace.traces.forEach((tr, i) => {
      const lines = T.describe(S.p, tr);
      let body = lines.map((ln) => {
        let extra = '';
        if (ln.type === 'port' && ln.maps && ln.maps.length && ln.maps.indexOf(S.mapId) < 0) {
          extra = ' ' + ln.maps.map((m) => '<a class="lnk" data-act="goto" data-kind="object" data-id="' + esc(ln.objectId) + '" data-map="' + esc(m) + '">open ' + esc(idx.maps[m].name) + '</a>').join(' ');
        } else if (ln.type === 'port' && ln.maps && !ln.maps.length) extra = ' <span class="sev-warning">(not on a map)</span>';
        if (ln.type === 'wire' && ln.maps && ln.maps.indexOf(S.mapId) < 0 && ln.maps.length) extra = ' ' + ln.maps.map((m) => '<a class="lnk" data-act="goto" data-kind="link" data-id="' + esc(ln.linkId) + '" data-map="' + esc(m) + '">open ' + esc(idx.maps[m].name) + '</a>').join(' ');
        const target = ln.type === 'port' ? 'port' : ln.type === 'patch' ? 'cable' : ln.type === 'wire' ? 'wire' : null;
        const text = target ? '<a class="lnk" data-act="goto" data-kind="' + target + '" data-id="' + esc(ln.id) + '">' + esc(ln.text) + '</a>' : esc(ln.text);
        return '<div class="trace-line ' + ln.type + '">' + (ln.type === 'port' ? '' : '<span class="pill ' + (ln.type === 'wire' ? 'fx' : '') + '">' + (ln.type === 'patch' ? 'patch' : ln.type === 'wire' ? 'fixed' : 'panel') + '</span>') + '<span>' + text + extra + '</span></div>';
      }).join('');
      body += tr.ends.map((e) => '<div class="trace-end ' + (e.code === 'endpoint' ? '' : 'open') + '">' + esc(e.text) + '</div>').join('');
      if (many) {
        const first = lines[0], last = lines[lines.length - 1];
        h += '<details class="trace-group"><summary>' + esc(first.text) + ' ... ' + esc(last.text) + ' (' + lines.filter((x) => x.type === 'port').length + ' ports)</summary>' + body + '</details>';
      } else h += body;
    });
    pane.innerHTML = h;
  }
  function fitTrace() {
    if (!S.trace) return;
    const mid = curMap().id, rects = [], idx = M.buildIndex(S.p);
    Object.keys(S.trace.highlight.objects).forEach((id) => { const q = M.placementOf(S.p, mid, id); if (q) rects.push(q); });
    void idx;
    if (!rects.length) { toast('Nothing from this trace is drawn on this map - use the "open map" links', true); return; }
    const x0 = Math.min.apply(null, rects.map((r) => r.x)), y0 = Math.min.apply(null, rects.map((r) => r.y));
    const x1 = Math.max.apply(null, rects.map((r) => r.x + r.w)), y1 = Math.max.apply(null, rects.map((r) => r.y + r.h));
    focusRect({ x: x0 - 20, y: y0 - 20, w: x1 - x0 + 40, h: y1 - y0 + 40 });
  }

  /* ---------------------------------------------------------------- dialogs */
  function openDialog(spec) {
    return new Promise((resolve) => {
      const dlg = $('dlg');
      const ctx = {
        draw: function () {
          const r = spec.render();
          dlg.innerHTML = '<div class="dh">' + esc(spec.title) + '</div><div class="db">' + r.body + '</div><div class="df">' +
            r.buttons.map((b) => '<button data-btn="' + b.key + '" class="' + (b.cls || '') + '"' + (b.disabled ? ' disabled' : '') + '>' + esc(b.label) + '</button>').join('') + '</div>';
        },
        close: function (v) { if (dlg.open) dlg.close(); resolve(v); },
        root: dlg
      };
      dlg.onclick = (e) => {
        const b = e.target.closest('[data-btn]');
        if (b) spec.onButton(b.dataset.btn, ctx);
        else if (spec.onClick) spec.onClick(e, ctx);
      };
      dlg.onchange = (e) => { if (spec.onChange) spec.onChange(e, ctx); };
      dlg.oncancel = () => resolve(null);
      ctx.draw();
      dlg.showModal();
      if (spec.after) spec.after(ctx);
    });
  }
  function confirmDlg(title, html, okLabel, danger) {
    return openDialog({
      title: title, render: () => ({ body: html, buttons: [{ key: 'no', label: 'Cancel' }, { key: 'yes', label: okLabel || 'OK', cls: danger ? 'danger solid' : 'primary' }] }),
      onButton: (k, c) => c.close(k === 'yes')
    }).then((v) => !!v);
  }
  function formDlg(title, fields, okLabel, intro, validate) {
    function body() {
      return (intro || '') + fields.map((f) => {
        let c;
        if (f.type === 'select') c = '<select name="' + f.k + '">' + opts(f.opts, f.v) + '</select>';
        else if (f.type === 'check') c = '<input type="checkbox" name="' + f.k + '"' + (f.v ? ' checked' : '') + '>';
        else if (f.type === 'area') c = '<textarea name="' + f.k + '" rows="3" style="width:100%">' + esc(f.v) + '</textarea>';
        else c = '<input name="' + f.k + '" type="' + (f.type || 'text') + '" value="' + esc(f.v == null ? '' : f.v) + '"' + (f.min != null ? ' min="' + f.min + '"' : '') + (f.max != null ? ' max="' + f.max + '"' : '') + ' style="width:100%">';
        return fld(esc(f.label), c + (f.hint ? '<div class="sub">' + esc(f.hint) + '</div>' : ''));
      }).join('');
    }
    return openDialog({
      title: title, render: () => ({ body: body(), buttons: [{ key: 'no', label: 'Cancel' }, { key: 'ok', label: okLabel || 'OK', cls: 'primary' }] }),
      onButton: (k, c) => {
        if (k !== 'ok') { c.close(null); return; }
        const out = {};
        fields.forEach((f) => {
          const el = c.root.querySelector('[name="' + f.k + '"]');
          out[f.k] = f.type === 'check' ? el.checked : f.type === 'number' ? parseInt(el.value, 10) : el.value;
        });
        const err = validate && validate(out);
        if (err) {
          let box = c.root.querySelector('.form-err');
          if (!box) { box = document.createElement('div'); box.className = 'msg-box err-text form-err'; c.root.querySelector('.db').prepend(box); }
          box.textContent = err; return;
        }
        c.close(out);
      }
    });
  }

  /* ---------------------------------------------------------------- actions: create / delete */
  function viewCentre() {
    const s = stageSize(), v = vpState();
    return { x: snap((s.w / 2 - v.x) / v.zoom - 80), y: snap((s.h / 2 - v.y) / v.zoom - 40) };
  }
  function defaultContainer(type) {
    if (!S.sel) return '';
    if (S.sel.kind === 'group') return S.sel.id;
    if (S.sel.kind === 'object') {
      const o = S.p.objects.find((x) => x.id === S.sel.id);
      if (o && o.type === 'rack' && type !== 'rack') return o.id;
      return o ? (o.containerId && (type !== 'rack' || M.findContainer(S.p, o.containerId).kind === 'group') ? o.containerId : '') : '';
    }
    return '';
  }
  async function createItem(type) {
    const isGroup = type === 'group';
    const fields = [{ k: 'name', label: 'Name', v: '' }];
    if (type === 'switch' || type === 'patchpanel') fields.push({ k: 'portCount', label: 'Ports', type: 'number', v: 24, min: 1, max: 96, hint: 'Any number from 1 to 96 (for example 8, 12, 15, 16, 24, 48).' });
    if (type === 'router') {
      fields.push({ k: 'wanPorts', label: 'WAN ports', type: 'number', v: 1, min: 0, max: 96 });
      fields.push({ k: 'lanPorts', label: 'LAN ports', type: 'number', v: 4, min: 0, max: 96 });
      fields.push({ k: 'ipAddress', label: 'IP address', v: '', hint: 'Optional IPv4 address, e.g. 192.168.1.1 (no /prefix; the subnet is assumed to be the /24). Each port can also have its own IP later.' });
    }
    if (type === 'internet') {
      fields[0].v = 'INTERNET'; fields[0].hint = 'The ISP / upstream network. Cable its ports to your router WAN ports.';
      fields.push({ k: 'portCount', label: 'ISP ports', type: 'number', v: 1, min: 1, max: 12 });
      fields.push({ k: 'ipAddress', label: 'Public IP / circuit', v: '' });
    }
    if (type === 'switch') fields.push({ k: 'ipAddress', label: 'Management IP', v: '', hint: 'Optional: the web interface address of a managed switch (IPv4, e.g. 192.168.1.2).' });
    if (type === 'generic') fields.push({ k: 'ipAddress', label: 'IP address', v: '', hint: 'Optional IPv4 address for a single-port device; give multi-port devices per-port addresses afterwards.' });
    if (type === 'socket') fields.push({ k: 'portCount', label: 'Ports', type: 'number', v: 2, min: 1, max: 12 });
    if (type === 'generic') {
      fields.unshift({ k: 'deviceKind', label: 'Device type', type: 'select', opts: M.DEVICE_KINDS.map((k) => [k[0], k[1]]), v: 'other' });
      fields.push({ k: 'portCount', label: 'Ports', type: 'number', v: 1, min: 0, max: 96, hint: 'Network ports of this device (0 for none).' });
    }
    if (type === 'rack') fields.push({ k: 'rackHeight', label: 'Height (U)', type: 'number', v: 42, min: 1, max: 60 });
    if (type === 'patchpanel') fields.push({ k: 'sectionSize', label: 'Ports per section', type: 'number', v: '', min: 1, max: 96, hint: 'Leave empty for automatic (24 -> 3 x 8, 12 -> 2 x 6, 16 -> 2 x 8). Must divide the port count evenly.' });
    if (type === 'switch') fields.push({ k: 'uplinkPorts', label: 'Uplink ports', type: 'number', v: 0, min: 0, max: 16, hint: 'Extra ports next to the main ports (1, 2, 4...).' });
    if (type === 'switch') fields.push({ k: 'sectionSize', label: 'Ports per section', type: 'number', v: '', min: 1, max: 96, hint: 'Optional, e.g. 8 for 3 x 8 on a 24-port switch. Leave empty for plain rows. Must divide the port count evenly.' });
    if (type === 'switch') fields.push({ k: 'sectionRows', label: 'Rows per section', type: 'number', v: '', min: 1, max: 8, hint: 'Optional: 2 makes 8-port sections 2 x 4. Needs ports per section.' });
    if (type === 'switch') fields.push({ k: 'portIsolation', label: 'Port isolation', type: 'check', v: false, hint: 'Access ports can only talk to uplinks, not to each other.' });
    if (type === 'patchpanel' || type === 'socket') fields.push({ k: 'straight', label: 'Front N <-> rear N', type: 'check', v: true, hint: 'Documents a straight-through internal mapping. Untick if this panel is not wired that way.' });
    const v = await formDlg('New ' + (isGroup ? 'group' : M.TYPE_LABELS[type]), fields, 'Create', '', (vals) => (vals.ipAddress && !M.isValidIp(vals.ipAddress) ? M.IP_ERROR : null));
    if (!v) return;
    const portCount = v.portCount != null ? parseInt(v.portCount, 10) : undefined;
    const spec = isGroup ? { name: v.name || undefined } : { type: type, name: v.name || undefined, portCount: portCount, rackHeight: v.rackHeight, straight: v.straight, wanPorts: v.wanPorts, lanPorts: v.lanPorts, deviceKind: v.deviceKind, sectionSize: (type === 'patchpanel' || type === 'switch') && v.sectionSize > 0 ? v.sectionSize : undefined, uplinkPorts: v.uplinkPorts > 0 ? v.uplinkPorts : undefined, sectionRows: v.sectionRows > 1 ? v.sectionRows : undefined, portIsolation: !!v.portIsolation, ipAddress: v.ipAddress };
    startPlace(isGroup ? 'group' : 'object', spec, type);
  }

  /* ---- placing a new item: it follows the cursor, a click drops it, Ctrl+click keeps going with incrementing names ---- */
  function ghostMarkup(pl) {
    const temp = M.createProject('ghost'), mid = temp.maps[0].id;
    try {
      const spec = Object.assign({}, pl.spec);
      if (pl.name) spec.name = pl.name;
      if (pl.kind === 'group') B.addGroupPlaced(temp, mid, spec, 0, 0); else B.addObjectPlaced(temp, mid, spec, 0, 0);
      const q = temp.placements[0], r = R.renderMap(temp, mid, { mode: 'view' });
      return { svg: r.content, w: q.w, h: q.h };
    } catch (e) { return { svg: '', w: 160, h: 60 }; }
  }
  function startPlace(kind, spec, type) {
    S.tool = null; clearPgroup();
    S.place = { kind: kind, spec: spec, type: type, name: spec.name || '', count: 0, pos: null, host: null };
    const g = ghostMarkup(S.place);
    S.place.w = g.w; S.place.h = g.h; $('ghostInner').innerHTML = g.svg;
    $('ghost').style.display = 'none'; // shown once the cursor is over the map
    renderAll(); closeRight(); closeLeft();
  }
  function cancelPlace() {
    if (!S.place) return;
    S.place = null; $('ghostInner').innerHTML = ''; $('ghost').style.display = 'none';
    renderAll();
  }
  function moveGhost(e) {
    const pl = S.place; if (!pl) return;
    const pt = toMap(e.clientX, e.clientY);
    pl.pos = { x: snap(pt.x - pl.w / 2), y: snap(pt.y - pl.h / 2) };
    $('ghostInner').setAttribute('transform', 'translate(' + pl.pos.x + ' ' + pl.pos.y + ')');
    $('ghost').style.display = '';
    const host = B.containerAt(S.p, curMap().id, pl.pos.x + pl.w / 2, pl.pos.y + pl.h / 2, pl.kind, pl.type);
    const hid = host ? host.refId : null;
    if (hid !== pl.host) { pl.host = hid; renderCanvas(); }
  }
  function placeHere(e) {
    const pl = S.place; if (!pl) return;
    const pt = toMap(e.clientX, e.clientY);
    const x = snap(pt.x - pl.w / 2), y = snap(pt.y - pl.h / 2), keep = e.ctrlKey || e.metaKey;
    const spec = Object.assign({}, pl.spec); if (pl.name) spec.name = pl.name; else delete spec.name;
    const r = commit('Create ' + pl.type, (p) => B.placeNewAt(p, curMap().id, pl.kind, spec, x, y).id);
    if (!r || r === true) { cancelPlace(); return; }
    pl.count++;
    if (keep) { // next copy: same settings, name counts up
      if (pl.name) pl.name = B.nextName(pl.name);
      else { const it = M.findContainer(S.p, r); pl.name = it ? B.nextName(it.item.name) : ''; }
      const g = ghostMarkup(pl); pl.w = g.w; pl.h = g.h; $('ghostInner').innerHTML = g.svg;
      pl.host = null; moveGhost(e);
      toast('Placed ' + M.findContainer(S.p, r).item.name + ' - Ctrl+click to place more, Esc to stop');
    } else {
      S.place = null; $('ghostInner').innerHTML = ''; $('ghost').style.display = 'none';
      S.sel = { kind: pl.kind, id: r }; renderAll(); openRight();
    }
  }

  async function deleteSelection() {
    const sel = S.sel; if (!sel) return;
    if (sel.kind === 'cable') {
      const c = S.p.patchCables.find((x) => x.id === sel.id);
      if (await confirmDlg('Remove patch cable', 'Remove <b>' + esc(c.name) + '</b>? Both ports become free.', 'Remove', true)) commit('Remove cable', (p) => M.deletePatchCable(p, sel.id));
      return;
    }
    if (sel.kind === 'link') {
      const l = S.p.fixedLinks.find((x) => x.id === sel.id);
      if (await confirmDlg('Delete fixed link', 'Delete installed link <b>' + esc(l.name) + '</b> and all <b>' + l.wires.length + '</b> wire records? The panels stay.', 'Delete link', true)) commit('Delete fixed link', (p) => M.deleteFixedLink(p, sel.id));
      return;
    }
    if (sel.kind !== 'group' && sel.kind !== 'object') return;
    const c = M.findContainer(S.p, sel.id), kids = M.containerChildren(S.p, sel.id);
    let mode = 'delete';
    if (kids.length) {
      const choice = await openDialog({
        title: 'Delete ' + c.item.name, render: () => ({
          body: '<p><b>' + esc(c.item.name) + '</b> contains ' + kids.length + ' item(s).</p><p>Keep the contents and remove only the container, or delete the contents as well?</p>',
          buttons: [{ key: 'no', label: 'Cancel' }, { key: 'keep', label: 'Keep contents', cls: 'primary' }, { key: 'delete', label: 'Delete contents too...', cls: 'danger' }]
        }), onButton: (k, cx) => cx.close(k)
      });
      if (!choice || choice === 'no') return;
      mode = choice;
    }
    const im = M.deleteImpact(S.p, sel.kind, sel.id, mode);
    const lines = ['This removes ' + im.groups + ' group(s) and ' + im.objects + ' equipment object(s).'];
    lines.push(im.cables + ' patch cable(s) and ' + im.links + ' fixed link(s) (with all their wires) that touch the removed equipment are deleted too.');
    if (!(await confirmDlg('Confirm deletion', '<p>' + lines.map(esc).join('</p><p>') + '</p><p class="sub">You can undo this.</p>', 'Delete', true))) return;
    S.sel = null;
    commit('Delete ' + c.item.name, (p) => M.deleteContainerOrObject(p, sel.kind, sel.id, mode));
  }

  async function newLink(prefA) {
    const panels = S.p.objects.filter((o) => M.isTermination(o));
    if (panels.length < 2) { toast('Create at least two patch panels (or a panel and a wall socket) first', true); return; }
    const po = panels.map((o) => [o.id, o.name + (o.type === 'socket' ? ' (wall socket)' : '')]);
    const a = prefA || (S.sel && S.sel.kind === 'object' && panels.some((x) => x.id === S.sel.id) ? S.sel.id : panels[0].id);
    const v = await formDlg('New fixed link', [
      { k: 'a', label: 'Panel A', type: 'select', opts: po, v: a },
      { k: 'b', label: 'Panel B', type: 'select', opts: po, v: (panels.find((x) => x.id !== a) || panels[1]).id },
      { k: 'n', label: 'Wires', type: 'number', v: 24, min: 1, max: 288 },
      { k: 'mapping', label: 'Mapping', type: 'select', opts: [['sequential', 'Sequential: next free rear port to next free rear port'], ['none', 'Leave unmapped (map each wire later)']], v: 'sequential', hint: 'Mappings are never assumed. Choose sequential only if the installation really is 1:1.' },
      { k: 'cableType', label: 'Cable type', v: 'Cat6' }, { k: 'length', label: 'Length', v: '' }, { k: 'route', label: 'Route', v: '' }
    ], 'Create link');
    if (!v) return;
    const r = commit('Create fixed link', (p) => M.addFixedLink(p, { aObjectId: v.a, bObjectId: v.b, wireCount: v.n, mapping: v.mapping, cableType: v.cableType, length: v.length, route: v.route }).id);
    if (r && r !== true) select({ kind: 'link', id: r });
  }

  /* explicit "Edit installed wiring" workflow with review step */
  async function editWiring(linkId) {
    const link = S.p.fixedLinks.find((l) => l.id === linkId);
    const draft = { aObjectId: link.aObjectId, bObjectId: link.bObjectId, wires: M.clone(link.wires) };
    let step = 1;
    const panels = S.p.objects.filter((o) => M.isTermination(o)).map((o) => [o.id, o.name + (o.type === 'socket' ? ' (wall socket)' : '')]);
    const portOptions = (objId, sel) => {
      const idx = M.buildIndex(S.p), o = idx.objects[objId];
      const own = {}; link.wires.forEach((w) => { own[w.id] = 1; });
      const draftUsed = {}; draft.wires.forEach((w) => { [w.aPortId, w.bPortId].forEach((x) => { if (x && x !== sel) draftUsed[x] = 1; }); });
      return [['', '(unmapped)']].concat(M.rearPorts(o).map((pt) => {
        const u = idx.portUse[pt.id], busy = (u && !(u.kind === 'wire' && own[u.id])) || draftUsed[pt.id];
        return [pt.id, 'rear ' + pt.label + (busy ? ' (in use)' : '')];
      }));
    };
    function problems() { return M.validateLinkDraft(S.p, linkId, draft); }
    const res = await openDialog({
      title: 'Edit installed wiring: ' + link.name,
      render: () => {
        if (step === 2) {
          const diff = M.diffLinkDraft(S.p, linkId, draft), errs = problems();
          return {
            body: '<p>Review the changes to installed cabling. They are recorded as one undoable step.</p>' +
              (errs.length ? '<div class="msg-box err-text"><b>Cannot apply:</b><br>' + errs.map(esc).join('<br>') + '</div>' : '') +
              (diff.length ? diff.map((d) => '<div class="diff-line">' + esc(d) + '</div>').join('') : '<p>No changes.</p>'),
            buttons: [{ key: 'back', label: 'Back' }, { key: 'cancel', label: 'Cancel' }, { key: 'apply', label: 'Apply ' + diff.length + ' change(s)', cls: 'danger solid', disabled: errs.length > 0 || !diff.length }]
          };
        }
        const rows = draft.wires.map((w, i) => '<tr><td><input type="number" data-w="' + i + '" data-k="number" value="' + w.number + '" style="width:4em"></td>' +
          '<td><select data-w="' + i + '" data-k="aPortId">' + opts(portOptions(draft.aObjectId, w.aPortId), w.aPortId || '') + '</select></td>' +
          '<td><select data-w="' + i + '" data-k="bPortId">' + opts(portOptions(draft.bObjectId, w.bPortId), w.bPortId || '') + '</select></td>' +
          '<td><select data-w="' + i + '" data-k="status">' + opts(M.WIRE_STATUS.map((s) => [s, s]), w.status) + '</select></td>' +
          '<td><button data-del="' + i + '">Delete</button></td></tr>').join('');
        return {
          body: '<div class="msg-box">Installed cabling. Changes here describe real-world re-wiring and are shown for review before they are applied.</div>' +
            fld('Panel A', '<select data-ep="aObjectId">' + opts(panels, draft.aObjectId) + '</select>') + fld('Panel B', '<select data-ep="bObjectId">' + opts(panels, draft.bObjectId) + '</select>') +
            '<div class="btn-row"><button data-addwire="1">+ Add wire</button><button data-seq="1">Map unmapped wires sequentially</button></div>' +
            '<table class="t"><tr><th>#</th><th>A termination</th><th>B termination</th><th>Status</th><th></th></tr>' + rows + '</table>',
          buttons: [{ key: 'cancel', label: 'Cancel' }, { key: 'review', label: 'Review changes...', cls: 'primary' }]
        };
      },
      onChange: (e, c) => {
        const t = e.target;
        if (t.dataset.ep) {
          draft[t.dataset.ep] = t.value;
          draft.wires.forEach((w) => { w.aPortId = null; w.bPortId = null; });
          toast('Endpoints changed: all wire terminations were cleared and must be re-mapped');
        } else if (t.dataset.w !== undefined) {
          const w = draft.wires[+t.dataset.w], k = t.dataset.k;
          w[k] = k === 'number' ? parseInt(t.value, 10) || w.number : (k === 'status' ? t.value : (t.value || null));
        }
        c.draw();
      },
      onClick: (e, c) => {
        const t = e.target;
        if (t.dataset.del !== undefined) { draft.wires.splice(+t.dataset.del, 1); c.draw(); }
        else if (t.dataset.addwire) { draft.wires.push({ number: draft.wires.reduce((m, w) => Math.max(m, w.number), 0) + 1, aPortId: null, bPortId: null, status: 'unused' }); c.draw(); }
        else if (t.dataset.seq) {
          const idx = M.buildIndex(S.p), a = idx.objects[draft.aObjectId], b = idx.objects[draft.bObjectId];
          const own = {}; link.wires.forEach((w) => { own[w.id] = 1; });
          const used = {}; draft.wires.forEach((w) => { if (w.aPortId) used[w.aPortId] = 1; if (w.bPortId) used[w.bPortId] = 1; });
          const free = (o) => M.rearPorts(o).filter((pt) => { const u = idx.portUse[pt.id]; return !used[pt.id] && !(u && !(u.kind === 'wire' && own[u.id])); });
          const fa = free(a), fb = free(b);
          draft.wires.filter((w) => !w.aPortId && !w.bPortId).forEach((w) => {
            const x = fa.shift(), y = fb.shift();
            if (x && y) { w.aPortId = x.id; w.bPortId = y.id; w.status = 'connected'; }
          });
          c.draw();
        }
      },
      onButton: (k, c) => {
        if (k === 'review') { step = 2; c.draw(); } else if (k === 'back') { step = 1; c.draw(); }
        else if (k === 'apply') c.close('apply'); else c.close(null);
      }
    });
    if (res === 'apply') commit('Edit installed wiring ' + link.name, (p) => M.applyLinkEdit(p, linkId, draft));
  }

  async function mapPort(portId) {
    const idx = M.buildIndex(S.p), pt = idx.ports[portId], o = idx.portObj[portId];
    const other = o.ports.filter((x) => x.side !== pt.side && !idx.mapByPort[x.id]);
    if (!other.length) { toast('No unmapped ports on the other side', true); return; }
    const v = await formDlg('Internal mapping', [{ k: 'to', label: 'Maps to', type: 'select', opts: other.map((x) => [x.id, x.side + ' ' + x.label]), v: other[0].id }], 'Add mapping', '<p class="sub">Documents a physical path through ' + esc(o.name) + '.</p>');
    if (v) commit('Add internal mapping', (p) => M.addInternalMapping(p, o.id, portId, v.to));
  }

  async function mapForm(existing) {
    const v = await formDlg(existing ? 'Edit map' : 'New map', [{ k: 'name', label: 'Name', v: existing ? existing.name : 'Map ' + (S.p.maps.length + 1) }, { k: 'location', label: 'Location', v: existing ? existing.location : '' }], 'Save');
    if (!v || !v.name) return;
    if (existing) {
      const kill = await openDialog({ title: 'Map: ' + existing.name, render: () => ({ body: '<p>Save the new name, or delete this map? Deleting a map removes only its layout; equipment and connections stay in the project.</p>', buttons: [{ key: 'cancel', label: 'Cancel' }, { key: 'del', label: 'Delete map', cls: 'danger' }, { key: 'save', label: 'Save', cls: 'primary' }] }), onButton: (k, c) => c.close(k) });
      if (kill === 'del') {
        if (S.p.maps.length < 2) { toast('A project needs at least one map', true); return; }
        commit('Delete map', (p) => { p.maps = p.maps.filter((m) => m.id !== existing.id); p.placements = p.placements.filter((q) => q.mapId !== existing.id); });
      } else if (kill === 'save') commit('Edit map', (p) => { const m = p.maps.find((x) => x.id === existing.id); m.name = v.name; m.location = v.location; });
    } else {
      const id = M.uid('map');
      commit('Add map', (p) => { p.maps.push({ id: id, name: v.name, location: v.location, viewport: { x: 0, y: 0, zoom: 1 } }); });
      switchMap(id);
    }
  }

  async function addExisting() {
    const mid = curMap().id;
    const items = [];
    S.p.groups.forEach((g) => { if (!M.placementOf(S.p, mid, g.id)) items.push(['group:' + g.id, 'Group: ' + g.name]); });
    S.p.objects.forEach((o) => { if (!M.placementOf(S.p, mid, o.id)) items.push(['object:' + o.id, M.typeLabel(o) + ': ' + o.name]); });
    if (!items.length) { toast('Everything is already on this map'); return; }
    const v = await formDlg('Add existing item to this map', [{ k: 'it', label: 'Item', type: 'select', opts: items, v: items[0][0] }, { k: 'contents', label: 'With contents', type: 'check', v: true, hint: 'The same equipment record is shown again - no duplicate is created.' }], 'Add');
    if (!v) return;
    const a = v.it.split(':'), pos = viewCentre();
    commit('Add to map', (p) => { B.placeItem(p, mid, a[0], a[1], pos.x, pos.y, v.contents); });
  }

  /* ---------------------------------------------------------------- field editing */
  function onFieldChange(el) {
    let f = el.dataset.f;
    const t = el.dataset.t, val = el.type === 'checkbox' ? el.checked : el.value;
    if (f === 'pgPreset') {
      if (val === 'custom') { S.customColorFor = 'pg:' + t; renderRight(); return; }
      S.customColorFor = null; f = 'pgColor';
    } else if (f === 'pgColor') S.customColorFor = null;
    if (f === 'netPreset') {
      if (val === 'custom') { S.customColorFor = 'net:' + t; renderRight(); return; }
      S.customColorFor = null; f = 'pnet';
    } else if (f === 'pnet') S.customColorFor = null;
    if (f === 'colorPreset') {
      if (val === 'custom') { S.customColorFor = S.sel && S.sel.id; renderRight(); return; }
      S.customColorFor = null; f = 'color';
    } else if (f === 'color') S.customColorFor = null;
    const sel = S.sel; if (!sel && !t) return;
    const netPort = f === 'pnet' && val ? (t || (sel && sel.id)) : null;
    const beforeNet = netIssues().map((i) => i.message);
    const ok = commit('Edit ' + f, (p) => {
      const idx = M.buildIndex(p);
      if (f === 'pnet') { const pt = idx.ports[t || sel.id]; if (pt) { if (val) pt.networkColor = val; else delete pt.networkColor; } return; }
      if (f === 'pdesc') { const pt = idx.ports[t || sel.id]; if (pt) { if (val.trim()) pt.description = val.trim(); else delete pt.description; } return; }
      if (f === 'plabel' || f === 'ptype' || f === 'pspeed' || f === 'pmedia' || f === 'pip') {
        const pt = idx.ports[t || sel.id]; if (!pt) return;
        if (f === 'pip') { M.setPortIp(p, pt.id, val); return; }
        if (f === 'plabel') { pt.label = val; B.fitMinimum(p, idx.portObj[pt.id].id); } else pt[{ ptype: 'portType', pspeed: 'speed', pmedia: 'media', pip: 'ip' }[f]] = val.trim();
        return;
      }
      if (f === 'wstatus') { M.updateWireStatus(p, t, val); return; }
      if (sel.kind === 'group' || sel.kind === 'object') {
        const c = M.findContainer(p, sel.id);
        if (f === 'deviceKind') { M.setDeviceKind(p, sel.id, val); B.refitObject(p, sel.id); }
        else if (f === 'sectionSize') { M.setSectionSize(p, sel.id, parseInt(val, 10)); B.refitObject(p, sel.id); }
        else if (f === 'sectionRows') { M.setSwitchLayout(p, sel.id, { sectionRows: parseInt(val, 10) }); B.refitObject(p, sel.id); }
        else if (f === 'portOrder' || f === 'align' || f === 'uplinkSide') M.setSwitchLayout(p, sel.id, { [f]: val });
        else if (f === 'uplinkRows') { M.setSwitchLayout(p, sel.id, { uplinkRows: parseInt(val, 10) }); B.refitObject(p, sel.id); }
        else if (f === 'portIsolation') M.setSwitchLayout(p, sel.id, { portIsolation: !!val });
        else if (f === 'fullWidth') { M.setFullWidth(p, sel.id, !!val); B.applyFullWidthFor(p, sel.id); }
        else if (f === 'container') {
          M.setContainer(p, sel.kind, sel.id, val || null);
          M.mapsFor(p, sel.kind, sel.id).forEach((m) => { if (val) M.growToFit(p, m, val); });
        } else if (f === 'rackHeight') c.item.rackHeight = parseInt(val, 10) || null;
        else {
          if (f === 'ipAddress') M.setDeviceIp(p, sel.id, val); else c.item[f] = val;
        }
      } else if (sel.kind === 'cable') M.updatePatchCable(p, sel.id, { [f]: val });
      else if (sel.kind === 'pgroup') {
        const fg = M.findPortGroup(p, sel.id), side = fg && groupSide(fg.obj, fg.group);
        if (f === 'pgName') M.updatePortGroup(p, sel.id, { name: val });
        else if (f === 'pgColor') M.updatePortGroup(p, sel.id, { color: val });
        else if (f === 'pgPorts') M.updatePortGroup(p, sel.id, { portsText: val, side: side || undefined });
      } else if (sel.kind === 'link') M.updateLinkMeta(p, sel.id, { [f]: val });
    });
    if (ok && netPort) offerMatchNetworkColor(netPort);
    if (ok && (f === 'pip' || f === 'ipAddress')) { const fresh = netIssues().filter((i) => beforeNet.indexOf(i.message) < 0); if (fresh.length) toast('Network warning: ' + fresh[0].message, true); }
  }

  /* after a router port gets a network colour: offer to recolour the cables that already extend from it */
  function offerMatchNetworkColor(portId) {
    const pt = S.p.objects.flatMap((o) => o.ports).find((x) => x.id === portId);
    if (!pt || !pt.networkColor) return;
    const col = pt.networkColor, ids = NM.topology.networkCables(S.p, portId);
    const cables = S.p.patchCables.filter((c) => ids.indexOf(c.id) >= 0), diff = cables.filter((c) => c.color.toLowerCase() !== col.toLowerCase());
    if (!diff.length) return;
    confirmDlg('Match colours on downstream cables?', '<p><b>' + diff.length + '</b> of the <b>' + cables.length + '</b> patch cable(s) extending from this router port have a different colour.</p><p>Change them to <span class="swatch" style="background:' + esc(col) + '"></span> to match the network colour? (Cables you draw from now on use it automatically.)</p>', 'Match colours').then((yes) => {
      if (yes) commit('Match network cable colours', (p) => { p.patchCables.forEach((c) => { if (diff.some((d) => d.id === c.id)) c.color = col; }); });
    });
  }

  /* ---------------------------------------------------------------- file menu */
  function exportJson() {
    saveNow();
    X.download(slug(S.p.name) + '-' + new Date().toISOString().slice(0, 10) + '.json', M.exportProject(S.p), 'application/json');
    S.lastExport = time(new Date()); try { localStorage.setItem(KEY_EXPORT, S.lastExport); } catch (_) { /* ignore */ }
    markDirty(false);
    setStatus();
  }
  async function exportImages(kind) {
    const scopeOpts = [['__cur', 'Current map']].concat(S.p.maps.map((m) => [m.id, m.name])).concat(S.p.maps.length > 1 ? [['__all', 'All maps']] : []);
    const v = await formDlg('Export ' + kind.toUpperCase(), [{ k: 'scope', label: 'Maps', type: 'select', opts: scopeOpts, v: '__cur' }], 'Export');
    if (!v) return;
    const ids = v.scope === '__all' ? S.p.maps.map((m) => m.id) : [v.scope === '__cur' ? S.mapId : v.scope];
    try {
      if (kind === 'pdf') {
        const bytes = await X.pdfForMaps(S.p, ids);
        X.download(slug(S.p.name) + '.pdf', bytes, 'application/pdf');
      } else {
        for (const id of ids) {
          const name = slug(S.p.name) + '-' + slug(S.p.maps.find((m) => m.id === id).name);
          const svg = R.svgDocument(S.p, id);
          if (kind === 'svg') X.download(name + '.svg', svg, 'image/svg+xml');
          else { const c = await X.svgToCanvas(svg, 2); X.download(name + '.png', await X.canvasToBlob(c, 'image/png'), 'image/png'); }
        }
      }
      toast('Exported ' + kind.toUpperCase());
    } catch (e) { toast('Export failed: ' + e.message, true); }
  }
  function showTable() {
    openDialog({
      title: 'Connection table', render: () => ({ body: X.tableHtml(S.p), buttons: [{ key: 'print', label: 'Print...' }, { key: 'close', label: 'Close', cls: 'primary' }] }),
      onButton: (k, c) => { if (k === 'print') window.print(); else c.close(null); }
    });
  }
  async function importFile(file) {
    let text;
    try { text = await file.text(); } catch (e) { toast('Could not read file', true); return; }
    let res;
    try { res = M.importProject(text); } catch (e) { toast('Import failed: ' + e.message, true); return; }
    const errs = res.issues.filter((i) => i.severity === 'error'), warns = res.issues.filter((i) => i.severity === 'warning');
    const sum = (p) => p.objects.length + ' objects, ' + p.patchCables.length + ' patch cables, ' + p.fixedLinks.length + ' fixed links, ' + p.maps.length + ' maps';
    const html = '<p>Replace the current project <b>' + esc(S.p.name) + '</b> (' + sum(S.p) + ') with <b>' + esc(res.project.name) + '</b> (' + sum(res.project) + ')?</p>' +
      (res.migratedFrom !== M.SCHEMA_VERSION ? '<p>File migrated from schema version ' + res.migratedFrom + ' to ' + M.SCHEMA_VERSION + '.</p>' : '') +
      (errs.length ? '<div class="msg-box err-text"><b>' + errs.length + ' validation error(s):</b><br>' + errs.slice(0, 12).map((i) => esc(i.message)).join('<br>') + (errs.length > 12 ? '<br>...' : '') + '</div>' : '') +
      (warns.length ? '<div class="msg-box">' + warns.length + ' warning(s).</div>' : '') +
      '<p class="sub">Export a JSON backup of the current project first if you may need it. Undo history is cleared by an import.</p>';
    if (!(await confirmDlg('Import project', html, errs.length ? 'Import with errors' : 'Replace project', !!errs.length))) return;
    loadProject(res.project);
    toast('Imported ' + res.project.name);
  }
  function loadProject(p) {
    const fixed = B.normalizeSizes(p);
    if (fixed) setTimeout(() => toast('Enlarged ' + fixed + ' item(s) that were too small to read', false), 100);
    S.rev++; markDirty(false); S.p = p; S.mapId = p.maps[0].id; S.sel = null; S.trace = null; S.tool = null; S.undo = []; S.redo = []; S.issues = []; S.showIssues = false;
    saveNow(); renderAll();
    if (p.placements.some((q) => q.mapId === S.mapId)) fitMap();
  }
  async function fileMenu() {
    const choice = await openDialog({
      title: 'Project: ' + S.p.name, render: () => ({
        body: '<div class="btn-row" style="flex-direction:column;align-items:stretch">' +
          [['rename', 'Rename project'], ['json', 'Export project as JSON (backup)'], ['import', 'Import JSON...'], ['svg', 'Export map as SVG'], ['png', 'Export map as PNG'], ['pdf', 'Export PDF (maps + connection table)'], ['table', 'Connection table...'], ['validate', 'Validate project'], ['demo', 'Load demo project...'], ['new', 'New empty project...'], ['help', 'Help']]
            .map((b) => '<button data-btn="' + b[0] + '">' + b[1] + '</button>').join('') + '</div><p class="sub">Browser autosave is a convenience only. Export a JSON file to back up your work.</p>',
        buttons: [{ key: 'x', label: 'Close' }]
      }), onButton: (k, c) => c.close(k)
    });
    if (!choice || choice === 'x') return;
    if (choice === 'rename') { const v = await formDlg('Rename project', [{ k: 'n', label: 'Name', v: S.p.name }], 'Save'); if (v && v.n) commit('Rename project', (p) => { p.name = v.n; }); }
    else if (choice === 'json') exportJson();
    else if (choice === 'import') $('fileInput').click();
    else if (choice === 'svg' || choice === 'png' || choice === 'pdf') exportImages(choice);
    else if (choice === 'table') showTable();
    else if (choice === 'validate') runValidate();
    else if (choice === 'demo') { if (await confirmDlg('Load demo project', 'Replace the current project with the demo? Export a backup first if you need the current one.', 'Load demo', true)) { loadProject(B.buildDemoProject()); } }
    else if (choice === 'new') { if (await confirmDlg('New project', 'Replace the current project with an empty one? Export a backup first if you need it.', 'Start empty', true)) loadProject(M.createProject('Untitled project')); }
    else if (choice === 'help') showHelp();
  }
  function runValidate() {
    S.issues = allIssues(); S.showIssues = true; renderLeft(); openLeft();
    const n = S.issues.filter((i) => i.severity !== 'info').length;
    toast(n ? n + ' problem(s) found' : 'No errors or warnings');
  }
  function showHelp() {
    openDialog({
      title: 'How NetMap works', render: () => ({
        body: '<p><b>View mode</b> is read-only: browse, search, inspect ports and trace connections. <b>Edit</b> unlocks editing; moving anything never changes cabling.</p>' +
          '<p><b>Fixed links</b> are installed cable runs between patch panels. Each has numbered wires with explicit mappings; change them only with "Edit installed wiring".</p>' +
          '<p><b>Patch cables</b> are removable leads between two ports. Press <b>W</b> (or use the "Patch cable tool") and click two ports; with a port selected, W draws a single cable from it and leaves the new cable selected so you can set its colour.</p>' +
          '<p><b>Trace</b> follows only documented connections: patch cables, fixed wires and internal panel mappings. Proximity, groups and shared switches imply nothing.</p>' +
          '<p>Autosave goes to this browser only. Use File -> Export JSON for real backups.</p>',
        buttons: [{ key: 'x', label: 'Close', cls: 'primary' }]
      }), onButton: (k, c) => c.close(null)
    });
  }

  /* ---------------------------------------------------------------- wiring up */
  function setMode(mode) {
    if (S.mode === mode) return;
    S.mode = mode; S.tool = null; S.drag = null; clearPgroup(); cancelPlace();
    if (mode === 'view') saveNow();
    renderAll();
    toast(mode === 'edit' ? 'Edit mode on' : 'View mode - saved, read-only');
  }

  function bindUi() {
    $('btnMode').onclick = () => setMode(isEdit() ? 'view' : 'edit');
    $('btnUndo').onclick = undo; $('btnRedo').onclick = redo;
    $('btnFile').onclick = fileMenu;
    $('btnAlerts').onclick = runValidate;
    $('btnGraph').onclick = () => setView(S.view === 'graph' ? 'map' : 'graph');
    $('graphView').addEventListener('change', (e) => {
      const k = e.target.dataset.g; if (!k) return;
      if (k === 'via') S.graph.via = e.target.checked; else S.graph[k] = e.target.value;
      renderGraph();
    });
    $('graphView').addEventListener('click', (e) => {
      const n = e.target.closest('[data-gnode]'), l = e.target.closest('[data-gedge]');
      if (n) { S.view = 'map'; renderAll(); goTo('object', n.dataset.gnode); }
      else if (l) {
        const g = NM.topology.buildGraph(S.p, { viaInternet: S.graph.via }), lk = g.links.find((x) => x.id === l.dataset.gedge);
        if (lk) { S.view = 'map'; renderAll(); startTrace('port', lk.paths[0].aPortId); goTo('port', lk.paths[0].aPortId); }
      }
    });
    $('btnMenu').onclick = openLeft; $('btnCloseLeft').onclick = closeLeft; $('btnCloseRight').onclick = closeRight;
    $('mapSelect').onchange = (e) => switchMap(e.target.value);
    $('searchBox').oninput = (e) => { S.query = e.target.value; renderLeft(); if (S.query) openLeft(); };
    $('searchBox').onkeydown = (e) => { if (e.key === 'Enter') { const r = M.search(S.p, S.query); if (r[0]) { goTo(r[0].kind, r[0].id); } } };
    $('tabDetails').onclick = () => showTab('details'); $('tabTrace').onclick = () => showTab('trace');
    $('zoomIn').onclick = () => zoomAt(1.25); $('zoomOut').onclick = () => zoomAt(0.8); $('zoomFit').onclick = fitMap;
    $('fileInput').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importFile(f); };
    $('toolbar').addEventListener('change', (e) => {
      const f = e.target.dataset.f;
      if (f === 'toolPreset') { if (e.target.value === 'custom') S.customColorFor = '__tool'; else { S.customColorFor = null; S.cableColor = e.target.value; } renderToolbar(); }
      else if (f === 'toolColor') { S.cableColor = e.target.value; S.customColorFor = null; renderToolbar(); }
    });
    $('toolbar').onclick = (e) => {
      const a = e.target.closest('button'); if (!a) return;
      if (a.dataset.add) createItem(a.dataset.add);
      else if (a.dataset.act === 'patchTool') setTool(S.tool && S.tool.type === 'patch' ? null : { type: 'patch', pending: null, cableType: 'Cat6' });
      else if (a.dataset.act === 'newLink') newLink();
      else if (a.dataset.act === 'addMapItems') addExisting();
    };
    document.addEventListener('change', (e) => { if (e.target.dataset && e.target.dataset.f && isEdit() && !e.target.closest('dialog') && !e.target.closest('#toolbar')) onFieldChange(e.target); });
    document.addEventListener('click', (e) => {
      const a = e.target.closest('[data-act]'); if (!a || a.closest('dialog')) return;
      const d = a.dataset;
      switch (d.act) {
        case 'select': select({ kind: d.kind, id: d.id }); break;
        case 'goto': goTo(d.kind, d.id, d.map, !!a.closest('#tracePane')); break;
        case 'trace': startTrace(d.kind, d.id); break;
        case 'clearTrace': clearTrace(); break;
        case 'fitTrace': fitTrace(); break;
        case 'addToMap': commit('Add to map', (p) => { const pos = viewCentre(); B.placeItem(p, curMap().id, d.kind, d.id, pos.x, pos.y, true); }); break;
        case 'removeFromMap': commit('Remove from map', (p) => { p.placements = p.placements.filter((q) => !(q.mapId === curMap().id && q.refId === d.id)); }); break;
        case 'deleteSel': deleteSelection(); break;
        case 'deleteCable': { S.sel = { kind: 'cable', id: d.id }; deleteSelection(); break; }
        case 'customColor': {
          S.customColorFor = d.owner;
          if (d.owner === '__tool') renderToolbar(); else renderRight();
          const pick = document.querySelector(d.owner === '__tool' ? '#toolbar input[type="color"]' : '#detailsPane input[type="color"]');
          if (pick) { try { pick.showPicker(); } catch (_) { pick.click(); } }
          break;
        }
        case 'recolorNet': {
          const pid = d.id, ids = NM.topology.networkCables(S.p, pid), col = S.p.objects.flatMap((o) => o.ports).find((x) => x.id === pid).networkColor;
          confirmDlg('Recolour network cables', '<p>Set <span class="swatch" style="background:' + esc(col) + '"></span> on <b>' + ids.length + '</b> patch cable(s) extending from this router port (through switches and panels, not through other routers)? Cables with a manually chosen colour are included.</p>', 'Recolour').then((ok) => {
            if (ok) commit('Recolour network cables', (p) => { p.patchCables.forEach((c) => { if (ids.indexOf(c.id) >= 0) c.color = col; }); });
          });
          break;
        }
        case 'addPGroup': {
          const id = S.sel.id, side = $('pgNewSide') ? $('pgNewSide').value : undefined;
          const spec = { name: $('pgNewName').value, portsText: $('pgNewPorts').value, side: side, color: $('pgNewColor').value };
          const g = commit('Add port group', (p) => M.addPortGroup(p, id, spec));
          if (g && g !== true) { S.sel = { kind: 'pgroup', id: g.id }; renderAll(); }
          break;
        }
        case 'deletePGroup': { const f = M.findPortGroup(S.p, d.id), oid = f && f.obj.id; commit('Delete port group', (p) => M.deletePortGroup(p, d.id)); if (oid) { S.sel = { kind: 'object', id: oid }; renderAll(); } break; }
        case 'linkFromGroup': {
          const f = M.findPortGroup(S.p, d.id), idx = M.buildIndex(S.p);
          const ids = f.group.portIds.filter((pid) => idx.ports[pid].side === 'rear' && !idx.portUse[pid]);
          if (!ids.length) { toast('No free rear ports in this group', true); break; }
          S.pgroup = { objId: f.obj.id, ids: ids, last: ids[ids.length - 1] }; S.hoverPort = null; S.preview = null;
          renderAll(); toast(ids.length + ' port(s) ready: hover another panel or socket and click to link'); break;
        }
        case 'applyUplinks': { const n = parseInt($('upInput').value, 10), id = S.sel.id; commit('Set uplink ports', (p) => { M.setUplinkPorts(p, id, n); B.refitObject(p, id); }); break; }
        case 'applyPortCount': { const n = parseInt($('pcInput').value, 10), id = S.sel.id; commit('Set port count', (p) => { M.setPortCount(p, id, n); B.refitObject(p, id); }); break; }
        case 'applyRouterPorts': { const id = S.sel.id, w = parseInt($('wanInput').value, 10), l = parseInt($('lanInput').value, 10); commit('Set router ports', (p) => M.setRouterPorts(p, id, w, l)); break; }
        case 'presetPorts': { const id = S.sel.id, n = parseInt(d.n, 10); commit('Set port count', (p) => { M.setPortCount(p, id, n); B.refitObject(p, id); }); break; }
        case 'automap': { const id = S.sel.id; commit('Map front to rear', (p) => { const n = M.autoMapPanel(p, id); toast(n + ' mapping(s) added'); }); break; }
        case 'mapPort': mapPort(d.id); break;
        case 'unmap': commit('Remove internal mapping', (p) => M.removeInternalMapping(p, d.id)); break;
        case 'startPatchFrom': startWire(d.id); break;
        case 'patchTool': break;
        case 'reconnect': S.tool = { type: 'reconnect', cableId: S.sel.id, end: d.end }; renderAll(); break;
        case 'editWiring': editWiring(S.sel.id); break;
        case 'newLink': newLink(); break;
        case 'newLinkFrom': newLink(S.sel.id); break;
        case 'newMap': mapForm(null); break;
        case 'editMap': e.stopPropagation(); mapForm(S.p.maps.find((m) => m.id === d.id)); break;
        case 'validate': runValidate(); break;
        case 'demo': loadProject(B.buildDemoProject()); break;
        case 'help': showHelp(); break;
        default: break;
      }
    });
    // hovering "Reconnect end A/B" circles the port that would move
    document.addEventListener('mouseover', (e) => {
      const b = e.target.closest && e.target.closest('button[data-act="reconnect"]');
      if (!b || S.sel?.kind !== 'cable') return;
      const c = S.p.patchCables.find((x) => x.id === S.sel.id);
      const pid = c && (b.dataset.end === 'a' ? c.aPortId : c.bPortId);
      if (pid && S.ring !== pid) { S.ring = pid; renderCanvas(); }
    });
    document.addEventListener('mouseout', (e) => {
      const b = e.target.closest && e.target.closest('button[data-act="reconnect"]');
      if (b && S.ring) { S.ring = null; renderCanvas(); }
    });
    document.addEventListener('keydown', (e) => {
      if ($('dlg').open) return;
      const typing = /INPUT|SELECT|TEXTAREA/.test((e.target.tagName || ''));
      if (e.key === 'Escape') { if (S.place) cancelPlace(); else if (S.pgroup) { clearPgroup(); renderAll(); } else if (S.tool) cancelTool(); else if (S.trace) clearTrace(); else if (S.sel) { S.sel = null; renderAll(); } }
      else if (isEdit() && !typing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if (isEdit() && !typing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
      else if (isEdit() && !typing && (e.key === 'Delete')) deleteSelection();
      else if (isEdit() && !typing && !e.ctrlKey && !e.metaKey && !e.altKey && S.pgroup && (e.key === 'g' || e.key === 'G')) { e.preventDefault(); nameSelectedPorts(); }
      else if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'w' || e.key === 'W')) { e.preventDefault(); startWire(); }
    });
    window.addEventListener('pagehide', () => { if (S.unsaved) saveNow(); });
    // never lose work silently: reloading or closing with changes that were not exported asks first (the browser shows its own wording)
    window.addEventListener('beforeunload', (e) => {
      if (S.unsaved) saveNow();
      if (S.fileDirty) { e.preventDefault(); e.returnValue = ''; return ''; }
      return undefined;
    });
    $('btnUpdate').onclick = () => { S.updateHidden = false; renderUpdate(); };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) checkVersion(); });
    setInterval(checkVersion, POLL_MS);
    window.addEventListener('resize', () => applyVp());
  }

  function init() {
    try { S.lastExport = localStorage.getItem(KEY_EXPORT); S.fileDirty = localStorage.getItem(KEY_DIRTY) === '1'; } catch (_) { S.lastExport = null; }
    S.p = loadSaved() || M.createProject('Untitled project');
    if (B.normalizeSizes(S.p)) saveNow();
    S.mapId = S.p.maps[0].id;
    loadCollapsed();
    bindUi(); bindCanvas();
    renderAll();
    if (S.p.placements.some((q) => q.mapId === S.mapId)) { const v = vpState(); if (v.zoom === 1 && v.x === 0 && v.y === 0) fitMap(); }
    S.savedAt = new Date(); setStatus(); renderUpdate();
    setTimeout(checkVersion, 3000);
    NM.app.ready = true;
  }
  /* ---- new-version detection: version.json is polled every minute; the page is never reloaded for the user ---- */
  function renderUpdate() {
    const cur = NM.version || 'dev', stale = !!S.newVersion;
    $('verInfo').textContent = 'v' + cur;
    $('btnUpdate').hidden = !stale;
    const bar = $('updateBar');
    bar.hidden = !stale || S.updateHidden;
    if (stale && !S.updateHidden) {
      bar.innerHTML = '<span class="msg"><b>A new version of NetMap is available</b> (this page runs v' + esc(cur) + ', latest v' + esc(S.newVersion) + '). ' +
        'Save your work first - ' + (S.fileDirty ? 'you have changes that were not exported - ' : '') + 'use <b>Export JSON</b> - then reload with <b>F5</b> or <b>Ctrl+R</b>. Nothing is reloaded automatically.</span>' +
        '<button data-upd="export" class="primary">Export JSON now</button><button data-upd="hide">Remind me later</button>';
    }
  }
  async function checkVersion() {
    if (!NM.version || location.protocol === 'file:') return null; // opened from disk (no server to ask) or without version info
    try {
      const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return null;
      const v = (await r.json()).version;
      if (v && v !== NM.version && v !== S.newVersion) {
        S.newVersion = v; S.updateHidden = false;
        toast('A new version of NetMap is available - export your project, then reload (F5)', true);
      }
      renderUpdate();
      return v;
    } catch (e) { return null; } // offline, file:// or no version.json
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-upd]');
    if (!b) return;
    if (b.dataset.upd === 'export') { exportJson(); renderUpdate(); } else { S.updateHidden = true; renderUpdate(); }
  });
  NM.app.api = {
    checkVersion: checkVersion, pollMs: POLL_MS,
    commit: commit, goTo: goTo, setMode: setMode, startTrace: startTrace, loadProject: loadProject, select: select,
    undo: undo, redo: redo, saveNow: saveNow, fitMap: fitMap
  };
  init();
})();
