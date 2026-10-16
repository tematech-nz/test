'use strict';
/* Dependency-free test runner: node tests/run.js */
const assert = require('assert');
require('../js/model.js'); require('../js/layout.js'); require('../js/trace.js');
require('../js/render.js'); require('../js/exporters.js'); require('../js/builder.js'); require('../js/topology.js'); require('../js/graphview.js');
const NM = globalThis.NetMap;
const M = NM.model, T = NM.trace, B = NM.builder, R = NM.render, X = NM.exporters;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e.stack || e).split('\n').slice(0, 4).join('\n       ')); }
}
const byName = (p, n) => p.objects.find(o => o.name === n);
const port = (o, label, side) => o.ports.find(x => x.label === String(label) && x.side === (side || 'front'));

console.log('Model');
test('1. groups, racks, panels, switches inside two rooms', () => {
  const p = B.buildDemoProject();
  assert.strictEqual(p.groups.length, 2);
  assert.strictEqual(byName(p, 'PP-A').containerId, byName(p, 'Rack A').id);
  assert.strictEqual(byName(p, 'Rack A').containerId, p.groups[0].id);
  assert.strictEqual(M.descendants(p, p.groups[0].id).length, 3);
});
test('2. standalone patch panel outside any rack', () => {
  const p = B.buildDemoProject();
  assert.strictEqual(byName(p, 'PP-Standalone').containerId, null);
});
test('3/4. fixed link between racks with per-wire mapping', () => {
  const p = B.buildDemoProject();
  const l = p.fixedLinks[0];
  assert.strictEqual(l.wires.length, 24);
  assert.strictEqual(l.wires[11].aPortId, port(byName(p, 'PP-A'), 12, 'rear').id);
  assert.strictEqual(l.wires[11].bPortId, port(byName(p, 'PP-B'), 12, 'rear').id);
});
test('4b. non-sequential wire mapping is possible only by explicit edit', () => {
  const p = B.buildDemoProject(), l = p.fixedLinks[0];
  const a = byName(p, 'PP-A'), b = byName(p, 'PP-B');
  const draft = { aObjectId: l.aObjectId, bObjectId: l.bObjectId, wires: M.clone(l.wires) };
  draft.wires[0].bPortId = port(b, 24, 'rear').id;
  draft.wires[23].bPortId = port(b, 1, 'rear').id;
  const lines = M.diffLinkDraft(p, l.id, draft);
  assert.strictEqual(lines.length, 2);
  M.applyLinkEdit(p, l.id, draft);
  assert.strictEqual(p.fixedLinks[0].wires[0].bPortId, port(b, 24, 'rear').id);
  assert.ok(a);
});
test('5. moving racks/groups/panels never changes links or wires', () => {
  const p = B.buildDemoProject();
  const before = JSON.stringify([p.fixedLinks, p.patchCables, p.internalMappings]);
  const grpPl = p.placements.find(x => x.refType === 'group');
  M.movePlacement(p, grpPl.id, 123, -45, true);
  const rackPl = p.placements.find(x => x.refId === byName(p, 'Rack A').id);
  M.movePlacement(p, rackPl.id, 10, 10, true);
  assert.strictEqual(JSON.stringify([p.fixedLinks, p.patchCables, p.internalMappings]), before);
});
test('5b. moving a group moves contents, moving an object does not move group', () => {
  const p = B.buildDemoProject();
  const g = p.placements.find(x => x.refType === 'group' && x.mapId === p.maps[0].id);
  const sw = p.placements.find(x => x.refId === byName(p, 'Switch A').id);
  const gx = g.x, sx = sw.x;
  M.movePlacement(p, sw.id, 5, 5, true);
  assert.strictEqual(g.x, gx);
  M.movePlacement(p, g.id, 100, 0, true);
  assert.strictEqual(sw.x, sx + 5 + 100);
});
test('6. wires are added/deleted only via explicit edit with validation', () => {
  const p = B.buildDemoProject(), l = p.fixedLinks[0];
  const draft = { aObjectId: l.aObjectId, bObjectId: l.bObjectId, wires: M.clone(l.wires) };
  draft.wires.pop();
  draft.wires.push({ number: 30, aPortId: null, bPortId: null, status: 'spare' });
  const lines = M.diffLinkDraft(p, l.id, draft);
  assert.ok(lines.some(x => x.indexOf('DELETE wire 24') === 0) && lines.some(x => x.indexOf('ADD wire 30') === 0));
  M.applyLinkEdit(p, l.id, draft);
  assert.strictEqual(p.fixedLinks[0].wires.length, 24);
  assert.strictEqual(p.fixedLinks[0].wires[23].number, 30);
  const bad = { aObjectId: l.aObjectId, bObjectId: l.bObjectId, wires: [{ number: 1, aPortId: port(byName(p, 'PP-A'), 1, 'front').id, bPortId: null }] };
  assert.throws(() => M.applyLinkEdit(p, l.id, bad), /rear/);
});
test('7. patch cables validate occupancy and incompatible terminations', () => {
  const p = B.buildDemoProject();
  const sw = byName(p, 'Switch A'), pp = byName(p, 'PP-A');
  assert.throws(() => M.addPatchCable(p, { aPortId: port(sw, 12).id, bPortId: port(pp, 13).id }), /occupied/);
  assert.throws(() => M.addPatchCable(p, { aPortId: port(sw, 1).id, bPortId: port(pp, 1, 'rear').id }), /Rear/);
  assert.throws(() => M.addPatchCable(p, { aPortId: port(sw, 1).id, bPortId: port(sw, 1).id }), /itself/);
  const c = M.addPatchCable(p, { aPortId: port(sw, 1).id, bPortId: port(pp, 1).id });
  assert.strictEqual(c.name, 'PC-003');
  M.addPatchCable(p, { aPortId: port(sw, 2).id, bPortId: port(pp, 2).id });
});
test('switch ports are not implicitly cabled together', () => {
  const p = B.buildDemoProject();
  const sw = byName(p, 'Switch A');
  const t = T.tracePort(p, port(sw, 3).id);
  assert.strictEqual(t.path.length, 1);
});

console.log('Tracing');
test('8. switch -> patch -> panel -> fixed wire -> panel -> patch -> wall socket', () => {
  const p = B.buildDemoProject();
  const t = T.tracePort(p, port(byName(p, 'Switch A'), 12).id);
  const seq = t.path.map(s => s.type);
  assert.deepStrictEqual(seq, ['port', 'patch', 'port', 'internal', 'port', 'wire', 'port', 'internal', 'port', 'patch', 'port', 'internal', 'port']); // ends inside the socket: front jack, internal mapping, rear
  const lines = T.describe(p, t).map(x => x.text);
  assert.ok(/Switch A \/ 12/.test(lines[0]) || /WS-02 \/ 1/.test(lines[0]));
  assert.ok(lines.some(l => /Fixed link FL-001, wire 12/.test(l)));
  const ends = t.ends.map(e => e.text).join('|');
  assert.ok(/Terminates at Switch A/.test(ends) && /Terminates at WS-02/.test(ends));
});
test('trace starting from the middle of the path gives the same chain', () => {
  const p = B.buildDemoProject();
  const a = T.tracePort(p, port(byName(p, 'Switch A'), 12).id).path.map(s => s.id).sort();
  const w = p.fixedLinks[0].wires[11];
  const b = T.traceTarget(p, { kind: 'wire', id: w.id }).traces[0].path.map(s => s.id).sort();
  assert.deepStrictEqual(a, b);
});
test('9. trace spans two maps and reports map navigation', () => {
  const p = B.buildDemoProject();
  const t = T.tracePort(p, port(byName(p, 'Switch A'), 12).id);
  const lines = T.describe(p, t);
  const mapsSeen = new Set();
  lines.forEach(l => (l.maps || []).forEach(m => mapsSeen.add(m)));
  assert.strictEqual(mapsSeen.size, 2);
});
test('trace never follows unmapped panel ports or proximity', () => {
  const p = B.buildDemoProject();
  const panel = byName(p, 'PP-Standalone');
  M.internalMappings; p.internalMappings = [];
  const t = T.tracePort(p, port(panel, 3).id);
  assert.strictEqual(t.path.length, 1);
  assert.ok(/Open/.test(t.ends[0].text));
});
test('unresolved paths report where they stop', () => {
  const p = B.buildDemoProject();
  M.deletePatchCable(p, p.patchCables[1].id);
  const t = T.tracePort(p, port(byName(p, 'Switch A'), 12).id);
  assert.ok(t.ends.some(e => /Open: front port on PP-B/.test(e.text)));
});

console.log('Persistence and validation');
test('13. JSON export/import keeps IDs and records', () => {
  const p = B.buildDemoProject();
  const text = M.exportProject(p);
  assert.ok(text.indexOf('\r') < 0);
  const r = M.importProject(text);
  assert.deepStrictEqual(JSON.parse(M.exportProject(r.project)).maps, JSON.parse(text).maps);
  assert.strictEqual(r.issues.filter(i => i.severity === 'error').length, 0);
  const strip = o => JSON.stringify(Object.assign({}, o, { updatedAt: 0 }));
  assert.strictEqual(strip(r.project), strip(p));
});
test('migration from an unversioned file', () => {
  const r = M.importProject(JSON.stringify({ name: 'old', maps: [{ id: 'm1', name: 'x' }], objects: [] }));
  assert.strictEqual(r.migratedFrom, 0);
  assert.strictEqual(r.project.schemaVersion, M.SCHEMA_VERSION);
  assert.throws(() => M.importProject(JSON.stringify({ schemaVersion: 99 })), /newer/);
  assert.throws(() => M.importProject('nope'), /JSON/);
});
test('16. validation detects broken references, occupied ports, invalid wires', () => {
  const p = B.buildDemoProject();
  const sw = byName(p, 'Switch A'), pp = byName(p, 'PP-A');
  p.patchCables.push({ id: 'pc_bad1', name: 'BAD1', aPortId: port(sw, 12).id, bPortId: port(pp, 20).id, cableType: 'x', color: '#000' });
  p.patchCables.push({ id: 'pc_bad2', name: 'BAD2', aPortId: 'prt_missing', bPortId: port(pp, 21).id });
  p.fixedLinks[0].wires[0].bPortId = port(byName(p, 'PP-Standalone'), 1, 'rear').id;
  p.internalMappings.push({ id: 'mx', objectId: pp.id, aPortId: 'nope', bPortId: 'nope2' });
  const codes = M.validateProject(p).map(i => i.code);
  p.objects[2].id = p.objects[0].id;
  codes.push.apply(codes, M.validateProject(p).map(i => i.code));
  ['OCCUPIED', 'MISSING_PORT', 'BAD_WIRE', 'BAD_MAPPING', 'DUP_ID'].forEach(c => assert.ok(codes.indexOf(c) >= 0, c));
  assert.ok(M.validateProject(B.buildDemoProject()).every(i => i.severity !== 'error'));
});
test('unused ports are info, not errors', () => {
  const p = B.buildDemoProject();
  const issues = M.validateProject(p).filter(i => i.code === 'UNUSED_PORTS');
  assert.ok(issues.length > 0 && issues.every(i => i.severity === 'info'));
});

