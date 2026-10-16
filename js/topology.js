/*
 * Device-level topology: collapses passive cabling (patch cables, patch panels, fixed links) into links between
 * active devices, then answers "how can I theoretically reach X from Y?". Physical reachability only.
 */
(function (g) {
  'use strict';
  var NM = g.NetMap = g.NetMap || {};
  if (typeof require === 'function') { if (!NM.model) require('./model.js'); if (!NM.trace) require('./trace.js'); }
  var M = NM.model, T = NM.trace;

  var PASSIVE = { rack: true, patchpanel: true };
  /* endpoints: traffic ends here and does not pass through, unless the user allows transit */
  var TERMINAL = { socket: true, generic: true, internet: true };

  /* "192.168.1.5/24" -> "192.168.1.0/24"; anything without a valid IPv4 prefix -> null */
  function subnetOf(ip) {
    var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(String(ip || '').trim());
    if (!m || +m[5] > 32) return null;
    var oct = [+m[1], +m[2], +m[3], +m[4]];
    if (oct.some(function (x) { return x > 255; })) return null;
    var n = ((oct[0] * 16777216) + (oct[1] * 65536) + (oct[2] * 256) + oct[3]);
    var bits = +m[5], size = Math.pow(2, 32 - bits), net = Math.floor(n / size) * size;
    return [Math.floor(net / 16777216) % 256, Math.floor(net / 65536) % 256, Math.floor(net / 256) % 256, net % 256].join('.') + '/' + bits;
  }

  function nodeNets(o) {
    var out = [];
    [o.ipAddress].concat(o.ports.map(function (pt) { return pt.ip; })).forEach(function (ip) {
      var s = subnetOf(ip);
      if (s && out.indexOf(s) < 0) out.push(s);
    });
    return out;
  }

  /* opts.viaInternet: allow paths to pass through Internet nodes */
  function buildGraph(p, opts) {
    opts = opts || {};
    var idx = M.buildIndex(p), nodes = {}, order = [], seen = {}, edges = [], dangling = [];
    // a wall socket with a device plugged into it is just a pass-through of the cabling; one at the end of a lead from a panel is an endpoint
    function pluggedSocket(o) {
      return o.type === 'socket' && o.ports.some(function (pt) {
        var u = pt.side !== 'rear' && idx.portUse[pt.id];
        if (!(u && u.kind === 'patch' && idx.portObj[u.other] && !M.isTermination(idx.portObj[u.other]))) return false; // a device lead plugged into the outlet...
        var m = idx.mapByPort[pt.id];
        return !!(m && idx.portUse[m.other] && idx.portUse[m.other].kind === 'wire'); // ...whose rear carries installed cabling onward
      });
    }
    p.objects.forEach(function (o) {
      if (PASSIVE[o.type] || pluggedSocket(o)) return;
      nodes[o.id] = {
        id: o.id, name: o.name, type: o.type, label: M.typeLabel(o), ip: o.ipAddress || '', nets: nodeNets(o),
        transit: !TERMINAL[o.type] || (o.type === 'internet' && !!opts.viaInternet),
        isolated: o.type === 'switch' && !!o.portIsolation
      };
      order.push(o.id);
    });
    order.forEach(function (nid) {
      idx.objects[nid].ports.forEach(function (pt) {
        if (!idx.portUse[pt.id]) return;
        var tr = T.tracePort(p, pt.id, idx);
        if (!tr || tr.path.length < 2) return;
        var last = tr.path[tr.path.length - 1];
        if (last.type !== 'port') return;
        var far = idx.portObj[last.id];
        if (!far || far.id === nid) return;
        if (!nodes[far.id]) { if (PASSIVE[far.type]) dangling.push({ portId: pt.id, objectId: nid, endsAt: far.id }); return; }
        var key = [pt.id, last.id].sort().join('|');
        if (seen[key]) return;
        seen[key] = true;
        var via = [];
        tr.path.forEach(function (s) {
          if (s.type === 'patch') via.push(idx.cables[s.id].name);
          else if (s.type === 'wire') { var l = idx.wireLink[s.id], w = idx.wires[s.id]; via.push(l.name + ' w' + w.number); }
          else if (s.type === 'port' && M.isTermination(idx.portObj[s.id])) {
            var nm = idx.portObj[s.id].name;
            if (via[via.length - 1] !== nm && s.id !== pt.id && s.id !== last.id) via.push(nm);
          }
        });
        edges.push({ a: nid, b: far.id, aPortId: pt.id, bPortId: last.id, via: via, trace: tr });
      });
    });
    // aggregate parallel physical paths between the same two devices into one link
    var links = {}, linkList = [], adj = {};
    order.forEach(function (id) { adj[id] = []; });
    edges.forEach(function (e) {
      var key = [e.a, e.b].sort().join('|');
      var l = links[key];
      if (!l) { l = links[key] = { id: 'lk' + linkList.length, a: e.a < e.b ? e.a : e.b, b: e.a < e.b ? e.b : e.a, paths: [], uplinkAt: {} }; linkList.push(l); adj[e.a].push({ to: e.b, link: l }); adj[e.b].push({ to: e.a, link: l }); }
      l.paths.push(e);
      if (idx.ports[e.aPortId].role === 'uplink') l.uplinkAt[e.a] = true;
      if (idx.ports[e.bPortId].role === 'uplink') l.uplinkAt[e.b] = true;
    });
    return { nodes: nodes, order: order, links: linkList, adj: adj, dangling: dangling };
  }

  /*
   * May traffic arriving at nodeId over inLink continue over outLink? Endpoints never pass traffic; a switch with port
   * isolation only forwards between an access port and an uplink port (never access to access).
   */
  function canPass(graph, nodeId, inLink, outLink, rootId) {
    if (nodeId === rootId) return true;
    var n = graph.nodes[nodeId];
    if (!n.transit) return false;
    if (inLink && outLink && inLink === outLink && n.type !== 'router') return false; // no U-turn on the same link (a router on a stick may)
    if (n.isolated && inLink && outLink) return !!(inLink.uplinkAt[nodeId] || outLink.uplinkAt[nodeId]);
    return true;
  }

  /*
   * Breadth-first tree of everything reachable from rootId (shortest hop count). States are (device, arrival link), so
   * port isolation is exact: devices on an isolated switch's access ports can only meet by going up an uplink and
   * coming back down (for example through a router), which counts as a longer path.
   */
  function reachTree(graph, rootId) {
    var depth = {}, seenState = {}, queue = [{ id: rootId, via: null, d: 0 }], out = [];
    depth[rootId] = 0;
    out.push({ id: rootId, depth: 0, parent: null, link: null });
    seenState[rootId + '|'] = true;
    while (queue.length) {
      var st = queue.shift();
      (graph.adj[st.id] || []).forEach(function (n) {
        if (!canPass(graph, st.id, st.via, n.link, rootId)) return;
        var key = n.to + '|' + n.link.id;
        if (seenState[key]) return;
        seenState[key] = true;
        if (depth[n.to] === undefined) {
          depth[n.to] = st.d + 1;
          out.push({ id: n.to, depth: st.d + 1, parent: st.id, link: n.link });
        }
        queue.push({ id: n.to, via: n.link, d: st.d + 1 });
      });
    }
    var unreachable = graph.order.filter(function (id) { return depth[id] === undefined; });
    return { order: out, depth: depth, unreachable: unreachable };
  }

  /* all paths from -> to; transit and isolation rules apply; shortest first. Devices are visited once, except isolated switches (up and back down) */
  function allPaths(graph, from, to, limit, maxHops) {
    limit = limit || 100; maxHops = maxHops || 12;
    var out = [], visited = {};
    function cap(id) { return graph.nodes[id].isolated ? 2 : 1; }
    function dfs(id, nodes, links) {
      if (out.length >= limit * 4) return;
      if (id === to) { out.push({ nodes: nodes.slice(), links: links.slice() }); return; }
      if (nodes.length - 1 >= maxHops) return;
      var inLink = links.length ? links[links.length - 1] : null;
      (graph.adj[id] || []).forEach(function (n) {
        if ((visited[n.to] || 0) >= cap(n.to)) return;
        if (!canPass(graph, id, inLink, n.link, from)) return;
        visited[n.to] = (visited[n.to] || 0) + 1; nodes.push(n.to); links.push(n.link);
        dfs(n.to, nodes, links);
        nodes.pop(); links.pop(); visited[n.to]--;
      });
    }
    if (!graph.nodes[from] || !graph.nodes[to] || from === to) return [];
    visited[from] = 1;
    dfs(from, [from], []);
    out.sort(function (a, b) { return a.nodes.length - b.nodes.length; });
    return out.slice(0, limit);
  }

  NM.topology = { canPass: canPass, buildGraph: buildGraph, reachTree: reachTree, allPaths: allPaths, subnetOf: subnetOf, PASSIVE: PASSIVE, TERMINAL: TERMINAL };
  if (typeof module !== 'undefined' && module.exports) module.exports = NM.topology;
})(typeof window !== 'undefined' ? window : globalThis);
