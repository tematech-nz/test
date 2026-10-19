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

  /* IP addresses carry no prefix, so a subnet is assumed to be a /24: "192.168.1.5" -> "192.168.1.0/24" (invalid or empty -> null) */
  function subnetOf(ip) {
    var q = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || '').trim());
    if (!q || [q[1], q[2], q[3], q[4]].some(function (x) { return +x > 255; })) return null;
    return +q[1] + '.' + +q[2] + '.' + +q[3] + '.0/24';
  }
  function nodeNets(o) {
    var out = [];
    var ips = o.type === 'generic' || o.type === 'router' ? o.ports.map(function (pt) { return M.effectivePortIp(o, pt); }).concat(o.ports.length ? [] : [o.ipAddress]) : [o.ipAddress].concat(o.ports.map(function (pt) { return pt.ip; }));
    ips.forEach(function (ip) {
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
        id: o.id, name: o.name, type: o.type, label: M.typeLabel(o), ip: M.ipList(o).map(function (x) { return x.ip; }).filter(function (v, i, a) { return a.indexOf(v) === i; }).join(', '), nets: nodeNets(o),
        transit: !TERMINAL[o.type] || (o.type === 'internet' && !!opts.viaInternet),
        isolated: o.type === 'switch' && !!o.portIsolation,
        publicIp: o.type === 'internet' && !!o.publicIp,
        dhcp: !!o.dhcp && (o.type === 'generic' || o.type === 'switch')
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
        // one physical path is found from both ends (and, through a wall socket, even from its front jack): key it by the cables and wires it uses
        var segs = tr.path.filter(function (s) { return s.type === 'patch' || s.type === 'wire'; }).map(function (s) { return s.id; }).sort();
        var key = segs.length ? segs.join('|') : [pt.id, last.id].sort().join('|');
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
    // a DHCP device has no address of its own to read a subnet from: it is in the LAN of the router it hangs off (reached over switches only)
    order.forEach(function (id) {
      var n = nodes[id];
      if (!n.dhcp) return;
      var seenN = {}, stack = [id]; seenN[id] = true;
      while (stack.length) {
        var cur = stack.pop();
        (adj[cur] || []).forEach(function (e) {
          if (seenN[e.to]) return;
          var far = nodes[e.to];
          if (far.type === 'router') {
            e.link.paths.forEach(function (pe) {
              [pe.aPortId, pe.bPortId].forEach(function (pid) {
                var po = idx.portObj[pid];
                if (!po || po.id !== e.to || idx.ports[pid].role !== 'lan') return;
                var s = subnetOf(M.effectivePortIp(po, idx.ports[pid]));
                if (s && n.nets.indexOf(s) < 0) n.nets.push(s);
              });
            });
          } else if (far.type === 'switch') { seenN[e.to] = true; stack.push(e.to); }
        });
      }
    });
    return { nodes: nodes, order: order, links: linkList, adj: adj, dangling: dangling };
  }

  /*
   * May traffic arriving at nodeId over inLink continue over outLink? Endpoints never pass traffic; a switch with port
   * isolation only forwards between an access port and an uplink port (never access to access).
   */
  /*
   * hair: the isolated switches this path has already left through an uplink (it went up from an access port). Coming back down into
   * one of them (a router turning the traffic round) is only believed when the addresses prove it is routed: both ends have an address
   * and they are in different subnets. Hosts in one subnet talk directly (ARP), which the isolated switch stops, and a router does not
   * carry traffic between two hosts of one subnet; with no address on one side the safe reading of "isolated" applies: no route.
   */
  function routedApart(graph, a, b) {
    var na = graph.nodes[a] && graph.nodes[a].nets, nb = graph.nodes[b] && graph.nodes[b].nets;
    if (!na || !nb || !na.length || !nb.length) return false;
    return !na.some(function (x) { return nb.indexOf(x) >= 0; });
  }
  function canPass(graph, nodeId, inLink, outLink, rootId, hair) {
    if (nodeId === rootId || (rootId && typeof rootId === 'object' && rootId[nodeId])) return true;
    var n = graph.nodes[nodeId];
    if (!n.transit) return false;
    if (inLink && outLink && inLink === outLink && n.type !== 'router') return false; // no U-turn on the same link (a router on a stick may)
    if (n.isolated && inLink && outLink) {
      if (!(inLink.uplinkAt[nodeId] || outLink.uplinkAt[nodeId])) return false;
      if (hair && hair[nodeId] && inLink.uplinkAt[nodeId] && !outLink.uplinkAt[nodeId]) { // back down into the switch the path came up from
        var dest = outLink.a === nodeId ? outLink.b : outLink.a, roots = rootId && typeof rootId === 'object' ? Object.keys(rootId) : [rootId];
        if (!roots.every(function (r) { return routedApart(graph, r, dest); })) return false;
      }
    }
    return true;
  }
  /* the isolated switches left through an uplink after entering from an access port (the route so far, as {id: true}) */
  function hairAfter(graph, nodeId, inLink, outLink, hair) {
    var n = graph.nodes[nodeId];
    if (!(n && n.isolated && inLink && outLink && !inLink.uplinkAt[nodeId] && outLink.uplinkAt[nodeId]) || (hair && hair[nodeId])) return hair || {};
    var h = {}; Object.keys(hair || {}).forEach(function (k) { h[k] = true; }); h[nodeId] = true; return h;
  }

  /*
   * Breadth-first tree of everything reachable from rootId (shortest hop count). States are (device, arrival link), so
   * port isolation is exact: devices on an isolated switch's access ports can only meet by going up an uplink and
   * coming back down (for example through a router), which counts as a longer path.
   */
  function reachTree(graph, rootId) {
    var roots = [].concat(rootId), rootSet = {}, depth = {}, seenState = {}, queue = [], out = [];
    roots.forEach(function (r) {
      rootSet[r] = true; depth[r] = 0; seenState[r + '|'] = true;
      queue.push({ id: r, via: null, d: 0, hair: {} });
      out.push({ id: r, depth: 0, parent: null, link: null });
    });
    rootId = rootSet;
    while (queue.length) {
      var st = queue.shift();
      (graph.adj[st.id] || []).forEach(function (n) {
        if (!canPass(graph, st.id, st.via, n.link, rootId, st.hair)) return;
        var hair = hairAfter(graph, st.id, st.via, n.link, st.hair);
        var key = n.to + '|' + n.link.id + '|' + Object.keys(hair).sort().join(',');
        if (seenState[key]) return;
        seenState[key] = true;
        if (depth[n.to] === undefined) {
          depth[n.to] = st.d + 1;
          out.push({ id: n.to, depth: st.d + 1, parent: st.id, link: n.link });
        }
        queue.push({ id: n.to, via: n.link, d: st.d + 1, hair: hair });
      });
    }
    var unreachable = graph.order.filter(function (id) { return depth[id] === undefined; });
    return { order: out, depth: depth, unreachable: unreachable };
  }

  /*
   * The pseudo end "Internet (all ISPs)": a project often has one Internet object per ISP. INTERNET stands for all of them, so "from" it
   * gives everything any ISP can reach, and "to" it gives how a device gets out through any of them.
   */
  var INTERNET = '@internet';
  /* inbound: the starting side of "what can be reached" - only an ISP with a public IP lets the Internet start a connection into the network */
  function endpoints(graph, v, inbound) {
    if (v === INTERNET) return graph.order.filter(function (id) { return graph.nodes[id].type === 'internet' && (!inbound || graph.nodes[id].publicIp); });
    return graph.nodes[v] ? [v] : [];
  }
  function pathsBetween(graph, from, to, limit, maxHops) {
    var out = [];
    endpoints(graph, from, true).forEach(function (a) {
      endpoints(graph, to).forEach(function (b) { allPaths(graph, a, b, limit, maxHops).forEach(function (p) { out.push(p); }); });
    });
    out.sort(function (x, y) { return x.nodes.length - y.nodes.length; });
    return out.slice(0, limit || 100);
  }
  /* all paths from -> to; transit and isolation rules apply; shortest first. Devices are visited once, except isolated switches (up and back down) */
  function allPaths(graph, from, to, limit, maxHops) {
    limit = limit || 100; maxHops = maxHops || 12;
    var out = [], visited = {};
    function cap(id) { return graph.nodes[id].isolated ? 2 : 1; }
    function hairOf(nodes, links) { // isolated switches this route has already gone up out of
      var h = {};
      for (var i = 1; i < nodes.length - 1; i++) h = hairAfter(graph, nodes[i], links[i - 1], links[i], h);
      return h;
    }
    function dfs(id, nodes, links) {
      if (out.length >= limit * 4) return;
      if (id === to) { out.push({ nodes: nodes.slice(), links: links.slice() }); return; }
      if (nodes.length - 1 >= maxHops) return;
      var inLink = links.length ? links[links.length - 1] : null;
      (graph.adj[id] || []).forEach(function (n) {
        if ((visited[n.to] || 0) >= cap(n.to)) return;
        if (!canPass(graph, id, inLink, n.link, from, hairOf(nodes, links))) return;
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

  /*
   * "Show all links in this network": the connections that share a network with the ends of a trace, as a list of physical traces
   * (feed them to trace.highlightSets). A network is the Layer-2 domain of an end port: switches flood it (port isolation honoured:
   * from an access port of an isolated switch only its uplinks and what lies beyond them), routers, devices and the Internet end it
   * (their own link is part of it, nothing behind them). A router's WAN port leads downstream: the network behind a WAN port is the
   * LAN side of that router, so tracing a cable between one router's LAN and another's WAN shows everything on the downstream LAN.
   */
  function networkTraces(p, traces, graph) {
    graph = graph || buildGraph(p, {});
    var idx = M.buildIndex(p), linkOfPort = {}, out = [], seen = {};
    graph.links.forEach(function (l) { l.paths.forEach(function (e) { linkOfPort[e.aPortId] = l; linkOfPort[e.bPortId] = l; }); });
    function addLink(l) { if (seen[l.id]) return; seen[l.id] = true; l.paths.forEach(function (e) { out.push(e.trace); }); }
    function flood(startNode, inLink) {
      var done = {}, queue = [{ n: startNode, l: inLink }];
      while (queue.length) {
        var c = queue.shift(), key = c.n + '|' + (c.l ? c.l.id : '');
        if (done[key]) continue; done[key] = true;
        var node = graph.nodes[c.n];
        if (!node || node.type !== 'switch') continue; // only switches carry the network further
        (graph.adj[c.n] || []).forEach(function (a) {
          if (a.link === c.l || !canPass(graph, c.n, c.l, a.link, '')) return;
          addLink(a.link); queue.push({ n: a.to, l: a.link });
        });
      }
    }
    function domainOf(portId) {
      var o = idx.portObj[portId], l = linkOfPort[portId];
      if (!o || !l) return;
      addLink(l);
      if (o.type === 'switch') flood(o.id, l);
      else { var far = l.a === o.id ? l.b : l.a; flood(far, l); }
    }
    traces.forEach(function (tr) {
      tr.path.forEach(function (s) {
        if (s.type !== 'port') return;
        var o = idx.portObj[s.id], pt = idx.ports[s.id];
        if (!o || !graph.nodes[o.id]) return; // passive panel ports are in the middle of the route, not its ends
        if (o.type === 'router' && pt.role === 'wan') o.ports.forEach(function (q) { if (q.role === 'lan' && linkOfPort[q.id]) domainOf(q.id); });
        else domainOf(s.id);
      });
    });
    return out;
  }

  /*
   * Route optimisation: a physical route between two devices passes through panels and sockets (device > panel > panel > panel >
   * device). When two non-adjacent ones on that route are also joined directly by a fixed link that still has free wires
   * (spare or unused), the route could skip the panels in between. Returns one suggestion per route, biggest saving first.
   */
  function routeShortcuts(p, graph) {
    graph = graph || buildGraph(p);
    var idx = M.buildIndex(p), out = [];
    function freeWires(l) { return l.wires.filter(function (w) { return w.status === 'spare' || w.status === 'unused'; }); }
    function between(a, b) {
      return p.fixedLinks.filter(function (l) {
        return ((l.aObjectId === a && l.bObjectId === b) || (l.aObjectId === b && l.bObjectId === a)) && l.status !== 'decommissioned' && l.status !== 'faulty';
      });
    }
    graph.links.forEach(function (gl) {
      gl.paths.forEach(function (e) {
        var seq = [];
        e.trace.path.forEach(function (s) {
          if (s.type !== 'port') return;
          var o = idx.portObj[s.id];
          if (o && seq[seq.length - 1] !== o.id) seq.push(o.id);
        });
        var mid = seq.slice(1, -1), best = null;
        for (var i = 0; i < mid.length; i++) {
          for (var j = mid.length - 1; j >= i + 2; j--) {
            between(mid[i], mid[j]).forEach(function (l) {
              var free = freeWires(l);
              if (!free.length) return;
              var saved = j - i - 1;
              if (!best || saved > best.saved) best = { i: i, j: j, link: l, free: free, saved: saved };
            });
          }
        }
        if (!best) return;
        out.push({
          aId: e.a, bId: e.b, aName: graph.nodes[e.a].name, bName: graph.nodes[e.b].name, via: e.via.join(' > '),
          fromId: mid[best.i], toId: mid[best.j], fromName: idx.objects[mid[best.i]].name, toName: idx.objects[mid[best.j]].name,
          skipped: mid.slice(best.i + 1, best.j).map(function (id) { return idx.objects[id].name; }),
          linkId: best.link.id, linkName: best.link.name, freeWires: best.free.map(function (w) { return w.number; }), saved: best.saved
        });
      });
    });
    out.sort(function (x, y) { return y.saved - x.saved; });
    return out;
  }

  /*
   * Network colour: a router port may carry a networkColor. Patch cables extending from it - through switches and panels,
   * not through other routers - default to that colour. ends are the port(s) a new cable would join.
   */
  function networkColorFor(p, portIds, graph) {
    var idx = M.buildIndex(p);
    graph = graph || buildGraph(p);
    function colorOf(id) { var pt = idx.ports[id]; return pt && pt.networkColor ? pt.networkColor : null; }
    function routerSide(node, link) {
      for (var i = 0; i < link.paths.length; i++) {
        var e = link.paths[i], pid = e.a === node ? e.aPortId : e.bPortId, c = colorOf(pid);
        if (c) return c;
      }
      return null;
    }
    function bfs(startId) {
      var node = graph.nodes[startId];
      if (!node || node.type === 'router') return null;
      var seen = {}, queue = [startId]; seen[startId] = true;
      while (queue.length) {
        var cur = queue.shift();
        var adj = graph.adj[cur] || [];
        for (var i = 0; i < adj.length; i++) {
          var n = adj[i], to = graph.nodes[n.to];
          if (to.type === 'router') { var c = routerSide(n.to, n.link); if (c) return c; continue; }
          if (to.transit && !seen[n.to]) { seen[n.to] = true; queue.push(n.to); }
        }
      }
      return null;
    }
    for (var k = 0; k < portIds.length; k++) {
      var own = colorOf(portIds[k]);
      if (own) return own;
      var ends = [portIds[k]], tr = T.tracePort(p, portIds[k], idx);
      if (tr) tr.path.forEach(function (s) { if (s.type === 'port' && s.id !== portIds[k]) ends.push(s.id); });
      for (var j = 0; j < ends.length; j++) {
        var c2 = colorOf(ends[j]); if (c2) return c2;
        var o = idx.portObj[ends[j]];
        if (o && graph.nodes[o.id]) { var c3 = bfs(o.id); if (c3) return c3; }
      }
    }
    return null;
  }

  /* ids of the patch cables on the network that starts at a router port (the cables networkColorFor would colour) */
  function networkCables(p, routerPortId, graph) {
    var idx = M.buildIndex(p), start = idx.portObj[routerPortId];
    graph = graph || buildGraph(p);
    var out = {};
    if (!start || !graph.nodes[start.id]) return [];
    var seenNode = {}, queue = [], seenLink = {};
    function collect(link) { link.paths.forEach(function (e) { e.trace.path.forEach(function (s) { if (s.type === 'patch') out[s.id] = true; }); }); }
    (graph.adj[start.id] || []).forEach(function (n) {
      var onThisPort = n.link.paths.some(function (e) { return e.aPortId === routerPortId || e.bPortId === routerPortId; });
      if (!onThisPort) return;
      seenLink[n.link.id] = true; collect(n.link);
      if (graph.nodes[n.to].type !== 'router' && graph.nodes[n.to].transit && !seenNode[n.to]) { seenNode[n.to] = true; queue.push(n.to); }
    });
    while (queue.length) {
      var cur = queue.shift();
      (graph.adj[cur] || []).forEach(function (n) {
        if (seenLink[n.link.id] || n.to === start.id) return;
        if (graph.nodes[n.to].type === 'router') return;
        seenLink[n.link.id] = true; collect(n.link);
        if (graph.nodes[n.to].transit && !seenNode[n.to]) { seenNode[n.to] = true; queue.push(n.to); }
      });
    }
    return Object.keys(out);
  }

  /*
   * Layer-2 segments and subnet sanity. A segment is a set of devices joined by switches, patch panels and cables; routers
   * terminate it (their ports are the members). Several router ports on one segment are fine when their subnets match
   * (different host addresses); otherwise we warn: different subnets joined, a LAN port without an address next to a
   * configured one, or the same address twice. WAN ports without an address are ignored (DHCP).
   */
  /*
   * Address a port answers to. Routers: the port's own, else (LAN ports) the router address. Generic devices: the port's own, else
   * the device address (so every port without its own address answers to it). Switches have a management address only (see below), no per-port ones.
   */
  function effectiveIp(o, pt) {
    return M.effectivePortIp(o, pt);
  }
  function hostOf(ip) { return String(ip).toLowerCase(); }

  /*
   * Layer-2 domains. Switches bridge: switches joined by cables, panels and fixed links form one domain. Routers and
   * generic devices do NOT bridge: a PC with two NICs sits in two domains without joining them. A cable between two
   * non-switch devices is its own two-member segment. Members are the addressed ports of routers and generic devices plus the
   * management address of each switch (web interface).
   */
  function segments(p, graph) {
    graph = graph || buildGraph(p);
    var idx = M.buildIndex(p), parent = {};
    function find(x) { while (parent[x] !== undefined && parent[x] !== x) x = parent[x]; return x; }
    function union(a, b) { var ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
    graph.order.forEach(function (id) { if (graph.nodes[id].type === 'switch') parent[id] = id; });
    graph.links.forEach(function (l) { if (graph.nodes[l.a].type === 'switch' && graph.nodes[l.b].type === 'switch') union(l.a, l.b); });
    var segs = {};
    function seg(key) { return segs[key] = segs[key] || { key: key, ports: [], hasInternet: false }; }
    function addPort(s, portId) {
      var pt = idx.ports[portId], o = idx.portObj[portId];
      if (!pt || !o) return;
      if (o.type === 'internet') { s.hasInternet = true; return; }
      if (o.type !== 'router' && o.type !== 'generic') return;
      if (s.ports.some(function (x) { return x.portId === portId; })) return;
      var ip = effectiveIp(o, pt);
      s.ports.push({ portId: portId, objId: o.id, name: o.name, label: pt.label, role: o.type === 'router' ? (pt.role || 'lan') : 'device', ip: ip, subnet: NM.topology.subnetOf(ip) });
    }
    graph.links.forEach(function (l) {
      var A = graph.nodes[l.a], B = graph.nodes[l.b], aSw = A.type === 'switch', bSw = B.type === 'switch';
      if (aSw && bSw) return;
      if (!aSw && !bSw) {
        l.paths.forEach(function (e) { var s = seg('p:' + [e.aPortId, e.bPortId].sort().join('|')); addPort(s, e.aPortId); addPort(s, e.bPortId); });
      } else {
        var swId = aSw ? l.a : l.b, other = aSw ? l.b : l.a, s2 = seg('c:' + find(swId));
        l.paths.forEach(function (e) { addPort(s2, e.a === other ? e.aPortId : e.bPortId); });
      }
    });
    graph.order.forEach(function (id) { // managed switches: the web/management address belongs to the switch's domain
      var o = idx.objects[id];
      if (o.type !== 'switch' || !o.ipAddress) return;
      var s = seg('c:' + find(id)), ip = String(o.ipAddress).trim();
      s.ports.push({ portId: null, objId: o.id, name: o.name, label: 'management', role: 'management', ip: ip, subnet: NM.topology.subnetOf(ip) });
    });
    return Object.keys(segs).map(function (k) { return segs[k]; });
  }

  /*
   * Warnings per segment with at least two members: different subnets, the same address twice, and a router LAN port without
   * any address next to configured ones. Unaddressed devices (DHCP) and unaddressed WAN ports are ignored.
   */
  function networkIssues(p, graph) {
    var out = [];
    segments(p, graph).forEach(function (s) {
      if (s.hasInternet || s.ports.length < 2) return;
      var configured = s.ports.filter(function (x) { return x.ip; });
      var subnets = {};
      configured.forEach(function (x) { if (x.subnet) (subnets[x.subnet] = subnets[x.subnet] || []).push(x); });
      var keys = Object.keys(subnets);
      var describe = function (x) { return x.name + ' / ' + x.label + ' ' + x.ip; };
      if (keys.length > 1) {
        out.push({
          severity: 'warning', code: 'SUBNET_MISMATCH', target: { kind: 'object', id: subnets[keys[0]][0].objId },
          objectIds: configured.map(function (x) { return x.objId; }),
          message: 'Different subnets share one network segment: ' + keys.map(function (k) { return k + ' (' + subnets[k].map(describe).join(', ') + ')'; }).join('  vs  ')
        });
      }
      if (configured.length) {
        s.ports.forEach(function (x) {
          if (x.ip || x.role !== 'lan') return;
          out.push({
            severity: 'warning', code: 'UNCONFIGURED_LAN', target: { kind: 'port', id: x.portId }, objectIds: [x.objId],
            message: x.name + ' / ' + x.label + ' (LAN) has no IP address but shares a network segment with ' + configured.map(describe).join(', ')
          });
        });
      }
      var byHost = {};
      configured.forEach(function (x) { (byHost[hostOf(x.ip)] = byHost[hostOf(x.ip)] || []).push(x); });
      Object.keys(byHost).forEach(function (h) {
        if (byHost[h].length > 1) out.push({
          severity: 'warning', code: 'DUPLICATE_IP', target: byHost[h][0].portId ? { kind: 'port', id: byHost[h][0].portId } : { kind: 'object', id: byHost[h][0].objId }, objectIds: byHost[h].map(function (x) { return x.objId; }),
          message: 'Address ' + h + ' is configured twice on one network segment: ' + byHost[h].map(function (x) { return x.name + ' / ' + x.label; }).join(' and ')
        });
      });
    });
    return out;
  }

  NM.topology = { segments: segments, networkIssues: networkIssues, effectiveIp: effectiveIp, networkColorFor: networkColorFor, networkTraces: networkTraces, routeShortcuts: routeShortcuts, networkCables: networkCables, canPass: canPass, INTERNET: INTERNET, endpoints: endpoints, pathsBetween: pathsBetween, buildGraph: buildGraph, reachTree: reachTree, allPaths: allPaths, subnetOf: subnetOf, PASSIVE: PASSIVE, TERMINAL: TERMINAL };
  if (typeof module !== 'undefined' && module.exports) module.exports = NM.topology;
})(typeof window !== 'undefined' ? window : globalThis);