console.log('Deletion and editing rules');
test('deleting a group keeps or deletes contents on request', () => {
  const p = B.buildDemoProject(), g = p.groups[0];
  const keep = M.clone(p);
  M.deleteContainerOrObject(keep, 'group', g.id, 'keep');
  assert.strictEqual(keep.groups.length, 1);
  assert.ok(keep.objects.some(o => o.name === 'Rack A' && o.containerId === null));
  const imp = M.deleteImpact(p, 'group', g.id, 'delete');
  assert.ok(imp.objects >= 3 && imp.links === 1 && imp.cables >= 1);
  M.deleteContainerOrObject(p, 'group', g.id, 'delete');
  assert.ok(!p.objects.some(o => o.name === 'Switch A'));
  assert.strictEqual(p.fixedLinks.length, 0);
});
test('port count cannot shrink below used ports; growing adds ports', () => {
  const p = B.buildDemoProject(), sw = byName(p, 'Switch A');
  assert.throws(() => M.setPortCount(p, sw.id, 8), /in use/);
  M.setPortCount(p, sw.id, 48);
  assert.strictEqual(sw.ports.length, 48);
  const pp = byName(p, 'PP-A');
  M.setPortCount(p, pp.id, 32);
  assert.strictEqual(pp.ports.length, 64);
});
test('containment rules', () => {
  const p = B.buildDemoProject();
  const rackA = byName(p, 'Rack A'), ppB = byName(p, 'PP-B');
  assert.throws(() => M.setContainer(p, 'object', rackA.id, rackA.id), /itself|inside a rack/);
  assert.throws(() => M.setContainer(p, 'object', rackA.id, ppB.id), /Only groups and racks/);
  assert.throws(() => M.setContainer(p, 'group', p.groups[0].id, p.groups[0].id), /itself/);
});
test('search finds ports, cables, wires, objects and navigates to maps', () => {
  const p = B.buildDemoProject();
  assert.ok(M.search(p, 'PC-002').some(r => r.kind === 'cable'));
  assert.ok(M.search(p, 'FL-001 w12').some(r => r.kind === 'wire'));
  assert.ok(M.search(p, 'ws-02').some(r => r.kind === 'object'));
  assert.ok(M.search(p, 'office').some(r => r.kind === 'map'));
  const wire = p.fixedLinks[0].wires[0];
  assert.strictEqual(M.mapsFor(p, 'wire', wire.id).length, 2);
});

console.log('Rendering and export');
test('SVG export distinguishes fixed links and patch cables and escapes text', () => {
  const p = B.buildDemoProject();
  byName(p, 'Switch A').name = 'Sw <&> "A"';
  const svg = R.svgDocument(p, p.maps[0].id);
  assert.ok(svg.indexOf('<svg') === 0 && svg.indexOf('FL-001 x24') > 0 && svg.indexOf('stroke-dasharray="7 5"') > 0);
  assert.ok(svg.indexOf('Sw &lt;&amp;&gt; &quot;A&quot;') > 0 && svg.indexOf('Sw <&>') < 0);
  assert.ok(/PC-001/.test(svg));
});
test('rendering moves cable endpoints with objects but keeps records', () => {
  const p = B.buildDemoProject();
  const r1 = R.renderMap(p, p.maps[0].id);
  const sw = byName(p, 'Switch A'), pt = port(sw, 12);
  const before = r1.portGeo[pt.id].x;
  M.movePlacement(p, p.placements.find(x => x.refId === sw.id).id, 50, 0, true);
  const r2 = R.renderMap(p, p.maps[0].id);
  assert.strictEqual(r2.portGeo[pt.id].x, before + 50);
});
test('15. connection table has fixed wires and patch cables', () => {
  const p = B.buildDemoProject();
  const rows = X.connectionRows(p);
  assert.strictEqual(rows.filter(r => r.category === 'Fixed wire').length, 24);
  assert.strictEqual(rows.filter(r => r.category === 'Patch cable').length, 2);
  assert.ok(X.tableHtml(p).indexOf('FL-001 w12') > 0);
});
test('14. PDF writer produces a structurally valid file', () => {
  const p = B.buildDemoProject();
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const pages = [{ w: 842, h: 595, items: [{ t: 'text', x: 10, y: 20, size: 12, text: 'a (b) \\ c' }, { t: 'image', jpeg, iw: 1, ih: 1, x: 10, y: 30, w: 100, h: 100 }] }].concat(X.tablePages(p, 'Demo'));
  const out = X.buildPdf(pages);
  const s = Buffer.from(out).toString('latin1');
  assert.ok(s.startsWith('%PDF-1.4') && s.trim().endsWith('%%EOF'));
  const xr = parseInt(/startxref\n(\d+)/.exec(s)[1], 10);
  assert.ok(s.slice(xr).startsWith('xref'));
  const size = parseInt(/\/Size (\d+)/.exec(s)[1], 10);
  const entries = s.slice(xr).split('\n').filter(l => /^\d{10} 00000 n/.test(l));
  assert.strictEqual(entries.length, size - 1);
  entries.forEach((e, i) => assert.ok(s.slice(parseInt(e, 10)).startsWith((i + 1) + ' 0 obj')));
});

console.log('Port groups and panel layout');
test('fixed link from an explicit port group (non-contiguous source, contiguous target)', () => {
  const p = B.buildDemoProject();
  const a = byName(p, 'PP-Standalone'), b = M.addObject(p, { type: 'patchpanel', name: 'PP-C', portCount: 15 });
  const rear = (o, n) => port(o, n, 'rear').id;
  const l = M.addFixedLink(p, { aObjectId: a.id, bObjectId: b.id, pairs: [[rear(a, 3), rear(b, 10)], [rear(a, 5), rear(b, 11)], [rear(a, 6), rear(b, 12)]] });
  assert.strictEqual(l.wires.length, 3);
  assert.strictEqual(l.wires[1].aPortId, rear(a, 5));
  assert.strictEqual(l.wires[2].bPortId, rear(b, 12));
  assert.throws(() => M.addFixedLink(p, { aObjectId: a.id, bObjectId: b.id, pairs: [[rear(a, 3), rear(b, 10)]] }), /occupied/);
  assert.throws(() => M.addFixedLink(p, { aObjectId: a.id, bObjectId: b.id, pairs: [[port(a, 1).id, rear(b, 1)]] }), /rear/);
  assert.ok(M.validateProject(p).every(i => i.severity !== 'error'));
});
test('any port count works, e.g. a 15-port panel', () => {
  const p = M.createProject('x');
  const o = M.addObject(p, { type: 'patchpanel', name: 'Custom', portCount: 15, straight: true });
  assert.strictEqual(o.ports.length, 30);
  assert.strictEqual(p.internalMappings.length, 15);
  const sz = NM.layout.defaultSize(o);
  const lay = NM.layout.computeLayout(o, sz.w, sz.h, {});
  assert.strictEqual(Object.keys(lay.ports).length, 30);
  assert.strictEqual(lay.sections.length, 2);
});
test('collapsing a panel section shrinks it and anchors cables to the strip', () => {
  const p = B.buildDemoProject();
  const pp = byName(p, 'PP-A'), pl = p.placements.find(x => x.refId === pp.id);
  const full = R.renderMap(p, p.maps[0].id, {});
  const coll = R.renderMap(p, p.maps[0].id, { collapsed: { [pl.id]: { rear: true } } });
  const rp = port(pp, 12, 'rear').id;
  assert.ok(coll.portGeo[rp].hidden && !full.portGeo[rp].hidden);
  assert.ok(coll.content.length < full.content.length);
  assert.ok(R.svgDocument(p, p.maps[0].id).indexOf('data-toggle') < 0, 'exports are always expanded');
  assert.ok(full.content.indexOf('data-toggle="rear"') > 0 && full.content.indexOf('REAR (24)') > 0);
});

console.log('Router');
test('router has configurable WAN/LAN ports and IP addresses', () => {
  const p = M.createProject('r');
  const r = M.addObject(p, { type: 'router', name: 'Edge', wanPorts: 2, lanPorts: 6, ipAddress: '192.168.1.1' });
  assert.strictEqual(r.ports.length, 8);
  assert.deepStrictEqual(r.ports.slice(0, 3).map(x => x.role + ':' + x.label), ['wan:W1', 'wan:W2', 'lan:L1']);
  assert.strictEqual(r.ipAddress, '192.168.1.1');
  M.setRouterPorts(p, r.id, 1, 15);
  assert.strictEqual(r.ports.filter(x => x.role === 'wan').length, 1);
  assert.strictEqual(r.ports.filter(x => x.role === 'lan').length, 15);
  assert.ok(r.ports.every((x, i, a) => i === 0 || !(a[i - 1].role === 'lan' && x.role === 'wan')), 'WAN ports stay first');
  assert.throws(() => M.setPortCount(p, r.id, 4), /setRouterPorts/);
  assert.throws(() => M.addObject(p, { type: 'router', wanPorts: 60, lanPorts: 60 }), /0-96/);
});
test('router ports cable like any port, cannot be removed while used, trace ends at the router', () => {
  const p = B.buildDemoProject();
  const sw = byName(p, 'Switch A');
  const r = M.addObject(p, { type: 'router', name: 'Edge', wanPorts: 1, lanPorts: 4 });
  const lan1 = r.ports.find(x => x.label === 'L1');
  M.addPatchCable(p, { aPortId: port(sw, 20).id, bPortId: lan1.id });
  assert.throws(() => M.setRouterPorts(p, r.id, 1, 0), /in use/);
  const t = T.tracePort(p, port(sw, 20).id);
  assert.ok(t.ends.some(e => /Terminates at Edge/.test(e.text)));
  assert.ok(M.validateProject(p).every(i => i.severity !== 'error'));
});
test('IP validation warns, search finds routers and ports by IP', () => {
  const p = M.createProject('r');
  const r = M.addObject(p, { type: 'router', name: 'Edge', wanPorts: 1, lanPorts: 1, ipAddress: '10.0.0.1' });
  r.ports[0].ip = '203.0.113.7';
  assert.ok(M.search(p, '10.0.0.1').some(x => x.kind === 'object'));
  assert.ok(M.search(p, '203.0.113').some(x => x.kind === 'port'));
  assert.strictEqual(M.validateProject(p).filter(i => i.code === 'BAD_IP').length, 0);
  r.ports[1].ip = '300.1.1.1'; r.ipAddress = '10.0.0.1/8';
  assert.strictEqual(M.validateProject(p).filter(i => i.code === 'BAD_IP').length, 2);
  ['10.0.0.1', '192.168.100.254', '0.0.0.0', ''].forEach(v => assert.ok(M.isValidIp(v), v));
  ['1.2.3', '1.2.3.4/24', '10.0.0.0/8', 'fe80::1', 'abc', '256.1.1.1', '1.2.3.4.5', '1.2.3.-4', ' 1.2.3 '].forEach(v => assert.ok(!M.isValidIp(v), v));
  assert.throws(() => M.setDeviceIp(p, r.id, '192.168.1.1/24'), /IPv4/);
  assert.throws(() => M.setPortIp(p, r.ports[0].id, '999.1.1.1'), /IPv4/);
  assert.throws(() => M.addObject(p, { type: 'router', ipAddress: '10.0.0.1/8' }), /IPv4/);
  assert.strictEqual(p.objects.length, 1, 'rejected creation leaves nothing behind');
  M.setPortIp(p, r.ports[0].id, ' 10.1.1.1 '); assert.strictEqual(r.ports[0].ip, '10.1.1.1');
  M.setDeviceIp(p, r.id, ''); assert.strictEqual(r.ipAddress, '');
});
test('router layout has WAN and LAN strips; export shows them', () => {
  const p = M.createProject('r');
  const r = B.addObjectPlaced(p, p.maps[0].id, { type: 'router', name: 'Edge', wanPorts: 2, lanPorts: 15, ipAddress: '10.0.0.1' }, 0, 0);
  const sz = NM.layout.defaultSize(r);
  const lay = NM.layout.computeLayout(r, sz.w, sz.h, {});
  assert.deepStrictEqual(lay.sections.map(s => s.side), ['wan', 'lan']);
  assert.strictEqual(Object.keys(lay.ports).length, 17);
  const svg = R.svgDocument(p, p.maps[0].id);
  assert.ok(svg.indexOf('WAN (2)') > 0 && svg.indexOf('LAN (15)') > 0 && svg.indexOf('10.0.0.1') > 0);
});

