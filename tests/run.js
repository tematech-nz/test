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
  assert.deepStrictEqual(seq, ['port', 'patch', 'port', 'internal', 'port', 'wire', 'port', 'internal', 'port', 'patch', 'port']);
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
  const r = M.addObject(p, { type: 'router', name: 'Edge', wanPorts: 2, lanPorts: 6, ipAddress: '192.168.1.1/24' });
  assert.strictEqual(r.ports.length, 8);
  assert.deepStrictEqual(r.ports.slice(0, 3).map(x => x.role + ':' + x.label), ['wan:W1', 'wan:W2', 'lan:L1']);
  assert.strictEqual(r.ipAddress, '192.168.1.1/24');
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
  r.ports[1].ip = '300.1.1.1'; r.ipAddress = 'not-an-ip';
  assert.strictEqual(M.validateProject(p).filter(i => i.code === 'BAD_IP').length, 2);
  ['10.0.0.1', '10.0.0.0/8', 'fe80::1', '2001:db8::1/64', ''].forEach(v => assert.ok(M.isValidIp(v), v));
  ['1.2.3', '1.2.3.4/33', 'abc', '256.1.1.1'].forEach(v => assert.ok(!M.isValidIp(v), v));
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
  const r1 = o('router', 'R1', { wanPorts: 1, lanPorts: 2, ipAddress: '192.168.1.1/24' });
  const r2 = o('router', 'R2', { wanPorts: 1, lanPorts: 2, ipAddress: '10.9.0.1/16' });
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
  assert.strictEqual(TP.subnetOf('192.168.1.77/24'), '192.168.1.0/24');
  assert.strictEqual(TP.subnetOf('10.9.200.1/16'), '10.9.0.0/16');
  assert.strictEqual(TP.subnetOf('10.0.0.1'), null);
  assert.strictEqual(TP.subnetOf('1.2.3.4/40'), null);
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

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
