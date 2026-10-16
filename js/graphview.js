/* Topology view: HTML/SVG for the interconnection graph, reachability tree and path list. No event handling here. */
(function (g) {
  'use strict';
  var NM = g.NetMap = g.NetMap || {};
  if (typeof require === 'function') { ['model', 'topology'].forEach(function (n) { if (!NM[n]) require('./' + n + '.js'); }); }
  var M = NM.model, TP = NM.topology;
  var esc = function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };

  var COLORS = {
    router: ['#e3f2fd', '#1565c0'], 'switch': ['#e6f4ea', '#2e7d32'], internet: ['#fff3cd', '#e65100'],
    socket: ['#f3e5f5', '#7b1fa2'], generic: ['#ffffff', '#777']
  };
  var NW = 168, NH = 50, XG = 70, YG = 16;

  function defaultRoot(graph) {
    var pick = function (t) { return graph.order.filter(function (id) { return graph.nodes[id].type === t; })[0]; };
    return pick('internet') || pick('router') || graph.order[0] || '';
  }

  /* state: {from, to, via}; returns { html } */
  function render(p, state) {
    var graph = TP.buildGraph(p, { viaInternet: !!state.via });
    if (!graph.order.length) return '<div class="gv-empty">No active devices yet. Add routers, switches, an Internet / ISP object and cable them to see the topology.</div>';
    if (!graph.nodes[state.from]) state.from = defaultRoot(graph);
    if (state.to && !graph.nodes[state.to]) state.to = '';
    var tree = TP.reachTree(graph, state.from);
    var paths = state.to ? TP.allPaths(graph, state.from, state.to, 60) : [];

    // highlight sets
    var hiNode = {}, hiLink = {}, best = {};
    paths.forEach(function (pt, i) {
      pt.nodes.forEach(function (n) { hiNode[n] = true; });
      pt.links.forEach(function (l) { hiLink[l.id] = true; if (i === 0) best[l.id] = true; });
    });
    var dim = state.to && paths.length;

    // layered layout: column = hop distance from root; unreachable devices in a last column
    var cols = [], pos = {};
    tree.order.forEach(function (n) { (cols[n.depth] = cols[n.depth] || []).push(n.id); });
    if (tree.unreachable.length) cols.push(tree.unreachable);
    var maxRows = 0;
    cols.forEach(function (c, ci) {
      c.forEach(function (id, ri) { pos[id] = { x: 16 + ci * (NW + XG), y: 16 + ri * (NH + YG) }; });
      maxRows = Math.max(maxRows, c.length);
    });
    var W = 32 + cols.length * (NW + XG) - XG, H = 32 + maxRows * (NH + YG) - YG;

    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" class="gv-svg">';
    graph.links.forEach(function (l) {
      var A = pos[l.a], B = pos[l.b];
      if (!A || !B) return;
      var inTree = tree.order.some(function (n) { return n.link === l; });
      var hi = hiLink[l.id], faded = dim && !hi;
      var ax = A.x + NW, ay = A.y + NH / 2, bx = B.x, by = B.y + NH / 2;
      if (B.x < A.x) { ax = A.x; bx = B.x + NW; }
      var d;
      if (A.x === B.x) { var cx = A.x + NW + 30; d = 'M' + (A.x + NW) + ' ' + ay + 'C' + cx + ' ' + ay + ' ' + cx + ' ' + by + ' ' + (B.x + NW) + ' ' + by; }
      else d = 'M' + ax + ' ' + ay + 'C' + (ax + (bx - ax) / 2) + ' ' + ay + ' ' + (ax + (bx - ax) / 2) + ' ' + by + ' ' + bx + ' ' + by;
      var tip = l.paths.map(function (e) { return e.via.join(' > ') || 'direct'; }).join('\n');
      svg += '<g data-gedge="' + l.id + '" style="cursor:pointer"' + (faded ? ' opacity="0.2"' : '') + '><title>' + esc(graph.nodes[l.a].name + ' <-> ' + graph.nodes[l.b].name + '\n' + tip) + '</title>' +
        '<path d="' + d + '" fill="none" stroke="transparent" stroke-width="14"/>' +
        '<path d="' + d + '" fill="none" stroke="' + (best[l.id] ? '#d32f2f' : (hi ? '#ff9800' : (inTree ? '#37474f' : '#90a4ae'))) + '" stroke-width="' + (best[l.id] ? 4 : (hi ? 3.2 : 2)) + '"' + (inTree || hi ? '' : ' stroke-dasharray="5 4"') + '/>';
      if (l.paths.length > 1) svg += '<text x="' + ((ax + bx) / 2) + '" y="' + ((ay + by) / 2 - 4) + '" font-size="10" text-anchor="middle" fill="#222" stroke="#fff" stroke-width="3" paint-order="stroke" font-family="sans-serif">x' + l.paths.length + '</text>';
      svg += '</g>';
    });
    graph.order.forEach(function (id) {
      var n = graph.nodes[id], P = pos[id], c = COLORS[n.type] || COLORS.generic;
      var faded = dim && !hiNode[id], isRoot = id === state.from, isTo = id === state.to;
      var sub = M.TYPE_LABELS[n.type] + (n.ip ? '  ' + n.ip : '');
      var nets = n.nets.join(', ');
      svg += '<g data-gnode="' + esc(id) + '" style="cursor:pointer"' + (faded ? ' opacity="0.25"' : '') + '><title>' + esc(n.name + ' (' + M.TYPE_LABELS[n.type] + ')' + (nets ? '\nNetworks: ' + nets : '') + (n.transit ? '' : '\nEndpoint: paths do not pass through')) + '</title>' +
        '<rect x="' + P.x + '" y="' + P.y + '" width="' + NW + '" height="' + NH + '" rx="' + (n.type === 'internet' ? 22 : 6) + '" fill="' + c[0] + '" stroke="' + (isRoot ? '#d32f2f' : (isTo ? '#6a1b9a' : c[1])) + '" stroke-width="' + (isRoot || isTo ? 3.5 : 1.5) + '"' + (n.transit ? '' : ' stroke-dasharray="6 3"') + '/>' +
        '<text x="' + (P.x + 8) + '" y="' + (P.y + 19) + '" font-size="13" font-weight="bold" fill="#111" font-family="sans-serif">' + esc(n.name.length > 22 ? n.name.slice(0, 21) + '~' : n.name) + '</text>' +
        '<text x="' + (P.x + 8) + '" y="' + (P.y + 33) + '" font-size="10" fill="#444" font-family="sans-serif">' + esc(sub.length > 30 ? sub.slice(0, 29) + '~' : sub) + '</text>' +
        '<text x="' + (P.x + 8) + '" y="' + (P.y + 45) + '" font-size="9" fill="#0d47a1" font-family="sans-serif">' + esc(nets.length > 34 ? nets.slice(0, 33) + '~' : nets) + '</text></g>';
    });
    svg += '</svg>';

    var opt = graph.order.map(function (id) { return [id, graph.nodes[id].name + ' (' + M.TYPE_LABELS[graph.nodes[id].type] + ')']; });
    var sel = function (name, list, cur, empty) {
      return '<select data-g="' + name + '">' + (empty ? '<option value="">' + empty + '</option>' : '') + list.map(function (o) { return '<option value="' + esc(o[0]) + '"' + (o[0] === cur ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join('') + '</select>';
    };
    var html = '<div class="gv-controls">' +
      '<label>From ' + sel('from', opt, state.from) + '</label>' +
      '<label>To ' + sel('to', opt, state.to, 'All devices (tree)') + '</label>' +
      '<label class="gv-check"><input type="checkbox" data-g="via"' + (state.via ? ' checked' : '') + '> Allow paths through Internet</label>' +
      '</div><div class="gv-note">Theoretical physical reachability over documented cabling, collapsing patch panels and fixed links. Switches and routers pass traffic through; the Internet, wall sockets and generic devices are endpoints (dashed). Solid dark lines are the shortest-path tree, dashed grey lines are extra links.</div>' +
      '<div class="gv-scroll">' + svg + '</div>';

    function nameLink(id) { return '<a class="lnk" data-gnode="' + esc(id) + '">' + esc(graph.nodes[id].name) + '</a>'; }
    function viaText(l) { return l.paths.map(function (e) { return e.via.join(' > ') || 'direct'; }).join('; '); }

    if (state.to) {
      html += '<h3>Paths from ' + esc(graph.nodes[state.from].name) + ' to ' + esc(graph.nodes[state.to].name) + ' (' + paths.length + (paths.length >= 60 ? '+' : '') + ')</h3>';
      if (!paths.length) html += '<div class="msg-box">No route: every physical path is broken or would need to pass through an endpoint' + (state.via ? '' : ' (try "Allow paths through Internet")') + '.</div>';
      paths.forEach(function (pt, i) {
        html += '<div class="gv-path' + (i === 0 ? ' best' : '') + '"><b>' + (pt.nodes.length - 1) + ' hop' + (pt.nodes.length === 2 ? '' : 's') + (i === 0 ? ' (shortest)' : '') + ':</b> ' +
          pt.nodes.map(nameLink).join(' &rarr; ') +
          '<div class="sub">' + pt.links.map(function (l, k) { return esc(graph.nodes[pt.nodes[k]].name) + ' - ' + esc(graph.nodes[pt.nodes[k + 1]].name) + ': ' + esc(viaText(l)); }).join('<br>') + '</div></div>';
      });
    } else {
      html += '<h3>Reachable from ' + esc(graph.nodes[state.from].name) + ' (' + (tree.order.length - 1) + ' device(s))</h3><div class="gv-tree">';
      tree.order.forEach(function (n) {
        html += '<div class="gv-tn" style="margin-left:' + (n.depth * 18) + 'px">' + (n.depth ? '&boxur; ' : '') + nameLink(n.id) +
          ' <span class="tag">' + esc(M.TYPE_LABELS[graph.nodes[n.id].type]) + '</span>' + (n.link ? ' <span class="sub">via ' + esc(viaText(n.link)) + '</span>' : '') +
          (n.depth && !graph.nodes[n.id].transit ? ' <span class="sub">(endpoint)</span>' : '') + '</div>';
      });
      html += '</div>';
      if (tree.unreachable.length) html += '<h3>Not reachable (' + tree.unreachable.length + ')</h3>' + tree.unreachable.map(function (id) { return '<div class="gv-tn">' + nameLink(id) + '</div>'; }).join('');
    }
    if (graph.dangling.length) html += '<div class="gv-note">' + graph.dangling.length + ' cable chain(s) end on a patch panel with nothing connected beyond it.</div>';
    return html;
  }

  NM.graphview = { render: render, defaultRoot: defaultRoot };
  if (typeof module !== 'undefined' && module.exports) module.exports = NM.graphview;
})(typeof window !== 'undefined' ? window : globalThis);