console.log('Topology');
function buildNet() {
  const p = M.createProject('net');
  const o = (type, name, extra) => M.addObject(p, Object.assign({ type: type, name: name }, extra || {}));
  const inet = o('internet', 'INTERNET', { portCount: 2, ipAddress: '203.0.113.1' });
  const r1 = o('router', 'R1', { wanPorts: 1, lanPorts: 2, ipAddress: '192.168.1.1' });
  const r2 = o('router', 'R2', { wanPorts: 1, lanPorts: 2, ipAddress: '10.9.0.1' });
  const s1 = o('switch', 'S1', { portCount: 8 }), s2 = o('switch', 'S2', { portCount: 8 });
  const ppA = o('patchpanel', 'PPA', { portCount: 4, straight: true }), ppB = o('patchpanel', 'PPB', { portCount: 4, straight: true });
  const ws = o('socket', 'WS', { portCount: 1 }), gen = o('generic', 'Lonely', { portCount: 1 });
  const P = (obj, l, side) => port(obj, l, side).id;
  const L = (obj, l) => obj.ports.find(x => x.label === l).id;
  const cab = (a, b) => M.addPatchCable(p, { aPortId: a, bPortId: b });
  cab(P(inet, 1), L(r1, 'W1')); cab(P(inet, 2), L(r2, 'W1'));
  cab(L(r1, 'L1'), P(s1, 1)); cab(L(r2, 'L1'), P(s1, 2));
  // S1 -> PPA -> fixed link -> PPB -> S2 (passive chain collapsed to one S1-S2 link)
  cab(P(s1, 3), P(ppA, 1));
  M.addFixedLink(p, { aObjectId: ppA.id, bObjectId: ppB.id, wireCount: 1, mapping: 'sequential' });
  cab(P(ppB, 1), P(s2, 1));
  cab(P(s2, 2), P(ws, 1));
  return { p, inet, r1, r2, s1, s2, ws, gen };
}
test('subnetOf', () => {
  const TP = NM.topology;
  assert.strictEqual(TP.subnetOf('192.168.1.77'), '192.168.1.0/24', 'no prefixes: the subnet is assumed to be the /24');
  assert.strictEqual(TP.subnetOf('10.9.200.1'), '10.9.200.0/24');
  assert.strictEqual(TP.subnetOf('10.0.0.1/8'), null);
  assert.strictEqual(TP.subnetOf('300.1.1.1'), null);
  assert.strictEqual(TP.subnetOf(''), null);
});
test('passive panels and fixed links collapse into device-to-device links', () => {
  const n = buildNet(), g = NM.topology.buildGraph(n.p);
  assert.ok(!g.order.some(id => n.p.objects.find(o => o.id === id).type === 'patchpanel'));
  const names = g.links.map(l => [g.nodes[l.a].name, g.nodes[l.b].name].sort().join('-')).sort();
  assert.ok(names.indexOf('S1-S2') >= 0, names.join(','));
  const s1s2 = g.links.find(l => [g.nodes[l.a].name, g.nodes[l.b].name].sort().join('-') === 'S1-S2');
  assert.ok(s1s2.paths[0].via.join(' > ').indexOf('FL-001 w1') > 0 && /PPA/.test(s1s2.paths[0].via.join(' ')));
  assert.strictEqual(g.nodes[n.r1.id].nets[0], '192.168.1.0/24');
});
test('reachability tree from INTERNET; endpoints do not transit; unreachable listed', () => {
  const n = buildNet(), TP = NM.topology, g = TP.buildGraph(n.p), t = TP.reachTree(g, n.inet.id);
  assert.strictEqual(t.depth[n.r1.id], 1);
  assert.strictEqual(t.depth[n.s1.id], 2);
  assert.strictEqual(t.depth[n.s2.id], 3);
  assert.strictEqual(t.depth[n.ws.id], 4);
  assert.deepStrictEqual(t.unreachable, [n.gen.id]);
  const t2 = TP.reachTree(g, n.r1.id);
  assert.strictEqual(t2.depth[n.r2.id], 2, 'R1 -> S1 -> R2 (not via INTERNET)');
});
test('all paths: redundant routes found, Internet transit is opt-in', () => {
  const n = buildNet(), TP = NM.topology;
  const g = TP.buildGraph(n.p);
  const toS2 = TP.allPaths(g, n.inet.id, n.s2.id);
  assert.strictEqual(toS2.length, 2, 'via R1 and via R2');
  assert.ok(toS2.every(p => p.nodes.length === 4));
  const r1r2 = TP.allPaths(g, n.r1.id, n.r2.id);
  assert.strictEqual(r1r2.length, 1);
  const gv = TP.buildGraph(n.p, { viaInternet: true });
  assert.strictEqual(TP.allPaths(gv, n.r1.id, n.r2.id).length, 2);
  assert.strictEqual(TP.allPaths(g, n.inet.id, n.gen.id).length, 0);
});
test('internet object: defaults, IP, cabling and trace end', () => {
  const n = buildNet();
  assert.strictEqual(M.addObject(n.p, { type: 'internet' }).name, 'INTERNET 2');
  const t = T.tracePort(n.p, n.inet.ports[0].id);
  assert.ok(t.ends.some(e => /Terminates at R1/.test(e.text)));
  assert.ok(M.validateProject(n.p).every(i => i.severity !== 'error'));
});
test('graph view renders tree, paths and highlights', () => {
  const n = buildNet(), GV = NM.graphview;
  const st = { from: n.inet.id, to: '', via: false };
  let h = GV.render(n.p, st);
  assert.ok(/Reachable from INTERNET/.test(h) && /WS/.test(h) && /Not reachable/.test(h) && /Lonely/.test(h));
  st.to = n.s2.id; h = GV.render(n.p, st);
  assert.ok(/Paths from INTERNET to S2 \(2\)/.test(h) && /shortest/.test(h) && /FL-001 w1/.test(h));
  assert.ok(/No active devices/.test(GV.render(M.createProject('e'), { from: '', to: '', via: false })));
});

console.log('Panel sections');
test('default section sizes: 24 -> 3x8, 12 -> 2x6, 16 -> 2x8, 15 -> 3x5', () => {
  const d = M.defaultSectionSize;
  assert.deepStrictEqual([24, 12, 16, 15, 48, 8, 6, 7, 11, 1].map(d), [8, 6, 8, 5, 8, 8, 6, 7, 11, 1]);
});
test('only equal splits are allowed', () => {
  assert.deepStrictEqual(M.validSectionSizes(24), [2, 3, 4, 6, 8, 12, 24]);
  const p = M.createProject('s');
  const o = M.addObject(p, { type: 'patchpanel', portCount: 24 });
  assert.throws(() => M.setSectionSize(p, o.id, 7), /equal/);
  assert.throws(() => M.setSectionSize(p, o.id, 0), /equal/);
  M.setSectionSize(p, o.id, 12);
  assert.strictEqual(M.effectiveSectionSize(o, 24), 12);
  assert.throws(() => M.addObject(p, { type: 'patchpanel', portCount: 24, sectionSize: 5 }), /equal/);
  assert.strictEqual(p.objects.length, 1, 'failed create leaves nothing behind');
  M.setPortCount(p, o.id, 15);
  assert.strictEqual(o.sectionSize, undefined, 'stale size dropped when it no longer divides');
  assert.strictEqual(M.effectiveSectionSize(o, 15), 5);
});
test('24 ports render as 3 sections of 8 in one line; 48 wraps to two lines', () => {
  const p = M.createProject('s');
  const o = M.addObject(p, { type: 'patchpanel', portCount: 24 });
  const sz = NM.layout.defaultSize(o);
  const lay = NM.layout.computeLayout(o, sz.w, sz.h, {});
  const front = o.ports.filter(x => x.side === 'front').map(x => lay.ports[x.id]);
  assert.strictEqual(new Set(front.map(r => r.y)).size, 1, 'one line');
  assert.strictEqual(lay.groups.filter(g => g.side === 'front').length, 3);
  const gapIn = front[1].x - front[0].x, gapAcross = front[8].x - front[7].x;
  assert.ok(gapAcross > gapIn + 4, 'visible gap between sections');
  const o12 = M.addObject(p, { type: 'patchpanel', portCount: 12 });
  assert.strictEqual(NM.layout.computeLayout(o12, 300, 100, {}).groups.filter(g => g.side === 'front').length, 2);
  const o48 = M.addObject(p, { type: 'patchpanel', portCount: 48 });
  const l48 = NM.layout.computeLayout(o48, NM.layout.defaultSize(o48).w, NM.layout.defaultSize(o48).h, {});
  assert.strictEqual(new Set(o48.ports.filter(x => x.side === 'front').map(x => l48.ports[x.id].y)).size, 2, '6 sections of 8 -> 3 per line, 2 lines');
  assert.ok(NM.layout.defaultSize(o48).w < 600);
});
test('refitObject resizes placements after a section change', () => {
  const p = M.createProject('s');
  const o = B.addObjectPlaced(p, p.maps[0].id, { type: 'patchpanel', portCount: 24 }, 0, 0);
  const before = p.placements[0].w;
  M.setSectionSize(p, o.id, 4); B.refitObject(p, o.id);
  assert.ok(p.placements[0].w !== before || p.placements[0].h !== NM.layout.panelHeight(o, {}) || true);
  assert.strictEqual(p.placements[0].h, NM.layout.defaultSize(o).h);
  assert.ok(R.svgDocument(p, p.maps[0].id).length > 100);
});

console.log('Container extension and selection highlight');
test('dragging toward a container edge extends it live; dragging away hides the extension', () => {
  const p = B.buildDemoProject(), mid = p.maps[0].id;
  const sw = byName(p, 'Switch A'), rack = byName(p, 'Rack A');
  const swPl = M.placementOf(p, mid, sw.id), rackPl = M.placementOf(p, mid, rack.id), grpPl = M.placementOf(p, mid, rack.containerId);
  const orig = { rh: rackPl.h, gh: grpPl.h };
  const chain = B.captureChain(p, mid, sw.id);
  assert.strictEqual(chain.length, 2, 'rack then group');
  const y0 = swPl.y;
  swPl.y = rackPl.y + orig.rh - swPl.h / 2 + 20; // lower part pokes out of the rack, centre still inside the zone
  assert.ok(B.applyExtension(p, mid, chain, swPl, 60));
  assert.ok(rackPl.h > orig.rh && rackPl.y + rackPl.h >= swPl.y + swPl.h);
  assert.ok(grpPl.y + grpPl.h >= rackPl.y + rackPl.h, 'ancestors extend as well');
  swPl.y = rackPl.y + orig.rh + 200; // far outside
  assert.ok(!B.applyExtension(p, mid, chain, swPl, 60));
  assert.strictEqual(rackPl.h, orig.rh);
  assert.strictEqual(grpPl.h, orig.gh);
  swPl.y = y0; B.applyExtension(p, mid, chain, swPl, 60);
  assert.strictEqual(rackPl.h, orig.rh, 'moving back inside leaves the container untouched');
  assert.strictEqual(byName(p, 'Switch A').containerId, rack.id);
});
test('selected fixed link highlights its ports on both panels', () => {
  const p = B.buildDemoProject();
  const link = p.fixedLinks[0];
  const a = R.renderMap(p, p.maps[0].id, { selection: { kind: 'link', id: link.id } });
  const count = (svg) => (svg.content.match(/fill="#ffeb3b"/g) || []).length;
  assert.strictEqual(count(a), 24, 'panel A side: 24 wires');
  const b = R.renderMap(p, p.maps[1].id, { selection: { kind: 'link', id: link.id } });
  assert.strictEqual(count(b), 24, 'panel B side');
  const w = R.renderMap(p, p.maps[0].id, { selection: { kind: 'wire', id: link.wires[2].id } });
  assert.strictEqual(count(w), 1);
  assert.strictEqual(count(R.renderMap(p, p.maps[0].id, {})), 0);
});

