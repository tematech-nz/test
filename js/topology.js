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
    p.objects.forEach(function (o) {
      if (PASSIVE[o.type]) return;
      nodes[o.id] = {
        id: o.id, name: o.name, type: o.type, ip: o.ipAddress || '', nets: nodeNets(o),
        transit: !TERMINAL[o.type] || (o.type === 'internet' && !!opts.viaInternet)
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
          else if (s.type === 'port' && idx.portObj[s.id].type === 'patchpanel') {
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
      if (!l) { l = links[key] = { id: 'lk' + linkList.length, a: e.a < e.b ? e.a : e.b, b: e.a < e.b ? e.b : e.a, paths: [] }; linkList.push(l); adj[e.a].push({ to: e.b, link: l }); adj[e.b].push({ to: e.a, link: l }); }
      l.paths.push(e);
    });
    return { nodes: nodes, order: order, links: linkList, adj: adj, dangling: dangling };
  }

  /* breadth-first tree of everything reachable from rootId (shortest hop count) */
  function reachTree(graph, rootId) {
    var depth = {}, parent = {}, parentLink = {}, queue = [rootId], out = [];
    depth[rootId] = 0;
    while (queue.length) {
      var id = queue.shift();
      out.push({ id: id, depth: depth[id], parent: parent[id] || null, link: parentLink[id] || null });
      if (id !== rootId && !graph.nodes[id].transit) continue;
      (graph.adj[id] || []).forEach(function (n) {
        if (depth[n.to] === undefined) { depth[n.to] = depth[id] + 1; parent[n.to] = id; parentLink[n.to] = n.link; queue.push(n.to); }
      });
    }
    var unreachable = graph.order.filter(function (id) { return depth[id] === undefined; });
    return { order: out, depth: depth, unreachable: unreachable };
  }

  /* all simple paths from -> to; transit rules apply; shortest first */
  function allPaths(graph, from, to, limit, maxHops) {
    limit = limit || 100; maxHops = maxHops || 12;
    var out = [], visited = {};
    function dfs(id, nodes, links) {
      if (out.length >= limit * 4) return;
      if (id === to) { out.push({ nodes: nodes.slice(), links: links.slice() }); return; }
      if (nodes.length - 1 >= maxHops) return;
      if (id !== from && !graph.nodes[id].transit) return;
      (graph.adj[id] || []).forEach(function (n) {
        if (visited[n.to]) return;
        visited[n.to] = true; nodes.push(n.to); links.push(n.link);
        dfs(n.to, nodes, links);
        nodes.pop(); links.pop(); visited[n.to] = false;
      });
    }
    if (!graph.nodes[from] || !graph.nodes[to] || from === to) return [];
    visited[from] = true;
    dfs(from, [from], []);
    out.sort(function (a, b) { return a.nodes.length - b.nodes.length; });
    return out.slice(0, limit);
  }

  NM.topology = { buildGraph: buildGraph, reachTree: reachTree, allPaths: allPaths, subnetOf: subnetOf, PASSIVE: PASSIVE, TERMINAL: TERMINAL };
  if (typeof module !== 'undefined' && module.exports) module.exports = NM.topology;
})(typeof window !== 'undefined' ? window : globalThis);
