/* End-to-end physical tracing. Follows only documented patch cables, fixed wires and internal mappings. */
(function (g) {
  'use strict';
  var NM = g.NetMap = g.NetMap || {};
  if (typeof require === 'function' && !NM.model) require('./model.js');
  var M = NM.model;

  function edgesOf(idx, portId) {
    var out = [], u = idx.portUse[portId], m = idx.mapByPort[portId];
    if (u) out.push({ kind: u.kind === 'patch' ? 'patch' : 'wire', id: u.id, linkId: u.linkId || null, to: u.other });
    if (m) out.push({ kind: 'internal', id: m.id, to: m.other });
    return out;
  }

  function walk(idx, startId, first) {
    var seq = [], visited = {}, edge = first, cycle = false;
    visited[startId] = true;
    while (edge) {
      seq.push({ type: edge.kind, id: edge.id, linkId: edge.linkId || null });
      if (visited[edge.to]) { cycle = true; break; }
      visited[edge.to] = true;
      seq.push({ type: 'port', id: edge.to });
      var next = null, list = edgesOf(idx, edge.to);
      for (var i = 0; i < list.length; i++) if (list[i].id !== edge.id) { next = list[i]; break; }
      edge = next;
    }
    return { seq: seq, cycle: cycle };
  }

  function endReason(p, idx, lastPortId, cycle) {
    if (cycle) return { code: 'cycle', text: 'Path loops back on itself' };
    var o = idx.portObj[lastPortId], pt = idx.ports[lastPortId];
    if (!o) return { code: 'unresolved', text: 'Unresolved termination' };
    if (o.type === 'patchpanel') {
      if (pt.side === 'rear') return { code: 'open', text: 'Open: rear termination on ' + o.name + ' has no fixed wire' };
      return { code: 'open', text: 'Open: front port on ' + o.name + ' has no documented onward connection' };
    }
    if (o.type === 'mediaconverter') return { code: 'open', text: 'Open: the other side of ' + o.name + ' has no documented onward connection' };
    return { code: 'endpoint', text: 'Terminates at ' + o.name };
  }

  /* trace through one port; result path is an ordered list of {type:'port'|'patch'|'wire'|'internal', id} */
  function tracePort(p, portId, idx) {
    idx = idx || M.buildIndex(p);
    if (!idx.ports[portId]) return null;
    var start = edgesOf(idx, portId), left = { seq: [], cycle: false }, right = { seq: [], cycle: false };
    if (start[0]) right = walk(idx, portId, start[0]);
    if (start[1]) left = walk(idx, portId, start[1]);
    var path = left.seq.slice().reverse().concat([{ type: 'port', id: portId }], right.seq);
    function endOf(w) {
      var last = null;
      for (var i = w.seq.length - 1; i >= 0; i--) if (w.seq[i].type === 'port') { last = w.seq[i].id; break; }
      return endReason(p, idx, last || portId, w.cycle);
    }
    var res = { startPortId: portId, path: path, ends: [endOf(left)] };
    if (start.length) res.ends.push(endOf(right));
    return res;
  }

  function highlightSets(p, traces, idx) {
    idx = idx || M.buildIndex(p);
    var h = { objects: {}, ports: {}, cables: {}, links: {}, wires: {} };
    traces.forEach(function (t) {
      t.path.forEach(function (s) {
        if (s.type === 'port') { h.ports[s.id] = true; if (idx.portObj[s.id]) h.objects[idx.portObj[s.id].id] = true; }
        else if (s.type === 'patch') h.cables[s.id] = true;
        else if (s.type === 'wire') { h.wires[s.id] = true; if (s.linkId) h.links[s.linkId] = true; }
      });
    });
    return h;
  }

  /* target: {kind:'port'|'cable'|'wire'|'link'|'object', id} */
  function traceTarget(p, target) {
    var idx = M.buildIndex(p), ports = [];
    if (target.kind === 'port') ports = [target.id];
    else if (target.kind === 'cable') { var c = idx.cables[target.id]; if (c) ports = [c.aPortId]; }
    else if (target.kind === 'wire') { var w = idx.wires[target.id]; if (w) ports = [w.aPortId || w.bPortId]; }
    else if (target.kind === 'link') { var l = idx.links[target.id]; if (l) ports = l.wires.map(function (x) { return x.aPortId || x.bPortId; }); }
    ports = ports.filter(Boolean);
    var traces = ports.map(function (pid) { return tracePort(p, pid, idx); }).filter(Boolean);
    return { target: target, traces: traces, highlight: highlightSets(p, traces, idx) };
  }

  /* human-readable lines for the trace panel */
  function describe(p, trace) {
    var idx = M.buildIndex(p);
    return trace.path.map(function (s) {
      var line = { type: s.type, id: s.id };
      if (s.type === 'port') {
        line.text = M.portName(p, s.id, idx); line.objectId = idx.portObj[s.id] && idx.portObj[s.id].id;
        line.maps = line.objectId ? M.mapsFor(p, 'object', line.objectId) : [];
      } else if (s.type === 'patch') {
        line.text = 'Patch cable ' + idx.cables[s.id].name + ' (' + idx.cables[s.id].cableType + ')'; line.cableId = s.id;
      } else if (s.type === 'wire') {
        var l = idx.wireLink[s.id], w = idx.wires[s.id];
        line.text = 'Fixed link ' + l.name + ', wire ' + w.number; line.linkId = l.id;
        line.maps = M.mapsFor(p, 'link', l.id);
      } else {
        line.text = 'Internal panel mapping';
      }
      return line;
    });
  }

  NM.trace = { tracePort: tracePort, traceTarget: traceTarget, highlightSets: highlightSets, describe: describe };
  if (typeof module !== 'undefined' && module.exports) module.exports = NM.trace;
})(typeof window !== 'undefined' ? window : globalThis);