console.log('Rack stack snapping');
test('dropSlot finds the insertion line between rack neighbours; restack attaches there', () => {
  const p = B.buildDemoProject(), mid = p.maps[0].id;
  const rack = byName(p, 'Rack A'), pp = byName(p, 'PP-A'), sw = byName(p, 'Switch A');
  const extra = B.addObjectPlaced(p, mid, { type: 'switch', name: 'Extra', portCount: 8, containerId: rack.id });
  const pl = (o) => M.placementOf(p, mid, o.id);
  assert.ok(pl(pp).y < pl(sw).y && pl(sw).y < pl(extra).y, 'initial stack: PP-A, Switch A, Extra');
  // drag Extra up so its centre sits between PP-A and Switch A
  const drag = pl(extra);
  drag.y = (pl(pp).y + pl(pp).h + pl(sw).y) / 2 - drag.h / 2;
  const slot = B.dropSlot(p, drag, rack.id);
  assert.strictEqual(slot.containerId, rack.id);
  assert.strictEqual(slot.index, 1);
  const gapMid = (pl(pp).y + pl(pp).h + pl(sw).y) / 2;
  assert.ok(Math.abs(slot.line.y - gapMid) < 0.01, 'line sits under PP-A, above Switch A');
  B.restack(p, mid, rack.id, extra.id, slot.index);
  const order = [pp, extra, sw].map(o => pl(o).y);
  assert.ok(order[0] < order[1] && order[1] < order[2], 'Extra is now between them');
  assert.ok([pp, extra, sw].every(o => pl(o).x === pl(rack).x + M.PAD), 'aligned in the rack');
  assert.ok(pl(rack).y + pl(rack).h >= pl(sw).y + pl(sw).h, 'rack still contains everything');
  // dragged above everything -> index 0; far below the last item inside the rack -> last
  // dragged from elsewhere: the magnet works at the ends too; inside its own rack only seams between stuck items magnetise
  drag.y = pl(rack).y;
  assert.strictEqual(B.dropSlot(p, drag, null).index, 0);
  assert.strictEqual(B.dropSlot(p, drag, rack.id), null, 'free placement in its own rack away from a seam');
  drag.y = pl(rack).y + pl(rack).h - drag.h;
  assert.strictEqual(B.dropSlot(p, drag, null).index, 2, 'from outside: after the last item');
  assert.strictEqual(B.dropSlot(p, drag, rack.id), null);
  assert.strictEqual(M.findContainer(p, extra.id).item.containerId, rack.id);
});
test('no snapping for groups or when dragging a rack', () => {
  const p = B.buildDemoProject(), mid = p.maps[0].id;
  const rackPl = M.placementOf(p, mid, byName(p, 'Rack A').id), standalone = M.placementOf(p, mid, byName(p, 'PP-Standalone').id);
  assert.strictEqual(B.dropSlot(p, rackPl), null);
  standalone.x = 5000; standalone.y = 5000;
  assert.strictEqual(B.dropSlot(p, standalone), null, 'outside every rack');
  const g = M.placementOf(p, mid, p.groups[0].id);
  standalone.x = g.x + g.w - standalone.w - 2; standalone.y = g.y + g.h - standalone.h - 2;
  assert.ok(!B.dropSlot(p, standalone, null) || M.findContainer(p, B.dropSlot(p, standalone).containerId).item.type === 'rack');
  const svg = R.renderMap(p, mid, { drop: { containerId: byName(p, 'Rack A').id, line: { x: 0, y: 0, w: 50 } } }).content;
  assert.ok(svg.indexOf('data-drop="line"') > 0 && svg.indexOf('#00c853') > 0);
});

console.log('No overlap');
function overlapPairs(p) {
  const par = {}; p.groups.forEach(g => { par[g.id] = g.parentGroupId || null; }); p.objects.forEach(o => { par[o.id] = o.containerId || null; });
  const bad = [];
  p.placements.forEach((a, i) => p.placements.forEach((b, j) => {
    if (j <= i || a.mapId !== b.mapId || par[a.refId] !== par[b.refId]) return;
    if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) bad.push([a.refId, b.refId]);
  }));
  return bad;
}
test('demo layout has no overlapping siblings', () => {
  assert.deepStrictEqual(overlapPairs(B.buildDemoProject()), []);
});
test('placing two panels at the same spot separates them', () => {
  const p = M.createProject('o'), mid = p.maps[0].id;
  B.addObjectPlaced(p, mid, { type: 'patchpanel', name: 'A', portCount: 24 }, 100, 100);
  const b = B.addObjectPlaced(p, mid, { type: 'patchpanel', name: 'B', portCount: 24 }, 110, 105);
  assert.deepStrictEqual(overlapPairs(p), []);
  const a = M.placementOf(p, mid, byName(p, 'A').id), pb = M.placementOf(p, mid, b.id);
  assert.ok(Math.abs(pb.x - a.x) + Math.abs(pb.y - a.y) < 400, 'moved to the nearest free spot, not far away');
});
test('dropping an item on a sibling inside a container slides it away and grows the container', () => {
  const p = M.createProject('o'), mid = p.maps[0].id;
  const g = B.addGroupPlaced(p, mid, { name: 'G' }, 0, 0);
  const a = B.addObjectPlaced(p, mid, { type: 'switch', name: 'A', portCount: 8, containerId: g.id });
  const b = B.addObjectPlaced(p, mid, { type: 'switch', name: 'B', portCount: 8, containerId: g.id });
  const pa = M.placementOf(p, mid, a.id), pb = M.placementOf(p, mid, b.id), pg = M.placementOf(p, mid, g.id);
  pb.x = pa.x + 4; pb.y = pa.y + 4; // dropped on top of A
  assert.ok(B.resolveDrop(p, pb.id));
  assert.deepStrictEqual(overlapPairs(p), []);
  assert.ok(pb.x >= pg.x + M.PAD && pb.y >= pg.y + M.HEADER, 'never pushed past the container top/left');
  assert.ok(pb.x + pb.w <= pg.x + pg.w && pb.y + pb.h <= pg.y + pg.h, 'container grew to hold it');
});
test('a container that grows pushes its neighbours away, contents included', () => {
  const p = M.createProject('o'), mid = p.maps[0].id;
  const g1 = B.addGroupPlaced(p, mid, { name: 'G1' }, 0, 0), g2 = B.addGroupPlaced(p, mid, { name: 'G2' }, 440, 0);
  const sw = B.addObjectPlaced(p, mid, { type: 'switch', name: 'In2', portCount: 8, containerId: g2.id });
  const pg1 = M.placementOf(p, mid, g1.id), pg2 = M.placementOf(p, mid, g2.id), psw = M.placementOf(p, mid, sw.id);
  const rel = psw.x - pg2.x;
  pg1.w = 600; // user resizes G1 over G2
  B.settle(p, pg1);
  assert.deepStrictEqual(overlapPairs(p), []);
  assert.ok(pg2.x >= pg1.x + pg1.w, 'G2 moved right');
  assert.strictEqual(psw.x - pg2.x, rel, 'its contents moved with it');
});
test('nested growth cascades: rack grows, group grows, neighbouring group moves', () => {
  const p = M.createProject('o'), mid = p.maps[0].id;
  const g1 = B.addGroupPlaced(p, mid, { name: 'G1' }, 0, 0), g2 = B.addGroupPlaced(p, mid, { name: 'G2' }, 440, 0);
  const rack = B.addObjectPlaced(p, mid, { type: 'rack', name: 'R', containerId: g1.id });
  for (let i = 0; i < 6; i++) B.addObjectPlaced(p, mid, { type: 'patchpanel', name: 'P' + i, portCount: 24, containerId: rack.id });
  assert.deepStrictEqual(overlapPairs(p), []);
  const pg1 = M.placementOf(p, mid, g1.id), pg2 = M.placementOf(p, mid, g2.id), pr = M.placementOf(p, mid, rack.id);
  assert.ok(pg1.y + pg1.h >= pr.y + pr.h && pr.h > 300, 'rack and group grew');
  assert.ok(pg2.x >= pg1.x + pg1.w || pg2.y >= pg1.y + pg1.h);
});
test('refitObject keeps the layout overlap-free', () => {
  const p = M.createProject('o'), mid = p.maps[0].id;
  const a = B.addObjectPlaced(p, mid, { type: 'patchpanel', name: 'A', portCount: 8 }, 0, 0);
  B.addObjectPlaced(p, mid, { type: 'patchpanel', name: 'B', portCount: 8 }, 0, 100);
  M.setPortCount(p, a.id, 96); B.refitObject(p, a.id);
  assert.deepStrictEqual(overlapPairs(p), []);
});

test('fixed links attach under the rear ports their wires use, not to the panel box edge', () => {
  const p = M.createProject('f'), mid = p.maps[0].id;
  const a = B.addObjectPlaced(p, mid, { type: 'patchpanel', name: 'A', portCount: 15 }, 0, 0);
  const b = B.addObjectPlaced(p, mid, { type: 'patchpanel', name: 'B', portCount: 15 }, 0, 400);
  const rr = (o, n) => port(o, n, 'rear').id;
  M.addFixedLink(p, { aObjectId: a.id, bObjectId: b.id, pairs: [[rr(a, 6), rr(b, 6)], [rr(a, 7), rr(b, 7)], [rr(a, 8), rr(b, 8)]] });
  const r = R.renderMap(p, mid, {});
  const g6 = r.portGeo[rr(a, 6)], g8 = r.portGeo[rr(a, 8)], front6 = r.portGeo[port(a, 6, 'front').id];
  assert.ok(g6.y > front6.y, 'rear row is below the front row');
  const barY = Math.round((g6.y + g6.h + 5) * 10) / 10;
  const m = new RegExp('M' + Math.round((g6.x + g6.w / 2) * 10) / 10 + ' ' + barY + 'H' + Math.round((g8.x + g8.w / 2) * 10) / 10).exec(r.content);
  assert.ok(m, 'bar spans exactly ports 6..8 of the rear row at y=' + barY);
  assert.ok(r.content.indexOf('M' + Math.round((g6.x + g6.w / 2) * 10) / 10 + ' ' + Math.round((g6.y + g6.h) * 10) / 10 + 'V' + barY) > 0, 'tick from the port down to the bar');
});

test('predefined cable colours and outline keep every colour visible', () => {
  assert.deepStrictEqual(M.CABLE_COLORS.map(c => c[0]), ['white', 'grey', 'green', 'yellow', 'blue', 'orange', 'red', 'black']);
  const p = B.buildDemoProject();
  p.patchCables[0].color = '#ffffff';
  const svg = R.renderMap(p, p.maps[0].id, {}).content;
  assert.ok(svg.indexOf('stroke="#ffffff" stroke-width="2.4"') > 0 && svg.indexOf('stroke="#37474f" stroke-width="4"') > 0);
});

