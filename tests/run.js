'use strict';
/* Dependency-free test runner: node tests/run.js */
const assert = require('assert');
require('../js/model.js'); require('../js/layout.js'); require('../js/trace.js');
require('../js/render.js'); require('../js/exporters.js'); require('../js/builder.js');
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

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
