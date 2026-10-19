/* NetMap application: state, canvas interaction, panels and dialogs. */
(function () {
  'use strict';
  const NM = window.NetMap, M = NM.model, L = NM.layout, T = NM.trace, R = NM.render, X = NM.exporters, B = NM.builder;
  const $ = (id) => document.getElementById(id);
  const esc = R.esc;
  const KEY = 'netmap.autosave.v1', KEY_EXPORT = 'netmap.lastExport', KEY_COLL = 'netmap.collapsed.v1', KEY_DIRTY = 'netmap.fileDirty';
  const POLL_MS = 60000;

  const S = {
    p: null, mapId: null, mode: 'view', sel: null, multi: [], trace: null, tool: null,
    undo: [], redo: [], unsaved: false, saveErr: null, savedAt: null, lastExport: null,
    drag: null, geo: null, query: '', showIssues: false, issues: [],
    collapsed: {}, pgroup: null, hoverPort: null, preview: null, drop: null, cableColor: 'auto', customColorFor: null, ring: null,
    fileDirty: false, newVersion: null, updateHidden: false, place: null, rev: 0, netRev: -1, netCache: [], view: 'map', graph: { from: '', to: '', via: false }
  };
  NM.app = { S: S, M: M, commit: (l, f) => commit(l, f), toggleCollapse: (id, side) => toggleCollapse(id, side) }; // exposed for tests

  /* ---------------------------------------------------------------- utils */
  let toastT = null;
  function toast(msg, bad) {
    const t = $('toast'); t.textContent = msg; t.className = 'show' + (bad ? ' bad' : '');
    clearTimeout(toastT); toastT = setTimeout(() => { t.className = ''; }, bad ? 5000 : 2500);
  }
  const curMap = () => S.p.maps.find((m) => m.id === S.mapId) || S.p.maps[0];
  /* the automatic "All items" overview map: ghost copies only - items can be rearranged there but never edited */
  const onAll = () => !!curMap().auto;
  let forceView = false; // the details panel of a live copy is rendered read-only
  const isEdit = () => S.mode === 'edit' && !onAll() && !forceView; // content editing
  const shownMaps = () => S.p.maps.filter((m) => !m.auto || M.equipmentMaps(S.p).length > 1);
  const firstMap = () => M.equipmentMaps(S.p)[0] || S.p.maps[0];
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
    try { localStorage.setItem(KEY, M.serializeProject(S.p)); S.unsaved = false; S.saveErr = null; S.savedAt = new Date(); }
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
  /* drawn height of a placement: folded sections make equipment shorter than its stored box */
  function drawnHeight(pl) {
    if (!pl.refId) return pl.h;
    const c = M.findContainer(S.p, pl.refId);
    if (!c || c.kind !== 'object' || !c.item.ports.length) return pl.h;
    const mn = L.minSizeAt(c.item, pl.w), coll = pl.id && S.collapsed && S.collapsed[pl.id]; // equipment is never drawn smaller than its readable minimum
    if (!coll || !Object.keys(coll).some((k) => coll[k])) return Math.max(pl.h, mn.h);
    return L.computeLayout(c.item, Math.max(pl.w, mn.w), Math.max(pl.h, mn.h), coll).h;
  }
  B.setHeightFn(drawnHeight);
  function toggleCollapse(plId, side) {
    const pl = S.p.placements.find((q) => q.id === plId), oldH = pl ? drawnHeight(pl) : 0;
    const c = S.collapsed[plId] = S.collapsed[plId] || {};
    c[side] = !c[side];
    if (!c.front && !c.rear) delete S.collapsed[plId];
    try { localStorage.setItem(KEY_COLL, JSON.stringify(S.collapsed)); } catch (e) { /* ignore */ }
    // magnet: whatever is stacked right under follows when this one folds or unfolds (edit mode only; view mode never changes the project)
    if (pl && isEdit() && Math.abs(drawnHeight(pl) - oldH) > 0.5 && B.stackedBelow(S.p, pl, oldH).length) {
      const newH = drawnHeight(pl);
      commit('Fold / unfold (items below follow)', (p) => { B.followFold(p, p.placements.find((q) => q.id === plId), oldH, newH); });
      return;
    }
    renderCanvas();
  }

  /* ---------------------------------------------------------------- store */
  function commit(label, fn) {
    const snap = JSON.stringify(S.p);
    let r;
    try { r = fn(S.p); M.syncAllMap(S.p); M.syncGhosts(S.p); }
    catch (e) { S.p = JSON.parse(snap); toast(e.message, true); renderAll(); return false; }
    S.undo.push({ label: label, snap: snap }); if (S.undo.length > 100) S.undo.shift();
    S.redo = [];
    S.rev++;
    scheduleSave(); afterChange();
    return r === undefined ? true : r;
  }
  function restore(from, to, quiet) {
    const e = from.pop();
    if (!e) return;
    to.push({ label: e.label, snap: JSON.stringify(S.p) });
    S.p = JSON.parse(e.snap); S.rev++;
    if (!quiet) toast((from === S.undo ? 'Undid: ' : 'Redid: ') + e.label);
    scheduleSave(); afterChange();
  }
  /* edit history: states 0..n+m, the current one is S.undo.length; state i (> 0) is the result of the i-th recorded action */
  function historyStates() {
    const n = S.undo.length, m = S.redo.length, out = [{ label: 'Oldest state kept', t: 0 }];
    S.undo.forEach((e, i) => out.push({ label: e.label, t: i + 1 }));
    for (let j = 1; j <= m; j++) out.push({ label: S.redo[m - j].label, t: n + j });
    return { states: out, cur: n };
  }
  function jumpTo(t) {
    let n = S.undo.length; const back = t < n;
    if (t < 0 || t > n + S.redo.length || t === n) return;
    if (t < n) { for (; n > t; n--) restore(S.undo, S.redo, true); } else { for (; n < t; n++) restore(S.redo, S.undo, true); }
    toast(back ? 'Reverted' : 'Moved on');
  }
  async function historyDlg() {
    await openDialog({
      title: 'Edit history', render: () => {
        const h = historyStates();
        const rows = h.states.slice().reverse().map((s) => '<button data-btn="go:' + s.t + '" class="hist-row' + (s.t === h.cur ? ' current' : (s.t > h.cur ? ' future' : '')) + '"><span class="hn">' + s.t + '</span><span class="grow">' + esc(s.label) + '</span><span class="tag">' + (s.t === h.cur ? 'you are here' : (s.t > h.cur ? 'redo' : 'revert here')) + '</span></button>').join('');
        return { body: '<div class="sub">Newest first. Click an entry to return the project to the state right after it (greyed entries are undone changes you can still redo; making a new change drops them). The history is cleared when a project is loaded or imported.</div><div class="hist">' + rows + '</div>', buttons: [{ key: 'x', label: 'Close' }] };
      },
      onButton: (k, c) => { if (k.indexOf('go:') === 0) { jumpTo(+k.slice(3)); c.draw(); } else c.close(); }
    });
  }
  const undo = () => restore(S.undo, S.redo);
  const redo = () => restore(S.redo, S.undo);

  function selExists() {
    if (!S.sel) return true;
    const idx = M.buildIndex(S.p), k = S.sel.kind, id = S.sel.id;
    if (k === 'pgroup') return !!M.findPortGroup(S.p, id);
    if (k === 'fline' || k === 'fpoint' || k === 'flink' || k === 'flabel') { const f = isFloor() ? floorOf() : null; return !!f && !!({ fline: FL.lineById(f, id), fpoint: FL.pt(f, id), flink: FL.linkById(f, id), flabel: FL.labelById(f, id) }[k]); }
    const t = { group: idx.groups, object: idx.objects, port: idx.ports, cable: idx.cables, link: idx.links, wire: idx.wires }[k];
    return !!(t && t[id]);
  }
  function afterChange() {
    M.syncAllMap(S.p); M.syncGhosts(S.p);
    if (!shownMaps().some((m) => m.id === S.mapId)) S.mapId = firstMap().id;
    if (!selExists()) S.sel = null;
    if (S.pgroup && !M.buildIndex(S.p).objects[S.pgroup.objId]) clearPgroup();
    if (S.trace) {
      const t = S.trace.target;
      const idx = M.buildIndex(S.p);
      const ok = { port: idx.ports, cable: idx.cables, link: idx.links, wire: idx.wires }[t.kind];
      S.trace = ok && ok[t.id] ? T.traceTarget(S.p, t) : null;
      applyTraceNetwork();
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
    floorViewChanged(v);
  }
  function stageSize() { const r = $('canvas').getBoundingClientRect(); return { w: r.width, h: r.height, left: r.left, top: r.top }; }
  function toMap(cx, cy) { const s = stageSize(), v = vpState(); return { x: (cx - s.left - v.x) / v.zoom, y: (cy - s.top - v.y) / v.zoom }; }
  function zoomAt(factor, cx, cy) {
    const v = vpState(), s = stageSize();
    const px = cx == null ? s.w / 2 : cx - s.left, py = cy == null ? s.h / 2 : cy - s.top;
    const nz = isFloor() ? Math.min(8, Math.max(0.05, v.zoom * factor)) : Math.min(4, Math.max(0.1, v.zoom * factor)), f = nz / v.zoom;
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
    if (mapId && maps.indexOf(mapId) >= 0) maps = [mapId]; // a map was asked for (e.g. "open the original", a map link): go there even from the overview
    else if ((kind === 'object' || kind === 'group') && onAll() && M.placementOf(S.p, S.mapId, id)) maps = [S.mapId]; // already in the overview
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
    S.mapId = id; clearPgroup(); floorReset(); S.multi = []; if (!keepSel) { S.sel = null; }
    if (S.place) { S.place = null; $('ghostInner').innerHTML = ''; $('ghost').style.display = 'none'; }
    renderAll();
    const v = vpState();
    if (v.zoom === 1 && v.x === 0 && v.y === 0 && S.p.placements.some((p) => p.mapId === id)) fitMap();
    closeLeft();
  }

  /* ---------------------------------------------------------------- selection and tools */
  /* ---- multiple selection (Ctrl+click toggles, Ctrl+A selects everything on this map): equipment maps and floor plans ---- */
  const multiKinds = { object: 1, group: 1, fline: 1, flink: 1, flabel: 1 };
  function multiAlive(r) {
    if (r.kind === 'object' || r.kind === 'group') return !!M.findContainer(S.p, r.id) && !!M.placementOf(S.p, S.mapId, r.id);
    const f = isFloor() ? floorOf() : null;
    return !!f && (r.kind === 'fline' ? !!FL.lineById(f, r.id) : (r.kind === 'flabel' ? !!FL.labelById(f, r.id) : !!FL.linkById(f, r.id)));
  }
  const validMulti = () => S.multi.filter(multiAlive);
  function multiMap() { const out = {}; if (S.multi.length > 1) validMulti().forEach((r) => { out[r.kind + ':' + r.id] = true; }); return out; }
  function toggleMulti(kind, id) {
    if (!multiKinds[kind]) return;
    let list = S.multi.length ? validMulti() : (S.sel && multiKinds[S.sel.kind] && !S.selGhost ? [{ kind: S.sel.kind, id: S.sel.id }] : []);
    const i = list.findIndex((r) => r.kind === kind && r.id === id);
    if (i >= 0) list.splice(i, 1); else list.push({ kind: kind, id: id });
    if (list.length <= 1) { S.multi = []; S.sel = list[0] || null; } else { S.multi = list; S.sel = list[list.length - 1]; }
    S.selGhost = false; renderAll(); showTab('details'); if (S.sel) openRight();
  }
  function selectAll() {
    if (!isEdit() || S.tool || onAll()) return;
    let list = [];
    if (isFloor()) { const f = floorOf(); list = f.lines.map((l) => ({ kind: 'fline', id: l.id })).concat(f.links.map((l) => ({ kind: 'flink', id: l.id })), f.labels.map((l) => ({ kind: 'flabel', id: l.id }))); }
    else S.p.placements.forEach((q) => { if (q.mapId === S.mapId && !q.ghost) { const c = M.findContainer(S.p, q.refId); if (c) list.push({ kind: c.kind, id: q.refId }); } });
    S.multi = list.length > 1 ? list : []; S.sel = list.length ? list[list.length - 1] : null; S.selGhost = false;
    renderAll(); if (list.length) { showTab('details'); openRight(); toast(list.length + ' selected - Delete removes them, Esc clears'); }
  }
  function clearMulti() { S.multi = []; }
  function multiDetails() {
    const list = validMulti(), count = {};
    list.forEach((r) => { count[r.kind] = (count[r.kind] || 0) + 1; });
    const names = { object: 'equipment', group: 'group(s)', fline: 'line(s)', flink: 'link(s)', flabel: 'label(s)' };
    return '<h3>' + list.length + ' selected</h3><div class="sub">' + Object.keys(count).map((k) => count[k] + ' ' + names[k]).join(', ') + '</div>' +
      '<div class="sub">Ctrl+click adds or removes one, Ctrl+A selects everything on this map, Esc clears.</div>' +
      '<div class="btn-row">' + btn('deleteSel', 'Delete selected...', '', 'danger') + btn('clearMulti', 'Clear selection') + '</div>';
  }
  async function deleteMulti() {
    const list = validMulti(); if (list.length < 2 || !isEdit()) return;
    if (isFloor()) {
      S.sel = null; S.multi = [];
      floorEdit('Delete ' + list.length + ' floor plan items', (f) => { list.forEach((r) => { if (r.kind === 'fline') FL.deleteLine(f, r.id); else if (r.kind === 'flabel') FL.removeLabel(f, r.id); else FL.removeLink(f, r.id); }); });
      renderAll(); return;
    }
    const here = list.filter((r) => M.mapsFor(S.p, r.kind, r.id).length > 1);
    let removeOnly = false;
    if (here.length) {
      const where = await openDialog({
        title: 'Delete ' + list.length + ' items',
        render: () => ({ body: '<p>' + here.length + ' of the selected items are also shown on other maps.</p><p>Remove everything from <b>this map only</b> (items and connections stay in the project), or <b>delete everywhere</b>?</p>',
          buttons: [{ key: 'no', label: 'Cancel' }, { key: 'here', label: 'Remove from this map only', cls: 'primary' }, { key: 'all', label: 'Delete everywhere...', cls: 'danger' }] }),
        onButton: (k, cx) => cx.close(k)
      });
      if (!where || where === 'no') return;
      removeOnly = where === 'here';
    }
    if (removeOnly) {
      const mid = S.mapId, gone = {};
      list.forEach((r) => { gone[r.id] = true; M.descendants(S.p, r.id).forEach((d) => { gone[d.id] = true; }); });
      S.sel = null; S.multi = [];
      commit('Remove ' + list.length + ' items from map', (p) => { p.placements = p.placements.filter((q) => !(q.mapId === mid && gone[q.refId])); });
      renderAll(); return;
    }
    const apply = (p) => { list.forEach((r) => { M.deleteContainerOrObject(p, r.kind, r.id, 'delete'); }); };
    const copy = M.clone(S.p), b = { c: copy.patchCables.length, l: copy.fixedLinks.length, o: copy.objects.length, g: copy.groups.length };
    apply(copy);
    const lines = ['This deletes ' + (b.g - copy.groups.length) + ' group(s) and ' + (b.o - copy.objects.length) + ' equipment object(s); containers go together with their contents.',
      (b.c - copy.patchCables.length) + ' patch cable(s) and ' + (b.l - copy.fixedLinks.length) + ' fixed link(s) (with all their wires) that touch them are deleted too.'];
    if (!(await confirmDlg('Confirm deletion', '<p>' + lines.map(esc).join('</p><p>') + '</p><p class="sub">You can undo this.</p>', 'Delete', true))) return;
    S.sel = null; S.multi = [];
    commit('Delete ' + list.length + ' items', apply);
  }
  function select(sel) {
    S.sel = sel; S.selGhost = false; S.multi = []; renderAll();
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
    ].concat(M.isTermination(o) ? [] : [{ k: 'deviceKind', label: 'Plugged-in device', type: 'select', opts: [['', 'none - just a label']].concat(M.DEVICE_KINDS.map((k) => [k[0], k[1]])), v: '', hint: 'Pick a type to mark these ports as occupied by that equipment (e.g. 16 cameras) without adding each one.' }]), 'Create group', '', (vals) => (vals.name.trim() ? null : 'Give the group a name'));
    if (!v) return;
    const created = commit('Add port group', (p) => M.addPortGroup(p, g.objId, { name: v.name, color: v.color, portIds: g.ids, deviceKind: v.deviceKind || undefined }));
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
    const f0 = g.gid && M.findPortGroup(S.p, g.gid), whole = f0 && M.rearPorts(f0.obj).filter((pt) => f0.group.portIds.indexOf(pt.id) >= 0).length === g.ids.length;
    const r = commit('Create fixed link', (p) => {
      const link = M.addFixedLink(p, { aObjectId: g.objId, bObjectId: pv.objId, pairs: pairs });
      if (whole) linkFarGroup(p, g.gid, pv.objId, pv.ids);
      return link.id;
    });
    if (r && r !== true) { toast('Created fixed link - edit its properties on the right'); select({ kind: 'link', id: r }); }
  }

  /* double-click a fixed link's label: go to the map where the link terminates (its far end) */
  function openLinkFarEnd(linkId) {
    const l = S.p.fixedLinks.find((x) => x.id === linkId); if (!l) return;
    const here = (id) => !!M.placementOf(S.p, S.mapId, id);
    const far = here(l.aObjectId) && !here(l.bObjectId) ? l.bObjectId : (here(l.bObjectId) && !here(l.aObjectId) ? l.aObjectId : null);
    if (!far) { toast('Both ends of this link are on this map', false); return; }
    const real = M.realPlacement(S.p, far), mapId = real ? real.mapId : M.mapsFor(S.p, 'object', far)[0];
    if (!mapId) { toast('The other end is not on any map yet', true); return; }
    goTo('object', far, mapId);
    toast('Other end of ' + l.name + ' on ' + (S.p.maps.find((m) => m.id === mapId) || {}).name);
  }
  function handleTap(target, ev) {
    if (isFloor() && ev) { floorTap(ev); return; }
    if (S.place && ev) { placeHere(ev); return; }
    // two quick taps on a fixed link's label: the label stays click-through (ports under it keep working), so it is found by position
    let ll = null;
    if (!isEdit() && !S.tool && ev) Array.prototype.forEach.call($('vp').querySelectorAll('[data-lblink]'), (r) => { const b = r.getBoundingClientRect(); if (ev.clientX >= b.left && ev.clientX <= b.right && ev.clientY >= b.top && ev.clientY <= b.bottom) ll = r; });
    if (ll) {
      const now = Date.now(), lt = S.lastLabelTap;
      if (lt && lt.id === ll.dataset.lblink && now - lt.t < 450) { S.lastLabelTap = null; openLinkFarEnd(lt.id); return; }
      S.lastLabelTap = { id: ll.dataset.lblink, t: now };
    } else S.lastLabelTap = null;
    const tg = target.closest ? target.closest('[data-toggle]') : null;
    if (tg) { toggleCollapse(tg.dataset.pl, tg.dataset.toggle); return; }
    const el = target.closest ? target.closest('[data-kind]') : null;
    if (el && target.closest('[data-ghost]')) { // a live copy is not editable here: a tap shows it read-only, a double-click opens the original
      if (S.tool || S.pgroup) { toast('That is a live copy: edit it on its own map (double-click it to go there)', true); return; }
      if (el.dataset.kind === 'port' && !S.pgroup) { // a port on a live copy / the overview: selectable read-only, so it can be traced
        select({ kind: 'port', id: el.dataset.id }); S.selGhost = true; renderRight();
        return;
      }
      if (el.dataset.kind === 'object' || el.dataset.kind === 'group' || el.dataset.kind === 'port') {
        const oid0 = el.dataset.kind === 'port' ? (M.buildIndex(S.p).portObj[el.dataset.id] || {}).id : el.dataset.id;
        select({ kind: el.dataset.kind === 'group' ? 'group' : 'object', id: oid0 }); S.selGhost = true; renderRight();
        toast('Live copy - double-click to open the original and edit it there');
        return;
      }
    }
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
    if (!el) { S.sel = null; S.multi = []; closeRight(); renderAll(); return; }
    if (kind === 'pgroup' && !(ev && ev.shiftKey)) { // a linked group whose other end is on another map: go there (Shift+click selects this end instead)
      const q = M.peerGroup(S.p, id);
      if (q && !M.placementOf(S.p, S.mapId, q.obj.id)) {
        const m = M.mapsFor(S.p, 'object', q.obj.id)[0];
        if (m) { goTo('pgroup', q.group.id, m); toast('Linked group: "' + q.group.name + '" on ' + q.obj.name + ' (Shift+click selects this end)'); return; }
      }
    }
    if (isEdit() && !S.tool && ev && (ev.ctrlKey || ev.metaKey) && (kind === 'object' || kind === 'group')) { if (!target.closest('[data-ghost]') && !onAll()) toggleMulti(kind, id); return; }
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
      if (isFloor() && floorPointerDown(e)) return;
      const lbl = isEdit() && !S.place && !S.tool && e.target.closest ? e.target.closest('[data-linklabel]') : null;
      if (lbl) { // drag a fixed link label out of the way (per map)
        const lk = S.p.fixedLinks.find((x) => x.id === lbl.dataset.linklabel);
        if (lk) { S.drag = { kind: 'label', linkId: lk.id, mapId: curMap().id, start: toMap(e.clientX, e.clientY), snap: JSON.stringify(S.p), ox: ((lk.labelAt && lk.labelAt[curMap().id]) || [0, 0])[0], oy: ((lk.labelAt && lk.labelAt[curMap().id]) || [0, 0])[1], moved: false, items: [] }; return; }
      }
      const h = (isEdit() || (S.mode === 'edit' && onAll())) && !S.place && e.target.closest ? e.target.closest('[data-handle]') : null;
      if (h && h.dataset.handle === 'unghost') {
        const gq = S.p.placements.find((x) => x.id === h.dataset.pl);
        if (gq) { const ids = M.placementGroup(S.p, gq.id).map((x) => x.id); commit('Remove ghost copy', (p) => { p.placements = p.placements.filter((x) => ids.indexOf(x.id) < 0); }); }
        pointers.delete(e.pointerId); return;
      }
      if (h) {
        const q = S.p.placements.find((x) => x.id === h.dataset.pl);
        if (!q) return;
        const kind = h.dataset.handle, start = toMap(e.clientX, e.clientY);
        const items = kind === 'move' ? (onAll() && q.ghost ? M.overviewBlock(S.p, q.refId) : M.placementGroup(S.p, q.id)).map((x) => ({ q: x, ox: x.x, oy: x.y })) : [{ q: q, ow: q.w, oh: q.h }]; // on the overview a drag moves the whole block of that item's map
        S.drag = { kind: kind, plId: q.id, ctrl: e.ctrlKey || e.metaKey, start: start, snap: JSON.stringify(S.p), items: items, moved: false, chain: kind === 'move' && !q.ghost ? B.captureChain(S.p, q.mapId, q.refId) : [], from: q.ghost ? null : (() => { const c = M.findContainer(S.p, q.refId); return c ? (c.kind === 'group' ? c.item.parentGroupId : c.item.containerId) : null; })() };
        return;
      }
      gesture = { x: e.clientX, y: e.clientY, vx: vpState().x, vy: vpState().y, target: e.target, moved: false };
    });
    cv.addEventListener('pointerleave', () => { if (S.place) $('ghost').style.display = 'none'; });
    cv.addEventListener('pointermove', (e) => {
      if (S.drag && e.pointerType === 'mouse' && e.buttons === 0) { finishDrag(); return; } // the button was released elsewhere (e.g. after Alt+Tab)
      if (isFloor() && !S.drag && !pointers.size) floorHover(e);
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
        if (/^(fpoint|flink|flabel|fresize|frotate|fbg)$/.test(d.kind)) { floorDragMove(d, pt); return; }
        if (d.kind === 'label') { M.setLinkLabelOffset(S.p, d.linkId, d.mapId, d.ox + dx, d.oy + dy); scheduleRender(); return; }
        if (d.kind === 'move') {
          const p0 = d.items[0], fc = M.findContainer(S.p, p0.q.refId);
          dx = snap(p0.ox + dx) - p0.ox; dy = snap(p0.oy + dy) - p0.oy;
          if (fc && fc.kind === 'object' && fc.item.fullWidth && fc.item.containerId && !p0.q.ghost) dx = 0; // full-width equipment only moves up and down its container
          d.items.forEach((it) => { it.q.x = it.ox + dx; it.q.y = it.oy + dy; });
          B.applyExtension(S.p, d.items[0].q.mapId, d.chain, d.items[0].q, EXTEND_ZONE);
          S.drop = d.items[0].q.ghost ? null : B.dropSlot(S.p, d.items[0].q, d.from);
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
    cv.addEventListener('dblclick', (e) => { // double-click a live copy: open the original on its own map
      if (isFloor()) { const pt = toMap(e.clientX, e.clientY), hit = FL.hitTest(floorOf(), pt.x, pt.y, floorTolerance()); if (hit && hit.type === 'link') { const lk = FL.linkById(floorOf(), hit.id); if (lk) floorOpenItem(lk.refId); } return; }
      const g = e.target.closest ? e.target.closest('[data-ghost]') : null, el = e.target.closest ? e.target.closest('[data-kind]') : null;
      if (g && el && (el.dataset.kind === 'object' || el.dataset.kind === 'group' || el.dataset.kind === 'port')) { e.preventDefault(); openOriginal(el.dataset.kind, el.dataset.id); }
    });
    cv.addEventListener('contextmenu', (e) => { if (isFloor()) { e.preventDefault(); floorContextMenu(e); } });
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); gesture = null; pinch = null; S.drop = null; if (S.drag) { S.p = JSON.parse(S.drag.snap); S.drag = null; renderAll(); } });
    cv.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY); }, { passive: false });
  }

  function finishDrag() {
    const d = S.drag; S.drag = null;
    const slot = S.drop; S.drop = null;
    if (d.kind === 'fbg') return; // the tracing image is not part of the project: no undo step
    if (!d.moved && d.kind === 'move' && d.ctrl) { // Ctrl+click on an item's move handle: add it to / remove it from the selection
      const q0 = S.p.placements.find((x) => x.id === d.plId), c0 = q0 && !q0.ghost && !onAll() && M.findContainer(S.p, q0.refId);
      if (c0) toggleMulti(c0.kind, q0.refId);
      return;
    }
    if (!d.moved) { if (d.kind === 'label') select({ kind: 'link', id: d.linkId }); else if (d.kind === 'fpoint') select({ kind: 'fpoint', id: d.id }); else if (d.kind === 'flink') select({ kind: 'flink', id: d.id }); else if (d.kind === 'flabel') select({ kind: 'flabel', id: d.id }); return; }
    S.undo.push({ label: d.kind === 'label' ? 'Move label' : (/^(fpoint|flink|flabel|fresize|frotate)$/.test(d.kind) ? (d.kind === 'fresize' ? 'Resize on floor plan' : d.kind === 'frotate' ? 'Rotate on floor plan' : 'Move on floor plan') : (d.kind === 'move' ? 'Move' : 'Resize')), snap: d.snap }); if (S.undo.length > 100) S.undo.shift(); S.redo = [];
    const gq = S.p.placements.find((x) => x.id === d.plId);
    if (d.kind === 'label') { /* only the label moved */ }
    else if (/^(fpoint|flink|flabel|fresize|frotate)$/.test(d.kind)) floorDragEnd(d);
    else if (gq && gq.ghost && onAll()) { // overview: the block of this item's map moved; remember its new offset (items follow their sources from now on)
      const it0 = d.items.find((x) => x.q.id === gq.id) || d.items[0];
      if (it0) { const dx = it0.q.x - it0.ox, dy = it0.q.y - it0.oy; d.items.forEach((x) => { x.q.x = x.ox; x.q.y = x.oy; }); M.moveOverviewBlock(S.p, gq.refId, dx, dy); }
    }
    else if (gq && gq.ghost) { /* a live copy on an equipment map only has a position: no containers, racks or overlaps to sort out */ }
    else if (d.kind === 'move') {
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
    document.body.className = 'mode-' + S.mode + (onAll() ? ' on-all' : '') + (isFloor() ? ' on-floor' : '') + (S.view === 'graph' ? ' view-graph' : '') + (document.body.classList.contains('nav-hidden') ? ' nav-hidden' : '');
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
    {
      const ov = M.allMap(S.p), rs = M.equipmentMaps(S.p), fls = M.floorMaps(S.p), one = (m) => '<option value="' + esc(m.id) + '"' + (m.id === S.mapId ? ' selected' : '') + '>' + esc(m.name) + '</option>';
      $('mapSelect').innerHTML = (ov && rs.length > 1 ? one(ov) + '<optgroup label="Maps in the overview">' + rs.map(one).join('') + '</optgroup>' : rs.map(one).join('')) +
        (fls.length ? '<optgroup label="Floor plans">' + fls.map(one).join('') + '</optgroup>' : '');
    }
    $('btnMode').textContent = S.mode === 'edit' ? 'Done editing' : 'Edit';
    $('editBanner').textContent = onAll() ? 'OVERVIEW - ghost copies of every map. Drag them to arrange the overview; nothing here changes the equipment or cabling (edit things on their own maps).' : 'EDIT MODE - changes modify the infrastructure model. Moving things never changes connections.';
    const na = netIssues(), ab = $('btnAlerts');
    ab.hidden = !na.length; ab.textContent = 'Network warnings (' + na.length + ')'; ab.title = na.slice(0, 5).map((i) => i.message).join('\n');
    $('btnUndo').disabled = !S.undo.length; $('btnRedo').disabled = !S.redo.length;
    $('btnUndo').title = S.undo.length ? 'Undo: ' + S.undo[S.undo.length - 1].label : 'Nothing to undo';
    setStatus();
  }
  function renderCanvas() {
    const map = curMap();
    const r = R.renderMap(S.p, map.id, Object.assign({
      mode: onAll() ? 'view' : S.mode, moveGhosts: S.mode === 'edit' && onAll(), selection: S.sel, multi: multiMap(), highlight: S.trace && S.trace.highlight,
      pendingPortId: S.tool && S.tool.pending, collapsed: S.collapsed, drop: S.place && S.place.host ? { containerId: S.place.host } : S.drop, alerts: netAlertMap(), ringPorts: ringPorts(),
      groupPorts: S.pgroup ? S.pgroup.ids : null, preview: S.preview
    }, floorRenderOpts()));
    S.geo = r;
    $('vp').innerHTML = r.content;
    applyVp();
    const none = isFloor() ? !(floorOf().lines.length || floorOf().links.length) : !S.p.placements.some((q) => q.mapId === map.id);
    const eh = $('emptyHint');
    eh.hidden = !none;
    if (none) {
      if (isFloor()) eh.innerHTML = '<div><strong>This floor plan is empty.</strong></div><div>' + (isEdit() || S.mode === 'edit' ? 'Pick Line or Rectangle in the toolbar and click on the plan to draw walls (lengths are real: 1 m is 1 m), then use + Add link... to place your racks, sockets and devices.' : 'Tap "Edit" to draw the floor plan.') + '</div>';
      else eh.innerHTML = '<div><strong>This map is empty.</strong></div><div>' + (isEdit() ? 'Use the toolbar to add groups, racks and equipment.' : 'Tap "Edit" to start documenting, or load the demo project.') + '</div>' +
        (S.p.objects.length ? '' : '<button data-act="help">Quick start guide</button> <button data-act="demo">Load demo project</button>');
    }
    const th = $('toolHint');
    if (floorEditing() && (FS.place || FS.draw || FS.rect || FS.tool !== 'select')) {
      th.hidden = false;
      th.textContent = FS.tool === 'label' ? 'Label: click where the text label goes (Esc cancels)' : FS.tool === 'calib' ? (FS.calib ? 'Click the other end of the known length (Esc cancels)' : 'Scale to size line: click one end of something on the image with a known length (zoom in for accuracy)') : FS.tool === 'bgmove' ? 'Drag to move the tracing image' : FS.place ? 'Click to place ' + FS.place.name + ' - R rotates it - Esc cancels (Ctrl+click keeps placing)' :
        FS.tool === 'line' ? (FS.draw ? 'Line: click the next point - or type its length in metres and press Enter - lines click into 30/45 degree angles (Shift forces, hold Ctrl to bypass) - Esc/Enter finishes' : 'Line: click the first point (it snaps to points and lines)') :
        FS.tool === 'rect' ? (FS.rect ? 'Rectangle: click the opposite corner (Esc cancels)' : 'Rectangle: click the first corner') : '';
      th.hidden = !th.textContent;
    } else if (S.tool && S.tool.type === 'patch') { th.hidden = false; th.textContent = S.tool.pending ? 'Tap the destination port (Esc to cancel)' : 'Patch cable: tap the first port (W or Esc to stop)'; }
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
    if (isFloor()) { tb.innerHTML = floorEditing() ? floorToolbar() : ''; return; }
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

    const grips = S.mode === 'edit' && M.realMaps(S.p).length > 1; // in edit mode every ordinary map has a handle to drag it to another position
    const mapRow = (m) => '<div class="list-item ' + (m.id === S.mapId ? 'active' : '') + '" data-act="goto" data-kind="map" data-id="' + esc(m.id) + '">' + (grips && !m.auto ? '<span class="map-grip" data-mapgrip="' + esc(m.id) + '" title="Drag to change the order of the maps"></span>' : '') + '<div class="grow">' + esc(m.name) +
      (m.location ? '<div class="sub">' + esc(m.location) + '</div>' : '') + '</div>' +
      (isEdit() && !m.auto ? '<button data-act="editMap" data-id="' + esc(m.id) + '" style="padding:0 6px">Edit</button>' : '') + '</div>';
    const ovMap = M.allMap(S.p), reals = M.equipmentMaps(S.p), floors = M.floorMaps(S.p);
    const inBin = !!ovMap && (ovMap.id === S.mapId || reals.some((m) => m.id === S.mapId)); // the box is outlined strongly only while one of its maps (or the overview) is open
    // with an overview the maps sit in a box under its "lid": the overview is the header, the maps are what it combines
    $('mapList').innerHTML = '<h3>Maps' + (isEdit() ? ' <button data-act="newMap" style="float:right;padding:0 6px">+ Add</button>' : '') + '</h3>' +
      (ovMap && reals.length > 1
        ? '<div class="map-lid' + (ovMap.id === S.mapId ? ' active' : '') + (inBin ? ' in-bin' : '') + '" data-act="goto" data-kind="map" data-id="' + esc(ovMap.id) + '" title="Every map together (overview)"><div class="grow"><b>' + esc(ovMap.name) + '</b><div class="sub">Every map together (overview)</div></div></div><div class="map-box map-rows' + (inBin ? ' in-bin' : '') + '">' + reals.map(mapRow).join('') + '</div>'
        : '<div class="map-rows">' + reals.map(mapRow).join('') + '</div>') +
      (floors.length ? '<h3 style="margin-top:8px">Floor plans</h3><div class="map-rows">' + floors.map(mapRow).join('') + '</div>' : '');

    const idx = M.buildIndex(S.p), mid = curMap().id;
    const onMap = (id) => isFloor() ? !!FL.linkOf(floorOf(), id) : !!M.placementOf(S.p, mid, id);
    // the equipment list shows what is on THIS map (plus anything not placed on any map yet, so it can be found and added);
    // containers stay when something inside them is shown; "show all" brings back the equipment of other maps
    const unplaced = (kind, id) => !M.mapsFor(S.p, kind, id).length;
    const shown = (kind, item) => S.listAll || onMap(item.id) || unplaced(kind, item.id) || M.containerChildren(S.p, item.id).some((k) => shown(k.kind, k.kind === 'group' ? idx.groups[k.id] : idx.objects[k.id]));
    let hidden = 0;
    function node(kind, item, depth) {
      if (!shown(kind, item)) { hidden++; return ''; }
      const isG = kind === 'group', pl = M.placementOf(S.p, mid, item.id);
      let h = '<div class="list-item ' + (S.sel && S.sel.id === item.id ? 'active' : '') + '" style="margin-left:' + depth * 14 + 'px" data-act="goto" data-kind="' + kind + '" data-id="' + esc(item.id) + '">' +
        '<div class="grow">' + esc(item.name) + '</div><span class="tag">' + (isG ? 'group' : M.typeLabel(item)) + '</span>' +
        (pl && pl.ghost ? '<span class="tag" title="Shown here as a live copy of an item on another map">live copy</span>' : (pl ? '' : (unplaced(kind, item.id) ? '<span class="tag" title="Not placed on any map yet">no map</span>' : '<span class="tag" title="Not drawn on the current map">other map</span>'))) + '</div>';
      M.containerChildren(S.p, item.id).forEach((k) => {
        h += node(k.kind, k.kind === 'group' ? idx.groups[k.id] : idx.objects[k.id], depth + 1);
      });
      return h;
    }
    if (isFloor()) { // a floor plan lists only what is placed on it (its links), nothing from the equipment maps
      const lks = floorOf().links.map((lk) => ({ lk: lk, c: M.findContainer(S.p, lk.refId) })).filter((x) => x.c).sort((a, b) => a.c.item.name.localeCompare(b.c.item.name));
      let fl = '<h3>On this floor plan <span class="sub" style="text-transform:none;letter-spacing:0">(' + lks.length + ')</span></h3>';
      fl += lks.length ? lks.map((x) => '<div class="list-item ' + (S.sel && S.sel.id === x.lk.id ? 'active' : '') + '" data-act="goFloor" data-map="' + esc(mid) + '" data-link="' + esc(x.lk.id) + '"><div class="grow">' + esc(x.c.item.name) + '</div><span class="tag">' + esc(x.c.kind === 'group' ? 'group' : M.typeLabel(x.c.item)) + '</span></div>').join('') :
        '<div class="sub">Nothing is placed on this plan yet. In edit mode use <b>+ Add link...</b> to place a rack, wall socket, device or group from your equipment maps.</div>';
      $('objectList').innerHTML = fl;
    } else {
    let ol = '<h3>Equipment' + (M.realMaps(S.p).length > 1 && !onAll() ? ' <span class="sub" style="text-transform:none;letter-spacing:0">on this map</span>' : '') + '</h3>';
    S.p.groups.filter((g) => !g.parentGroupId).forEach((g) => { ol += node('group', g, 0); });
    S.p.objects.filter((o) => !o.containerId).forEach((o) => { ol += node('object', o, 0); });
    if (!S.p.groups.length && !S.p.objects.length) ol += '<div class="sub">Nothing documented yet.</div>';
    else if (!S.listAll && hidden) ol += '<div class="sub" style="margin-top:6px"><a class="lnk" data-act="listAll">Show equipment on other maps (' + (S.p.groups.filter((g) => !onMap(g.id) && !unplaced('group', g.id)).length + S.p.objects.filter((o) => !onMap(o.id) && !unplaced('object', o.id)).length) + ')</a></div>';
    else if (S.listAll && M.realMaps(S.p).length > 1) ol += '<div class="sub" style="margin-top:6px"><a class="lnk" data-act="listAll">Only this map\'s equipment</a></div>';
    $('objectList').innerHTML = ol;
    }

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
  /* desktop: the navigation column can be folded away (remembered); phone: it is a slide-in drawer */
  const isNarrow = () => window.matchMedia && window.matchMedia('(max-width: 760px)').matches;
  function setNavHidden(on) {
    document.body.classList.toggle('nav-hidden', !!on);
    const b = $('btnMenu'); if (b) { b.setAttribute('aria-expanded', on ? 'false' : 'true'); b.classList.toggle('active', !on); }
    try { localStorage.setItem('netmap.navHidden', on ? '1' : '0'); } catch (_) { /* ignore */ }
  }
  const openLeft = () => { if (isNarrow()) $('left').classList.add('open'); else if (document.body.classList.contains('nav-hidden')) setNavHidden(false); };
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
    duplicate: 'Copy this item (with everything inside it) and place the copy where you click. Settings are copied, connections and IP addresses are not. Ctrl+C / Ctrl+V does the same.',
    moveToMap: 'Cut this item (with its contents) from this map and paste it, editable, on another map or a new one. Only possible while nothing in it is patch-corded to anything outside it; fixed links stay and keep a label here.',
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
    traceNet: 'Also highlight everything else in the same network as the ends of this trace (softer than the route). A switch carries the network to all its ports - except port isolation, where an access port only reaches the uplinks and what lies beyond. Routers end a network; behind a router WAN port it shows the LAN side of that router.',
    clearTrace: 'Remove the trace highlight and return to the normal map',
    seeOnFullMap: 'Open the All items overview (every map together) with the whole route highlighted',
    backFromFullMap: 'Return to the map you came from; the trace stays',
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
    if (S.multi.length > 1 && validMulti().length > 1) pane.innerHTML = multiDetails();
    else if (!S.sel) {
      pane.innerHTML = '<h3>Nothing selected</h3><div class="sub">Tap an object, port, cable or fixed link on the map to see details. Use the search box to find a port, cable or wire by label or ID.</div>' +
        '<div class="btn-row">' + btn('help', 'Help') + '</div>';
    } else {
      const d = { group: detGroup, object: detObject, port: detPort, cable: detCable, link: detLink, wire: detWire, pgroup: detPGroup, fline: detFloorLine, fpoint: detFloorPoint, flink: detFloorLink, flabel: detFloorLabel }[S.sel.kind];
      forceView = !!S.selGhost;
      pane.innerHTML = (S.selGhost && (S.sel.kind === 'object' || S.sel.kind === 'group') ? '<div class="msg-box">Live copy of an item on another map: shown read-only. <a class="lnk" data-act="openOriginal" data-kind="' + S.sel.kind + '" data-id="' + esc(S.sel.id) + '">Open the original to edit it</a> (or double-click the copy).</div>' : '') + (!S.selGhost && onAll() && (S.sel.kind === 'object' || S.sel.kind === 'group') ? '<div class="msg-box">Overview copy: shown read-only here. Edit it on its own map: ' + mapsLine(S.sel.kind, S.sel.id) + '</div>' : '') + d(S.sel.id);
    }
    forceView = false;
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
    h += fld('On maps', mapsLine('group', id)) + floorRefsLine(id);
    h += '<h3>Contents (' + kids.length + ')</h3>' + (kids.map((k) => '<div class="list-item" data-act="goto" data-kind="' + k.kind + '" data-id="' + esc(k.id) + '">' + esc((k.kind === 'group' ? idx.groups[k.id] : idx.objects[k.id]).name) + '</div>').join('') || '<div class="sub">Empty. Groups only organise equipment; they never connect ports.</div>');
    if (isEdit()) h += '<div class="btn-row">' + placeButtons(id, 'group') + btn('duplicate', 'Copy / duplicate', 'data-kind="group" data-id="' + esc(id) + '"') + btn('moveToMap', 'Move to another map...', 'data-kind="group" data-id="' + esc(id) + '"') + btn('deleteSel', 'Delete group...', '', 'danger') + '</div>';
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
    const ps = M.pseudoOf(o, pt.id);
    if (ps) parts.push('<span class="tag">occupied by ' + esc(ps.name) + '</span> <span class="sub">(a ' + esc(M.DEVICE_KINDS.find((k) => k[0] === ps.deviceKind)[1].toLowerCase()) + ', not modelled individually)</span>');
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
      h += inp(o.type === 'switch' ? 'Management IP' : 'IP address', 'ipAddress', o.ipAddress || '');
      if (o.type === 'internet') h += isEdit() ? fld('Public IP', '<label><input type="checkbox" data-f="publicIp"' + (o.publicIp ? ' checked' : '') + '> the Internet can reach in (a routable address, not behind the ISP\'s CGNAT)</label>') : fld('Public IP', o.publicIp ? 'yes: reachable from the Internet' : 'no: outbound only');
      if (isEdit() && o.type === 'switch') h += '<div class="sub">Address of the switch\'s web interface (managed switch). It joins the network of the switch, not its ports.</div>';
      if (isEdit() && o.type === 'generic') h += '<div class="sub">Every port without its own address uses this one. For several networks (e.g. a PC with two NICs) give ports their own IP below - a device never joins its networks together.</div>';
    }
    const par = o.containerId ? M.findContainer(S.p, o.containerId) : null;
    h += isEdit() ? fld('Inside', '<select data-f="container">' + opts(containerOptions('object', o.type, id), o.containerId || '') + '</select>') : fld('Inside', par ? lnk(par.kind, par.id, par.item.name) : '-');
    h += fld('On maps', mapsLine('object', id)) + floorRefsLine(id) + fld('ID', '<span class="sub">' + esc(o.id) + '</span>');
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
        (hasIp(o) ? (isEdit() ? '<input type="text" data-f="pip" data-t="' + esc(pt.id) + '" value="' + esc(pt.ip || '') + '" placeholder="' + esc(M.effectivePortIp(o, pt) || 'IP') + '" style="width:100%;margin-bottom:2px">' : (M.effectivePortIp(o, pt) ? '<div>' + esc(M.effectivePortIp(o, pt)) + (pt.ip ? '' : ' <span class="tag">device</span>') + '</div>' : '')) : '') +
        portState(o, pt, idx) + '</td><td>' +
        '<button data-act="trace" data-kind="port" data-id="' + esc(pt.id) + '" title="Trace connection">Trace</button></td></tr>').join('') + '</table>';
    }
    h += pgroupSection(o);
    if (isEdit()) {
      h += '<div class="btn-row">' + placeButtons(id, 'object') + btn('duplicate', 'Copy / duplicate', 'data-kind="object" data-id="' + esc(id) + '"') + btn('moveToMap', 'Move to another map...', 'data-kind="object" data-id="' + esc(id) + '"') + (M.isTermination(o) ? btn('automap', 'Map front N <-> rear N') + btn('newLinkFrom', 'Fixed link from here...') : '') +
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
    if (!M.isTermination(o) && o.type !== 'rack' && o.type !== 'internet') {
      h += isEdit() ? fld('Plugged-in device', '<select data-f="pgDevice" data-t="' + esc(g.id) + '">' + opts([['', 'none - just a label']].concat(M.DEVICE_KINDS.map((k) => [k[0], k[1]])), g.deviceKind || '') + '</select>' +
        '<div class="sub">Marks these ports as occupied by that kind of equipment without adding each one (e.g. 16 cameras). The graph shows one "' + esc(g.name) + ' x' + g.portIds.length + '" endpoint on ' + esc(o.name) + '.</div>') : (g.deviceKind ? fld('Plugged-in device', esc(M.DEVICE_KINDS.find((k) => k[0] === g.deviceKind)[1]) + ' x' + g.portIds.length) : '');
    }
    if (isEdit()) h += '<div class="sub">Ports as numbers and ranges, e.g. 7-14, 17. A port belongs to one group.</div>';
    const peer = M.peerGroup(S.p, g.id);
    if (peer) {
      const pm = M.mapsFor(S.p, 'object', peer.obj.id).map((m) => (S.p.maps.find((x) => x.id === m) || {}).name).filter(Boolean).join(', ');
      h += fld('Linked to', '<a class="lnk" data-act="goto" data-kind="pgroup" data-id="' + esc(peer.group.id) + '">' + esc(peer.group.name) + '</a> on ' + esc(peer.obj.name) + (pm ? ' <span class="sub">(' + esc(pm) + ')</span>' : '')) +
        '<div class="sub">The other end of the same cable group. Each end has its own name and colour; hover shows the other end and clicking it jumps there when it is on another map.</div>';
    }
    h += '<div class="btn-row">';
    if (isEdit()) {
      const rear = o.ports.filter((pt) => g.portIds.indexOf(pt.id) >= 0 && pt.side === 'rear');
      if (M.isTermination(o) && rear.length) h += btn('linkFromGroup', 'Fixed link from this group...', 'data-id="' + esc(g.id) + '"');
      if (peer) h += btn('unlinkPGroup', 'Unlink from other end', 'data-id="' + esc(g.id) + '"');
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
        ' <select id="pgNewColor">' + opts(M.CABLE_COLORS.filter((c) => c[0] !== 'white').map((c) => [c[1], c[0]]), '#1f77b4') + '</select> ' +
        (M.isTermination(o) || o.type === 'rack' || o.type === 'internet' ? '' : '<select id="pgNewDevice" title="Plugged-in device: marks the ports as occupied by that kind of equipment">' + opts([['', 'no device']].concat(M.DEVICE_KINDS.map((k) => [k[0], k[1]])), '') + '</select> ') + btn('addPGroup', 'Add') + '</div>';
      h += '<div class="sub">Tip: Ctrl+click ports, then press G to name them as a group.</div>';
    }
    return h;
  }
  function detPort(id) {
    const idx = M.buildIndex(S.p), pt = idx.ports[id], o = idx.portObj[id];
    let h = '<h3>Port</h3>' + fld('Equipment', lnk('object', o.id, o.name)) + inp('Number', 'plabel', pt.label, pt.id) + inp('Label', 'pdesc', pt.description || '', pt.id, 'placeholder="shown on hover"');
    if (M.isTermination(o)) h += fld('Side', pt.side);
    if (o.type === 'router') h += fld('Role', esc((pt.role || '').toUpperCase()));
    if (hasIp(o)) h += inp('IP address', 'pip', pt.ip || '', pt.id, 'placeholder="' + esc(M.effectivePortIp(o, pt) || '') + '"') + (!pt.ip && M.effectivePortIp(o, pt) ? '<div class="sub">Empty: uses the device address ' + esc(M.effectivePortIp(o, pt)) + '.</div>' : '');
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
    if (isEdit()) h += btn('editWiring', 'Edit installed wiring...') + (l.labelAt && l.labelAt[curMap().id] ? btn('resetLabel', 'Reset label position', 'data-id="' + esc(id) + '"') : '') + btn('deleteSel', 'Delete link...', '', 'danger');
    if (isEdit()) h += '<div class="sub">Tip: drag the link\'s label on the map to move it out of the way (per map).</div>';
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
    applyTraceNetwork();
    showTab('trace'); openRight(); renderAll(); showTab('trace');
  }
  /* "Show all links in this network": add the rest of the network of the trace's ends to the highlight (softer than the route itself) */
  function applyTraceNetwork() {
    const tr = S.trace; if (!tr) return;
    tr.base = tr.base || tr.highlight;
    if (!S.traceNet) { tr.highlight = tr.base; return; }
    const nh = T.highlightSets(S.p, NM.topology.networkTraces(S.p, tr.traces)), merged = { objects: {}, ports: {}, cables: {}, links: {}, wires: {}, soft: {} };
    ['objects', 'ports', 'cables', 'links', 'wires'].forEach((k) => {
      Object.keys(tr.base[k]).forEach((id) => { merged[k][id] = true; });
      Object.keys(nh[k]).forEach((id) => { merged[k][id] = true; if (!tr.base[k][id] && k !== 'objects') merged.soft[id] = true; });
    });
    tr.highlight = merged;
  }
  function clearTrace() { S.trace = null; renderAll(); showTab('details'); }
  function renderTracePane() {
    const pane = $('tracePane');
    if (!S.trace) { pane.innerHTML = '<h3>No trace</h3><div class="sub">Select a port, cable, fixed link or wire and press "Trace connection". Only documented connections are followed.</div>'; return; }
    const idx = M.buildIndex(S.p);
    const t = S.trace.target;
    const title = t.kind === 'port' ? M.portName(S.p, t.id, idx) : t.kind === 'cable' ? idx.cables[t.id].name : t.kind === 'link' ? idx.links[t.id].name + ' (all wires)' : M.wireName(idx.wireLink[t.id], idx.wires[t.id]);
    let h = '<h3>Trace: ' + esc(title) + '</h3><div class="btn-row">' + btn('clearTrace', 'Clear trace', '', 'primary') + btn('fitTrace', 'Fit to path') +
      (M.allMap(S.p) && M.realMaps(S.p).length > 1 ? (onAll() ? (S.prevMapId && S.p.maps.some((m) => m.id === S.prevMapId) ? btn('backFromFullMap', 'Back to ' + S.p.maps.find((m) => m.id === S.prevMapId).name) : '') : btn('seeOnFullMap', 'See on full map')) : '') + '</div>';
    h += '<label class="trace-net" title="' + esc(TIPS.traceNet) + '"><input type="checkbox" data-act="traceNet"' + (S.traceNet ? ' checked' : '') + '> Show all links in this network</label>';
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
  /* show the whole route on the "All items" overview (every map together), keeping the trace highlight */
  function seeOnFullMap() {
    const ov = M.allMap(S.p);
    if (!ov || !S.trace) return;
    S.prevMapId = S.mapId;
    switchMap(ov.id, true); showTab('trace'); openRight(); fitTrace();
  }
  function backFromFullMap() {
    const id = S.prevMapId; S.prevMapId = null;
    if (id && S.p.maps.some((m) => m.id === id)) { switchMap(id, true); showTab('trace'); fitTrace(); }
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
      dlg.oninput = (e) => { if (spec.onInput) spec.onInput(e, ctx); };
      dlg.onmouseover = (e) => { if (spec.onHover) spec.onHover(e, ctx); };
      dlg.onmouseout = (e) => { if (spec.onHover) spec.onHover(e, ctx, true); };
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
      fields.push({ k: 'ipAddress', label: 'IP address / circuit', v: '' });
      fields.push({ k: 'publicIp', label: 'Public IP', type: 'check', v: false, hint: 'Tick when this ISP gives you a routable address, so the Internet can reach in (not CGNAT). The graph uses it for "what can be reached from the Internet".' });
    }
    if (type === 'switch') fields.push({ k: 'ipAddress', label: 'Management IP', v: '', hint: 'Optional: the web interface address of a managed switch (IPv4, e.g. 192.168.1.2).' });
    if (type === 'generic') fields.push({ k: 'ipAddress', label: 'IP address', v: '', hint: 'Optional IPv4 address; all ports use it unless given an address of their own.' });
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
    const spec = isGroup ? { name: v.name || undefined } : { type: type, name: v.name || undefined, portCount: portCount, rackHeight: v.rackHeight, straight: v.straight, wanPorts: v.wanPorts, lanPorts: v.lanPorts, deviceKind: v.deviceKind, sectionSize: (type === 'patchpanel' || type === 'switch') && v.sectionSize > 0 ? v.sectionSize : undefined, uplinkPorts: v.uplinkPorts > 0 ? v.uplinkPorts : undefined, sectionRows: v.sectionRows > 1 ? v.sectionRows : undefined, portIsolation: !!v.portIsolation, ipAddress: v.ipAddress, publicIp: !!v.publicIp };
    startPlace(isGroup ? 'group' : 'object', spec, type);
  }

  /* ---- placing a new item: it follows the cursor, a click drops it, Ctrl+click keeps going with incrementing names ---- */
  function ghostMarkup(pl) {
    const temp = M.createProject('ghost'), mid = temp.maps[0].id;
    if (pl.clip) {
      try {
        const root = B.pasteClipAt(temp, mid, pl.clip, 0, 0).placement, r = R.renderMap(temp, mid, { mode: 'view' });
        return { svg: r.content, w: root.w, h: root.h };
      } catch (e) { return { svg: '', w: 160, h: 60 }; }
    }
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
  /* copy / paste: Ctrl+C remembers the selected item (with its contents); Ctrl+V / Duplicate puts a copy under the cursor */
  function copySelection(kind, id, quiet) {
    const sel = kind ? { kind: kind, id: id } : S.sel;
    if (!sel || (sel.kind !== 'object' && sel.kind !== 'group')) { if (!quiet) toast('Select an item to copy', true); return false; }
    const clip = B.copyClip(S.p, curMap().id, sel.kind, sel.id);
    if (!clip) return false;
    S.clip = clip;
    if (!quiet) toast('Copied ' + M.findContainer(S.p, sel.id).item.name + ' - Ctrl+V to paste (connections and IP addresses are not copied)');
    return true;
  }
  function pasteStart() {
    if (!S.clip) { toast('Nothing copied yet: select an item and press Ctrl+C', true); return; }
    S.tool = null; clearPgroup();
    S.place = { kind: S.clip.kind, clip: S.clip, spec: {}, type: S.clip.type, name: '', count: 0, pos: null, host: null };
    const g = ghostMarkup(S.place);
    S.place.w = g.w; S.place.h = g.h; $('ghostInner').innerHTML = g.svg;
    $('ghost').style.display = 'none';
    renderAll(); closeRight(); closeLeft();
    toast('Click to place the copy - Ctrl+click for more, Esc to stop');
  }
  function cancelPlace() {
    if (!S.place) return;
    S.place = null; $('ghostInner').innerHTML = ''; $('ghost').style.display = 'none';
    renderAll();
  }
  function moveGhost(e) {
    const pl = S.place; if (!pl) return;
    const pt = toMap(e.clientX, e.clientY);
    pl.pos = { x: snap(pt.x), y: snap(pt.y) }; // top-left corner sticks to the pointer
    $('ghostInner').setAttribute('transform', 'translate(' + pl.pos.x + ' ' + pl.pos.y + ')');
    $('ghost').style.display = '';
    const host = B.containerAt(S.p, curMap().id, pl.pos.x + 2, pl.pos.y + 2, pl.kind, pl.type);
    const hid = host ? host.refId : null;
    if (hid !== pl.host) { pl.host = hid; renderCanvas(); }
  }
  function placeHere(e) {
    const pl = S.place; if (!pl) return;
    const pt = toMap(e.clientX, e.clientY);
    const x = snap(pt.x), y = snap(pt.y), keep = e.ctrlKey || e.metaKey;
    const spec = Object.assign({}, pl.spec); if (pl.name) spec.name = pl.name; else delete spec.name;
    const r = commit(pl.clip ? 'Paste copy' : 'Create ' + pl.type, (p) => (pl.clip ? B.pasteClipAt(p, curMap().id, pl.clip, x, y) : B.placeNewAt(p, curMap().id, pl.kind, spec, x, y)).id);
    if (!r || r === true) { cancelPlace(); return; }
    pl.count++;
    if (keep) { // next copy: same settings, name counts up
      if (pl.clip) { /* names count on by themselves */ }
      else if (pl.name) pl.name = B.nextName(pl.name);
      else { const it = M.findContainer(S.p, r); pl.name = it ? B.nextName(it.item.name) : ''; }
      const g = ghostMarkup(pl); pl.w = g.w; pl.h = g.h; $('ghostInner').innerHTML = g.svg;
      pl.host = null; moveGhost(e);
      toast('Placed ' + M.findContainer(S.p, r).item.name + ' - Ctrl+click to place more, Esc to stop');
    } else {
      S.place = null; $('ghostInner').innerHTML = ''; $('ghost').style.display = 'none';
      S.sel = { kind: pl.kind, id: r }; renderAll(); openRight();
    }
  }

  /* open the editable original of an item that is shown here as a live copy */
  function openOriginal(kind, id) {
    const oid = kind === 'port' ? (M.buildIndex(S.p).portObj[id] || {}).id : id, real = oid && M.realPlacement(S.p, oid);
    if (!real) { toast('The original is not on any map', true); return; }
    const k = M.findContainer(S.p, oid).kind;
    goTo(k, oid, real.mapId);
    toast('Original on ' + (S.p.maps.find((m) => m.id === real.mapId) || {}).name);
  }
  /* hide an item (and, for a group or rack, everything shown inside it) from the current map only; nothing is deleted from the project */
  function removeFromThisMap(id) {
    const mid = curMap().id, gone = {}; gone[id] = true;
    M.descendants(S.p, id).forEach((d) => { gone[d.id] = true; });
    commit('Remove from map', (p) => { p.placements = p.placements.filter((q) => !(q.mapId === mid && gone[q.refId])); });
    renderAll();
  }
  /* ---------------------------------------------------------------- floor plans (map kind 'floor'; geometry in js/floor.js) */
  const FL = NM.floor;
  const isFloor = () => M.isFloorMap(curMap());
  const floorOf = () => FL.ensure(curMap());
  const FS = S.floor = { tool: 'select', kind: 'wall', snap: 10, labels: true, draw: null, rect: null, place: null, hover: null, typed: '', lastZoom: null, calib: null, labelSize: 14, labelColor: '#1b2a38' };
  /* tracing image per floor map: lives only in this page (never in the project, a backup or an export); gone on reload.
     x,y = top-left corner in cm, scale = cm per image pixel */
  const BG = {};
  const floorBg = () => (isFloor() ? BG[curMap().id] || null : null);
  const floorEditing = () => isFloor() && S.mode === 'edit';
  function floorRenderOpts() {
    if (!isFloor()) return {};
    const z = vpState().zoom, h = FS.hover, active = floorEditing(), bg = floorBg();
    return {
      zoom: z, labels: active ? FS.labels : true, hoverLine: active ? null : FS.hoverLine,
      floorDraw: active && FS.draw && h ? { a: FS.draw.a, to: h, kind: FS.kind, typed: FS.typed } : null,
      floorRect: active && FS.rect && h ? { x0: FS.rect.a.x, y0: FS.rect.a.y, x1: h.x, y1: h.y, kind: FS.kind } : null,
      floorPlace: active && FS.place && h ? { x: h.x, y: h.y, w: FS.place.w, d: FS.place.d, rot: FS.place.rot, name: FS.place.name } : null,
      floorSnap: active && h && (FS.draw || FS.rect || FS.place) ? h : null,
      floorBg: bg ? { href: bg.href, x: bg.x, y: bg.y, w: bg.nw * bg.scale, h: bg.nh * bg.scale, opacity: bg.opacity } : null,
      floorCalib: active && FS.calib ? { a: FS.calib.a, to: FS.calib.b || h } : null
    };
  }
  /* zoom changed: labels and handles are sized in screen pixels, so a floor plan redraws; also the scale bar */
  function floorViewChanged(v) {
    const bar = $('scaleBar'); if (!bar) return;
    if (!isFloor()) { bar.hidden = true; return; }
    bar.hidden = false;
    const ns = FL.niceScale(v.zoom);
    bar.style.width = Math.round(ns.px) + 'px';
    bar.querySelector('span').textContent = (ns.cm >= 100 ? ns.cm / 100 + ' m' : ns.cm + ' cm');
    if (FS.lastZoom !== v.zoom) { FS.lastZoom = v.zoom; scheduleRender(); }
  }
  function floorReset() { FS.hoverLine = null; FS.draw = null; FS.rect = null; FS.place = null; FS.hover = null; FS.typed = ''; FS.calib = null; }
  function floorTolerance() { return 10 / vpState().zoom; }
  /* where a click lands: on an existing point, on a line (which will be split there), or on the snap grid; near 30 and 45 degree directions a line clicks into the angle (Shift forces it, hold Ctrl / Cmd to bypass it) */
  function floorSnapPoint(pt, o) {
    o = o || {};
    const f = floorOf(), tol = floorTolerance();
    const ANGLES = [0, 30, 45, 60, 90, 120, 135, 150, 180, 210, 225, 240, 270, 300, 315, 330];
    /* snap the direction from o.from to a 30 or 45 degree angle; the length still follows the grid */
    const toAngle = (force) => {
      const dx = pt.x - o.from.x, dy = pt.y - o.from.y, len = Math.hypot(dx, dy); if (!len) return null;
      const deg = ((Math.atan2(dy, dx) * 180 / Math.PI) + 360) % 360;
      let bestA = null, bd = 1e9;
      ANGLES.concat([360]).forEach((an) => { const d = Math.abs(deg - an); if (d < bd) { bd = d; bestA = an % 360; } });
      if (!force && len * Math.sin(Math.min(bd, 90) * Math.PI / 180) > tol) return null; // soft snap: only when the pointer is close to the ray (in screen pixels)
      const l2 = FS.snap ? Math.max(FS.snap, Math.round(len / FS.snap) * FS.snap) : Math.round(len), rad = bestA * Math.PI / 180;
      return { x: Math.round(o.from.x + Math.cos(rad) * l2), y: Math.round(o.from.y + Math.sin(rad) * l2), type: 'angle', deg: bestA };
    };
    /* the 30 / 45 degree ray from o.from meets an existing line near the pointer: finish exactly there (the line gets split at that spot) */
    const rayToLine = (force) => {
      const dx = pt.x - o.from.x, dy = pt.y - o.from.y, len = Math.hypot(dx, dy); if (!len) return null;
      const deg = ((Math.atan2(dy, dx) * 180 / Math.PI) + 360) % 360;
      let bestA = 0, bd = 1e9;
      ANGLES.concat([360]).forEach((an) => { const d = Math.abs(deg - an); if (d < bd) { bd = d; bestA = an % 360; } });
      const rad = bestA * Math.PI / 180, ux = Math.cos(rad), uy = Math.sin(rad);
      let hit = null;
      f.lines.forEach((l) => {
        const q = FL.pt(f, l.a), r = FL.pt(f, l.b); if (!q || !r) return;
        const ex = r.x - q.x, ey = r.y - q.y, den = ux * ey - uy * ex; if (Math.abs(den) < 1e-9) return; // parallel
        const wx = q.x - o.from.x, wy = q.y - o.from.y, s = (wx * ey - wy * ex) / den, u = (wx * uy - wy * ux) / den;
        if (s < 1 || u <= 0 || u >= 1) return; // behind the start, or off the ends of the line (ends are handled as points)
        const hx = o.from.x + ux * s, hy = o.from.y + uy * s, d = Math.hypot(hx - pt.x, hy - pt.y);
        if (d <= tol * (force ? 4 : 1.5) && (!hit || d < hit.d)) hit = { x: Math.round(hx), y: Math.round(hy), type: 'line', deg: bestA, d: d };
      });
      return hit;
    };
    if (o.shift && o.from) { const s = rayToLine(true) || toAngle(true); if (s) return s; } // Shift: always a 30 / 45 degree direction
    let best = null;
    f.points.forEach((q) => { if (o.exclude === q.id) return; const d = Math.hypot(q.x - pt.x, q.y - pt.y); if (d <= tol && (!best || d < best.d)) best = { x: q.x, y: q.y, type: 'point', d: d }; });
    if (best) return best;
    if (o.from && !o.free) { const s = rayToLine(false); if (s) return s; } // on a line: keep the angle, end where the ray meets it
    f.lines.forEach((l) => {
      if (o.exclude && (l.a === o.exclude || l.b === o.exclude)) return;
      const a = FL.pt(f, l.a), b = FL.pt(f, l.b); if (!a || !b) return;
      const sg = FL.toSegment(pt.x, pt.y, a.x, a.y, b.x, b.y);
      if (sg.d <= tol && sg.t > 0 && sg.t < 1 && (!best || sg.d < best.d)) best = { x: Math.round(sg.x), y: Math.round(sg.y), type: 'line', d: sg.d };
    });
    if (best) return best;
    if (o.from && !o.free) { const s = toAngle(false); if (s) return s; } // automatic: lines click into 30 / 45 degree directions (hold Ctrl / Cmd = free)
    const g = FS.snap;
    return { x: g ? Math.round(pt.x / g) * g : Math.round(pt.x), y: g ? Math.round(pt.y / g) * g : Math.round(pt.y), type: 'grid' };
  }
  /* right-click a line in edit mode: make it horizontal / vertical (needs a free end) or delete it */
  function closeCtx() { const m = document.getElementById('ctxMenu'); if (m) m.remove(); }
  function floorContextMenu(e) {
    closeCtx();
    if (!floorEditing()) return;
    const f = floorOf(), pt = toMap(e.clientX, e.clientY), hit = FL.hitTest(f, pt.x, pt.y, floorTolerance());
    if (!hit || hit.type !== 'line') return;
    S.sel = { kind: 'fline', id: hit.id }; renderAll();
    const locked = FL.lineLocked(f, hit.id), id = hit.id;
    const m = document.createElement('div'); m.id = 'ctxMenu'; m.className = 'ctx-menu';
    const item = (label, act, off, tip) => '<button data-cx="' + act + '"' + (off ? ' disabled' : '') + (tip ? ' title="' + esc(tip) + '"' : '') + '>' + esc(label) + '</button>';
    const why = 'Both ends are connected to other lines, so the direction is fixed: move a point instead';
    m.innerHTML = item('Make horizontal', 'h', locked, locked ? why : '') + item('Make vertical', 'v', locked, locked ? why : '') + '<div class="ctx-sep"></div>' + item('Delete line', 'del', false);
    m.style.left = Math.min(e.clientX, window.innerWidth - 170) + 'px'; m.style.top = Math.min(e.clientY, window.innerHeight - 120) + 'px';
    m.onclick = (ev) => {
      const b = ev.target.closest('button[data-cx]'); if (!b || b.disabled) return;
      closeCtx();
      if (b.dataset.cx === 'del') { S.sel = null; floorEdit('Delete line', (ff) => FL.deleteLine(ff, id)); renderAll(); return; }
      floorEdit(b.dataset.cx === 'h' ? 'Make horizontal' : 'Make vertical', (ff) => FL.setLineAxis(ff, id, b.dataset.cx));
      renderAll();
    };
    document.body.appendChild(m);
    const off = (ev) => { if (!m.contains(ev.target)) { closeCtx(); document.removeEventListener('pointerdown', off, true); } };
    setTimeout(() => document.addEventListener('pointerdown', off, true), 0);
  }
  /* run an edit on this floor plan as one undo step */
  function floorEdit(label, fn) {
    const id = curMap().id;
    return commit(label, (p) => fn(FL.ensure(p.maps.find((m) => m.id === id)), p));
  }
  function floorSetTool(tool, kind) {
    FS.draw = null; FS.rect = null; FS.hover = null; FS.typed = ''; FS.calib = null; if (tool !== 'link') FS.place = null;
    FS.tool = tool; if (kind) FS.kind = kind;
    renderAll();
  }
  /* pressing or releasing Shift / Ctrl while a line is being placed re-evaluates the snap under the pointer without waiting for a move */
  function floorModifierKey(e) {
    if (!floorEditing() || !FS.lastPtr || !(FS.draw || FS.rect) || !/^(Control|Meta|Shift)$/.test(e.key)) return;
    floorHover({ clientX: FS.lastPtr.x, clientY: FS.lastPtr.y, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey });
  }
  function floorHover(e) {
    FS.lastPtr = { x: e.clientX, y: e.clientY };
    if (!floorEditing()) { // view mode: a wall shows its length only while the pointer is on it
      const pt = toMap(e.clientX, e.clientY), hit = FL.hitTest(floorOf(), pt.x, pt.y, floorTolerance()), id = hit && hit.type === 'line' ? hit.id : null;
      if (id !== FS.hoverLine) { FS.hoverLine = id; scheduleRender(); }
      return;
    }
    if (!(FS.draw || FS.rect || FS.place || FS.calib)) return;
    const pt = toMap(e.clientX, e.clientY), from = FS.draw ? FS.draw.a : (FS.rect ? FS.rect.a : (FS.calib ? FS.calib.a : null));
    FS.hover = FS.calib ? { x: pt.x, y: pt.y, type: 'free' } : floorSnapPoint(pt, { from: from, shift: e.shiftKey, free: e.ctrlKey || e.metaKey });
    scheduleRender();
  }
  /* pointer down in edit mode with the select tool on a point or a link: start dragging it (anything else pans) */
  function floorPointerDown(e) {
    if (floorEditing() && FS.tool === 'bgmove' && floorBg()) {
      const bg = floorBg();
      S.drag = { kind: 'fbg', start: toMap(e.clientX, e.clientY), snap: JSON.stringify(S.p), moved: false, items: [], ox: bg.x, oy: bg.y, mapId: curMap().id };
      return true;
    }
    if (!floorEditing() || FS.tool !== 'select' || FS.place) return false;
    const f = floorOf(), pt = toMap(e.clientX, e.clientY);
    // handles of the selected link / label: a corner resizes the box, the round handle above it rotates it
    const sb = S.sel && (S.sel.kind === 'flink' || S.sel.kind === 'flabel') && !S.multi.length ? (S.sel.kind === 'flink' ? FL.linkById(f, S.sel.id) : FL.labelById(f, S.sel.id)) : null;
    if (sb) {
      const tol = floorTolerance() * 0.9, base0 = { start: pt, snap: JSON.stringify(S.p), moved: false, items: [], mapId: curMap().id, id: sb.id, sel: S.sel.kind };
      const rh = floorRotHandle(sb);
      if (Math.hypot(pt.x - rh.x, pt.y - rh.y) <= tol * 1.2) { S.drag = Object.assign(base0, { kind: 'frotate' }); return true; }
      const ci = FL.linkCorners(sb).findIndex((c) => Math.hypot(pt.x - c[0], pt.y - c[1]) <= tol);
      if (ci >= 0) { S.drag = Object.assign(base0, { kind: 'fresize', corner: ci }); return true; }
    }
    const hit = FL.hitTest(f, pt.x, pt.y, floorTolerance());
    if (!hit || (hit.type !== 'point' && hit.type !== 'link' && hit.type !== 'label')) return false;
    const base = { start: pt, snap: JSON.stringify(S.p), moved: false, items: [], mapId: curMap().id };
    if (hit.type === 'point') { const q = FL.pt(f, hit.id); S.drag = Object.assign(base, { kind: 'fpoint', id: hit.id, ox: q.x, oy: q.y }); }
    else if (hit.type === 'label') { const lb = FL.labelById(f, hit.id); S.drag = Object.assign(base, { kind: 'flabel', id: hit.id, ox: lb.x, oy: lb.y }); }
    else { const lk = FL.linkById(f, hit.id); S.drag = Object.assign(base, { kind: 'flink', id: hit.id, ox: lk.x, oy: lk.y }); }
    return true;
  }
  /* where the round rotate handle sits: above the box's top edge, in the box's own direction */
  function floorRotHandle(b) {
    const rad = b.rot * Math.PI / 180, off = b.d / 2 + 28 / vpState().zoom;
    return { x: b.x + Math.sin(rad) * off, y: b.y - Math.cos(rad) * off };
  }
  function floorDragMove(d, pt) {
    const f = floorOf(), dx = pt.x - d.start.x, dy = pt.y - d.start.y;
    if (d.kind === 'fresize' || d.kind === 'frotate') {
      const b = d.sel === 'flink' ? FL.linkById(f, d.id) : FL.labelById(f, d.id); if (!b) return;
      if (d.kind === 'fresize') { const g = FS.snap || 1; FL.resizeBox(b, d.corner, Math.round(pt.x / g) * g, Math.round(pt.y / g) * g, d.sel === 'flabel' ? 10 : 5); }
      else {
        let deg = Math.atan2(pt.y - b.y, pt.x - b.x) * 180 / Math.PI + 90; deg = ((deg % 360) + 360) % 360;
        const near = Math.round(deg / 15) * 15; // soft snap to every 15 degrees
        b.rot = Math.round(Math.abs(deg - near) <= 4 ? near : deg) % 360;
      }
      scheduleRender(); return;
    }
    if (d.kind === 'flabel') { const lb = FL.labelById(f, d.id), g = FS.snap || 1; if (lb) { lb.x = Math.round((d.ox + dx) / g) * g; lb.y = Math.round((d.oy + dy) / g) * g; } scheduleRender(); return; }
    if (d.kind === 'fbg') { const bg = BG[d.mapId]; if (bg) { bg.x = d.ox + dx; bg.y = d.oy + dy; scheduleRender(); } return; }
    if (d.kind === 'fpoint') {
      const sp = floorSnapPoint({ x: d.ox + dx, y: d.oy + dy }, { exclude: d.id });
      const q = FL.pt(f, d.id); if (q) { q.x = sp.x; q.y = sp.y; }
    } else {
      const lk = FL.linkById(f, d.id), g = FS.snap || 1;
      if (lk) { lk.x = Math.round((d.ox + dx) / g) * g; lk.y = Math.round((d.oy + dy) / g) * g; }
    }
    scheduleRender();
  }
  function floorDragEnd(d) { // a moved point joins / splits / crosses like drawn lines do
    if (d.kind === 'fpoint') { const id = curMap().id; const f = FL.ensure(S.p.maps.find((m) => m.id === id)); const newId = FL.settleAfterMove(f, d.id); if (newId !== d.id && S.sel && S.sel.id === d.id) S.sel = { kind: 'fpoint', id: newId }; }
  }
  function floorSelect(hit) {
    if (!hit) { S.sel = null; S.multi = []; closeRight(); renderAll(); return; }
    select({ kind: hit.type === 'point' ? 'fpoint' : (hit.type === 'link' ? 'flink' : (hit.type === 'label' ? 'flabel' : 'fline')), id: hit.id });
  }
  /* a click on the floor plan (also what a finger tap does) */
  function floorTap(ev) {
    const pt = toMap(ev.clientX, ev.clientY), f = floorOf();
    // two quick taps on a link open the real item (the first tap re-draws the plan, so the browser's own dblclick is not reliable here)
    if (!FS.place && (FS.tool === 'select' || !floorEditing())) {
      const h2 = FL.hitTest(f, pt.x, pt.y, floorTolerance()), now = Date.now(), lt = FS.lastTap;
      if (h2 && h2.type === 'link' && lt && lt.id === h2.id && now - lt.t < 450) { FS.lastTap = null; const lk = FL.linkById(f, h2.id); if (lk) { floorOpenItem(lk.refId); return; } }
      if (h2 && h2.type === 'label' && floorEditing() && lt && lt.id === h2.id && now - lt.t < 450) { FS.lastTap = null; floorEditLabelText(h2.id); return; }
      FS.lastTap = h2 && (h2.type === 'link' || h2.type === 'label') ? { id: h2.id, t: now } : null;
    }
    if (!floorEditing()) { // view mode: links and lines can be looked at
      const hit = FL.hitTest(f, pt.x, pt.y, floorTolerance());
      floorSelect(hit && hit.type !== 'point' ? hit : null); return;
    }
    if (FS.place) {
      const sp = floorSnapPoint(pt, {}), pl = FS.place;
      const lk = floorEdit('Add link', (ff) => FL.addLink(ff, { kind: pl.kind, refId: pl.refId, x: sp.x, y: sp.y, rot: pl.rot, w: pl.w, d: pl.d }));
      if (lk && lk !== true) { if (!(ev.ctrlKey || ev.metaKey)) { FS.place = null; FS.hover = null; } S.sel = { kind: 'flink', id: lk.id }; showTab('details'); renderAll(); }
      return;
    }
    if (FS.tool === 'label') {
      const sp = floorSnapPoint(pt, {}), lb = floorEdit('Add label', (ff) => FL.addLabel(ff, { x: sp.x, y: sp.y, w: 240, d: 80, text: 'Room', size: FS.labelSize, color: FS.labelColor }));
      if (lb && lb !== true) { FS.tool = 'select'; S.sel = { kind: 'flabel', id: lb.id }; showTab('details'); openRight(); renderAll(); const ta = document.querySelector('#detailsPane [data-ff="ltext"]'); if (ta) { ta.focus(); ta.select(); } }
      return;
    }
    if (FS.tool === 'calib') {
      if (!FS.calib) { FS.calib = { a: { x: pt.x, y: pt.y } }; FS.hover = { x: pt.x, y: pt.y }; renderAll(); return; }
      if (Math.hypot(pt.x - FS.calib.a.x, pt.y - FS.calib.a.y) < 3 / vpState().zoom) return;
      FS.calib.b = { x: pt.x, y: pt.y }; renderCanvas(); floorScaleToLine(); return;
    }
    if (FS.tool === 'line') {
      const sp = floorSnapPoint(pt, { from: FS.draw ? FS.draw.a : null, shift: ev.shiftKey, free: ev.ctrlKey || ev.metaKey });
      if (!FS.draw) { FS.draw = { a: sp }; FS.hover = sp; FS.typed = ''; renderAll(); return; }
      if (sp.x === FS.draw.a.x && sp.y === FS.draw.a.y) return;
      const a = FS.draw.a;
      floorEdit('Draw line', (ff) => FL.addLine(ff, a.x, a.y, sp.x, sp.y, FS.kind));
      FS.draw = { a: sp }; FS.typed = ''; renderCanvas(); return;
    }
    if (FS.tool === 'rect') {
      const sp = floorSnapPoint(pt, {});
      if (!FS.rect) { FS.rect = { a: sp }; FS.hover = sp; renderAll(); return; }
      const a = FS.rect.a; FS.rect = null;
      const made = floorEdit('Draw rectangle', (ff) => FL.addRect(ff, a.x, a.y, sp.x, sp.y, FS.kind));
      if (made && made.length === 0) toast('Nothing to draw: the rectangle is flat or already there', true);
      renderAll(); return;
    }
    const hit0 = FL.hitTest(f, pt.x, pt.y, floorTolerance());
    if (hit0 && (hit0.type === 'line' || hit0.type === 'link' || hit0.type === 'label') && (ev.ctrlKey || ev.metaKey)) { toggleMulti(hit0.type === 'line' ? 'fline' : (hit0.type === 'label' ? 'flabel' : 'flink'), hit0.id); return; }
    floorSelect(hit0);
  }
  /* double-click a label: edit its text in a dialog */
  async function floorEditLabelText(id) {
    const lb = FL.labelById(floorOf(), id); if (!lb) return;
    const r = await formDlg('Label text', [{ k: 'text', label: 'Text (Enter in the box for a new line)', type: 'area', v: lb.text }], 'OK');
    if (r) { floorEdit('Edit label', (f) => { FL.labelById(f, id).text = String(r.text); }); renderAll(); }
  }
  /* tracing image: pick or drop a picture of the room, size it by drawing a line of known length on it */
  function floorLoadImage(file) {
    if (!floorEditing()) { toast('Open a floor plan in edit mode to add a tracing image', true); return; }
    if (!file || !/^image\//.test(file.type)) { toast('That is not an image (use PNG, JPG, WebP or SVG)', true); return; }
    if (file.size > 40 * 1024 * 1024) { toast('Image is too large (40 MB max)', true); return; }
    const mid = curMap().id, url = URL.createObjectURL(file), img = new Image(); // a short blob: URL keeps redraws cheap
    img.onload = () => {
      const nw = img.naturalWidth || 1000, nh = img.naturalHeight || 700, v = vpState(), cv = stageSize();
      const visW = Math.max(200, (cv.w - 80) / v.zoom), sc = visW * 0.8 / nw;
      if (BG[mid]) URL.revokeObjectURL(BG[mid].href);
      BG[mid] = { href: url, name: file.name, nw: nw, nh: nh, scale: sc, x: (60 - v.x) / v.zoom, y: (90 - v.y) / v.zoom, opacity: 0.5 };
      if (curMap().id === mid) { renderAll(); toast('Image added (not saved in the project). Use "Scale to size line" to match its real size'); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); toast('Could not read that image', true); };
    img.src = url;
  }
  async function floorScaleToLine() {
    const bg = floorBg(), c = FS.calib; if (!bg || !c || !c.b) return;
    const dist = Math.hypot(c.b.x - c.a.x, c.b.y - c.a.y);
    const r = await formDlg('Scale to size line', [{ k: 'len', label: 'Real length of this line (metres)', v: '', hint: 'The image is resized about the first point so the line becomes exactly this long. Your drawn plan does not move.' }], 'Scale image', '<p>The line you drew is ' + esc(FL.fmtLen(Math.round(dist))) + ' long on the plan now.</p>',
      (o) => { const n = parseFloat(String(o.len).replace(',', '.')); return n > 0 && n < 5000 ? '' : 'Enter a length in metres, e.g. 3.2'; });
    FS.calib = null;
    if (r) {
      const cm = parseFloat(String(r.len).replace(',', '.')) * 100, k = cm / dist;
      bg.scale *= k; bg.x = c.a.x + (bg.x - c.a.x) * k; bg.y = c.a.y + (bg.y - c.a.y) * k;
      FS.tool = 'select'; toast('Image scaled: 1 m on the image is now 1 m on the plan');
    }
    FS.hover = null; renderAll();
  }
  /* keys on a floor plan: Esc, Enter, a typed length (metres), Delete, and the tool letters V L R */
  function floorKey(e) {
    if (!isFloor() || e.ctrlKey || e.metaKey || e.altKey) return false;
    const k = e.key;
    if (k === 'Escape' && document.getElementById('ctxMenu')) { closeCtx(); return true; }
    if (k === 'Escape') {
      if (FS.typed) { FS.typed = ''; renderCanvas(); return true; }
      if (FS.draw || FS.rect || FS.place || FS.calib) { floorReset(); renderAll(); return true; } // first Esc: cancel what is being placed
      if (floorEditing() && FS.tool !== 'select') { floorSetTool('select'); return true; } // next Esc: back to the select tool
      return false;
    }
    if (!floorEditing()) return false;
    if (FS.draw && FS.tool === 'line') {
      if (/^[0-9.,]$/.test(k)) { FS.typed = (FS.typed + (k === ',' ? '.' : k)).slice(0, 8); renderCanvas(); return true; }
      if (k === 'Backspace' && FS.typed) { FS.typed = FS.typed.slice(0, -1); renderCanvas(); return true; }
      if (k === 'Enter') {
        if (!FS.typed) { FS.draw = null; FS.hover = null; renderAll(); return true; }
        const cm = Math.round(parseFloat(FS.typed) * 100), a = FS.draw.a, h = FS.hover || { x: a.x + 100, y: a.y };
        if (!(cm >= 1)) { toast('Type a length in metres, e.g. 3.2', true); return true; }
        const len = Math.hypot(h.x - a.x, h.y - a.y) || 1, end = { x: Math.round(a.x + (h.x - a.x) * cm / len), y: Math.round(a.y + (h.y - a.y) * cm / len) };
        floorEdit('Draw line', (ff) => FL.addLine(ff, a.x, a.y, end.x, end.y, FS.kind));
        FS.draw = { a: end }; FS.typed = ''; FS.hover = end; renderCanvas(); return true;
      }
    }
    if (FS.place && (k === 'r' || k === 'R')) { FS.place.rot = (FS.place.rot + 90) % 360; renderCanvas(); return true; }
    if (k === 'Delete' || (k === 'Backspace' && !FS.draw && S.sel)) { floorDeleteSelection(); return true; }
    if (k === 'v' || k === 'V') { floorSetTool('select'); return true; }
    if (k === 'l' || k === 'L') { floorSetTool('line'); return true; }
    if (k === 't' || k === 'T') { floorSetTool('label'); return true; }
    if (k === 'r' || k === 'R') { floorSetTool('rect'); return true; }
    if (k === 'w' || k === 'W') return true; // (W is the patch cable tool on equipment maps)
    return false;
  }
  function floorDeleteSelection() {
    if (S.multi.length > 1) { deleteMulti(); return; }
    const sel = S.sel; if (!sel || !floorEditing()) return;
    if (sel.kind === 'fline') { S.sel = null; floorEdit('Delete line', (f) => FL.deleteLine(f, sel.id)); }
    else if (sel.kind === 'flink') { S.sel = null; floorEdit('Remove link', (f) => FL.removeLink(f, sel.id)); }
    else if (sel.kind === 'flabel') { S.sel = null; floorEdit('Remove label', (f) => FL.removeLabel(f, sel.id)); }
    else if (sel.kind === 'fpoint') toast('Delete the lines that meet at a point to remove it', true);
    renderAll();
  }
  /* "Add link": search and filter the items on the equipment maps, then place the symbol on the plan */
  async function floorAddLink() {
    if (!floorEditing()) return;
    const f = floorOf(), st = { q: '', type: 'all' };
    const types = [['all', 'Everything'], ['group', 'Groups'], ['rack', 'Racks'], ['socket', 'Wall sockets'], ['generic', 'Generic equipment'], ['other', 'Other equipment']];
    const items = [];
    S.p.groups.forEach((g) => { if (!FL.linkOf(f, g.id)) items.push({ kind: 'group', id: g.id, name: g.name, type: 'group', sub: 'Group' + (g.location ? ' - ' + g.location : ''), hay: [g.name, g.location, g.description].join(' ').toLowerCase() }); });
    S.p.objects.forEach((o) => {
      if (FL.linkOf(f, o.id)) return;
      const maps = M.mapsFor(S.p, 'object', o.id).map((m) => (S.p.maps.find((x) => x.id === m) || {}).name).filter(Boolean);
      items.push({ kind: 'object', id: o.id, name: o.name, type: o.type, sub: M.typeLabel(o) + (maps.length ? ' - on ' + maps.join(', ') : ' - not on a map') + (o.location ? ' - ' + o.location : ''), hay: [o.name, o.location, o.description, M.typeLabel(o)].join(' ').toLowerCase() });
    });
    const ofType = (it, t) => {
      if (t === 'group') return it.kind === 'group';
      if (t === 'rack' || t === 'socket' || t === 'generic') return it.type === t;
      if (t === 'other') return it.kind !== 'group' && ['rack', 'socket', 'generic'].indexOf(it.type) < 0;
      return true;
    };
    const textOk = (it) => !st.q || it.hay.indexOf(st.q.toLowerCase()) >= 0;
    const match = (it) => ofType(it, st.type) && textOk(it);
    const results = () => {
      const m = items.filter(match);
      return (m.slice(0, 80).map((it) => '<button class="fl-pick" data-btn="pick:' + esc(it.kind + ':' + it.id) + '"><b>' + esc(it.name) + '</b><span class="sub">' + esc(it.sub) + '</span></button>').join('') || '<div class="sub">Nothing matches' + (items.length ? '' : ' (everything is already linked here)') + '.</div>') + (m.length > 80 ? '<div class="sub">' + (m.length - 80) + ' more - narrow the search.</div>' : '');
    };
    const v = await openDialog({
      title: 'Add link to this floor plan',
      render: () => ({
        body: '<div class="sub">What do you want to place on the plan? Pick an item from your equipment maps; it keeps living there and this plan shows where it physically is.</div>' +
          '<input type="search" data-s="q" placeholder="Search by name, location, description..." value="' + esc(st.q) + '" style="width:100%;margin:8px 0" autocomplete="off">' +
          '<div class="fl-types">' + types.map((t) => '<button class="pk-tool' + (st.type === t[0] ? ' on' : '') + '" data-type="' + t[0] + '">' + esc(t[1]) + ' (' + items.filter((it) => ofType(it, t[0]) && textOk(it)).length + ')</button>').join('') + '</div>' +
          '<div class="fl-results">' + results() + '</div>',
        buttons: [{ key: 'no', label: 'Cancel' }]
      }),
      onInput: (e, c) => { if (e.target.dataset.s === 'q') { st.q = e.target.value; c.root.querySelector('.fl-results').innerHTML = results(); } },
      onClick: (e, c) => {
        const b = e.target.closest('[data-type]'); if (!b) return;
        st.type = b.dataset.type; c.draw(); const inp = c.root.querySelector('input[data-s="q"]'); if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
      },
      onButton: (k, c) => c.close(k.indexOf('pick:') === 0 ? k.slice(5) : null),
      after: (c) => { const inp = c.root.querySelector('input[data-s="q"]'); if (inp) inp.focus(); }
    });
    if (!v) return;
    const sep = v.indexOf(':'), kind = v.slice(0, sep), id = v.slice(sep + 1), c = M.findContainer(S.p, id);
    if (!c) return;
    const fp = FL.footprintFor(kind, kind === 'object' ? c.item.type : null);
    FS.tool = 'select'; FS.draw = null; FS.rect = null; FS.hover = null;
    FS.place = { kind: kind, refId: id, name: c.item.name, w: fp.w, d: fp.d, rot: 0 };
    renderAll();
    toast('Click on the plan to place ' + c.item.name + ' - R rotates it, Esc cancels (Ctrl+click places and keeps going)');
  }
  /* open the real item of a link on the equipment map where it lives */
  function floorOpenItem(refId) {
    const c = M.findContainer(S.p, refId);
    if (!c) { toast('That item no longer exists', true); return; }
    if (!M.mapsFor(S.p, c.kind, refId).length) { toast(c.item.name + ' is not on any equipment map yet', true); return; }
    goTo(c.kind, refId);
  }
  function floorFieldChange(el) {
    const id = el.dataset.fid, what = el.dataset.ff, v = el.value;
    const fn = {
      kind: (f) => FL.setLineKind(f, id, v),
      len: (f) => { const cm = Math.round(parseFloat(String(v).replace(',', '.')) * 100); FL.setLineLength(f, id, cm); },
      angle: (f) => FL.setLineAngle(f, id, parseFloat(String(v).replace(',', '.'))),
      px: (f) => { const q = FL.pt(f, id); FL.movePoint(f, id, parseFloat(v), q.y); },
      py: (f) => { const q = FL.pt(f, id); FL.movePoint(f, id, q.x, parseFloat(v)); },
      lw: (f) => { const l = FL.linkById(f, id) || FL.labelById(f, id); if (!(parseFloat(v) >= (l.text !== undefined ? 10 : 1))) throw new Error('The size must be at least ' + (l.text !== undefined ? 10 : 1) + ' cm'); l.w = Math.round(parseFloat(v)); },
      ld: (f) => { const l = FL.linkById(f, id) || FL.labelById(f, id); if (!(parseFloat(v) >= (l.text !== undefined ? 10 : 1))) throw new Error('The size must be at least ' + (l.text !== undefined ? 10 : 1) + ' cm'); l.d = Math.round(parseFloat(v)); },
      lpreset: (f) => { const l = FL.linkById(f, id), p = String(v).split('x'); if (l && p.length === 2) { l.w = parseInt(p[0], 10); l.d = parseInt(p[1], 10); } },
      ltext: (f) => { FL.labelById(f, id).text = String(v); },
      lsize: (f) => { FL.labelById(f, id).size = parseInt(v, 10) || 14; FS.labelSize = parseInt(v, 10) || 14; },
      lcolor: (f) => { FL.labelById(f, id).color = v; FS.labelColor = v; },
      lbox: (f) => { const l = FL.labelById(f, id); if (el.checked) l.box = true; else delete l.box; },
      lrot: (f) => { const l = FL.linkById(f, id) || FL.labelById(f, id); const r = parseFloat(String(v).replace(',', '.')); if (!isFinite(r)) throw new Error('Rotation must be a number'); l.rot = ((Math.round(r) % 360) + 360) % 360; }
    }[what];
    if (!fn) return;
    floorEdit('Edit floor plan', (f) => fn(f));
    renderAll();
  }
  /* details panels */
  function floorHeaderNote() { return isEdit() ? '' : ''; }
  function detFloorLine(id) {
    const f = floorOf(), l = FL.lineById(f, id);
    if (!l) return '<h3>Line</h3><div class="sub">This line no longer exists.</div>';
    const edit = floorEditing(), locked = FL.lineLocked(f, id), len = FL.lineLength(f, l);
    let h = '<h3>Line</h3>';
    h += fld('Type', edit ? '<select data-ff="kind" data-fid="' + esc(id) + '">' + opts(FL.KINDS.map((k) => [k[0], k[1]]), l.kind) + '</select>' : esc((FL.KINDS.find((k) => k[0] === l.kind) || [0, l.kind])[1]));
    h += fld('Length (m)', edit ? '<input type="text" data-ff="len" data-fid="' + esc(id) + '" value="' + (len / 100).toFixed(2) + '"' + (locked ? ' disabled' : '') + ' style="width:100%">' : (len / 100).toFixed(2) + ' m');
    h += fld('Angle (deg)', edit ? '<input type="text" data-ff="angle" data-fid="' + esc(id) + '" value="' + FL.lineAngle(f, l) + '"' + (locked ? ' disabled' : '') + ' style="width:100%">' : FL.lineAngle(f, l) + '');
    if (edit && locked) h += '<div class="sub">Can\'t change the length: it is defined by the connected lines (both ends are connected). Move a point to reshape, or delete a neighbouring line.</div>';
    else if (edit) h += '<div class="sub">The free end moves; lines attached to it follow. 0 = right, 90 = down.</div>';
    if (edit) h += '<div class="btn-row">' + btn('floorDelete', 'Delete line', '', 'danger') + '</div>';
    return h;
  }
  function detFloorPoint(id) {
    const f = floorOf(), q = FL.pt(f, id);
    if (!q) return '<h3>Point</h3><div class="sub">This point no longer exists.</div>';
    const edit = floorEditing();
    return '<h3>Point</h3>' + fld('X (cm)', edit ? '<input type="text" data-ff="px" data-fid="' + esc(id) + '" value="' + q.x + '" style="width:100%">' : q.x) +
      fld('Y (cm)', edit ? '<input type="text" data-ff="py" data-fid="' + esc(id) + '" value="' + q.y + '" style="width:100%">' : q.y) + fld('Lines', FL.degree(f, id)) +
      '<div class="sub">A point joins the lines that meet there. Drag it to reshape the plan; the lines stay joined and are re-split where they cross.</div>';
  }
  function detFloorLink(id) {
    const f = floorOf(), lk = FL.linkById(f, id);
    if (!lk) return '<h3>Link</h3><div class="sub">This link no longer exists.</div>';
    const c = M.findContainer(S.p, lk.refId), edit = floorEditing();
    let h = '<h3>Link on the floor plan</h3>' + fld('Item', c ? lnk(c.kind, c.item.id, c.item.name) : '<span class="sev-warning">missing</span>') + fld('Type', c ? esc(c.kind === 'group' ? 'Group' : M.typeLabel(c.item)) : '-');
    h += fld('Width (cm)', edit ? '<input type="text" data-ff="lw" data-fid="' + esc(id) + '" value="' + lk.w + '" style="width:100%">' : lk.w) + fld('Depth (cm)', edit ? '<input type="text" data-ff="ld" data-fid="' + esc(id) + '" value="' + lk.d + '" style="width:100%">' : lk.d);
    if (edit) {
      const type = c && c.kind === 'object' ? c.item.type : null, pr = FL.sizePresets(c ? c.kind : 'object', type), cur = lk.w + 'x' + lk.d;
      h += fld('Size preset', '<select data-ff="lpreset" data-fid="' + esc(id) + '"><option value="">(custom)</option>' + pr.map((s) => '<option value="' + s[0] + 'x' + s[1] + '"' + (cur === s[0] + 'x' + s[1] ? ' selected' : '') + '>' + FL.fmtLen(s[0]) + ' x ' + FL.fmtLen(s[1]) + '</option>').join('') + '</select><div class="sub">Or drag a corner handle on the plan.</div>');
    }
    h += fld('Rotation (deg)', edit ? '<input type="text" data-ff="lrot" data-fid="' + esc(id) + '" value="' + lk.rot + '" style="width:100%">' : lk.rot) + (edit ? '<div class="sub">Or drag the round handle above it.</div>' : '');
    h += '<div class="sub">The thick edge is the front. The real item lives on the equipment maps - this is only where it stands.</div>';
    h += '<div class="btn-row">' + btn('floorOpen', 'Open the item', 'data-id="' + esc(lk.refId) + '"', 'primary') + (edit ? btn('floorDelete', 'Remove link', '', 'danger') : '') + '</div>';
    return h;
  }
  function detFloorLabel(id) {
    const lb = FL.labelById(floorOf(), id), edit = floorEditing();
    if (!lb) return '<h3>Label</h3><div class="sub">This label no longer exists.</div>';
    const fid = ' data-fid="' + esc(id) + '"';
    let h = '<h3>Text label</h3>';
    h += fld('Text', edit ? '<textarea data-ff="ltext"' + fid + ' rows="3" style="width:100%">' + esc(lb.text) + '</textarea>' : esc(lb.text));
    h += fld('Size (pt)', edit ? '<select data-ff="lsize"' + fid + '>' + opts(FL.LABEL_SIZES.map((n) => [String(n), String(n) + ' pt']), String(lb.size)) + '</select>' : lb.size + ' pt');
    h += fld('Colour', edit ? '<input type="color" data-ff="lcolor"' + fid + ' value="' + esc(lb.color) + '">' : '<span style="display:inline-block;width:14px;height:14px;background:' + esc(lb.color) + ';border:1px solid #888"></span>');
    h += fld('Border', edit ? '<label><input type="checkbox" data-ff="lbox"' + fid + (lb.box ? ' checked' : '') + '> draw a box around the text</label>' : (lb.box ? 'yes' : 'no'));
    h += fld('Width (cm)', edit ? '<input type="text" data-ff="lw"' + fid + ' value="' + lb.w + '" style="width:100%">' : lb.w) + fld('Height (cm)', edit ? '<input type="text" data-ff="ld"' + fid + ' value="' + lb.d + '" style="width:100%">' : lb.d);
    h += fld('Rotation (deg)', edit ? '<input type="text" data-ff="lrot"' + fid + ' value="' + lb.rot + '" style="width:100%">' : lb.rot);
    if (edit) h += '<div class="sub">Drag the box to move it, a corner to resize it, the round handle to rotate it; double-click to edit the text. Text scales with the plan (1 pt = ' + FL.PT_CM + ' cm).</div><div class="btn-row">' + btn('floorDelete', 'Remove label', '', 'danger') + '</div>';
    return h;
  }
  /* "On floor plans" line for an item's details */
  function floorRefsLine(id) {
    const refs = [];
    M.floorMaps(S.p).forEach((m) => { const lk = FL.linkOf(FL.ensure(m), id); if (lk) refs.push('<a class="lnk" data-act="goFloor" data-map="' + esc(m.id) + '" data-link="' + esc(lk.id) + '">' + esc(m.name) + '</a>'); });
    return refs.length ? fld('On floor plans', refs.join(', ')) : '';
  }
  function floorBgToolbar() {
    const bg = floorBg(), t = (id, label, tip) => '<button data-floortool="' + id + '" class="' + (FS.tool === id ? 'active' : '') + '" title="' + esc(tip) + '">' + label + '</button>';
    if (!bg) return '<button data-act="floorBgPick" title="Trace over a picture of the room: pick a file, or drop an image on the plan. The picture is only used for tracing: it is not saved in the project and is gone when the page reloads.">Image...</button>';
    return '<label class="trace-net" title="How strongly the tracing image shows"><span>Image</span> <input type="range" min="5" max="100" value="' + Math.round(bg.opacity * 100) + '" data-floorbgop style="width:90px"></label>' +
      t('calib', 'Scale to size line', 'Click both ends of something with a known length on the image, then type its real length') + t('bgmove', 'Move image', 'Drag the image under your drawing') +
      '<button data-act="floorBgRemove" title="Remove the tracing image (the plan stays)">Remove image</button>';
  }
  /* while placing a link: choose one of the predefined sizes */
  function floorPlaceSize() {
    const pl = FS.place, c = M.findContainer(S.p, pl.refId), pr = FL.sizePresets(pl.kind, c && pl.kind === 'object' ? c.item.type : null), cur = pl.w + 'x' + pl.d;
    return '<label class="trace-net" title="Predefined sizes for what you are placing">Size <select data-floorplacesize>' + (pr.some((s) => s[0] + 'x' + s[1] === cur) ? '' : '<option value="' + cur + '">' + FL.fmtLen(pl.w) + ' x ' + FL.fmtLen(pl.d) + '</option>') +
      pr.map((s) => '<option value="' + s[0] + 'x' + s[1] + '"' + (cur === s[0] + 'x' + s[1] ? ' selected' : '') + '>' + FL.fmtLen(s[0]) + ' x ' + FL.fmtLen(s[1]) + '</option>').join('') + '</select></label><span class="sep"></span>';
  }
  function floorToolbar() {
    const t = (id, label, extra) => '<button data-floortool="' + id + '" class="' + (FS.tool === id && !FS.place ? 'active' : '') + '" title="' + esc(extra) + '">' + label + '</button>';
    return t('select', 'Select (V)', 'Select and drag points and links; click a line to edit it') + t('line', 'Line (L)', 'Click to start, click again for each next point; type a length in metres and press Enter; Esc/Enter finishes') +
      t('rect', 'Rectangle (R)', 'Click two opposite corners: four lines that share their corner points') + t('label', 'Label (T)', 'Click to put a text label (a scalable box with a name, for example a room)') +
      '<select data-floorkind title="What the lines you draw are">' + opts(FL.KINDS.map((k) => [k[0], k[1]]), FS.kind) + '</select><span class="sep"></span>' +
      (FS.place ? floorPlaceSize() : '') + '<button data-act="floorAddLink" title="Place a to-scale symbol for a rack, wall socket, device or group from your equipment maps">+ Add link...</button><span class="sep"></span>' +
      '<label class="trace-net" title="Snap clicks to this grid (points and lines always snap first; lines click into 30 / 45 degree angles, Shift forces them, hold Ctrl / Cmd to bypass)">Snap <select data-floorsnap>' + opts([['0', 'off'], ['5', '5 cm'], ['10', '10 cm'], ['25', '25 cm'], ['50', '50 cm']], String(FS.snap)) + '</select></label>' +
      '<label class="trace-net"><input type="checkbox" data-floorlabels' + (FS.labels ? ' checked' : '') + '> Lengths</label><span class="sep"></span>' + floorBgToolbar();
  }

  async function deleteSelection() {
    if (S.multi.length > 1) { deleteMulti(); return; }
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
    if (S.selGhost) { S.sel = null; S.selGhost = false; removeFromThisMap(sel.id); return; } // a live copy: only the copy goes
    const c = M.findContainer(S.p, sel.id), kids = M.containerChildren(S.p, sel.id);
    // shown on several maps: deleting it here must not silently delete it everywhere
    const onMaps = M.mapsFor(S.p, sel.kind, sel.id);
    if (onMaps.length > 1 && onMaps.indexOf(S.mapId) >= 0) {
      const names = onMaps.map((m) => (S.p.maps.find((x) => x.id === m) || {}).name).filter(Boolean);
      const where = await openDialog({
        title: 'Delete ' + c.item.name,
        render: () => ({
          body: '<p><b>' + esc(c.item.name) + '</b> is shown on ' + onMaps.length + ' maps (' + esc(names.join(', ')) + ').</p><p>Remove it from <b>this map only</b> (it and its connections stay on the other maps), or <b>delete it everywhere</b>?</p>',
          buttons: [{ key: 'no', label: 'Cancel' }, { key: 'here', label: 'Remove from this map only', cls: 'primary' }, { key: 'all', label: 'Delete everywhere...', cls: 'danger' }]
        }), onButton: (k, cx) => cx.close(k)
      });
      if (!where || where === 'no') return;
      if (where === 'here') { S.sel = null; removeFromThisMap(sel.id); return; }
    }
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

  /*
   * New fixed link: pick the actual rear ports on both panels. Occupied ports are greyed out and cannot be picked, port groups are
   * shown (click a group name to pick its free ports). Ports pair up in the order they were picked, so 1,3,5,7 on one panel can
   * join 1-4 on the other. Without any pick it falls back to "N wires" (sequential or unmapped).
   */
  /* far end of a link made from a group: a new group on the other panel with the same name and colour, linked to the first */
  function linkFarGroup(p, gid, objId, portIds) {
    const src = M.findPortGroup(p, gid);
    if (!src) return null;
    const dst = M.addPortGroup(p, objId, { name: src.group.name, color: src.group.color, portIds: portIds.slice() });
    M.linkPortGroups(p, gid, dst.id);
    return dst;
  }
  async function newLink(prefA) {
    const panels = S.p.objects.filter((o) => M.isTermination(o));
    if (panels.length < 2) { toast('Create at least two patch panels (or a panel and a wall socket) first', true); return; }
    // panels often share names ("1", "top"): lead with the group they are in, e.g. "L1 Server Room: top"
    const po = panels.map((o) => { const g = M.groupOf(S.p, o.id); return [o.id, (g ? g.name + ': ' : '') + o.name + (o.type === 'socket' ? ' (wall socket)' : '')]; });
    const a0 = prefA || (S.sel && S.sel.kind === 'object' && panels.some((x) => x.id === S.sel.id) ? S.sel.id : panels[0].id);
    const st = { place: null, a: a0, b: (panels.find((x) => x.id !== a0) || panels[1]).id, sel: { a: [], b: [] }, last: { a: null, b: null }, n: 24, mapping: 'sequential', cableType: 'Cat6', length: '', route: '' };
    const idx = M.buildIndex(S.p);
    const objOf = (side) => idx.objects[st[side]];
    const fmt = (o, ids) => ids.map((id) => idx.ports[id].label).join(', ');
    /* every run of n consecutive rear ports on a panel: ok when all are free (where a group of n ports could land) */
    function windows(side, n) {
      const rear = M.rearPorts(objOf(side)), out = [];
      for (let i = 0; i + n <= rear.length; i++) { const ids = rear.slice(i, i + n).map((x) => x.id); out.push({ i: i, ids: ids, ok: ids.every((id) => !idx.portUse[id]) }); }
      return out;
    }
    const otherSide = (side) => (side === 'a' ? 'b' : 'a');
    function grid(side) {
      const o = objOf(side), rear = M.rearPorts(o), size = M.effectiveSectionSize(o, rear.length) || rear.length;
      let h = '', gl = '';
      (o.portGroups || []).forEach((g) => {
        const ids = g.portIds.filter((id) => idx.ports[id] && idx.ports[id].side === 'rear');
        if (!ids.length) return;
        const used = ids.some((id) => idx.portUse[id]), on = st.place && st.place.from === side && st.place.gid === g.id;
        gl += '<button class="pk-group' + (on ? ' on' : '') + '" data-pickgroup="' + esc(g.id) + '" data-side="' + side + '"' + (used ? ' disabled' : '') + ' style="border-color:' + esc(g.color) + ';background:' + esc(g.color) + '33" title="' +
          (used ? 'Some ports of this group are already connected' : 'Select this group, then place it on the other panel') + '">' + esc(g.name) + ' (' + ids.length + ')</button>';
      });
      const placeOn = st.place && st.place.active && st.place.from !== side;
      const cand = {};
      if (placeOn) windows(side, st.place.n).forEach((w) => { if (w.ok) w.ids.forEach((id) => { cand[id] = true; }); });
      rear.forEach((pt, i) => {
        if (i && size && i % size === 0) h += '<span class="pk-gap"></span>';
        const busy = !!idx.portUse[pt.id], pos = st.sel[side].indexOf(pt.id), g = M.portGroupOf(o, pt.id);
        h += '<button class="pk' + (busy ? ' busy' : '') + (pos >= 0 ? ' on' : '') + (cand[pt.id] && pos < 0 ? ' cand' : '') + '" data-pick="' + esc(pt.id) + '" data-side="' + side + '"' + (busy ? ' disabled title="Already has a fixed wire"' : '') +
          (g ? ' style="border-bottom:4px solid ' + esc(g.color) + '" title="' + esc(g.name) + '"' : '') + '>' + esc(pt.label) + (pos >= 0 ? '<i>' + (pos + 1) + '</i>' : '') + '</button>';
      });
      const free = rear.filter((pt) => !idx.portUse[pt.id]).length;
      return '<div class="pk-side"><div class="pk-head"><b>Panel ' + side.toUpperCase() + ': ' + esc((po.find((q) => q[0] === o.id) || [0, o.name])[1]) + '</b> <span class="sub">' + free + ' of ' + rear.length + ' rear ports free - ' + st.sel[side].length + ' picked</span> ' +
        '<button class="pk-tool" data-pickall="' + side + '">All free</button><button class="pk-tool" data-pickclear="' + side + '">Clear</button>' +
        '<button class="pk-tool pk-place' + (placeOn ? ' on' : '') + '" data-placegroup="' + side + '"' + (st.place && st.place.from !== side ? '' : ' disabled') + ' title="Select a group on the other panel first (click its name), then place it here: possible spots turn green">' + (placeOn ? 'Placing group - click a spot' : 'Place selected group') + '</button></div>' +
        (gl ? '<div class="pk-groups">' + gl + '</div>' : '') + '<div class="pk-grid">' + h + '</div></div>';
    }
    function problem() {
      if (st.a === st.b) return 'Choose two different panels';
      const na = st.sel.a.length, nb = st.sel.b.length;
      if (na !== nb) return 'Pick the same number of ports on both panels (' + na + ' on A, ' + nb + ' on B)';
      return null;
    }
    const v = await openDialog({
      title: 'New fixed link',
      render: () => {
        const picked = st.sel.a.length || st.sel.b.length, pr = problem();
        return {
          body: fld('Panel A', '<select data-s="a">' + opts(po, st.a) + '</select>') + fld('Panel B', '<select data-s="b">' + opts(po, st.b) + '</select>') +
            '<div class="sub" style="margin:6px 0">Click ports to pick them (Shift+click for a range, or click a group name). They are joined in the order picked: pick 1,3,5,7 on A and 1-4 on B to wire A1-B1, A3-B2, A5-B3, A7-B4. Greyed ports already have a wire.</div>' +
            (st.place && st.place.active ? '<div class="pk-banner">Placing <b>' + esc(st.place.name) + '</b> (' + st.place.n + ' port' + (st.place.n === 1 ? '' : 's') + '): hover over Panel ' + otherSide(st.place.from).toUpperCase() + ' - possible spots are green, the exact ports light up under the pointer - and click where its first wire should land. <button data-placegroup="cancel" class="pk-tool">Cancel</button></div>' : '') +
            '<div class="pk-wrap' + (st.sel.a.length && st.sel.a.length === st.sel.b.length && !pr ? ' valid' : '') + '">' + grid('a') + grid('b') + '</div>' +
            (picked ? '<div class="pk-sum' + (st.sel.a.length && st.sel.a.length === st.sel.b.length && !pr ? ' valid' : '') + '">' + (st.sel.a.length ? 'A: ' + esc(fmt(objOf('a'), st.sel.a)) : 'A: -') + ' &harr; ' + (st.sel.b.length ? 'B: ' + esc(fmt(objOf('b'), st.sel.b)) : 'B: -') + '</div>' + (pr ? '<div class="err-text">' + esc(pr) + '</div>' : '') :
              fld('Wires', '<input type="number" data-s="n" value="' + st.n + '" min="1" max="288">') +
              fld('Mapping', '<select data-s="mapping">' + opts([['sequential', 'Sequential: next free rear port to next free rear port'], ['none', 'Leave unmapped (map each wire later)']], st.mapping) + '</select><div class="sub">Nothing picked: create this many wires without choosing ports. Mappings are never assumed; choose sequential only if the installation really is 1:1.</div>')) +
            fld('Cable type', '<input type="text" data-s="cableType" value="' + esc(st.cableType) + '">') + fld('Length', '<input type="text" data-s="length" value="' + esc(st.length) + '">') + fld('Route', '<input type="text" data-s="route" value="' + esc(st.route) + '">'),
          buttons: [{ key: 'no', label: 'Cancel' }, { key: 'ok', label: picked ? 'Create link (' + st.sel.a.length + ' wire' + (st.sel.a.length === 1 ? '' : 's') + ')' : 'Create link', cls: 'primary', disabled: !!pr }]
        };
      },
      onChange: (e, c) => {
        const t = e.target, k = t.dataset.s; if (!k) return;
        if (k === 'a' || k === 'b') { st[k] = t.value; st.sel[k] = []; st.last[k] = null; st.place = null; c.draw(); }
        else st[k] = k === 'n' ? (parseInt(t.value, 10) || 1) : t.value;
      },
      onClick: (e, c) => {
        const el = e.target.closest('[data-pick],[data-pickgroup],[data-pickall],[data-pickclear],[data-placegroup]');
        if (!el) return;
        if (el.dataset.placegroup) { // "Place selected group" / cancel
          if (st.place) st.place.active = el.dataset.placegroup === 'cancel' ? false : !st.place.active;
          c.draw(); return;
        }
        const side = el.dataset.side || el.dataset.pickall || el.dataset.pickclear, rear = M.rearPorts(objOf(side)), free = (pt) => !idx.portUse[pt.id];
        const sel = st.sel[side], add = (id) => { if (sel.indexOf(id) < 0) sel.push(id); };
        if (el.dataset.pick && st.place && st.place.active && side !== st.place.from) { // drop the selected group here
          const w = windows(side, st.place.n).find((x) => x.ids[0] === el.dataset.pick);
          if (!w || !w.ok) { toast('The ' + st.place.n + ' ports of the group do not fit there: they must be consecutive and free', true); return; }
          st.sel[side] = w.ids.slice(); st.last[side] = w.ids[0]; st.place.active = false;
          c.draw(); return;
        }
        if (side === (st.place && st.place.from) && (el.dataset.pick || el.dataset.pickall || el.dataset.pickclear)) st.place = null; // the selection is no longer just the group
        if (el.dataset.pick) {
          const id = el.dataset.pick, at = sel.indexOf(id);
          if (e.shiftKey && st.last[side]) {
            const i0 = rear.findIndex((x) => x.id === st.last[side]), i1 = rear.findIndex((x) => x.id === id);
            rear.slice(Math.min(i0, i1), Math.max(i0, i1) + 1).filter(free).forEach((pt) => add(pt.id));
          } else if (at >= 0) sel.splice(at, 1); else add(id);
          st.last[side] = id;
        } else if (el.dataset.pickgroup) { // select the whole (unconnected) group, then it can be placed on the other panel
          const g = (objOf(side).portGroups || []).find((x) => x.id === el.dataset.pickgroup);
          const ids = g ? rear.filter((pt) => g.portIds.indexOf(pt.id) >= 0).map((pt) => pt.id) : [];
          if (!g || !ids.length || ids.some((id) => idx.portUse[id])) { toast('That group already has connected ports', true); return; }
          st.sel[side] = ids; st.last[side] = ids[0]; st.sel[otherSide(side)] = [];
          st.place = { from: side, gid: g.id, name: g.name, n: ids.length, active: true };
        } else if (el.dataset.pickall) rear.filter(free).forEach((pt) => add(pt.id));
        else if (el.dataset.pickclear) st.sel[side] = [];
        c.draw();
      },
      onHover: (e, c, out) => { // live preview while placing a group: the exact ports it would take light up green (or red when it does not fit)
        c.root.querySelectorAll('.pk.win-ok,.pk.win-bad').forEach((x) => x.classList.remove('win-ok', 'win-bad'));
        if (out || !st.place || !st.place.active) return;
        const el = e.target.closest ? e.target.closest('.pk[data-pick]') : null;
        if (!el || el.dataset.side === st.place.from) return;
        const rear = M.rearPorts(objOf(el.dataset.side)), i = rear.findIndex((x) => x.id === el.dataset.pick), n = st.place.n;
        const ids = rear.slice(i, i + n).map((x) => x.id), ok = ids.length === n && ids.every((id) => !idx.portUse[id]);
        ids.forEach((id) => { const b = c.root.querySelector('.pk[data-side="' + el.dataset.side + '"][data-pick="' + id + '"]'); if (b) b.classList.add(ok ? 'win-ok' : 'win-bad'); });
      },
      onButton: (k, c) => c.close(k === 'ok' ? 'ok' : null)
    });
    if (v !== 'ok') return;
    const picked = st.sel.a.length > 0;
    // a link made from a port group gives the far end a group of its own, linked to the first (own names, hover and click-through)
    const fromG = picked && st.place && (() => {
      const f = M.findPortGroup(S.p, st.place.gid), side = st.place.from;
      if (!f || f.obj.id !== st[side]) return null;
      const rear = M.rearPorts(f.obj).filter((pt) => f.group.portIds.indexOf(pt.id) >= 0).map((pt) => pt.id);
      return rear.length === st.sel[side].length && rear.every((id) => st.sel[side].indexOf(id) >= 0) ? { gid: f.group.id, side: side } : null;
    })();
    const r = commit('Create fixed link', (p) => {
      const link = M.addFixedLink(p, picked
        ? { aObjectId: st.a, bObjectId: st.b, pairs: st.sel.a.map((id, i) => [id, st.sel.b[i]]), cableType: st.cableType, length: st.length, route: st.route }
        : { aObjectId: st.a, bObjectId: st.b, wireCount: st.n, mapping: st.mapping, cableType: st.cableType, length: st.length, route: st.route });
      if (fromG) linkFarGroup(p, fromG.gid, st[otherSide(fromG.side)], st.sel[otherSide(fromG.side)]);
      return link.id;
    });
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
    const v = await formDlg(existing ? 'Edit map' : 'New map', [{ k: 'name', label: 'Name', v: existing ? existing.name : 'Map ' + (M.realMaps(S.p).length + 1) }, { k: 'location', label: 'Location', v: existing ? existing.location : '' }].concat(existing ? [] : [
      { k: 'kind', label: 'Type', type: 'select', opts: [['equipment', 'Equipment map (racks, panels, switches, cables)'], ['floor', 'Floor plan (walls, doors, windows, to-scale links to your equipment)']], v: 'equipment', hint: 'A floor plan is drawn in real centimetres (1 m is always 1 m) and links to equipment that lives on the equipment maps.' }]), 'Save');
    if (!v || !v.name) return;
    if (existing) {
      const kill = await openDialog({ title: 'Map: ' + existing.name, render: () => ({ body: '<p>Save the new name, or delete this map? Deleting a map removes only its layout; equipment and connections stay in the project.</p>', buttons: [{ key: 'cancel', label: 'Cancel' }, { key: 'del', label: 'Delete map', cls: 'danger' }, { key: 'save', label: 'Save', cls: 'primary' }] }), onButton: (k, c) => c.close(k) });
      if (kill === 'del') {
        if (M.realMaps(S.p).length < 2) { toast('A project needs at least one map', true); return; }
        commit('Delete map', (p) => { p.maps = p.maps.filter((m) => m.id !== existing.id); p.placements = p.placements.filter((q) => q.mapId !== existing.id); });
      } else if (kill === 'save') commit('Edit map', (p) => { const m = p.maps.find((x) => x.id === existing.id); m.name = v.name; m.location = v.location; });
    } else {
      let id = null;
      commit('Add map', (p) => { const m = M.addMap(p, { name: v.name, location: v.location, kind: v.kind === 'floor' ? 'floor' : 'equipment' }); if (m.kind === 'floor') m.viewport.zoom = 0.5; id = m.id; });
      if (id) switchMap(id);
    }
  }

  /*
   * Add an item from another map to this one: as a ghost copy (semi-transparent, non-editable, mirrors every change made on its
   * own map) or by relocating it (it leaves its old map). Items that are on no map yet are simply placed.
   */
  /*
   * "Move to another map...": cut an item (a group with its racks and equipment, a rack with what is inside it, or a single device)
   * and paste it, editable, on another map or a new one. Only allowed while nothing in it is patch-corded to anything outside it:
   * patch cables are local, only fixed links may run between maps (they stay and keep a label on this map).
   */
  async function moveToMap(kind, id) {
    const from = curMap().id, c = M.findContainer(S.p, id);
    if (!c || !M.placementOf(S.p, from, id) || M.placementOf(S.p, from, id).ghost) { toast('Open the map where this item lives first', true); return; }
    const blockers = B.patchBlockers(S.p, kind, id);
    if (blockers.length) {
      await openDialog({
        title: "Can't move " + c.item.name,
        render: () => ({
          body: '<p><b>Can\'t move while patch corded</b> - only static (fixed) links may run between maps.</p><p>These patch cables connect it to something outside it:</p><ul>' +
            blockers.map((b) => '<li>' + esc(b.cable) + ': ' + esc(b.inside) + ' &rarr; ' + esc(b.outside) + '</li>').join('') + '</ul><p class="sub">Remove or re-patch them, or replace them with a fixed link, then move it. Cables between things that both move together (inside the same group or rack) are fine.</p>',
          buttons: [{ key: 'x', label: 'Close', cls: 'primary' }]
        }), onButton: (k, cx) => cx.close(null)
      });
      return;
    }
    const others = M.equipmentMaps(S.p).filter((m) => m.id !== from);
    const st = { dest: others.length ? others[0].id : '__new', name: '' };
    const v = await openDialog({
      title: 'Move ' + c.item.name + ' to another map',
      render: () => ({
        body: '<div class="sub">The item moves with everything inside it, as an editable item, and is removed from this map. Its fixed links stay and keep a label here.</div>' +
          fld('To map', '<select data-s="dest">' + opts(others.map((m) => [m.id, m.name]).concat([['__new', '+ New map...']]), st.dest) + '</select>') +
          (st.dest === '__new' ? fld('New map name', '<input type="text" data-s="name" value="' + esc(st.name) + '" placeholder="e.g. ' + esc(c.item.name) + '">') : ''),
        buttons: [{ key: 'no', label: 'Cancel' }, { key: 'ok', label: 'Move', cls: 'primary' }]
      }),
      onChange: (e, cx) => {
        const t = e.target;
        if (t.dataset.s === 'name') { st.name = t.value; return; }
        if (t.dataset.s === 'dest') { st.dest = t.value; cx.draw(); }
      },
      onButton: (k, cx) => cx.close(k === 'ok' ? 'ok' : null)
    });
    if (v !== 'ok') return;
    const destId = st.dest === '__new' ? M.uid('map') : st.dest;
    const ok = commit('Move to another map', (p) => {
      if (st.dest === '__new') p.maps.push({ id: destId, name: st.name.trim() || c.item.name, location: '', viewport: { x: 0, y: 0, zoom: 1 } });
      const spot = B.arrivalSpot(p, destId);
      B.relocate(p, destId, kind, id, spot.x, spot.y, from);
    });
    if (!ok) return;
    S.sel = null;
    toast('Moved ' + c.item.name + ' to ' + (S.p.maps.find((m) => m.id === destId) || {}).name);
    renderAll();
  }
  async function addExisting() {
    const mid = curMap().id, idx = M.buildIndex(S.p);
    const items = [];
    S.p.groups.forEach((g) => { if (!M.placementOf(S.p, mid, g.id)) items.push({ key: 'group:' + g.id, kind: 'group', id: g.id, label: 'Group: ' + g.name }); });
    S.p.objects.forEach((o) => { if (!M.placementOf(S.p, mid, o.id)) items.push({ key: 'object:' + o.id, kind: 'object', id: o.id, label: M.typeLabel(o) + ': ' + o.name }); });
    if (!items.length) { toast('Everything is already on this map'); return; }
    const realMaps = (it) => S.p.placements.filter((q) => q.refId === it.id && !q.ghost).map((q) => q.mapId).filter((m, i, a) => a.indexOf(m) === i && m !== mid);
    const st = { item: items[0].key, mode: 'ghost', from: '', contents: true };
    const cur = () => items.find((x) => x.key === st.item);
    const isCont = (it) => it.kind === 'group' || (idx.objects[it.id] && idx.objects[it.id].type === 'rack');
    const v = await openDialog({
      title: 'Add existing item to this map',
      render: () => {
        const it = cur(), maps = realMaps(it), hasSrc = maps.length > 0;
        if (!hasSrc) st.mode = 'place';
        else if (st.mode === 'place') st.mode = 'ghost';
        if (!maps.some((m) => m === st.from)) st.from = maps[0] || '';
        // a patch-corded item cannot move: patch cables stay on one map, only fixed links may leave
        const blockers = st.mode === 'move' ? B.patchBlockers(S.p, it.kind, it.id) : [];
        const modeOpts = hasSrc ? [['ghost', 'Live copy (ghost) - faded and not editable, mirrors the other map; not a separate item'], ['move', 'Relocate - move it here and remove it from the other map']] : [['place', 'Place it on this map (it is not on any map yet)']];
        return {
          body: fld('Item', '<select data-s="item">' + opts(items.map((x) => [x.key, x.label]), st.item) + '</select>') +
            fld('How', '<select data-s="mode">' + opts(modeOpts, st.mode) + '</select>' + (hasSrc ? '<div class="sub">' + (st.mode === 'ghost' ? 'The same record is drawn here faintly with a blue dashed outline and a LIVE COPY badge. Edit it on the map where it lives; its size follows that map. A ghost never changes layout here and can be removed with the red x.' : 'Layout of the item (and what is inside it) is kept. It is removed from the other map and is editable here.') + '</div>' : '')) +
            (hasSrc && st.mode === 'move' && maps.length > 1 ? fld('Move from', '<select data-s="from">' + opts(maps.map((m) => [m, S.p.maps.find((x) => x.id === m).name]), st.from) + '</select>') : '') +
            (blockers.length ? '<div class="msg-box err-text"><b>Can\'t move while patch corded</b> - only static (fixed) links may run between maps.<br>' + blockers.slice(0, 6).map((b) => esc(b.cable) + ': ' + esc(b.inside) + ' &rarr; ' + esc(b.outside)).join('<br>') + (blockers.length > 6 ? '<br>and ' + (blockers.length - 6) + ' more' : '') + '</div>' : '') +
            (isCont(it) && st.mode !== 'move' ? fld('With contents', '<label><input type="checkbox" data-s="contents"' + (st.contents ? ' checked' : '') + '> include what is inside</label>') : ''),
          buttons: [{ key: 'no', label: 'Cancel' }, { key: 'ok', label: st.mode === 'move' ? 'Relocate here' : (st.mode === 'ghost' ? 'Add ghost copy' : 'Add'), cls: 'primary', disabled: !!blockers.length }]
        };
      },
      onChange: (e, c) => {
        const t = e.target, k = t.dataset.s; if (!k) return;
        st[k] = k === 'contents' ? t.checked : t.value;
        c.draw();
      },
      onButton: (k, c) => c.close(k === 'ok' ? 'ok' : null)
    });
    if (v !== 'ok') return;
    const it = cur(), pos = viewCentre(), mode = st.mode;
    commit(mode === 'move' ? 'Relocate to this map' : (mode === 'ghost' ? 'Add ghost copy' : 'Add to map'), (p) => {
      if (mode === 'ghost') B.addGhost(p, mid, it.kind, it.id, pos.x, pos.y, isCont(it) ? st.contents : false);
      else if (mode === 'move') B.relocate(p, mid, it.kind, it.id, pos.x, pos.y, st.from);
      else B.placeItem(p, mid, it.kind, it.id, pos.x, pos.y, true);
    });
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
        else if (f === 'publicIp') { const io = M.findContainer(p, sel.id).item; if (io.type === 'internet') { if (val) io.publicIp = true; else delete io.publicIp; } }
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
        else if (f === 'pgDevice') M.updatePortGroup(p, sel.id, { deviceKind: val });
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
    const scopeOpts = [['__cur', 'Current map']].concat(shownMaps().map((m) => [m.id, m.name])).concat(M.realMaps(S.p).length > 1 ? [['__all', 'All maps']] : []);
    const v = await formDlg('Export ' + kind.toUpperCase(), [{ k: 'scope', label: 'Maps', type: 'select', opts: scopeOpts, v: '__cur' }], 'Export');
    if (!v) return;
    const ids = v.scope === '__all' ? shownMaps().map((m) => m.id) : [v.scope === '__cur' ? S.mapId : v.scope];
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
    M.syncAllMap(p);
    const fixed = B.normalizeSizes(p), aligned = B.alignToGrid(p);
    M.syncGhosts(p); // sizes and grid alignment moved real items: the overview links follow
    if (fixed) setTimeout(() => toast('Adjusted ' + fixed + ' item(s) (too small to read, or not lined up with their rack)', false), 100);
    else if (aligned) setTimeout(() => toast('Aligned ' + aligned + ' item(s) to the grid (older project)', false), 100);
    Object.keys(BG).forEach((k) => { URL.revokeObjectURL(BG[k].href); delete BG[k]; }); // tracing images belong to the page session, not to a project
    S.rev++; markDirty(false); S.p = p; S.mapId = firstMap().id; S.sel = null; S.multi = []; S.trace = null; S.tool = null; S.undo = []; S.redo = []; S.issues = []; S.showIssues = false;
    saveNow(); renderAll();
    if (p.placements.some((q) => q.mapId === S.mapId)) fitMap();
  }
  /* route optimisation: routes that detour through panels although a fixed link with free wires joins two of their panels directly */
  async function showRoutes() {
    const list = NM.topology.routeShortcuts(S.p);
    const body = list.length
      ? '<div class="sub">These routes pass through more panels than needed: a fixed link with spare or unused wires already joins two of their panels directly. Re-patching onto it would shorten the route.</div>' +
        list.map((r) => '<div class="msg-box" style="margin:8px 0"><b>' + esc(r.aName) + ' &harr; ' + esc(r.bName) + '</b>' +
          '<div class="sub">Now: ' + esc(r.via || 'direct') + '</div>' +
          '<div>Shortcut: <b>' + esc(r.linkName) + '</b> joins <b>' + esc(r.fromName) + '</b> and <b>' + esc(r.toName) + '</b> directly, skipping ' + esc(r.skipped.join(', ')) + ' (' + r.saved + ' fewer panel' + (r.saved === 1 ? '' : 's') + '). Free wire' + (r.freeWires.length === 1 ? '' : 's') + ': ' + r.freeWires.map((n) => 'w' + n).join(', ') + '.</div>' +
          '<div class="btn-row" style="margin-top:6px"><button data-btn="link:' + esc(r.linkId) + '">Show ' + esc(r.linkName) + '</button></div></div>').join('')
      : '<p>No shorter routes found: no route skips panels that a fixed link with free wires could join directly.</p>';
    const k = await openDialog({ title: 'Shorter routes (' + list.length + ')', render: () => ({ body: body, buttons: [{ key: 'x', label: 'Close' }] }), onButton: (key, c) => c.close(key) });
    if (k && k.indexOf('link:') === 0) goTo('link', k.slice(5));
  }
  async function fileMenu() {
    const choice = await openDialog({
      title: 'Project: ' + S.p.name, render: () => ({
        body: '<div class="btn-row" style="flex-direction:column;align-items:stretch">' +
          [['rename', 'Rename project'], ['json', 'Export project as JSON (backup)'], ['import', 'Import JSON...'], ['svg', 'Export map as SVG'], ['png', 'Export map as PNG'], ['pdf', 'Export PDF (maps + connection table)'], ['table', 'Connection table...'], ['routes', 'Find shorter routes...'], ['grid', 'Align everything to the grid'], ['validate', 'Validate project'], ['demo', 'Load demo project...'], ['new', 'New empty project...'], ['help', 'Quick start / help']]
            .map((b) => '<button data-btn="' + b[0] + '">' + b[1] + '</button>').join('') + '</div><p class="sub">Browser autosave is a convenience only. Export a JSON file to back up your work.</p>',
        buttons: [{ key: 'x', label: 'Close' }]
      }), onButton: (k, c) => c.close(k)
    });
    if (!choice || choice === 'x') return;
    if (choice === 'rename') { const v = await formDlg('Rename project', [{ k: 'n', label: 'Name', v: S.p.name }], 'Save'); if (v && v.n) commit('Rename project', (p) => { p.name = v.n; }); }
    else if (choice === 'grid') { const n = commit('Align to grid', (p) => B.alignToGrid(p, true)); toast(typeof n === 'number' && n ? 'Aligned ' + n + ' item(s) to the grid' : 'Everything is already on the grid'); }
    else if (choice === 'routes') showRoutes();
    else if (choice === 'json') exportJson();
    else if (choice === 'import') $('fileInput').click();
    else if (choice === 'svg' || choice === 'png' || choice === 'pdf') exportImages(choice);
    else if (choice === 'table') showTable();
    else if (choice === 'validate') runValidate();
    else if (choice === 'demo') { if (await confirmDlg('Load demo project', 'Replace the current project with the demo? Export a backup first if you need the current one.', 'Load demo', true)) { loadProject(B.buildShowcaseProject()); } }
    else if (choice === 'new') { if (await confirmDlg('New project', 'Replace the current project with an empty one? Export a backup first if you need it.', 'Start empty', true)) loadProject(M.createProject('Untitled project')); }
    else if (choice === 'help') showHelp();
  }
  function runValidate() {
    S.issues = allIssues(); S.showIssues = true; renderLeft(); openLeft();
    const n = S.issues.filter((i) => i.severity !== 'info').length;
    toast(n ? n + ' problem(s) found' : 'No errors or warnings');
  }
  /* Quick start guide: File > Quick start / Help, and once automatically on the first visit with an empty project */
  const KEY_QS = 'netmap.quickstart.seen';
  function showHelp() {
    try { localStorage.setItem(KEY_QS, '1'); } catch (_) { /* ignore */ }
    const li = (t) => '<li>' + t + '</li>';
    const body =
      '<p>NetMap documents <b>what is physically cabled to what</b>: racks, patch panels, switches, routers, wall sockets and the cables between them. Everything stays in your browser (no server); export JSON for real backups.</p>' +
      '<h3>1. Look around (view mode)</h3><ul>' +
      li('<b>Navigation</b> (top left) lists maps and equipment; the search box finds ports, cables and devices by number, label, IP or name.') +
      li('Click a port, cable or device to see its details. <b>Trace</b> follows the complete path across patch panels, fixed links and even <b>across maps</b>.') +
      li('<b>Graph</b> shows how devices interconnect and what can reach what (through switches, routers, port isolation).') + '</ul>' +
      '<h3>2. Build it (press Edit)</h3><ul>' +
      li('Use the toolbar to add a <b>Group</b> (room, building), <b>Rack</b>, <b>Patch panel</b>, <b>Switch</b>, <b>Router</b>, <b>Wall socket</b>, <b>Generic device</b> (PC, camera, AP...) or <b>Internet</b>. The new item sticks to the pointer: click to drop it, <b>Ctrl+click</b> for several. Drop equipment into a rack or group to put it inside.') +
      li('<b>Ctrl+C / Ctrl+V</b> (or "Copy / duplicate") copies an item with its settings, named "... (Copy N)"; cables and IPs are not copied.') +
      li('Panels, switches and routers have sections, uplinks, rows, "full width", folding (click the <b>^</b> on a strip). Change them in the details panel.') + '</ul>' +
      '<h3>3. Connect it</h3><ul>' +
      li('<b>Patch cable</b> (removable lead between two ports): press <b>W</b>, click two ports. With a port selected, W draws one cable from it.') +
      li('<b>Fixed link</b> (installed wiring between two patch panels or wall sockets): toolbar "New fixed link" - pick the free rear ports on both panels, in any pattern (1,3,5,7 to 1-4). <b>The two panels can be on different maps</b>: a link joins the equipment, not the drawing, so a panel in the server room can be wired to a panel in an office on another map. Use <b>"Add existing here..."</b> (toolbar) to show the same panel on a second map.') +
      li('Panels map front N to rear N by default ("Map front N <-> rear N"); otherwise add internal mappings per port.') +
      li('Name sets of ports with <b>port groups</b> (Ctrl+click ports, press <b>G</b>), e.g. "to rack office"; mark ports as occupied by unmodelled equipment with a <b>Plugged-in device</b> (e.g. Cameras x16).') + '</ul>' +
      '<h3>4. Check and share</h3><ul>' +
      li('<b>Network colours and IP addresses</b> on routers and devices: NetMap warns when different subnets are joined by mistake.') +
      li('File menu: <b>Validate project</b>, <b>Find shorter routes</b>, connection table, export SVG / PNG / PDF, import / export JSON, align to grid. <b>History</b> (edit mode) lets you step back or forward to any change.') +
      li('The page warns before you leave with changes that were never exported, and tells you when a new version of NetMap is available.') + '</ul>' +
      '<h3>Shortcuts</h3><table class="t"><tr><td><b>W</b></td><td>patch cable tool / cable from selected port</td><td><b>Ctrl+Z / Y</b></td><td>undo / redo</td></tr>' +
      '<tr><td><b>Ctrl+C / V</b></td><td>copy / paste item</td><td><b>G</b></td><td>name the Ctrl+clicked ports as a group</td></tr>' +
      '<tr><td><b>Ctrl+click</b></td><td>place several / pick several ports</td><td><b>Esc</b></td><td>cancel the current action</td></tr>' +
      '<tr><td><b>Delete</b></td><td>delete selected item</td><td><b>Shift+click</b></td><td>port range in the fixed link picker</td></tr></table>' +
      '<p class="sub">Trace follows only documented connections: patch cables, fixed wires and internal panel mappings. Proximity, groups and shared switches imply nothing. Reopen this guide any time: File &gt; Quick start / help.</p>';
    return openDialog({
      title: 'NetMap quick start', render: () => ({
        body: body,
        buttons: [{ key: 'demo', label: 'Load demo project' }, { key: 'x', label: 'Got it', cls: 'primary' }]
      }), onButton: (k, c) => c.close(k)
    }).then(async (k) => { if (k === 'demo' && (!S.p.objects.length || await confirmDlg('Load demo project', 'Replace the current project with the demo? Export a backup first if you need the current one.', 'Load demo', true))) loadProject(B.buildShowcaseProject()); });
  }

  /* ---------------------------------------------------------------- wiring up */
  function setMode(mode) {
    if (S.mode === mode) return;
    S.mode = mode; S.tool = null; S.drag = null; clearPgroup(); cancelPlace(); floorReset();
    if (mode === 'view') saveNow();
    renderAll();
    toast(mode === 'edit' ? 'Edit mode on' : 'View mode - saved, read-only');
  }

  function bindUi() {
    $('btnMode').onclick = () => setMode(S.mode === 'edit' ? 'view' : 'edit');
    $('btnHistory').onclick = historyDlg; $('btnUndo').onclick = undo; $('btnRedo').onclick = redo;
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
    $('btnMenu').onclick = () => { if (isNarrow()) openLeft(); else setNavHidden(!document.body.classList.contains('nav-hidden')); };
    { let h = false; try { h = localStorage.getItem('netmap.navHidden') === '1'; } catch (_) { /* ignore */ } setNavHidden(h); } $('btnCloseLeft').onclick = closeLeft; $('btnCloseRight').onclick = closeRight;
    $('mapSelect').onchange = (e) => switchMap(e.target.value);
    $('searchBox').oninput = (e) => { S.query = e.target.value; renderLeft(); if (S.query) openLeft(); };
    $('searchBox').onkeydown = (e) => { if (e.key === 'Enter') { const r = M.search(S.p, S.query); if (r[0]) { goTo(r[0].kind, r[0].id); } } };
    $('tabDetails').onclick = () => showTab('details'); $('tabTrace').onclick = () => showTab('trace');
    $('zoomIn').onclick = () => zoomAt(1.25); $('zoomOut').onclick = () => zoomAt(0.8); $('zoomFit').onclick = fitMap;
    // reorder maps: drag the handle in the map list (edit mode)
    $('mapList').addEventListener('pointerdown', (e) => {
      const grip = e.target.closest && e.target.closest('[data-mapgrip]');
      if (!grip || S.mode !== 'edit') return;
      e.preventDefault(); e.stopPropagation();
      const list = $('mapList'), id = grip.dataset.mapgrip;
      const holder = grip.closest('.list-item').parentElement; // maps are reordered within their own list: equipment maps or floor plans
      const rows = () => Array.from(holder.querySelectorAll('.list-item')).filter((r) => r.querySelector('[data-mapgrip]'));
      const row0 = grip.closest('.list-item'); row0.classList.add('dragging');
      let to = rows().indexOf(row0);
      const mark = (i) => { rows().forEach((r, k) => { r.classList.toggle('drop-before', k === i && i <= rows().indexOf(row0) && k !== rows().indexOf(row0)); r.classList.toggle('drop-after', k === i && i > rows().indexOf(row0)); }); };
      const move = (ev) => {
        const rs = rows();
        let k = rs.findIndex((r) => ev.clientY < r.getBoundingClientRect().top + r.getBoundingClientRect().height / 2);
        if (k < 0) k = rs.length - 1;
        to = k; mark(k);
      };
      const done = (ev) => {
        document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', done); document.removeEventListener('pointercancel', done);
        const from = rows().indexOf(row0);
        rows().forEach((r) => r.classList.remove('dragging', 'drop-before', 'drop-after'));
        if (ev.type === 'pointerup' && to !== from) commit('Reorder maps', (p) => M.moveMap(p, id, to));
      };
      document.addEventListener('pointermove', move); document.addEventListener('pointerup', done); document.addEventListener('pointercancel', done);
    });
    $('fileInput').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importFile(f); };
    $('toolbar').addEventListener('change', (e) => {
      const f = e.target.dataset.f;
      if (e.target.hasAttribute('data-floorkind')) { FS.kind = e.target.value; renderToolbar(); return; }
      if (e.target.hasAttribute('data-floorplacesize')) { const p = e.target.value.split('x'); if (FS.place) { FS.place.w = parseInt(p[0], 10); FS.place.d = parseInt(p[1], 10); } renderCanvas(); return; }
      if (e.target.hasAttribute('data-floorsnap')) { FS.snap = parseInt(e.target.value, 10) || 0; return; }
      if (e.target.hasAttribute('data-floorlabels')) { FS.labels = e.target.checked; renderCanvas(); return; }
      if (f === 'toolPreset') { if (e.target.value === 'custom') S.customColorFor = '__tool'; else { S.customColorFor = null; S.cableColor = e.target.value; } renderToolbar(); }
      else if (f === 'toolColor') { S.cableColor = e.target.value; S.customColorFor = null; renderToolbar(); }
    });
    $('toolbar').addEventListener('input', (e) => {
      if (!e.target.hasAttribute('data-floorbgop')) return;
      const bg = floorBg(); if (bg) { bg.opacity = Math.min(1, Math.max(0.05, (parseInt(e.target.value, 10) || 50) / 100)); renderCanvas(); }
    });
    $('bgInput').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) floorLoadImage(f); };
    const imgDrag = (e) => { const t = e.dataTransfer; return !!t && Array.prototype.some.call(t.items || [], (it) => it.kind === 'file' && /^image\//.test(it.type)); };
    document.addEventListener('dragover', (e) => { if (imgDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = floorEditing() ? 'copy' : 'none'; } });
    document.addEventListener('drop', (e) => {
      if (!imgDrag(e)) return;
      e.preventDefault();
      const f = Array.prototype.find.call(e.dataTransfer.files || [], (x) => /^image\//.test(x.type));
      if (f) floorLoadImage(f);
    });
    $('toolbar').onclick = (e) => {
      const a = e.target.closest('button'); if (!a) return;
      if (a.dataset.floortool) floorSetTool(a.dataset.floortool);
      else if (a.dataset.add) createItem(a.dataset.add);
      else if (a.dataset.act === 'patchTool') setTool(S.tool && S.tool.type === 'patch' ? null : { type: 'patch', pending: null, cableType: 'Cat6' });
      else if (a.dataset.act === 'newLink') newLink();
      else if (a.dataset.act === 'addMapItems') addExisting();
    };
    document.addEventListener('change', (e) => { if (e.target.dataset && e.target.dataset.ff && !e.target.closest('dialog') && !e.target.closest('#toolbar')) { floorFieldChange(e.target); return; } if (e.target.dataset && e.target.dataset.f && isEdit() && !e.target.closest('dialog') && !e.target.closest('#toolbar')) onFieldChange(e.target); });
    document.addEventListener('click', (e) => {
      const a = e.target.closest('[data-act]'); if (!a || a.closest('dialog')) return;
      const d = a.dataset;
      switch (d.act) {
        case 'select': select({ kind: d.kind, id: d.id }); break;
        case 'goto': goTo(d.kind, d.id, d.map, !!a.closest('#tracePane')); break;
        case 'trace': startTrace(d.kind, d.id); break;
        case 'clearTrace': clearTrace(); break;
        case 'fitTrace': fitTrace(); break;
        case 'floorAddLink': floorAddLink(); break;
        case 'floorBgPick': $('bgInput').click(); break;
        case 'floorBgRemove': if (BG[curMap().id]) URL.revokeObjectURL(BG[curMap().id].href); delete BG[curMap().id]; if (FS.tool === 'calib' || FS.tool === 'bgmove') FS.tool = 'select'; FS.calib = null; renderAll(); break;
        case 'floorDelete': floorDeleteSelection(); break;
        case 'floorOpen': floorOpenItem(d.id); break;
        case 'goFloor': {
          switchMap(d.map, true); select({ kind: 'flink', id: d.link });
          const lk0 = FL.linkById(floorOf(), d.link), v0 = vpState(), s0 = stageSize(); // bring it to the middle of the view (zoom unchanged)
          if (lk0) { v0.x = s0.w / 2 - lk0.x * v0.zoom; v0.y = s0.h / 2 - lk0.y * v0.zoom; applyVp(); scheduleSave(true); }
          break;
        }
        case 'listAll': S.listAll = !S.listAll; renderLeft(); break;
        case 'traceNet': S.traceNet = !!a.checked; applyTraceNetwork(); renderAll(); showTab('trace'); break;
        case 'seeOnFullMap': seeOnFullMap(); break;
        case 'backFromFullMap': backFromFullMap(); break;
        case 'addToMap': commit('Add to map', (p) => { const pos = viewCentre(); B.placeItem(p, curMap().id, d.kind, d.id, pos.x, pos.y, true); }); break;
        case 'removeFromMap': removeFromThisMap(d.id); break;
        case 'deleteSel': deleteSelection(); break;
        case 'clearMulti': S.multi = []; S.sel = null; renderAll(); break;
        case 'duplicate': if (copySelection(d.kind, d.id, true)) pasteStart(); break;
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
          const spec = { name: $('pgNewName').value, portsText: $('pgNewPorts').value, side: side, color: $('pgNewColor').value, deviceKind: $('pgNewDevice') ? $('pgNewDevice').value || undefined : undefined };
          const g = commit('Add port group', (p) => M.addPortGroup(p, id, spec));
          if (g && g !== true) { S.sel = { kind: 'pgroup', id: g.id }; renderAll(); }
          break;
        }
        case 'resetLabel': commit('Reset label position', (p) => M.setLinkLabelOffset(p, d.id, curMap().id, 0, 0)); break;
        case 'openOriginal': openOriginal(d.kind, d.id); break;
        case 'moveToMap': moveToMap(d.kind, d.id); break;
        case 'unlinkPGroup': commit('Unlink port groups', (p) => M.unlinkPortGroup(p, d.id)); break;
        case 'deletePGroup': { const f = M.findPortGroup(S.p, d.id), oid = f && f.obj.id; commit('Delete port group', (p) => M.deletePortGroup(p, d.id)); if (oid) { S.sel = { kind: 'object', id: oid }; renderAll(); } break; }
        case 'linkFromGroup': {
          const f = M.findPortGroup(S.p, d.id), idx = M.buildIndex(S.p);
          const ids = f.group.portIds.filter((pid) => idx.ports[pid].side === 'rear' && !idx.portUse[pid]);
          if (!ids.length) { toast('No free rear ports in this group', true); break; }
          S.pgroup = { objId: f.obj.id, ids: ids, last: ids[ids.length - 1], gid: f.group.id }; S.hoverPort = null; S.preview = null;
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
        case 'demo': loadProject(B.buildShowcaseProject()); break;
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
      floorModifierKey(e);
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'a' && !typing) { e.preventDefault(); selectAll(); return; } // never select the page, only the items in the editor
      if (!typing && floorKey(e)) { e.preventDefault(); return; }
      if (e.key === 'Escape') { if (S.place) cancelPlace(); else if (S.pgroup) { clearPgroup(); renderAll(); } else if (S.tool) cancelTool(); else if (S.trace) clearTrace(); else if (S.sel || S.multi.length) { S.sel = null; S.multi = []; renderAll(); } }
      else if (isEdit() && !typing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
      else if (isEdit() && !typing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
      else if (isEdit() && !typing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') { if (S.sel && (S.sel.kind === 'object' || S.sel.kind === 'group')) { e.preventDefault(); copySelection(); } }
      else if (isEdit() && !typing && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') { if (S.clip) { e.preventDefault(); pasteStart(); } }
      else if (isEdit() && !typing && (e.key === 'Delete')) deleteSelection();
      else if (isEdit() && !typing && !e.ctrlKey && !e.metaKey && !e.altKey && S.pgroup && (e.key === 'g' || e.key === 'G')) { e.preventDefault(); nameSelectedPorts(); }
      else if (!typing && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'w' || e.key === 'W')) { e.preventDefault(); startWire(); }
    });
    document.addEventListener('keyup', floorModifierKey);
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
    M.syncAllMap(S.p);
    if (B.normalizeSizes(S.p) | B.alignToGrid(S.p)) { M.syncGhosts(S.p); saveNow(); }
    S.mapId = firstMap().id;
    loadCollapsed();
    bindUi(); bindCanvas();
    renderAll();
    if (S.p.placements.some((q) => q.mapId === S.mapId)) { const v = vpState(); if (v.zoom === 1 && v.x === 0 && v.y === 0) fitMap(); }
    S.savedAt = new Date(); setStatus(); renderUpdate();
    // first visit with an empty project: show the quick start once (not under automated browsers)
    try { if (!navigator.webdriver && !localStorage.getItem(KEY_QS) && !S.p.objects.length) setTimeout(showHelp, 300); } catch (_) { /* ignore */ }
    setTimeout(checkVersion, 3000);
    NM.app.ready = true;
  }
  /* ---- new-version detection: version.json is polled every minute; the page is never reloaded for the user ---- */
  function renderUpdate() {
    const cur = NM.version || 'dev', stale = !!S.newVersion;
    $('verInfo').textContent = 'v' + cur;
    $('verInfo').title = isLocalCopy() ? 'Version of the code in this page. This is a downloaded copy opened from disk (not served by a web server): updates come from the repository' : 'Version of the code running in this page';
    $('btnUpdate').hidden = !stale;
    const bar = $('updateBar');
    bar.hidden = !stale || S.updateHidden;
    if (stale && !S.updateHidden) {
      if (isLocalCopy()) bar.innerHTML = '<span class="msg"><b>A different version of NetMap is published in the repository</b> (this local copy is v' + esc(cur) + ', the repository has v' + esc(S.newVersion) + '). ' +
        'Please download the new version from the repository' + (S.fileDirty ? ' - first <b>Export JSON</b>, you have changes that were not exported' : '') + '. Nothing is changed automatically.</span>' +
        '<a class="btn primary" href="' + REPO_URL + '" target="_blank" rel="noopener">Open the repository</a>' + (S.fileDirty ? '<button data-upd="export">Export JSON now</button>' : '') + '<button data-upd="hide">Remind me later</button>';
      else bar.innerHTML = '<span class="msg"><b>A new version of NetMap is available</b> (this page runs v' + esc(cur) + ', latest v' + esc(S.newVersion) + '). ' +
        'Save your work first - ' + (S.fileDirty ? 'you have changes that were not exported - ' : '') + 'use <b>Export JSON</b> - then reload with <b>F5</b> or <b>Ctrl+R</b>. Nothing is reloaded automatically.</span>' +
        '<button data-upd="export" class="primary">Export JSON now</button><button data-upd="hide">Remind me later</button>';
    }
  }
  /* where the published version lives: a copy opened from disk (file:) has no server of its own to ask, so it asks the repository */
  const REPO_URL = 'https://github.com/tematech-nz/test';
  const REPO_VERSION_URL = 'https://raw.githubusercontent.com/tematech-nz/test/main/version.json';
  const isLocalCopy = () => location.protocol === 'file:';
  async function checkVersion() {
    if (!NM.version) return null; // built without version info
    try {
      const r = await fetch(isLocalCopy() ? REPO_VERSION_URL + '?t=' + Date.now() : 'version.json?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return null;
      const v = (await r.json()).version;
      if (v && v !== NM.version && v !== S.newVersion) {
        S.newVersion = v; S.updateHidden = false;
        toast(isLocalCopy() ? 'A different version is published in the repository - please download the new version from the repository' : 'A new version of NetMap is available - export your project, then reload (F5)', true);
      }
      renderUpdate();
      return v;
    } catch (e) { return null; } // offline, or no version.json
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest && e.target.closest('[data-upd]');
    if (!b) return;
    if (b.dataset.upd === 'export') { exportJson(); renderUpdate(); } else { S.updateHidden = true; renderUpdate(); }
  });
  NM.app.api = {
    checkVersion: checkVersion, pollMs: POLL_MS,
    commit: commit, goTo: goTo, setMode: setMode, startTrace: startTrace, loadProject: loadProject, select: select,
    undo: undo, redo: redo, saveNow: saveNow, fitMap: fitMap, moveToMap: moveToMap
  };
  init();
})();