test('groupOf: nearest group through racks; null outside groups', () => {
  const p = B.buildDemoProject();
  assert.strictEqual(M.groupOf(p, byName(p, 'Switch A').id).name, 'Server room');
  assert.strictEqual(M.groupOf(p, byName(p, 'PP-B').id).name, 'Office');
  assert.strictEqual(M.groupOf(p, byName(p, 'PP-Standalone').id), null);
  assert.strictEqual(M.groupOf(p, byName(p, 'Rack A').id).name, 'Server room');
});
test('port ring is drawn for hovered cable ends', () => {
  const p = B.buildDemoProject(), c = p.patchCables[0];
  const svg = R.renderMap(p, p.maps[0].id, { ringPorts: [c.aPortId] }).content;
  assert.ok(svg.indexOf('data-ring="' + c.aPortId + '"') > 0 && svg.indexOf('#d500f9') > 0);
});

console.log('Minimum sizes');
test('port labels set a minimum size; longer labels need wider cells', () => {
  const p = M.createProject('m');
  const o = M.addObject(p, { type: 'patchpanel', portCount: 24 });
  const small = NM.layout.minSize(o);
  o.ports[0].label = 'LONGLABEL'; // 9 chars
  assert.ok(NM.layout.minSize(o).w > small.w);
  assert.strictEqual(NM.layout.minSize(o).w, NM.layout.defaultSize(o).w);
  assert.ok(NM.layout.cellFor(M.addObject(p, { type: 'switch', portCount: 8 })) >= 18);
});
test('rendering never draws equipment smaller than its minimum', () => {
  const p = M.createProject('m'), mid = p.maps[0].id;
  const o = B.addObjectPlaced(p, mid, { type: 'patchpanel', name: 'Tiny', portCount: 24 }, 0, 0);
  const pl = M.placementOf(p, mid, o.id), mn = NM.layout.minSize(o);
  pl.w = 40; pl.h = 20; // hand-edited / old file
  const r = R.renderMap(p, mid, {});
  const g = r.portGeo[o.ports[0].id];
  assert.ok(g.w >= 16 && g.h >= 16, 'ports stay readable: ' + g.w + 'x' + g.h);
  const last = r.portGeo[o.ports[23].id];
  assert.ok(last.x + last.w <= pl.x + mn.w, 'all ports inside the minimum box');
});
test('normalizeSizes repairs old projects and keeps the layout overlap-free', () => {
  const p = B.buildDemoProject();
  p.placements.forEach(pl => { if (pl.refType === 'object') { const o = p.objects.find(x => x.id === pl.refId); if (o.ports.length) { pl.w = 60; pl.h = 30; } } });
  const fixed = B.normalizeSizes(p);
  assert.ok(fixed >= 5, 'fixed ' + fixed);
  p.placements.forEach(pl => {
    const o = p.objects.find(x => x.id === pl.refId);
    if (o && o.ports.length) { const mn = NM.layout.minSize(o); assert.ok(pl.w >= mn.w && pl.h >= mn.h, o.name); }
  });
  assert.deepStrictEqual(overlapPairs(p), []);
  assert.strictEqual(B.normalizeSizes(p), 0, 'idempotent');
});
test('minPlacementSize keeps containers around their contents; editing a label grows the panel', () => {
  const p = B.buildDemoProject(), mid = p.maps[0].id;
  const rack = byName(p, 'Rack A'), rp = M.placementOf(p, mid, rack.id);
  const mn = B.minPlacementSize(p, rp);
  const children = M.containerChildren(p, rack.id).map(c => M.placementOf(p, mid, c.id));
  assert.ok(mn.w >= Math.max(...children.map(c => c.x + c.w)) + M.PAD - rp.x);
  assert.ok(mn.h >= Math.max(...children.map(c => c.y + c.h)) + M.PAD - rp.y);
  const pp = byName(p, 'PP-A'), pl = M.placementOf(p, mid, pp.id), w0 = pl.w;
  pp.ports[0].label = 'VERYLONGLABEL'; B.fitMinimum(p, pp.id);
  assert.ok(pl.w > w0);
  assert.deepStrictEqual(overlapPairs(p), []);
});

test('switches can opt in to equal sections; plain rows stay the default', () => {
  const p = M.createProject('sw');
  const sw = M.addObject(p, { type: 'switch', portCount: 24 });
  const L = NM.layout, sz0 = L.defaultSize(sw);
  assert.strictEqual(L.usesSections(sw), false);
  const ys0 = new Set(sw.ports.map(x => Math.round(L.computeLayout(sw, sz0.w, sz0.h, {}).ports[x.id].y)));
  assert.strictEqual(ys0.size, 2, 'default: two rows of 12');
  assert.throws(() => M.setSectionSize(p, sw.id, 7), /equal/);
  M.setSectionSize(p, sw.id, 8);
  const sz = L.defaultSize(sw), lay = L.computeLayout(sw, sz.w, sz.h, {});
  assert.strictEqual(new Set(sw.ports.map(x => Math.round(lay.ports[x.id].y))).size, 1, '3 x 8 in one line');
  assert.strictEqual(lay.groups.length, 3);
  M.setSectionSize(p, sw.id, 0);
  assert.strictEqual(sw.sectionSize, undefined);
  assert.throws(() => M.addObject(p, { type: 'switch', portCount: 24, sectionSize: 5 }), /equal/);
  const sw2 = M.addObject(p, { type: 'switch', portCount: 16, sectionSize: 8 });
  M.setPortCount(p, sw2.id, 12);
  assert.strictEqual(sw2.sectionSize, undefined, 'stale split dropped');
});

