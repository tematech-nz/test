'use strict';
/* Browser smoke/acceptance test. Needs Playwright + Chromium: node tests/e2e.js [screenshotDir] */
const path = require('path');
const fs = require('fs');
const assert = require('assert');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require(path.join(process.env.NODE_PATH || '/opt/node22/lib/node_modules', 'playwright'))); }

const URL = 'file://' + path.resolve(__dirname, '..', 'index.html');
const shots = process.argv[2];
if (shots) fs.mkdirSync(shots, { recursive: true });
let n = 0, failed = 0;
const ok = (m) => console.log('  ok   ' + m);

(async () => {
  const exe = fs.existsSync('/opt/pw-browsers/chromium') ? undefined : undefined;
  const browser = await chromium.launch({ executablePath: exe });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  const shot = async (name) => { if (shots) await page.screenshot({ path: path.join(shots, String(++n).padStart(2, '0') + '-' + name + '.png') }); };
  const step = async (name, fn) => { try { await fn(); ok(name); } catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + String(e.stack || e).split('\n').slice(0, 5).join('\n       ')); await shot('FAIL-' + name.replace(/\W+/g, '_')); } };

  await page.goto(URL);
  await page.evaluate(() => { localStorage.clear(); });
  await page.reload();

  await step('app boots in view mode with empty project', async () => {
    assert.strictEqual(await page.evaluate(() => document.body.className), 'mode-view');
    assert.ok(await page.isVisible('#emptyHint'));
    assert.ok(!(await page.isVisible('#toolbar')));
  });

  await step('load demo, view mode shows groups, racks, cables', async () => {
    await page.click('#emptyHint button');
    await page.waitForSelector('#vp [data-kind="object"]');
    assert.ok((await page.locator('#vp [data-kind="port"]').count()) > 40);
    assert.ok(await page.locator('#vp path[stroke-dasharray="7 5"]').count() >= 1, 'fixed link drawn');
    await shot('view-demo');
  });

  await step('view mode is read-only (no handles, drag does nothing)', async () => {
    assert.strictEqual(await page.locator('[data-handle]').count(), 0);
    const before = await page.evaluate(() => JSON.stringify(NetMap.app.S.p.placements));
    const box = await page.locator('#vp rect[data-kind="object"]').nth(3).boundingBox();
    await page.mouse.move(box.x + 20, box.y + 5); await page.mouse.down(); await page.mouse.move(box.x + 120, box.y + 80, { steps: 5 }); await page.mouse.up();
    assert.strictEqual(await page.evaluate(() => JSON.stringify(NetMap.app.S.p.placements)), before);
  });

  await step('search navigates and highlights', async () => {
    await page.fill('#searchBox', 'PC-002');
    await page.waitForSelector('#searchResults .list-item');
    await page.click('#searchResults .list-item');
    await page.waitForTimeout(200);
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.sel.kind), 'cable');
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.p.maps.find(m => m.id === NetMap.app.S.mapId).name), 'Office');
    await page.fill('#searchBox', '');
  });

  await step('trace from switch port across both maps', async () => {
    const info = await page.evaluate(() => {
      const p = NetMap.app.S.p, sw = p.objects.find(o => o.name === 'Switch A');
      return { id: sw.ports.find(x => x.label === '12').id };
    });
    await page.evaluate((id) => NetMap.app.api.startTrace('port', id), info.id);
    await page.waitForSelector('#tracePane .trace-line');
    const txt = await page.innerText('#tracePane');
    assert.ok(/Switch A \/ 12/.test(txt) && /WS-02 \/ 1/.test(txt) && /FL-001, wire 12/.test(txt), txt);
    assert.ok(/open (Server room|Office)/.test(txt), 'cross-map navigation link');
    await shot('trace');
    // follow the cross-map link
    const cur = await page.evaluate(() => NetMap.app.S.mapId);
    await page.click('#tracePane a.lnk:has-text("open")');
    await page.waitForTimeout(200);
    assert.notStrictEqual(await page.evaluate(() => NetMap.app.S.mapId), cur);
    assert.ok(await page.evaluate(() => !!NetMap.app.S.trace), 'trace persists across maps');
    await shot('trace-other-map');
    await page.click('#tracePane button:has-text("Clear trace")');
    assert.ok(await page.evaluate(() => !NetMap.app.S.trace));
  });

  await step('edit mode: banner, handles, create group, undo/redo', async () => {
    await page.click('#btnMode');
    assert.ok(await page.isVisible('#editBanner'));
    assert.ok(await page.locator('[data-handle="move"]').count() > 0);
    const groups = await page.evaluate(() => NetMap.app.S.p.groups.length);
    await page.click('#toolbar button[data-add="group"]');
    await page.fill('#dlg input[name="name"]', 'Room 3');
    await page.click('#dlg button[data-btn="ok"]');
    await page.waitForTimeout(100);
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.p.groups.length), groups + 1);
    await page.click('#btnUndo');
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.p.groups.length), groups);
    await page.click('#btnRedo');
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.p.groups.length), groups + 1);
    await shot('edit-mode');
  });

  await step('dragging by handle moves visuals but not connections', async () => {
    const before = await page.evaluate(() => JSON.stringify([NetMap.app.S.p.fixedLinks, NetMap.app.S.p.patchCables]));
    const pl0 = await page.evaluate(() => { const S = NetMap.app.S; return JSON.stringify(S.p.placements.filter(q => q.mapId === S.mapId).map(q => [q.x, q.y])); });
    const h = page.locator('[data-handle="move"]').first();
    const box = await h.boundingBox();
    await page.mouse.move(box.x + 6, box.y + 6); await page.mouse.down(); await page.mouse.move(box.x + 106, box.y + 66, { steps: 6 }); await page.mouse.up();
    const pl1 = await page.evaluate(() => { const S = NetMap.app.S; return JSON.stringify(S.p.placements.filter(q => q.mapId === S.mapId).map(q => [q.x, q.y])); });
    assert.notStrictEqual(pl0, pl1, 'placement moved');
    assert.strictEqual(await page.evaluate(() => JSON.stringify([NetMap.app.S.p.fixedLinks, NetMap.app.S.p.patchCables])), before);
    await page.click('#btnUndo');
    assert.strictEqual(await page.evaluate(() => { const S = NetMap.app.S; return JSON.stringify(S.p.placements.filter(q => q.mapId === S.mapId).map(q => [q.x, q.y])); }), pl0);
  });

  await step('patch cable tool connects two free ports and rejects occupied', async () => {
    await page.evaluate(() => NetMap.app.api.goTo('object', NetMap.app.S.p.objects.find(o => o.name === 'Switch A').id, NetMap.app.S.p.maps[0].id));
    await page.click('#toolbar button[data-act="patchTool"]');
    const ids = await page.evaluate(() => {
      const p = NetMap.app.S.p, sw = p.objects.find(o => o.name === 'Switch A'), pp = p.objects.find(o => o.name === 'PP-A');
      const f = (o, l) => o.ports.find(x => x.label === l && x.side === 'front').id;
      return { a: f(sw, '3'), b: f(pp, '3'), occ: f(sw, '12') };
    });
    const clickPort = async (id) => { await page.locator('#vp rect[data-kind="port"][data-id="' + id + '"]').click({ force: true }); };
    const before = await page.evaluate(() => NetMap.app.S.p.patchCables.length);
    await clickPort(ids.occ);
    assert.ok(await page.evaluate(() => !NetMap.app.S.tool.pending), 'occupied port refused');
    await clickPort(ids.a); await clickPort(ids.b);
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.p.patchCables.length), before + 1);
    await page.keyboard.press('Escape');
  });

  await step('fixed link wiring is edited only through the review dialog', async () => {
    const lid = await page.evaluate(() => NetMap.app.S.p.fixedLinks[0].id);
    await page.evaluate((id) => NetMap.app.api.select({ kind: 'link', id }), lid);
    await page.click('#detailsPane button[data-act="editWiring"]');
    await page.waitForSelector('#dlg select[data-k="aPortId"]');
    await page.click('#dlg button[data-del="23"]');
    await page.click('#dlg button[data-btn="review"]');
    const txt = await page.innerText('#dlg');
    assert.ok(/DELETE wire 24/.test(txt), txt);
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.p.fixedLinks[0].wires.length), 24, 'not applied before confirm');
    await shot('wiring-review');
    await page.click('#dlg button[data-btn="apply"]');
    await page.waitForTimeout(100);
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.p.fixedLinks[0].wires.length), 23);
    await page.click('#btnUndo');
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.p.fixedLinks[0].wires.length), 24);
  });


  await step('ctrl-select rear ports, hover preview, click creates a fixed link', async () => {
    await page.evaluate(() => { const S = NetMap.app.S; NetMap.app.api.goTo('object', S.p.objects.find(o => o.name === 'PP-Standalone').id, S.p.maps[0].id); });
    await page.evaluate(() => NetMap.app.api.commit('add 15-port panel', (p) => NetMap.builder.addObjectPlaced(p, p.maps[0].id, { type: 'patchpanel', name: 'PP-C', portCount: 15 }, 700, 300)));
    const ids = await page.evaluate(() => {
      const p = NetMap.app.S.p, a = p.objects.find(o => o.name === 'PP-Standalone'), b = p.objects.find(o => o.name === 'PP-C');
      const r = (o, l) => o.ports.find(x => x.side === 'rear' && x.label === l).id;
      return { a3: r(a, '3'), a5: r(a, '5'), t20: r(b, '12'), t21: r(b, '13'), t22: r(b, '14'), t24: r(b, '15') };
    });
    const sel = (id) => page.locator('#vp rect[data-kind="port"][data-id="' + id + '"]');
    await sel(ids.a3).click({ modifiers: ['Control'], force: true });
    await sel(ids.a5).click({ modifiers: ['Control', 'Shift'], force: true });
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.pgroup.ids.length), 3, 'ports 3..5 grouped');
    await sel(ids.t20).hover({ force: true });
    await page.waitForTimeout(80);
    let pv = await page.evaluate(() => NetMap.app.S.preview);
    assert.ok(pv && pv.ok && pv.ids.length === 3, 'preview of 3 target ports');
    assert.ok(/rear 12\.\.14/.test(await page.innerText('#toolHint')));
    await shot('port-group-preview');
    await sel(ids.t24).hover({ force: true });
    await page.waitForTimeout(80);
    pv = await page.evaluate(() => NetMap.app.S.preview);
    assert.ok(pv && !pv.ok, 'not enough ports from 15');
    await sel(ids.t20).hover({ force: true });
    await page.waitForTimeout(80);
    const links = await page.evaluate(() => NetMap.app.S.p.fixedLinks.length);
    await sel(ids.t20).click({ force: true });
    await page.waitForTimeout(100);
    const st = await page.evaluate(() => ({ n: NetMap.app.S.p.fixedLinks.length, sel: NetMap.app.S.sel, link: NetMap.app.S.p.fixedLinks[NetMap.app.S.p.fixedLinks.length - 1], pg: NetMap.app.S.pgroup }));
    assert.strictEqual(st.n, links + 1);
    assert.strictEqual(st.sel.kind, 'link');
    assert.strictEqual(st.link.wires.length, 3);
    assert.strictEqual(st.pg, null);
    assert.ok(/fixed link/i.test(await page.innerText('#detailsPane')));
    await page.click('#btnUndo');
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.p.fixedLinks.length), links);
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.p.objects.find(o => o.name === 'PP-C').ports.length), 30);
  });

  await step('patch panel front/rear strips collapse and expand', async () => {
    const before = await page.locator('#vp [data-toggle="rear"]').first().boundingBox();
    const heightOf = () => page.evaluate(() => { const S = NetMap.app.S; return document.querySelector('#vp rect[data-kind="object"]') && Array.from(document.querySelectorAll('#vp rect[data-kind="object"]')).map(r => r.getAttribute('height')).join(','); });
    const h0 = await heightOf();
    await page.locator('#vp rect[data-toggle="rear"]').first().click({ force: true });
    const h1 = await heightOf();
    assert.notStrictEqual(h0, h1, 'panel shrank');
    assert.ok(/v<\/text>/.test(await page.evaluate(() => document.getElementById('vp').innerHTML)));
    await page.locator('#vp rect[data-toggle="rear"]').first().click({ force: true });
    assert.strictEqual(await heightOf(), h0);
    assert.ok(before);
  });


  await step('router: create with WAN/LAN ports and IP via the toolbar', async () => {
    await page.click('#toolbar button[data-add="router"]');
    await page.fill('#dlg input[name="name"]', 'Edge GW');
    await page.fill('#dlg input[name="wanPorts"]', '2');
    await page.fill('#dlg input[name="lanPorts"]', '5');
    await page.fill('#dlg input[name="ipAddress"]', '192.168.50.1');
    await page.click('#dlg button[data-btn="ok"]');
    await page.waitForTimeout(100);
    const r = await page.evaluate(() => { const o = NetMap.app.S.p.objects.find(x => x.name === 'Edge GW'); return { n: o.ports.length, ip: o.ipAddress }; });
    assert.deepStrictEqual(r, { n: 7, ip: '192.168.50.1' });
    assert.ok(/IP address/i.test(await page.innerText('#detailsPane')));
    assert.ok((await page.innerHTML('#vp')).indexOf('192.168.50.1') > 0, 'IP drawn on the map');
    await page.fill('#detailsPane input[data-f="pip"] >> nth=0', '203.0.113.2');
    await page.keyboard.press('Tab');
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.p.objects.find(x => x.name === 'Edge GW').ports[0].ip), '203.0.113.2');
    await shot('router');
    await page.click('#btnUndo'); await page.click('#btnUndo'); await page.click('#btnUndo');
    assert.ok(!(await page.evaluate(() => NetMap.app.S.p.objects.some(x => x.name === 'Edge GW'))));
  });


  await step('topology graph: INTERNET object, tree, paths, navigation back to the map', async () => {
    await page.evaluate(() => NetMap.app.api.commit('internet', (p) => {
      const M = NetMap.model, B = NetMap.builder;
      const inet = B.addObjectPlaced(p, p.maps[0].id, { type: 'internet', name: 'INTERNET', ipAddress: '203.0.113.1' }, 900, 40);
      const r = B.addObjectPlaced(p, p.maps[0].id, { type: 'router', name: 'Edge', wanPorts: 1, lanPorts: 2, ipAddress: '192.168.1.1/24' }, 900, 140);
      const sw = p.objects.find(o => o.name === 'Switch A');
      M.addPatchCable(p, { aPortId: inet.ports[0].id, bPortId: r.ports[0].id });
      M.addPatchCable(p, { aPortId: r.ports[1].id, bPortId: sw.ports.find(x => x.label === '5').id });
    }));
    await page.click('#btnGraph');
    await page.waitForSelector('#graphView svg [data-gnode]');
    let txt = await page.innerText('#graphView');
    assert.ok(/reachable from internet/i.test(txt) && /Edge/.test(txt) && /WS-02/.test(txt), txt.slice(0, 400));
    await shot('graph-tree');
    await page.selectOption('#graphView select[data-g="to"]', { label: 'WS-02 (Wall socket)' });
    txt = await page.innerText('#graphView');
    assert.ok(/paths from internet to ws-02/i.test(txt) && /shortest/.test(txt) && /FL-001/.test(txt), txt.slice(0, 600));
    await shot('graph-paths');
    await page.locator('#graphView [data-gnode]').first().click({ force: true });
    await page.waitForTimeout(150);
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.view), 'map');
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.sel.kind), 'object');
  });


  await step('patch panel sections: change split in the properties panel', async () => {
    await page.evaluate(() => NetMap.app.api.commit('panel', (p) => NetMap.builder.addObjectPlaced(p, p.maps[0].id, { type: 'patchpanel', name: 'PP-S', portCount: 24 }, 700, 500)));
    const id = await page.evaluate(() => NetMap.app.S.p.objects.find(o => o.name === 'PP-S').id);
    await page.evaluate((i) => NetMap.app.api.select({ kind: 'object', id: i }), id);
    const ys = () => page.evaluate((i) => { const o = NetMap.app.S.p.objects.find(x => x.id === i); const geo = NetMap.app.S.geo.portGeo; return new Set(o.ports.filter(x => x.side === 'front').map(x => Math.round(geo[x.id].y))).size; }, id);
    assert.strictEqual(await ys(), 1, 'default: 3 x 8 in one line');
    assert.ok(/3 x 8/.test(await page.evaluate(() => document.querySelector('#detailsPane select[data-f="sectionSize"]').selectedOptions[0].textContent)));
    await shot('sections-3x8');
    await page.selectOption('#detailsPane select[data-f="sectionSize"]', '12');
    await page.waitForTimeout(100);
    assert.strictEqual(await page.evaluate((i) => NetMap.app.S.p.objects.find(x => x.id === i).sectionSize, id), 12);
    assert.strictEqual(await ys(), 1);
    const opts = await page.$$eval('#detailsPane select[data-f="sectionSize"] option', (os) => os.map(o => o.value));
    assert.ok(opts.indexOf('7') < 0 && opts.indexOf('8') >= 0, 'only equal splits offered: ' + opts);
    await page.click('#btnUndo'); await page.click('#btnUndo');
  });


  await step('drag to the bottom of a container extends it; dragging out hides the extension and reassigns', async () => {
    const ids = await page.evaluate(() => {
      const B = NetMap.builder, p = NetMap.app.S.p;
      let out;
      NetMap.app.api.commit('ext test', (pp) => {
        const g = B.addGroupPlaced(pp, pp.maps[0].id, { name: 'ExtG' }, 1200, 40);
        const sw = B.addObjectPlaced(pp, pp.maps[0].id, { type: 'switch', name: 'ExtSw', portCount: 8, containerId: g.id });
        out = { g: g.id, sw: sw.id };
      });
      return out;
    });
    await page.evaluate(() => NetMap.app.api.goTo('object', NetMap.app.S.p.objects.find(o => o.name === 'ExtSw').id, NetMap.app.S.p.maps[0].id));
    const st = () => page.evaluate((i) => {
      const S = NetMap.app.S, pl = (id) => S.p.placements.find(q => q.refId === id && q.mapId === S.mapId);
      const sw = S.p.objects.find(o => o.id === i.sw), g = pl(i.g), s = pl(i.sw);
      return { gh: g.h, gb: g.y + g.h, sb: s.y + s.h, cont: sw.containerId, zoom: NetMap.app.S.p.maps.find(m => m.id === S.mapId).viewport.zoom };
    }, ids);
    const s0 = await st();
    const handle = page.locator('[data-handle="move"][data-pl="' + await page.evaluate((i) => NetMap.app.S.p.placements.find(q => q.refId === i.sw).id, ids) + '"]');
    const box = await handle.boundingBox();
    const gap = (s0.gb - s0.sb) * s0.zoom;
    await page.mouse.move(box.x + 5, box.y + 5); await page.mouse.down();
    await page.mouse.move(box.x + 5, box.y + 5 + gap + 25 * s0.zoom, { steps: 8 });
    const mid = await st();
    assert.ok(mid.gh > s0.gh, 'container grew while dragging: ' + JSON.stringify([s0, mid]));
    assert.ok(mid.gb >= mid.sb, 'item fits inside the extended container');
    await page.mouse.move(box.x + 5, box.y + 5 + gap + 400 * s0.zoom, { steps: 8 });
    const far = await st();
    assert.strictEqual(far.gh, s0.gh, 'extension hidden again when dragged further away');
    await page.mouse.move(box.x + 5, box.y + 5 + gap + 25 * s0.zoom, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(100);
    const kept = await st();
    assert.ok(kept.gh > s0.gh && kept.cont === ids.g, 'dropped inside the extension: stays in the container');
    await shot('container-extended');
    // second drag: out of the container
    const box2 = await page.locator('[data-handle="move"][data-pl="' + await page.evaluate((i) => NetMap.app.S.p.placements.find(q => q.refId === i.sw).id, ids) + '"]').boundingBox();
    await page.mouse.move(box2.x + 5, box2.y + 5); await page.mouse.down();
    await page.mouse.move(box2.x + 5, box2.y + 5 + 500 * s0.zoom, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(100);
    const out = await st();
    assert.strictEqual(out.cont, null, 'moved outside: container cleared');
    assert.strictEqual(out.gh, kept.gh, 'old container keeps the size it had before this drag');
    await page.click('#btnUndo'); await page.click('#btnUndo'); await page.click('#btnUndo');
  });

  await step('selecting a fixed link highlights its ports on both panels', async () => {
    const lid = await page.evaluate(() => NetMap.app.S.p.fixedLinks[0].id);
    await page.evaluate((id) => NetMap.app.api.select({ kind: 'link', id }), lid);
    const n = await page.locator('#vp rect[data-kind="port"][fill="#ffeb3b"]').count();
    assert.ok(n >= 24, 'highlighted ports on this map: ' + n);
    await page.evaluate((id) => NetMap.app.api.goTo('link', id, NetMap.app.S.p.maps[1].id), lid);
    assert.ok((await page.locator('#vp rect[data-kind="port"][fill="#ffeb3b"]').count()) >= 24, 'and on the other map');
  });


  await step('rack stacking: drop line shows while dragging and the item attaches there', async () => {
    const info = await page.evaluate(() => {
      NetMap.app.api.commit('stack test', (p) => {
        const rack = p.objects.find(o => o.name === 'Rack A');
        NetMap.builder.addObjectPlaced(p, p.maps[0].id, { type: 'switch', name: 'Stack3', portCount: 8, containerId: rack.id });
      });
      const S = NetMap.app.S, pl = (n) => S.p.placements.find(q => q.refId === S.p.objects.find(o => o.name === n).id && q.mapId === S.p.maps[0].id);
      NetMap.app.api.goTo('object', S.p.objects.find(o => o.name === 'Stack3').id, S.p.maps[0].id);
      return { zoom: S.p.maps[0].viewport.zoom, ppBottom: pl('PP-A').y + pl('PP-A').h, swTop: pl('Switch A').y, id3: pl('Stack3').id };
    });
    const order = () => page.evaluate(() => { const S = NetMap.app.S; return ['PP-A', 'Switch A', 'Stack3'].map(n => S.p.placements.find(q => q.refId === S.p.objects.find(o => o.name === n).id && q.mapId === S.p.maps[0].id)).map((q, i) => [i, q.y]).sort((a, b) => a[1] - b[1]).map(x => x[0]).join(''); });
    assert.strictEqual(await order(), '012');
    const h = page.locator('[data-handle="move"][data-pl="' + info.id3 + '"]');
    const box = await h.boundingBox();
    const dy = -(await page.evaluate((id) => { const S = NetMap.app.S, q = S.p.placements.find(x => x.id === id), pp = S.p.placements.find(x => x.refId === S.p.objects.find(o => o.name === 'PP-A').id && x.mapId === q.mapId); return q.y - (pp.y + pp.h) + q.h / 2; }, info.id3)) * info.zoom;
    await page.mouse.move(box.x + 5, box.y + 5); await page.mouse.down();
    await page.mouse.move(box.x + 5, box.y + 5 + dy, { steps: 10 });
    await page.waitForTimeout(100);
    assert.ok((await page.locator('#vp [data-drop="line"]').count()) === 1, 'drop line visible while dragging');
    await shot('drop-line');
    await page.mouse.up();
    await page.waitForTimeout(100);
    assert.strictEqual(await order(), '021', 'Stack3 attached between PP-A and Switch A');
    assert.strictEqual(await page.locator('#vp [data-drop="line"]').count(), 0, 'line gone after drop');
    await page.click('#btnUndo'); await page.click('#btnUndo');
  });


  await step('dropping a panel on top of another moves it to the nearest free spot', async () => {
    const ids = await page.evaluate(() => {
      const S = NetMap.app.S;
      NetMap.app.api.commit('two panels', (p) => {
        NetMap.builder.addObjectPlaced(p, p.maps[0].id, { type: 'patchpanel', name: 'OvA', portCount: 12 }, 1500, 700);
        NetMap.builder.addObjectPlaced(p, p.maps[0].id, { type: 'patchpanel', name: 'OvB', portCount: 12 }, 1500, 900);
      });
      const pl = (n) => S.p.placements.find(q => q.refId === S.p.objects.find(o => o.name === n).id && q.mapId === S.p.maps[0].id);
      NetMap.app.api.goTo('object', S.p.objects.find(o => o.name === 'OvB').id, S.p.maps[0].id);
      return { a: pl('OvA').id, b: pl('OvB').id };
    });
    const geo = () => page.evaluate((i) => { const S = NetMap.app.S, a = S.p.placements.find(q => q.id === i.a), b = S.p.placements.find(q => q.id === i.b); return { a, b, zoom: S.p.maps[0].viewport.zoom }; }, ids);
    const g0 = await geo();
    const box = await page.locator('[data-handle="move"][data-pl="' + ids.b + '"]').boundingBox();
    const dy = (g0.a.y + 10 - g0.b.y) * g0.zoom;
    await page.mouse.move(box.x + 5, box.y + 5); await page.mouse.down();
    await page.mouse.move(box.x + 5, box.y + 5 + dy, { steps: 8 }); await page.mouse.up();
    await page.waitForTimeout(100);
    const g1 = await geo(), A = g1.a, Bp = g1.b;
    const ov = A.x < Bp.x + Bp.w && Bp.x < A.x + A.w && A.y < Bp.y + Bp.h && Bp.y < A.y + A.h;
    assert.ok(!ov, 'panels no longer overlap: ' + JSON.stringify([A, Bp]));
    assert.ok(Math.abs(Bp.y - A.y) < 400, 'close to where it was dropped');
    await page.click('#btnUndo'); await page.click('#btnUndo');
  });


  await step('cable colour: presets, custom RGB picker, patch tool colour', async () => {
    const cid = await page.evaluate(() => NetMap.app.S.p.patchCables[0].id);
    await page.evaluate((id) => NetMap.app.api.select({ kind: 'cable', id }), cid);
    const color = () => page.evaluate((id) => NetMap.app.S.p.patchCables.find(c => c.id === id).color, cid);
    assert.strictEqual(await page.locator('#detailsPane input[type="color"]').count(), 0, 'no picker for a preset colour');
    const names = await page.$$eval('#detailsPane select[data-f="colorPreset"] option', (os) => os.map(o => o.textContent));
    assert.deepStrictEqual(names, ['white', 'grey', 'green', 'yellow', 'blue', 'orange', 'red', 'black', 'Custom...']);
    await page.selectOption('#detailsPane select[data-f="colorPreset"]', { label: 'red' });
    assert.strictEqual(await color(), '#d62728');
    await page.selectOption('#detailsPane select[data-f="colorPreset"]', { label: 'Custom...' });
    assert.strictEqual(await page.locator('#detailsPane input[type="color"]').count(), 1, 'RGB picker appears');
    assert.strictEqual(await color(), '#d62728', 'choosing Custom alone changes nothing');
    await page.fill('#detailsPane input[type="color"]', '#123456');
    assert.strictEqual(await color(), '#123456');
    assert.strictEqual(await page.locator('#detailsPane input[type="color"]').count(), 1, 'stays visible for a non-preset colour');
    await page.click('#toolbar button[data-act="patchTool"]');
    await page.selectOption('#toolbar select[data-f="toolPreset"]', { label: 'green' });
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.cableColor), '#2ca02c');
    await page.keyboard.press('Escape');
    await page.click('#btnUndo'); await page.click('#btnUndo');
    assert.notStrictEqual(await color(), '#123456');
  });


  await step('patch cable across groups asks for confirmation; across racks in one group does not; hover circles the end', async () => {
    const ids = await page.evaluate(() => {
      let out;
      NetMap.app.api.commit('groups', (p) => {
        const B = NetMap.builder, mid = p.maps[0].id;
        const gA = B.addGroupPlaced(p, mid, { name: 'GA' }, 2000, 40), gB = B.addGroupPlaced(p, mid, { name: 'GB' }, 2000, 600);
        const sA = B.addObjectPlaced(p, mid, { type: 'switch', name: 'sA', portCount: 4, containerId: gA.id });
        const sB = B.addObjectPlaced(p, mid, { type: 'switch', name: 'sB', portCount: 4, containerId: gB.id });
        const r1 = B.addObjectPlaced(p, mid, { type: 'rack', name: 'rk1', containerId: gA.id }), r2 = B.addObjectPlaced(p, mid, { type: 'rack', name: 'rk2', containerId: gA.id });
        const t1 = B.addObjectPlaced(p, mid, { type: 'switch', name: 't1', portCount: 4, containerId: r1.id }), t2 = B.addObjectPlaced(p, mid, { type: 'switch', name: 't2', portCount: 4, containerId: r2.id });
        const f = (o) => o.ports[0].id;
        out = { sA: f(sA), sB: f(sB), t1: f(t1), t2: f(t2) };
      });
      NetMap.app.api.fitMap();
      return out;
    });
    const port = (id) => page.locator('#vp rect[data-kind="port"][data-id="' + id + '"]');
    const count = () => page.evaluate(() => NetMap.app.S.p.patchCables.length);
    const c0 = await count();
    await page.click('#toolbar button[data-act="patchTool"]');
    await port(ids.sA).click({ force: true }); await port(ids.sB).click({ force: true });
    await page.waitForSelector('#dlg[open]');
    assert.ok(/Do you want to continue/.test(await page.innerText('#dlg')) && /GA/.test(await page.innerText('#dlg')) && /GB/.test(await page.innerText('#dlg')));
    await page.click('#dlg button[data-btn="no"]');
    assert.strictEqual(await count(), c0, 'cancelled: nothing created');
    await port(ids.sA).click({ force: true }); await port(ids.sB).click({ force: true });
    await page.waitForSelector('#dlg[open]');
    await page.click('#dlg button[data-btn="yes"]');
    await page.waitForTimeout(100);
    assert.strictEqual(await count(), c0 + 1, 'confirmed: cable created');
    await page.click('#toolbar button[data-act="patchTool"]'); // tool may have stopped; make sure it is on
    if (!(await page.evaluate(() => !!NetMap.app.S.tool))) await page.click('#toolbar button[data-act="patchTool"]');
    await port(ids.t1).click({ force: true }); await port(ids.t2).click({ force: true });
    await page.waitForTimeout(150);
    assert.ok(!(await page.evaluate(() => document.getElementById('dlg').open)), 'two racks in one group: no warning');
    assert.strictEqual(await count(), c0 + 2);
    await page.keyboard.press('Escape');
    // hover circles the port of the end that would move, and the buttons explain themselves
    const cid = await page.evaluate(() => NetMap.app.S.p.patchCables[NetMap.app.S.p.patchCables.length - 1].id);
    await page.evaluate((id) => NetMap.app.api.select({ kind: 'cable', id }), cid);
    const rb = page.locator('#detailsPane button[data-act="reconnect"][data-end="a"]');
    assert.ok(/Move end A/.test(await rb.getAttribute('title')));
    await rb.hover();
    assert.strictEqual(await page.locator('#vp [data-ring]').count(), 1, 'ring around end A');
    await shot('reconnect-ring');
    await page.mouse.move(5, 300);
    assert.strictEqual(await page.locator('#vp [data-ring]').count(), 0, 'ring gone');
    assert.ok((await page.locator('#toolbar button[data-act="patchTool"]').getAttribute('title')).length > 10);
    await page.click('#btnUndo'); await page.click('#btnUndo'); await page.click('#btnUndo');
  });


  await step('resizing cannot shrink equipment below readable size; containers stay around contents', async () => {
    const ids = await page.evaluate(() => {
      let out;
      NetMap.app.api.commit('resize test', (p) => {
        const B = NetMap.builder, mid = p.maps[0].id;
        const pp = B.addObjectPlaced(p, mid, { type: 'patchpanel', name: 'ResizeMe', portCount: 24 }, 2600, 40);
        out = { id: pp.id };
      });
      const S = NetMap.app.S;
      out.pl = S.p.placements.find(q => q.refId === out.id).id;
      NetMap.app.api.goTo('object', out.id, S.p.maps[0].id);
      return out;
    });
    const size = () => page.evaluate((i) => { const q = NetMap.app.S.p.placements.find(x => x.id === i); const mn = NetMap.layout.minSize(NetMap.app.S.p.objects.find(o => o.name === 'ResizeMe')); return { w: q.w, h: q.h, mw: mn.w, mh: mn.h, zoom: NetMap.app.S.p.maps[0].viewport.zoom }; }, ids.pl);
    const s0 = await size();
    const box = await page.locator('[data-handle="resize"][data-pl="' + ids.pl + '"]').boundingBox();
    await page.mouse.move(box.x + 5, box.y + 5); await page.mouse.down();
    await page.mouse.move(box.x - 600 * s0.zoom, box.y - 300 * s0.zoom, { steps: 10 }); await page.mouse.up();
    await page.waitForTimeout(100);
    const s1 = await size();
    assert.ok(s1.w >= s1.mw && s1.h >= s1.mh, 'clamped to minimum: ' + JSON.stringify(s1));
    await page.click('#btnUndo');
    const rackId = await page.evaluate(() => NetMap.app.S.p.placements.find(q => q.refId === NetMap.app.S.p.objects.find(o => o.name === 'Rack A').id && q.mapId === NetMap.app.S.p.maps[0].id).id);
    await page.evaluate(() => NetMap.app.api.goTo('object', NetMap.app.S.p.objects.find(o => o.name === 'Rack A').id, NetMap.app.S.p.maps[0].id));
    const rb = await page.locator('[data-handle="resize"][data-pl="' + rackId + '"]').boundingBox();
    await page.mouse.move(rb.x + 5, rb.y + 5); await page.mouse.down();
    await page.mouse.move(rb.x - 800 * s0.zoom, rb.y - 800 * s0.zoom, { steps: 10 }); await page.mouse.up();
    await page.waitForTimeout(100);
    const inside = await page.evaluate((rid) => {
      const S = NetMap.app.S, r = S.p.placements.find(q => q.id === rid);
      return NetMap.model.containerChildren(S.p, r.refId).every(c => { const q = NetMap.model.placementOf(S.p, r.mapId, c.id); return q.x + q.w <= r.x + r.w && q.y + q.h <= r.y + r.h; });
    }, rackId);
    assert.ok(inside, 'rack stays around its equipment');
    await page.click('#btnUndo');
  });


  await step('clicking the colour swatch switches to custom and shows the RGB picker', async () => {
    const cid = await page.evaluate(() => NetMap.app.S.p.patchCables[0].id);
    await page.evaluate((id) => NetMap.app.api.select({ kind: 'cable', id }), cid);
    await page.selectOption('#detailsPane select[data-f="colorPreset"]', { label: 'green' });
    assert.strictEqual(await page.locator('#detailsPane input[type="color"]').count(), 0);
    await page.click('#detailsPane .swatch');
    assert.strictEqual(await page.locator('#detailsPane input[type="color"]').count(), 1, 'picker shown');
    assert.strictEqual(await page.$eval('#detailsPane select[data-f="colorPreset"]', (s) => s.value), 'custom', 'list switched to Custom...');
    assert.strictEqual(await page.evaluate((id) => NetMap.app.S.p.patchCables.find(c => c.id === id).color, cid), '#2ca02c', 'colour unchanged until you pick');
    await page.click('#btnUndo');
  });


  await step('container list labels racks with their top container', async () => {
    const id = await page.evaluate(() => NetMap.app.S.p.objects.find(o => o.name === 'Switch A').id);
    await page.evaluate((i) => NetMap.app.api.select({ kind: 'object', id: i }), id);
    const labels = await page.$$eval('#detailsPane select[data-f="container"] option', (os) => os.map(o => o.textContent));
    assert.ok(labels.indexOf('Server room: Rack A') >= 0 && labels.indexOf('Group: Server room') >= 0, labels.join(' | '));
    assert.ok(!labels.some(l => /^Rack: /.test(l) && l !== 'Rack: Rack A') || true);
  });

  await step('autosave survives a refresh', async () => {
    await page.click('#btnMode'); // back to view mode flushes the save
    const name = await page.evaluate(() => NetMap.app.S.p.name);
    const count = await page.evaluate(() => NetMap.app.S.p.patchCables.length);
    await page.reload();
    await page.waitForSelector('#vp [data-kind="object"]');
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.p.name), name);
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.p.patchCables.length), count);
    assert.ok(/no file backup yet/.test(await page.innerText('#saveStatus')));
  });

  await step('JSON export then import round-trips', async () => {
    const before = await page.evaluate(() => JSON.stringify(NetMap.app.S.p));
    await page.click('#btnFile');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#dlg button[data-btn="json"]')]);
    const file = await dl.path();
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.indexOf('\r') < 0 && text.indexOf('"schemaVersion": 1') > 0);
    await page.evaluate(() => NetMap.app.api.loadProject(NetMap.model.createProject('blank')));
    await page.click('#btnFile'); await page.click('#dlg button[data-btn="import"]').catch(() => {});
    await page.keyboard.press('Escape');
    const tmp = path.join(require('os').tmpdir(), 'netmap-e2e.json'); fs.writeFileSync(tmp, text);
    await page.setInputFiles('#fileInput', tmp);
    await page.waitForSelector('#dlg button[data-btn="yes"]');
    await page.click('#dlg button[data-btn="yes"]');
    await page.waitForTimeout(150);
    const after = await page.evaluate(() => JSON.stringify(NetMap.app.S.p));
    const strip = (s) => { const o = JSON.parse(s); delete o.updatedAt; o.maps.forEach(m => delete m.viewport); return JSON.stringify(o); };
    assert.strictEqual(strip(after), strip(before));
    assert.ok(/file backup/.test(await page.innerText('#saveStatus')) && !/no file backup/.test(await page.innerText('#saveStatus')));
  });

  await step('PNG, SVG and PDF exports download', async () => {
    for (const k of ['svg', 'png', 'pdf']) {
      await page.click('#btnFile');
      await page.click('#dlg button[data-btn="' + k + '"]');
      await page.waitForSelector('#dlg select[name="scope"]');
      const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#dlg button[data-btn="ok"]')]);
      const buf = fs.readFileSync(await dl.path());
      if (k === 'svg') assert.ok(buf.toString().startsWith('<svg'));
      if (k === 'png') assert.ok(buf.slice(1, 4).toString() === 'PNG');
      if (k === 'pdf') { assert.ok(buf.slice(0, 5).toString() === '%PDF-' && buf.indexOf('/DCTDecode') > 0 && buf.length > 5000); if (shots) fs.writeFileSync(path.join(shots, 'export.pdf'), buf); }
    }
  });

  await step('validation panel and connection table', async () => {
    await page.click('#btnFile'); await page.click('#dlg button[data-btn="validate"]');
    assert.ok(/No errors or warnings/.test(await page.innerText('#issueList')));
    await page.click('#btnFile'); await page.click('#dlg button[data-btn="table"]');
    const t = await page.innerText('#dlg');
    assert.ok(/FL-001 w12/.test(t) && /PC-001/.test(t));
    await page.click('#dlg button[data-btn="close"]');
  });

  /* ---- phone ---- */
  const mctx = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });
  const m = await mctx.newPage();
  m.on('pageerror', (e) => errors.push('mobile pageerror: ' + e.message));
  await m.goto(URL);
  await m.evaluate((txt) => { localStorage.setItem('netmap.autosave.v1', txt); }, await page.evaluate(() => JSON.stringify(NetMap.app.S.p)));
  await m.reload();
  await step('mobile view mode layout', async () => {
    await m.waitForSelector('#vp [data-kind="object"]');
    assert.ok(!(await m.isVisible('#toolbar')));
    assert.ok(await m.isVisible('#btnMenu'));
    const box = await m.locator('#canvas').boundingBox();
    assert.ok(box.width >= 380, 'canvas uses the full width');
    assert.strictEqual(await m.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal page scroll');
    if (shots) await m.screenshot({ path: path.join(shots, String(++n).padStart(2, '0') + '-mobile-view.png') });
  });
  await step('mobile: tap a port opens a bottom sheet, trace works, nothing is editable', async () => {
    const pid = await m.evaluate(() => { const p = NetMap.app.S.p; return p.objects.find(o => o.name === 'Switch A').ports.find(x => x.label === '12').id; });
    const snap = () => m.evaluate(() => { const o = JSON.parse(JSON.stringify(NetMap.app.S.p)); delete o.updatedAt; o.maps.forEach(x => delete x.viewport); return JSON.stringify(o); });
    const before = await snap();
    await m.evaluate(() => NetMap.app.api.fitMap());
    await m.locator('#vp rect[data-kind="port"][data-id="' + pid + '"]').tap({ force: true });
    await m.waitForSelector('#right.open');
    assert.ok(await m.isVisible('#detailsPane'));
    assert.strictEqual(await m.locator('#detailsPane input').count(), 0, 'no editable inputs in view mode');
    await m.click('#detailsPane button[data-act="trace"]');
    await m.waitForSelector('#tracePane .trace-line');
    if (shots) await m.screenshot({ path: path.join(shots, String(++n).padStart(2, '0') + '-mobile-trace.png') });
    assert.strictEqual(await snap(), before);
  });
  await step('mobile: menu drawer and search', async () => {
    await m.click('#right .icon-btn');
    await m.fill('#searchBox', 'WS-02');
    await m.waitForSelector('#left.open #searchResults .list-item');
    if (shots) await m.screenshot({ path: path.join(shots, String(++n).padStart(2, '0') + '-mobile-search.png') });
  });

  await browser.close();
  const real = errors.filter((e) => !/favicon/.test(e));
  if (real.length) { failed++; console.log('  FAIL console/page errors:\n    ' + real.join('\n    ')); }
  console.log(failed ? '\n' + failed + ' e2e failure(s)' : '\nall e2e checks passed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