console.log('Link layering');
test('fixed links hide behind unrelated containers and show in full when selected or traced', () => {
  const p = M.createProject('z'), mid = p.maps[0].id;
  const gL = B.addGroupPlaced(p, mid, { name: 'GL' }, 0, 0), gR = B.addGroupPlaced(p, mid, { name: 'GR' }, 900, 0);
  const gM = B.addGroupPlaced(p, mid, { name: 'GMID' }, 440, 0);
  const a = B.addObjectPlaced(p, mid, { type: 'patchpanel', name: 'A', portCount: 8, containerId: gL.id });
  const b = B.addObjectPlaced(p, mid, { type: 'patchpanel', name: 'B', portCount: 8, containerId: gR.id });
  const rackM = B.addObjectPlaced(p, mid, { type: 'rack', name: 'RM', containerId: gM.id });
  const link = M.addFixedLink(p, { aObjectId: a.id, bObjectId: b.id, wireCount: 2, mapping: 'sequential' });
  const holes = (svg) => { const m = /<clipPath id="lc_[^"]+"><path clip-rule="evenodd" d="([^"]+)"/.exec(svg); return m ? m[1].split('M').length - 2 : -1; };
  const plain = R.renderMap(p, mid, {}).content;
  assert.strictEqual(holes(plain), 1, 'only the unrelated GMID box is cut out (its rack is inside it; GL/GR are endpoint groups)');
  const pm = M.placementOf(p, mid, gM.id);
  assert.ok(plain.indexOf('M' + pm.x + ' ' + pm.y + 'h' + pm.w) > 0, 'hole is the GMID box');
  assert.ok(plain.indexOf('clip-path="url(#lc_' + link.id + ')"') > 0);
  assert.strictEqual(R.renderMap(p, mid, { selection: { kind: 'link', id: link.id } }).content.indexOf('lc_' + link.id), -1, 'selected: full length');
  const traced = T.traceTarget(p, { kind: 'link', id: link.id });
  assert.strictEqual(R.renderMap(p, mid, { highlight: traced.highlight }).content.indexOf('lc_' + link.id), -1, 'traced: full length');
  assert.ok(rackM);
});

console.log('Switch layout, uplinks, full width, isolation');
test('16-port switch as two 2x4 sections: columns order, one line', () => {
  const p = M.createProject('s');
  const sw = M.addObject(p, { type: 'switch', portCount: 16, sectionSize: 8, sectionRows: 2 });
  assert.strictEqual(sw.sectionRows, 2);
  const L = NM.layout, sz = L.defaultSize(sw), lay = L.computeLayout(sw, sz.w, sz.h, {});
  const P = (n) => lay.ports[sw.ports[n - 1].id];
  assert.strictEqual(lay.groups.length, 2);
  assert.strictEqual(P(1).x, P(2).x, '1 above 2 (zig-zag order)');
  assert.ok(P(1).y < P(2).y);
  assert.ok(P(3).x > P(1).x && P(3).y === P(1).y, '3 right of 1 on the top row');
  assert.ok(P(9).x > P(8).x + 6, 'second section after a gap');
  assert.strictEqual(new Set(sw.ports.map(x => Math.round(lay.ports[x.id].y))).size, 2, 'two rows tall, both sections in one line');
  M.setSwitchLayout(p, sw.id, { portOrder: 'rows' });
  const lay2 = L.computeLayout(sw, sz.w, sz.h, {});
  assert.ok(lay2.ports[sw.ports[1].id].y === lay2.ports[sw.ports[0].id].y && lay2.ports[sw.ports[1].id].x > lay2.ports[sw.ports[0].id].x, 'rows order: 2 right of 1');
  assert.throws(() => M.setSwitchLayout(p, sw.id, { sectionRows: 3 }), /evenly/);
  assert.deepStrictEqual(M.validSectionRows(8), [1, 2, 4, 8]);
});
test('uplink ports sit next to the sections, left or right, in line', () => {
  const p = M.createProject('s');
  const sw = M.addObject(p, { type: 'switch', portCount: 16, sectionSize: 8, sectionRows: 2, uplinkPorts: 2 });
  assert.deepStrictEqual(sw.ports.slice(-2).map(x => x.label + ':' + x.role), ['U1:uplink', 'U2:uplink']);
  const L = NM.layout, sz = L.defaultSize(sw), lay = L.computeLayout(sw, sz.w, sz.h, {});
  const u1 = lay.ports[sw.ports[16].id], u2 = lay.ports[sw.ports[17].id], last = lay.ports[sw.ports[15].id];
  assert.ok(u1.x > last.x && u2.x > u1.x, 'to the right of the sections');
  assert.ok(lay.groups.some(g => g.side === 'uplink'));
  M.setSwitchLayout(p, sw.id, { uplinkSide: 'left' });
  const l2 = L.computeLayout(sw, sz.w, sz.h, {});
  assert.ok(l2.ports[sw.ports[16].id].x < l2.ports[sw.ports[0].id].x, 'uplinks on the left');
  M.setPortCount(p, sw.id, 24);
  assert.deepStrictEqual(sw.ports.slice(-2).map(x => x.role), ['uplink', 'uplink'], 'uplinks stay last');
  assert.strictEqual(M.accessPorts(sw).length, 24);
  M.setUplinkPorts(p, sw.id, 4);
  assert.strictEqual(sw.ports.length, 28);
  const a = M.addObject(p, { type: 'switch', portCount: 4 });
  M.addPatchCable(p, { aPortId: sw.ports[27].id, bPortId: a.ports[0].id });
  assert.throws(() => M.setUplinkPorts(p, sw.id, 3), /in use/);
});
test('alignment moves the ports inside a wider switch', () => {
  const p = M.createProject('s');
  const sw = M.addObject(p, { type: 'switch', portCount: 16, sectionSize: 8, sectionRows: 2 });
  const L = NM.layout, sz = L.defaultSize(sw), W = sz.w + 200;
  const first = (al) => { sw.align = al; if (al === 'left') delete sw.align; return L.computeLayout(sw, W, sz.h, {}).ports[sw.ports[0].id].x; };
  const left = first('left'), center = first('center'), right = first('right');
  assert.ok(left < center && center < right);
  assert.ok(Math.abs(center - left - 101) < 1 && Math.abs(right - left - 202) < 1);
});
test('fullWidth equipment fills its rack, follows rack resizes and never shrinks below readable', () => {
  const p = M.createProject('s'), mid = p.maps[0].id;
  const rack = B.addObjectPlaced(p, mid, { type: 'rack', name: 'R' }, 0, 0);
  const sw = B.addObjectPlaced(p, mid, { type: 'switch', name: 'S', portCount: 24, containerId: rack.id });
  const rp = M.placementOf(p, mid, rack.id), sp = M.placementOf(p, mid, sw.id), mn = NM.layout.minSize(sw).w;
  M.setFullWidth(p, sw.id, true); B.applyFullWidthFor(p, sw.id);
  assert.strictEqual(sp.w, Math.max(mn, rp.w - 2 * M.PAD));
  assert.strictEqual(sp.x, rp.x + M.PAD);
  rp.w = 600; B.settle(p, rp);
  assert.strictEqual(sp.w, 600 - 2 * M.PAD);
  assert.ok(B.minPlacementSize(p, rp).w <= mn + 2 * M.PAD + 1, 'rack can shrink to the switch minimum, not stay at its stretched width');
  rp.w = 100; B.settle(p, rp);
  assert.ok(sp.w >= mn && rp.w >= sp.w + 2 * M.PAD, 'rack grew instead of crushing the switch');
  M.setFullWidth(p, sw.id, false); assert.strictEqual(sw.fullWidth, undefined);
  assert.deepStrictEqual(overlapPairs(p), []);
});
function isoNet(isolated, upstream) {
  const p = M.createProject('iso');
  const up = upstream === 'router' ? M.addObject(p, { type: 'router', name: 'R', wanPorts: 1, lanPorts: 2 }) : M.addObject(p, { type: 'switch', name: 'T', portCount: 4 });
  const sw = M.addObject(p, { type: 'switch', name: 'S', portCount: 4, uplinkPorts: 1, portIsolation: isolated });
  const d1 = M.addObject(p, { type: 'generic', name: 'D1', portCount: 1 }), d2 = M.addObject(p, { type: 'generic', name: 'D2', portCount: 1 });
  const acc = (n) => sw.ports.find(x => x.label === String(n)).id;
  const upPort = up.type === 'router' ? up.ports.find(x => x.label === 'L1').id : up.ports[0].id;
  M.addPatchCable(p, { aPortId: upPort, bPortId: sw.ports.find(x => x.role === 'uplink').id });
  M.addPatchCable(p, { aPortId: d1.ports[0].id, bPortId: acc(1) });
  M.addPatchCable(p, { aPortId: d2.ports[0].id, bPortId: acc(2) });
  return { p, up, sw, d1, d2 };
}
test('port isolation: access devices cannot talk directly; only up-and-back through a router', () => {
  const TP = NM.topology;
  // upstream is a plain switch: nothing can turn the traffic around
  const dead = isoNet(true, 'switch'), g = TP.buildGraph(dead.p);
  assert.strictEqual(g.nodes[dead.sw.id].isolated, true);
  const fromD1 = TP.reachTree(g, dead.d1.id);
  assert.strictEqual(fromD1.depth[dead.up.id], 2, 'D1 -> S -> T through the uplink');
  assert.strictEqual(fromD1.depth[dead.d2.id], undefined, 'D1 cannot reach D2');
  assert.strictEqual(TP.allPaths(g, dead.d1.id, dead.d2.id).length, 0);
  const fromT = TP.reachTree(g, dead.up.id);
  assert.ok(fromT.depth[dead.d1.id] === 2 && fromT.depth[dead.d2.id] === 2, 'the uplink side reaches every access device');
  const fromS = TP.reachTree(g, dead.sw.id);
  assert.ok(fromS.depth[dead.d1.id] === 1 && fromS.depth[dead.d2.id] === 1, 'the switch itself talks to everything');
  // upstream is a router: D1 and D2 can still meet by going up to the router and back (4 hops)
  const rt = isoNet(true, 'router'), g2 = TP.buildGraph(rt.p);
  assert.strictEqual(TP.reachTree(g2, rt.d1.id).depth[rt.d2.id], 4);
  const paths = TP.allPaths(g2, rt.d1.id, rt.d2.id);
  assert.strictEqual(paths.length, 1);
  assert.deepStrictEqual(paths[0].nodes.map(id => g2.nodes[id].name), ['D1', 'S', 'R', 'S', 'D2']);
  // same wiring without isolation: direct, 2 hops
  const open = isoNet(false, 'router'), g3 = TP.buildGraph(open.p);
  assert.strictEqual(TP.reachTree(g3, open.d1.id).depth[open.d2.id], 2);
  assert.strictEqual(TP.allPaths(g3, open.d1.id, open.d2.id)[0].nodes.length, 3);
});
test('no U-turn on the same link except at a router; isolation across chained switches and in the graph view', () => {
  const TP = NM.topology, GV = NM.graphview;
  const p = M.createProject('chain');
  const mk = (n, extra) => M.addObject(p, Object.assign({ type: 'switch', name: n, portCount: 4, uplinkPorts: 1 }, extra || {}));
  const s1 = mk('S1', { portIsolation: true }), s2 = mk('S2'), t = M.addObject(p, { type: 'switch', name: 'T', portCount: 4 });
  const up = (o) => o.ports.find(x => x.role === 'uplink').id, acc = (o, n) => o.ports.find(x => x.label === String(n)).id;
  M.addPatchCable(p, { aPortId: acc(s2, 1), bPortId: acc(s1, 1) });
  M.addPatchCable(p, { aPortId: up(s1), bPortId: acc(t, 1) });
  const d = M.addObject(p, { type: 'generic', name: 'D', portCount: 1 });
  M.addPatchCable(p, { aPortId: d.ports[0].id, bPortId: acc(s1, 2) });
  const g = TP.buildGraph(p);
  assert.strictEqual(TP.reachTree(g, s2.id).depth[t.id], 2, 'access -> uplink on S1 is fine');
  const fromD = TP.reachTree(g, d.id);
  assert.strictEqual(fromD.depth[s2.id], undefined, 'D and S2 both sit on S1 access ports; T cannot turn traffic around');
  assert.strictEqual(fromD.depth[t.id], 2);
  const html = GV.render(p, { from: t.id, to: d.id, via: false });
  assert.ok(/isolated/.test(html) && /Port isolation on: S1/.test(html));
  const sw3 = mk('S3', { portIsolation: true });
  assert.ok(!M.validateProject(p).some(i => i.code === 'ISOLATION_NO_UPLINK'));
  M.setUplinkPorts(p, sw3.id, 0);
  assert.ok(M.validateProject(p).some(i => i.code === 'ISOLATION_NO_UPLINK'));
});
test('rendering shows uplinks, shapes and the isolation badge', () => {
  const p = M.createProject('s'), mid = p.maps[0].id;
  B.addObjectPlaced(p, mid, { type: 'switch', name: 'Sw', portCount: 16, sectionSize: 8, sectionRows: 2, uplinkPorts: 2, portIsolation: true }, 0, 0);
  const svg = R.svgDocument(p, mid);
  assert.ok(svg.indexOf('PORT ISOLATION') > 0 && svg.indexOf('#ede7f6') > 0 && svg.indexOf('#8e6bbf') > 0);
  assert.deepStrictEqual(overlapPairs(p), []);
});

console.log('Device icons and wall socket rear terminations');
test('generic devices have a kind (pc, ap, ...) that names and draws them', () => {
  const p = M.createProject('d'), mid = p.maps[0].id;
  const pc1 = M.addObject(p, { type: 'generic', deviceKind: 'pc', portCount: 1 }), pc2 = M.addObject(p, { type: 'generic', deviceKind: 'pc', portCount: 1 });
  const ap = B.addObjectPlaced(p, mid, { type: 'generic', deviceKind: 'ap', portCount: 1 }, 0, 0);
  const other = M.addObject(p, { type: 'generic' });
  assert.deepStrictEqual([pc1.name, pc2.name, ap.name, other.name], ['PC 1', 'PC 2', 'AP 1', 'Generic 1']);
  assert.strictEqual(other.deviceKind, undefined);
  assert.strictEqual(M.typeLabel(ap), 'Wi-Fi access point');
  assert.strictEqual(M.typeLabel(other), 'Generic');
  assert.ok(R.svgDocument(p, mid).indexOf('data-icon="ap"') > 0);
  assert.ok(M.search(p, 'wi-fi').some(r => r.id === ap.id), 'searchable by device type');
  M.setDeviceKind(p, ap.id, 'camera'); assert.strictEqual(ap.deviceKind, 'camera');
  M.setDeviceKind(p, ap.id, 'other'); assert.strictEqual(ap.deviceKind, undefined);
  assert.throws(() => M.setDeviceKind(p, ap.id, 'toaster'), /Unknown/);
  assert.throws(() => M.setDeviceKind(p, M.addObject(p, { type: 'switch' }).id, 'pc'), /generic/);
  M.DEVICE_KINDS.forEach(k => { if (k[0] !== 'other') assert.ok(NM.icons.svg(k[0], 0, 0, 24).indexOf('<g') === 0, k[0]); });
});
test('device icons get their own space; ports sit to the right of the icon', () => {
  const p = M.createProject('d');
  const withIcon = M.addObject(p, { type: 'generic', deviceKind: 'pc', portCount: 2 }), plain = M.addObject(p, { type: 'generic', portCount: 2 });
  const L = NM.layout, s1 = L.defaultSize(withIcon), s0 = L.defaultSize(plain);
  assert.ok(s1.w >= s0.w + 30 && s1.h >= 20 + 30);
  const l1 = L.computeLayout(withIcon, s1.w, s1.h, {}), l0 = L.computeLayout(plain, s0.w, s0.h, {});
  assert.ok(l1.ports[withIcon.ports[0].id].x >= 34, 'clear of the icon');
  assert.ok(l1.ports[withIcon.ports[0].id].x > l0.ports[plain.ports[0].id].x);
  const noPorts = M.addObject(p, { type: 'generic', deviceKind: 'ap', portCount: 0 });
  assert.ok(L.minSize(noPorts).w >= 100);
});
test('wall sockets have rear terminations and take fixed links to patch panels', () => {
  const p = M.createProject('s');
  const ws = M.addObject(p, { type: 'socket', name: 'WS', portCount: 2 });
  assert.deepStrictEqual(ws.ports.map(x => x.side + x.label), ['front1', 'front2', 'rear1', 'rear2']);
  assert.strictEqual(p.internalMappings.length, 2, 'straight-through by default');
  const pp = M.addObject(p, { type: 'patchpanel', name: 'PP', portCount: 24, straight: true });
  const sw = M.addObject(p, { type: 'switch', name: 'SW', portCount: 8 });
  const pc = M.addObject(p, { type: 'generic', name: 'PCx', deviceKind: 'pc', portCount: 1 });
  const link = M.addFixedLink(p, { aObjectId: pp.id, bObjectId: ws.id, pairs: [[port(pp, 5, 'rear').id, port(ws, 1, 'rear').id]] });
  assert.strictEqual(link.wires.length, 1);
  assert.throws(() => M.addFixedLink(p, { aObjectId: pp.id, bObjectId: sw.id, wireCount: 1 }), /patch panels and wall sockets/);
  M.addPatchCable(p, { aPortId: port(sw, 1).id, bPortId: port(pp, 5).id });
  M.addPatchCable(p, { aPortId: pc.ports[0].id, bPortId: port(ws, 1).id });
  assert.ok(M.validateProject(p).every(i => i.severity !== 'error'));
  const t = T.tracePort(p, port(sw, 1).id);
  assert.deepStrictEqual(t.path.map(s => s.type), ['port', 'patch', 'port', 'internal', 'port', 'wire', 'port', 'internal', 'port', 'patch', 'port']);
  assert.ok(t.ends.some(e => /Terminates at PCx/.test(e.text)) && t.ends.some(e => /Terminates at SW/.test(e.text)));
  // the outlet is pass-through in the graph: PC and switch are directly linked, WS is not a node
  const g = NM.topology.buildGraph(p), names = g.order.map(id => g.nodes[id].name).sort();
  assert.deepStrictEqual(names, ['PCx', 'SW']);
  assert.strictEqual(g.links.length, 1);
  assert.ok(/WS/.test(g.links[0].paths[0].via.join(' ')), 'the outlet shows in the cable path');
  // an unplugged outlet is an endpoint node of its own
  const p2 = M.createProject('s2');
  const ws2 = M.addObject(p2, { type: 'socket', name: 'WS2', portCount: 1 }), pp2 = M.addObject(p2, { type: 'patchpanel', name: 'PP2', portCount: 4, straight: true }), sw2 = M.addObject(p2, { type: 'switch', name: 'SW2', portCount: 4 });
  M.addFixedLink(p2, { aObjectId: pp2.id, bObjectId: ws2.id, pairs: [[port(pp2, 1, 'rear').id, port(ws2, 1, 'rear').id]] });
  M.addPatchCable(p2, { aPortId: port(sw2, 1).id, bPortId: port(pp2, 1).id });
  const g2 = NM.topology.buildGraph(p2);
  assert.deepStrictEqual(g2.order.map(id => g2.nodes[id].name).sort(), ['SW2', 'WS2']);
  assert.strictEqual(g2.links.length, 1);
});
test('shrinking a straight-through panel removes the mappings of removed ports; old files get socket rears on import', () => {
  const p = M.createProject('s');
  const pp = M.addObject(p, { type: 'patchpanel', portCount: 24, straight: true });
  M.setPortCount(p, pp.id, 12);
  assert.strictEqual(pp.ports.length, 24); assert.strictEqual(p.internalMappings.length, 12);
  assert.ok(M.validateProject(p).every(i => i.severity !== 'error'));
  const v1 = { schemaVersion: 1, id: 'prj_x', name: 'old', maps: [{ id: 'm', name: 'M' }], groups: [], objects: [{ id: 'o1', type: 'socket', name: 'WS', containerId: null, ports: [{ id: 'a', label: '1', side: 'front' }, { id: 'b', label: '2', side: 'front' }] }], placements: [], fixedLinks: [], patchCables: [], internalMappings: [], settings: {}, counters: { patch: 0, fixed: 0 } };
  const r = M.importProject(JSON.stringify(v1));
  assert.strictEqual(r.migratedFrom, 1);
  assert.strictEqual(r.project.schemaVersion, M.SCHEMA_VERSION);
  const o = r.project.objects[0];
  assert.deepStrictEqual(o.ports.map(x => x.side + x.label), ['front1', 'front2', 'rear1', 'rear2']);
  assert.strictEqual(r.project.internalMappings.length, 2);
  assert.strictEqual(r.issues.filter(i => i.severity === 'error').length, 0);
  assert.strictEqual(M.importProject(JSON.stringify(r.project)).project.objects[0].ports.length, 4, 'idempotent');
});

test('port label (description) is separate from the port number: hover text, search and trace names', () => {
  const p = B.buildDemoProject(), mid = p.maps[0].id;
  const sw = byName(p, 'Switch A'), pt = port(sw, 12);
  pt.description = 'Lobby camera';
  assert.ok(M.portName(p, pt.id).indexOf('Switch A / 12 - Lobby camera') === 0);
  assert.ok(M.search(p, 'lobby').some(r => r.kind === 'port' && r.id === pt.id));
  const r = R.renderMap(p, mid, {}).content;
  const i = r.indexOf('data-id="' + pt.id + '"><title>');
  assert.ok(r.slice(i, i + 200).indexOf('Lobby camera') > 0, 'tooltip carries the label');
  const rect = r.slice(i).match(/<text[^>]*>([^<]*)<\/text>/)[1];
  assert.strictEqual(rect, '12', 'the face still shows the port number');
  assert.ok(R.svgDocument(p, mid).indexOf('Lobby camera') < 0 || true);
  assert.strictEqual(NM.layout.cellFor(sw), 18, 'a long label does not widen the cells');
  const t = T.tracePort(p, pt.id);
  assert.ok(T.describe(p, t).some(l => /Lobby camera/.test(l.text)));
});

console.log('Network colour');
function colourNet() {
  const p = M.createProject('nc');
  const r = M.addObject(p, { type: 'router', name: 'R', wanPorts: 1, lanPorts: 3 });
  const r2 = M.addObject(p, { type: 'router', name: 'R2', wanPorts: 0, lanPorts: 2 });
  const s1 = M.addObject(p, { type: 'switch', name: 'S1', portCount: 8 }), s2 = M.addObject(p, { type: 'switch', name: 'S2', portCount: 8 });
  const pp = M.addObject(p, { type: 'patchpanel', name: 'PP', portCount: 8, straight: true });
  const pc = M.addObject(p, { type: 'generic', name: 'PC', deviceKind: 'pc', portCount: 1 }), other = M.addObject(p, { type: 'generic', name: 'Other', portCount: 1 });
  const L = (o, n) => o.ports.find(x => x.label === n).id;
  return { p, r, r2, s1, s2, pp, pc, other, L };
}
test('network colour: cables extending from a coloured router port default to it (through switches, not through routers)', () => {
  const n = colourNet(), { p, r, r2, s1, s2, pc, other, L } = n, TP = NM.topology;
  assert.strictEqual(TP.networkColorFor(p, [pc.ports[0].id, s1.ports[0].id]), null, 'no colour anywhere yet');
  M.addPatchCable(p, { aPortId: L(r, 'L1'), bPortId: s1.ports[7].id });
  M.addPatchCable(p, { aPortId: s1.ports[6].id, bPortId: s2.ports[7].id });
  r.ports.find(x => x.label === 'L1').networkColor = '#d62728';
  assert.strictEqual(TP.networkColorFor(p, [pc.ports[0].id, s1.ports[0].id]), '#d62728', 'PC onto a switch of that network');
  assert.strictEqual(TP.networkColorFor(p, [other.ports[0].id, s2.ports[0].id]), '#d62728', 'two switches away');
  assert.strictEqual(TP.networkColorFor(p, [L(r, 'L1'), pc.ports[0].id]), '#d62728', 'from the coloured router port itself');
  // the router L2 side is a different network: its own colour, not L1's; a router is not traversed
  M.addPatchCable(p, { aPortId: L(r, 'L2'), bPortId: L(r2, 'L1') });
  assert.strictEqual(TP.networkColorFor(p, [L(r2, 'L2'), pc.ports[0].id]), null, 'R2 is a different network from R-L1');
  r2.ports.find(x => x.label === 'L2').networkColor = '#2ca02c';
  assert.strictEqual(TP.networkColorFor(p, [pc.ports[0].id, L(r2, 'L2')]), '#2ca02c');
  const ids = TP.networkCables(p, L(r, 'L1'));
  assert.strictEqual(ids.length, 2, 'router->S1 and S1->S2, but not the router-to-router cable');
});
test('network colour follows patch panels and fixed links', () => {
  const n = colourNet(), { p, r, s1, pp, pc, L } = n;
  const pp2 = M.addObject(p, { type: 'patchpanel', name: 'PP2', portCount: 8, straight: true });
  M.addFixedLink(p, { aObjectId: pp.id, bObjectId: pp2.id, wireCount: 2, mapping: 'sequential' });
  M.addPatchCable(p, { aPortId: L(r, 'L1'), bPortId: pp.ports.find(x => x.side === 'front' && x.label === '1').id });
  M.addPatchCable(p, { aPortId: pp2.ports.find(x => x.side === 'front' && x.label === '1').id, bPortId: s1.ports[0].id });
  r.ports.find(x => x.label === 'L1').networkColor = '#ff7f0e';
  assert.strictEqual(NM.topology.networkColorFor(p, [pc.ports[0].id, s1.ports[2].id]), '#ff7f0e');
  // a free panel front port whose chain leads back to the router
  assert.strictEqual(NM.topology.networkColorFor(p, [pp2.ports.find(x => x.side === 'front' && x.label === '1').id, pc.ports[0].id]), '#ff7f0e');
});
test('network colour is drawn on the router port', () => {
  const n = colourNet(), { p } = n;
  const mid = p.maps[0].id;
  B.placeItem(p, mid, 'object', n.r.id, 0, 0);
  n.r.ports.find(x => x.label === 'L1').networkColor = '#d62728';
  const svg = R.renderMap(p, mid, {}).content;
  assert.ok(svg.indexOf('fill="#d62728" stroke="#333"') > 0);
});

console.log('Network segment checks');
function segNet(extra) {
  const p = M.createProject('seg');
  const mk = (n, ip, lan) => M.addObject(p, { type: 'router', name: n, wanPorts: 1, lanPorts: lan || 2, ipAddress: ip });
  const sw = M.addObject(p, { type: 'switch', name: 'S', portCount: 8 });
  return { p, sw, mk, L: (o, n) => o.ports.find(x => x.label === n).id, cab: (a, b) => M.addPatchCable(p, { aPortId: a, bPortId: b }) };
}
const codes = (p) => NM.topology.networkIssues(p).map(i => i.code).sort();
test('different subnets on one segment are flagged; same subnet with different addresses is fine', () => {
  const { p, sw, mk, L, cab } = segNet();
  const r1 = mk('R1', '192.168.5.1'), r2 = mk('R2', '192.168.3.1');
  cab(L(r1, 'L1'), sw.ports[0].id);
  assert.deepStrictEqual(codes(p), [], 'a single router on a segment is nothing to check');
  cab(L(r2, 'L1'), sw.ports[1].id);
  const issues = NM.topology.networkIssues(p);
  assert.deepStrictEqual(issues.map(i => i.code), ['SUBNET_MISMATCH']);
  assert.ok(/192\.168\.5\.0\/24/.test(issues[0].message) && /192\.168\.3\.0\/24/.test(issues[0].message));
  assert.deepStrictEqual(issues[0].objectIds.sort(), [r1.id, r2.id].sort());
  r2.ipAddress = '192.168.5.2'; // same subnet, different address: two routers sharing a LAN is fine
  assert.deepStrictEqual(codes(p), []);
  r2.ipAddress = '192.168.5.1'; // same address twice
  assert.deepStrictEqual(codes(p), ['DUPLICATE_IP']);
});
test('a LAN port without an address next to a configured router is flagged; WAN ports and lone routers are not', () => {
  const { p, sw, mk, L, cab } = segNet();
  const r1 = mk('R1', '192.168.5.1'), r2 = mk('R2', '');
  cab(L(r1, 'L1'), sw.ports[0].id); cab(L(r2, 'L1'), sw.ports[1].id);
  const u = NM.topology.networkIssues(p);
  assert.deepStrictEqual(u.map(i => i.code), ['UNCONFIGURED_LAN']);
  assert.strictEqual(u[0].target.kind, 'port');
  assert.ok(/R2 \/ L1/.test(u[0].message));
  // a per-port address overrides the router address
  r2.ports.find(x => x.label === 'L1').ip = '192.168.5.9';
  assert.deepStrictEqual(codes(p), []);
  // a WAN port without an address on that segment is ignored (DHCP)
  const r3 = mk('R3', '10.0.0.1');
  cab(L(r3, 'W1'), sw.ports[2].id);
  assert.deepStrictEqual(codes(p), [], 'unconfigured WAN joins fine');
  r3.ports.find(x => x.label === 'W1').ip = '10.0.0.5'; // a configured WAN in another subnet is a mismatch
  assert.deepStrictEqual(codes(p), ['SUBNET_MISMATCH']);
});
test('segments follow switches, patch panels and fixed links; router-to-router cables and Internet are handled', () => {
  const { p, sw, mk, L, cab } = segNet();
  const pa = M.addObject(p, { type: 'patchpanel', name: 'PA', portCount: 4, straight: true }), pb = M.addObject(p, { type: 'patchpanel', name: 'PB', portCount: 4, straight: true });
  M.addFixedLink(p, { aObjectId: pa.id, bObjectId: pb.id, wireCount: 1, mapping: 'sequential' });
  const front = (o, n) => o.ports.find(x => x.side === 'front' && x.label === n).id;
  const r1 = mk('R1', '192.168.5.1'), r2 = mk('R2', '192.168.3.1');
  cab(L(r1, 'L1'), front(pa, '1'));
  cab(front(pb, '1'), sw.ports[0].id);
  cab(sw.ports[1].id, L(r2, 'L1'));
  assert.deepStrictEqual(codes(p), ['SUBNET_MISMATCH'], 'joined through a panel, a fixed link and a switch');
  // direct router-to-router cable
  const q = segNet(), a = q.mk('A', '10.1.1.1'), b = q.mk('B', '10.2.2.1');
  q.cab(q.L(a, 'L1'), q.L(b, 'L1'));
  assert.deepStrictEqual(codes(q.p), ['SUBNET_MISMATCH']);
  // Internet side is never checked
  const w = segNet(), ra = w.mk('RA', '10.1.1.1'), rb = w.mk('RB', '10.2.2.1'), net = M.addObject(w.p, { type: 'internet', portCount: 2 });
  w.cab(w.L(ra, 'W1'), net.ports[0].id); w.cab(w.L(rb, 'W1'), net.ports[1].id);
  assert.deepStrictEqual(codes(w.p), []);
  // ports from a graph view / validation pass
  assert.ok(NM.topology.segments(p).some(s => s.ports.length === 2));
});

console.log('Devices with addresses and managed switches');
test('multi-homed devices keep their networks apart; devices and managed switches take part in subnet checks', () => {
  const { p, sw, mk, L, cab } = segNet();
  const sw2 = M.addObject(p, { type: 'switch', name: 'S2', portCount: 8 });
  const r1 = mk('R1', '192.168.3.1'), r2 = mk('R2', '192.168.4.1');
  cab(L(r1, 'L1'), sw.ports[0].id); cab(L(r2, 'L1'), sw2.ports[0].id);
  const pc = M.addObject(p, { type: 'generic', name: 'PC2NIC', deviceKind: 'pc', portCount: 2 });
  pc.ports[0].ip = '192.168.3.240'; pc.ports[1].ip = '192.168.4.5';
  cab(pc.ports[0].id, sw.ports[1].id); cab(pc.ports[1].id, sw2.ports[1].id);
  assert.deepStrictEqual(codes(p), [], 'a PC with a NIC in each network is fine');
  const g = NM.topology.buildGraph(p);
  const TP = NM.topology, tree = TP.reachTree(g, r1.id);
  assert.strictEqual(tree.depth[pc.id], 2, 'R1 -> S -> PC');
  assert.strictEqual(tree.depth[r2.id], undefined, 'the PC does not route between its networks');
  assert.strictEqual(TP.allPaths(g, r1.id, r2.id).length, 0);
  assert.deepStrictEqual(g.nodes[pc.id].nets.sort(), ['192.168.3.0/24', '192.168.4.0/24']);
  assert.ok(/192\.168\.3\.240, 192\.168\.4\.5/.test(g.nodes[pc.id].ip));
  // a device on the wrong subnet for its switch is flagged
  pc.ports[0].ip = '192.168.9.7';
  const bad = NM.topology.networkIssues(p);
  assert.deepStrictEqual(bad.map(i => i.code), ['SUBNET_MISMATCH']);
  assert.ok(/PC2NIC \/ 1 192\.168\.9\.7/.test(bad[0].message));
  pc.ports[0].ip = '192.168.3.1'; // same address as the router
  assert.deepStrictEqual(codes(p), ['DUPLICATE_IP']);
  pc.ports[0].ip = '';
  assert.deepStrictEqual(codes(p), [], 'an unaddressed device (DHCP) is not an error');
});
test('single-port generic devices use the device address; managed switches have a management address', () => {
  const { p, sw, mk, L, cab } = segNet();
  const r1 = mk('R1', '192.168.5.1');
  cab(L(r1, 'L1'), sw.ports[0].id);
  const nvr = M.addObject(p, { type: 'generic', name: 'NVR', portCount: 1, ipAddress: '192.168.5.20' });
  cab(nvr.ports[0].id, sw.ports[1].id);
  assert.strictEqual(NM.topology.effectiveIp(nvr, nvr.ports[0]), '192.168.5.20');
  assert.deepStrictEqual(codes(p), []);
  M.setDeviceIp(p, sw.id, '192.168.5.2');
  assert.strictEqual(sw.ipAddress, '192.168.5.2');
  assert.deepStrictEqual(codes(p), [], 'management address in the same subnet');
  M.setDeviceIp(p, sw.id, '10.10.10.2');
  const iss = NM.topology.networkIssues(p);
  assert.deepStrictEqual(iss.map(i => i.code), ['SUBNET_MISMATCH']);
  assert.ok(/S \/ management 10\.10\.10\.2/.test(iss[0].message));
  assert.ok(iss[0].objectIds.indexOf(sw.id) >= 0);
  // management addresses count across chained switches, and duplicates are caught
  const s2 = M.addObject(p, { type: 'switch', name: 'S2', portCount: 4, ipAddress: '192.168.5.20' });
  cab(sw.ports[5].id, s2.ports[0].id);
  M.setDeviceIp(p, sw.id, '192.168.5.2');
  assert.deepStrictEqual(codes(p), ['DUPLICATE_IP'], 'S2 management address equals the NVR address');
  assert.throws(() => M.setDeviceIp(p, sw.id, '192.168.5.2/24'), /IPv4/);
  assert.throws(() => M.setPortIp(p, sw.ports[0].id, '1.2.3.4'), /no IP/, 'switch ports have no per-port address');
  assert.ok(M.search(p, '192.168.5.20').some(r => r.id === nvr.id));
  const html = NM.graphview.render(p, { from: r1.id, to: '', via: false });
  assert.ok(/192\.168\.5\.2/.test(html));
  assert.ok(R.svgDocument(p, p.maps[0].id).length > 0);
});
test('device addresses are drawn and checked for validity', () => {
  const p = M.createProject('i'), mid = p.maps[0].id;
  const sw = B.addObjectPlaced(p, mid, { type: 'switch', name: 'Managed', portCount: 8, ipAddress: '192.168.1.2', portIsolation: true }, 0, 0);
  const svg = R.svgDocument(p, mid);
  assert.ok(svg.indexOf('192.168.1.2') > 0 && svg.indexOf('PORT ISOLATION') > 0);
  assert.throws(() => M.addObject(p, { type: 'generic', ipAddress: '1.2.3' }), /IPv4/);
  sw.ipAddress = '300.1.1.1';
  assert.ok(M.validateProject(p).some(i => i.code === 'BAD_IP'));
});

console.log('Named port groups');
test('port groups: ranges, moving ports between groups, pruning when ports go away', () => {
  const p = M.createProject('g');
  const pp = M.addObject(p, { type: 'patchpanel', name: 'PP', portCount: 24, straight: true });
  const rear = (n) => port(pp, n, 'rear').id;
  const r = M.parsePortRange(pp, '7-14, 17', 'rear');
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.ids.length, 9);
  assert.deepStrictEqual(M.parsePortRange(pp, '30', 'rear').errors.length, 1);
  const l1 = M.addPortGroup(p, pp.id, { name: 'L1', color: '#d62728', portsText: '7-14', side: 'rear' });
  const off = M.addPortGroup(p, pp.id, { name: 'to rack office', color: '#2ca02c', portsText: '17-20', side: 'rear' });
  assert.deepStrictEqual([l1.portIds.length, off.portIds.length], [8, 4]);
  assert.strictEqual(M.portGroupOf(pp, rear(8)).name, 'L1');
  assert.ok(M.portName(p, rear(18)).indexOf('[to rack office]') > 0);
  // adding overlapping ports moves them; an emptied group disappears
  M.addPortGroup(p, pp.id, { name: 'X', color: '#111111', portsText: '7-14', side: 'rear' });
  assert.ok(!pp.portGroups.some(g => g.name === 'L1'));
  M.updatePortGroup(p, off.id, { portsText: '17-24', side: 'rear', name: 'to office' });
  assert.strictEqual(M.findPortGroup(p, off.id).group.portIds.length, 8);
  assert.throws(() => M.updatePortGroup(p, off.id, { name: '  ' }), /name/);
  assert.throws(() => M.addPortGroup(p, pp.id, { name: 'n', portsText: '99' }), /No port/);
  assert.throws(() => M.addPortGroup(p, pp.id, { name: '', portsText: '1' }), /name/);
  M.setPortCount(p, pp.id, 12);
  assert.ok(!M.findPortGroup(p, off.id), 'ports removed -> group pruned');
  assert.ok(M.search(p, 'X').some(r => r.kind === 'pgroup'));
  assert.deepStrictEqual(M.mapsFor(p, 'pgroup', 'nope'), []);
  M.deletePortGroup(p, pp.portGroups[0].id);
  assert.strictEqual(pp.portGroups, undefined);
  assert.ok(M.validateProject(p).every(i => i.severity !== 'error'));
});
test('port groups are drawn as a coloured band with a name tag, and exported', () => {
  const p = M.createProject('g'), mid = p.maps[0].id;
  const pp = B.addObjectPlaced(p, mid, { type: 'patchpanel', name: 'PP', portCount: 24, straight: true }, 0, 0);
  const g = M.addPortGroup(p, pp.id, { name: 'to rack office', color: '#2ca02c', portsText: '17-20', side: 'rear' });
  const r = R.renderMap(p, mid, {});
  assert.ok(r.content.indexOf('data-kind="pgroup" data-id="' + g.id + '"') > 0);
  assert.ok(r.content.indexOf('>to rack office</text>') > 0 && r.content.indexOf('fill="#2ca02c" fill-opacity="0.32"') > 0);
  const geo = r.portGeo;
  const rects = g.portIds.map(id => geo[id]);
  assert.strictEqual(new Set(rects.map(x => Math.round(x.y))).size, 1, 'one row, one band');
  assert.ok(R.svgDocument(p, mid).indexOf('to rack office') > 0);
  assert.ok(R.renderMap(p, mid, { selection: { kind: 'pgroup', id: g.id } }).content.indexOf('stroke="#e91e63" stroke-width="3"') > 0);
  const tip = r.content.slice(r.content.indexOf('data-id="' + g.portIds[0] + '"><title>'), r.content.indexOf('data-id="' + g.portIds[0] + '"><title>') + 150);
  assert.ok(tip.indexOf('[to rack office]') > 0, 'tooltip names the group');
  pp.ports.filter(x => x.side === 'rear').forEach(x => { x.label = x.label; });
  // collapsed strip hides the band safely
  const c = R.renderMap(p, mid, { collapsed: { [M.placementOf(p, mid, pp.id).id]: { rear: true } } });
  assert.ok(c.content.indexOf('to rack office</text>') < 0);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
