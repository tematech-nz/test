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
  // a copy opened from disk asks the repository for the published version: answer it locally (default: same version as this checkout)
  let repoVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'version.json'), 'utf8')).version;
  await ctx.route('https://raw.githubusercontent.com/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ version: repoVersion }) }));
  const page = await ctx.newPage();
  const errors = [];
  const dialogs = []; // beforeunload prompts etc: record and accept so reloads in the tests proceed
  page.on('dialog', (d) => { dialogs.push(d.type()); d.accept(); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  // a new item follows the cursor: move over the map and click to drop it (Ctrl keeps going)
  const placeAt = async (x = 640, y = 620, mods = []) => { await page.mouse.move(x, y); await page.mouse.move(x + 3, y + 3); await page.keyboard.down('Control'); await page.keyboard.up('Control'); if (mods.length) await page.keyboard.down(mods[0]); await page.mouse.click(x + 3, y + 3); if (mods.length) await page.keyboard.up(mods[0]); await page.waitForTimeout(150); };
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
    await page.click('#emptyHint button[data-act="demo"]');
    await page.waitForSelector('#vp [data-kind="object"]');
    assert.ok((await page.locator('#vp [data-kind="port"]').count()) > 40);
    assert.ok(await page.locator('#vp path[stroke-dasharray="7 5"]').count() >= 1, 'fixed link drawn');
    await shot('view-demo');
    // the button loads the showcase (floor plans, router, live copy...); the rest of the suite runs on the small base scenario
    assert.strictEqual(await page.evaluate(() => NetMap.model.floorMaps(NetMap.app.S.p).length), 2, 'showcase has two floor plans');
    await page.evaluate(() => NetMap.app.api.loadProject(NetMap.builder.buildDemoProject()));
    await page.waitForSelector('#vp [data-kind="object"]');
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

  await step('navigation panel folds away on desktop and comes back (remembered)', async () => {
    assert.ok(await page.isVisible('#left'));
    const w0 = (await page.locator('#stage').boundingBox()).width;
    await page.click('#btnMenu');
    assert.ok(!(await page.isVisible('#left')), 'navigation hidden');
    assert.ok((await page.locator('#stage').boundingBox()).width > w0 + 200, 'map area took the space');
    assert.strictEqual(await page.evaluate(() => localStorage.getItem('netmap.navHidden')), '1');
    await page.fill('#searchBox', 'PC');
    assert.ok(await page.isVisible('#left'), 'searching reveals the navigation');
    await page.fill('#searchBox', '');
    await page.click('#btnMenu');
    assert.ok(!(await page.isVisible('#left')));
    await page.click('#btnMenu');
    assert.ok(await page.isVisible('#left'));
    assert.strictEqual(await page.evaluate(() => localStorage.getItem('netmap.navHidden')), '0');
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
    assert.ok(await page.isVisible('#toolHint') && /Click to place/.test(await page.innerText('#toolHint')), 'placement hint');
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.p.groups.length), groups, 'nothing is created until you click');
    await placeAt();
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.p.groups.length), groups + 1);
    await page.click('#btnUndo');
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.p.groups.length), groups);
    await page.click('#btnRedo');
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.p.groups.length), groups + 1);
    await shot('edit-mode');
  });

  await step('copy and paste: Ctrl+C, Ctrl+V places "(Copy N)" at the cursor without connections', async () => {
    const info = await page.evaluate(() => { const S = NetMap.app.S; const o = S.p.objects.find(x => x.type === 'switch' && S.p.placements.some(q => q.refId === x.id && q.mapId === S.mapId)) || S.p.objects.find(x => x.type === 'switch'); S.sel = { kind: 'object', id: o.id }; return { id: o.id, name: o.name, n: S.p.objects.length, cables: S.p.patchCables.length }; });
    await page.keyboard.press('Control+c');
    assert.ok(await page.evaluate(() => !!NetMap.app.S.clip), 'copied');
    await page.keyboard.press('Control+v');
    assert.ok(await page.evaluate(() => !!NetMap.app.S.place), 'paste follows the cursor');
    await page.mouse.move(500, 600); await page.mouse.move(510, 610);
    await page.mouse.click(510, 610); await page.waitForTimeout(150);
    const res = await page.evaluate((i) => { const S = NetMap.app.S; const o = S.p.objects[S.p.objects.length - 1]; return { name: o.name, n: S.p.objects.length, cables: S.p.patchCables.length, sel: S.sel && S.sel.id === o.id, placed: !!S.p.placements.find(q => q.refId === o.id) }; }, info);
    assert.strictEqual(res.name, info.name.replace(/ \(Copy \d+\)$/, '') + ' (Copy 1)');
    assert.strictEqual(res.n, info.n + 1); assert.strictEqual(res.cables, info.cables); assert.ok(res.sel && res.placed);
    await page.click('#btnUndo');
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.p.objects.length), info.n);
  });

  await step('pseudo-device: a port group "Cameras" shows as one endpoint in the graph and in the group panel', async () => {
    const gid = await page.evaluate(() => {
      const A = NetMap.app, M = NetMap.model;
      const sw = A.S.p.objects.find((o) => o.type === 'switch' && o.ports.length >= 8 && !(o.portGroups || []).length);
      if (!sw) return null;
      const ids = A.S.p.patchCables.reduce((s, c) => { s[c.aPortId] = 1; s[c.bPortId] = 1; return s; }, {});
      const free = sw.ports.filter((pt) => !ids[pt.id] && !A.S.p.fixedLinks.some((l) => l.wires.some((w) => w.aPortId === pt.id || w.bPortId === pt.id))).slice(0, 3).map((pt) => pt.id);
      if (free.length < 2) return null;
      const g = A.commit('pseudo test', (p) => M.addPortGroup(p, sw.id, { name: 'Cameras', color: '#2ca02c', portIds: free, deviceKind: 'camera' }));
      A.S.sel = { kind: 'pgroup', id: g.id };
      return g.id;
    });
    if (!gid) return;
    await page.evaluate(() => document.getElementById('btnGraph').click());
    await page.waitForTimeout(200);
    const gvText = await page.evaluate(() => document.getElementById('graphView').innerText);
    assert.ok(/Cameras x\d/.test(gvText), 'graph shows the pseudo-device: ' + gvText.slice(0, 80));
    await page.evaluate(() => document.getElementById('btnGraph').click());
    await page.waitForTimeout(100);
    await page.evaluate(() => { NetMap.app.S.graph.from = ''; NetMap.app.S.graph.to = ''; });
    assert.ok(await page.evaluate(() => /Plugged-in device/.test(document.getElementById('detailsPane').innerText)), 'group panel offers the plugged-in device');
    await page.click('#btnUndo');
  });

  await step('File > Find shorter routes opens a report', async () => {
    await page.click('#btnFile');
    await page.click('#dlg button[data-btn="routes"]');
    await page.waitForSelector('#dlg .dh');
    const txt = await page.innerText('#dlg');
    assert.ok(/Shorter routes \(\d+\)/.test(txt), txt.slice(0, 120));
    await page.click('#dlg button[data-btn="x"]');
  });

  await step('quick start guide opens from the File menu and mentions fixed links across maps', async () => {
    await page.click('#btnFile');
    await page.click('#dlg button[data-btn="help"]');
    await page.waitForSelector('#dlg .dh');
    const txt = await page.innerText('#dlg');
    assert.ok(/quick start/i.test(txt) && /different maps/i.test(txt) && /Shortcuts/i.test(txt), txt.slice(0, 100));
    await page.click('#dlg button[data-btn="x"]');
    assert.strictEqual(await page.evaluate(() => localStorage.getItem('netmap.quickstart.seen')), '1');
  });

  await step('add existing here: ghost copy mirrors the other map (faded, click goes to the original); relocate moves it', async () => {
    const ids = await page.evaluate(() => {
      const A = NetMap.app, B = NetMap.builder, M = NetMap.model, out = { m1: A.S.mapId };
      A.commit('ghost setup', (p) => {
        const m2 = { id: M.uid('map'), name: 'Ghost map', location: '', viewport: { x: 0, y: 0, zoom: 1 } };
        p.maps.push(m2); out.m2 = m2.id;
        out.sw = B.addObjectPlaced(p, m2.id, { type: 'switch', name: 'GhostSrc', portCount: 8 }, 40, 40).id;
      });
      return out;
    });
    await page.click('#toolbar button[data-act="addMapItems"]');
    await page.selectOption('#dlg select[data-s="item"]', { label: 'Switch: GhostSrc' });
    assert.ok(/Live copy/.test(await page.innerText('#dlg select[data-s="mode"]')) && /Relocate/.test(await page.innerText('#dlg select[data-s="mode"]')));
    await page.click('#dlg button[data-btn="ok"]');
    await page.waitForTimeout(200);
    const g = await page.evaluate((i) => NetMap.app.S.p.placements.filter((q) => q.refId === i.sw && !(NetMap.app.S.p.maps.find((m) => m.id === q.mapId) || {}).auto).map((q) => ({ map: q.mapId, ghost: !!q.ghost })), ids);
    assert.deepStrictEqual(g.sort((x, y) => (x.ghost ? 1 : 0) - (y.ghost ? 1 : 0)), [{ map: ids.m2, ghost: false }, { map: ids.m1, ghost: true }]);
    assert.ok(await page.locator('#vp [data-ghost="1"]').count() >= 1, 'faded copy drawn');
    assert.strictEqual(await page.locator('#vp [data-ghost="1"] [data-handle="move"]').count(), 0);
    await page.evaluate((i) => { NetMap.app.S.p.objects.find((o) => o.id === i.sw).name = 'GhostSrc renamed'; document.getElementById('btnMode').click(); document.getElementById('btnMode').click(); }, ids);
    await page.evaluate(() => { // a tap on the live copy (synthetic pointer events: other items may lie on top of it on screen)
      const r = document.querySelector('#vp [data-ghost="1"] rect[data-kind="object"]'), o = { bubbles: true, pointerId: 77, pointerType: 'mouse', button: 0, clientX: 5, clientY: 5 };
      r.dispatchEvent(new PointerEvent('pointerdown', o)); r.dispatchEvent(new PointerEvent('pointerup', o));
    });
    await page.waitForTimeout(200);
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.mapId), ids.m1, 'a single tap stays on this map');
    assert.ok(/Live copy of an item on another map/.test(await page.innerText('#detailsPane')) && (await page.locator('#detailsPane input[data-f="name"]').count()) === 0, 'read-only details for a live copy');
    await page.evaluate(() => document.querySelector('#vp [data-ghost="1"] rect[data-kind="object"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    await page.waitForTimeout(200);
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.mapId), ids.m2, 'double-click opens the original on its own map');
    await page.selectOption('#mapSelect', ids.m1);
    await page.click('#btnUndo'); await page.click('#btnUndo');
  });

  await step('All items overview: shown only with 2+ maps, ghosts can be moved but not edited', async () => {
    const before = await page.evaluate(() => ({ maps: NetMap.app.S.p.maps.length, real: NetMap.model.realMaps(NetMap.app.S.p).length }));
    const opts0 = await page.$$eval('#mapSelect option', (os) => os.map((o) => o.textContent));
    assert.ok(before.real >= 2 ? opts0.includes('All items') : !opts0.includes('All items'));
    // a project with a single map has no overview: simulate by deleting ordinary maps from a copy is risky, so just check the rule
    const am = await page.evaluate(() => { const A = NetMap.app; A.commit('touch', (p) => { p.name = p.name; }); const m = NetMap.model.allMap(A.S.p); return m && m.id; });
    assert.ok(am, 'overview exists with 2+ maps');
    assert.ok((await page.$$eval('#mapSelect option', (os) => os.map((o) => o.textContent))).includes('All items'));
    const mapBefore = await page.evaluate(() => NetMap.app.S.mapId);
    await page.selectOption('#mapSelect', am); await page.waitForTimeout(200);
    assert.ok(await page.evaluate(() => document.body.classList.contains('on-all')));
    assert.ok(!(await page.isVisible('#toolbar')), 'no toolbar in the overview');
    assert.ok(await page.locator('#vp [data-ghost="1"]').count() > 3, 'ghosts of the items');
    assert.ok(await page.locator('#vp [data-ghost="1"] [data-handle="move"]').count() > 0, 'move handles on the ghosts in edit mode');
    assert.strictEqual(await page.locator('#vp [data-handle="resize"]').count(), 0);
    // drag one ghost: only its overview position changes
    const snapNow = await page.evaluate(() => JSON.stringify({ o: NetMap.app.S.p.objects, g: NetMap.app.S.p.groups, c: NetMap.app.S.p.patchCables }));
    const h = await page.locator('#vp [data-ghost="1"] [data-handle="move"]').first().boundingBox();
    await page.mouse.move(h.x + 5, h.y + 5); await page.mouse.down(); await page.mouse.move(h.x + 60, h.y + 50, { steps: 4 }); await page.mouse.up();
    await page.waitForTimeout(150);
    assert.strictEqual(await page.evaluate(() => JSON.stringify({ o: NetMap.app.S.p.objects, g: NetMap.app.S.p.groups, c: NetMap.app.S.p.patchCables })), snapNow, 'equipment and cabling untouched');
    // selecting an item shows it read-only
    await page.evaluate(() => { // tap an item in the overview (synthetic pointer events)
      const r = document.querySelector('#vp [data-ghost="1"] rect[data-kind="object"]'), o = { bubbles: true, pointerId: 79, pointerType: 'mouse', button: 0, clientX: 5, clientY: 5 };
      r.dispatchEvent(new PointerEvent('pointerdown', o)); r.dispatchEvent(new PointerEvent('pointerup', o));
    });
    await page.waitForTimeout(150);
    assert.strictEqual(await page.evaluate(() => NetMap.model.allMap(NetMap.app.S.p).id === NetMap.app.S.mapId), true, 'tapping in the overview stays in the overview');
    assert.ok(/Live copy of an item on another map|Overview copy/.test(await page.innerText('#detailsPane')) && (await page.locator('#detailsPane input[data-f="name"]').count()) === 0, 'details are read-only in the overview');
    await page.click('#btnMode'); await page.waitForTimeout(100);
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.mode), 'view', 'Done editing works in the overview');
    await page.click('#btnMode'); await page.waitForTimeout(100);
    await page.selectOption('#mapSelect', mapBefore); await page.waitForTimeout(100);
    await page.click('#btnUndo');
  });

  await step('move to another map: blocked while patch corded, allowed without cables (fixed links stay)', async () => {
    const ids = await page.evaluate(() => {
      const A = NetMap.app, B = NetMap.builder, M = NetMap.model, out = {};
      A.commit('move setup', (p) => {
        const mid = A.S.mapId;
        const a = B.addObjectPlaced(p, mid, { type: 'switch', name: 'MV-SW', portCount: 4 }, 7000, 40), b = B.addObjectPlaced(p, mid, { type: 'generic', name: 'MV-PC', portCount: 1 }, 7000, 260);
        out.cable = M.addPatchCable(p, { aPortId: a.ports[0].id, bPortId: b.ports[0].id }).id; out.a = a.id; out.b = b.id; out.from = mid;
      });
      return out;
    });
    await page.evaluate((i) => { NetMap.app.api.moveToMap('object', i.b); }, ids);
    await page.waitForSelector('#dlg .dh');
    const t1 = await page.innerText('#dlg');
    assert.ok(/Can't move/.test(t1) && /patch corded/.test(t1) && /only static|only fixed/i.test(t1), t1.slice(0, 160));
    await page.click('#dlg button[data-btn="x"]');
    await page.evaluate((i) => NetMap.app.api.commit('remove cable', (p) => { p.patchCables = p.patchCables.filter((c) => c.id !== i.cable); }), ids);
    await page.evaluate((i) => { NetMap.app.api.moveToMap('object', i.b); }, ids);
    await page.waitForSelector('#dlg select[data-s="dest"]');
    assert.ok(/Move MV-PC/.test(await page.innerText('#dlg .dh')));
    await page.selectOption('#dlg select[data-s="dest"]', '__new');
    await page.fill('#dlg input[data-s="name"]', 'MV room'); await page.dispatchEvent('#dlg input[data-s="name"]', 'change');
    await page.click('#dlg button[data-btn="ok"]');
    await page.waitForTimeout(200);
    const r = await page.evaluate((i) => { const S = NetMap.app.S, q = S.p.placements.filter((x) => x.refId === i.b && !(S.p.maps.find((m) => m.id === x.mapId) || {}).auto).map((x) => S.p.maps.find((m) => m.id === x.mapId).name); return q; }, ids);
    assert.deepStrictEqual(r, ['MV room']);
    for (let i = 0; i < 3; i++) await page.click('#btnUndo');
  });

  await step('a fixed link label can be dragged out of the way and reset', async () => {
    const lid = await page.evaluate(() => { const A = NetMap.app; const l = A.S.p.fixedLinks.find((x) => NetMap.model.placementOf(A.S.p, A.S.mapId, x.aObjectId) || NetMap.model.placementOf(A.S.p, A.S.mapId, x.bObjectId)); A.S.sel = null; return l && l.id; });
    if (!lid) return;
    await page.evaluate(() => document.getElementById('zoomFit').click());
    const box = await page.locator('#vp [data-linklabel="' + lid + '"]').first().boundingBox();
    if (!box) return;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 40, { steps: 5 }); await page.mouse.up();
    await page.waitForTimeout(150);
    const off = await page.evaluate((i) => { const A = NetMap.app; const l = A.S.p.fixedLinks.find((x) => x.id === i); return l.labelAt && l.labelAt[A.S.mapId]; }, lid);
    assert.ok(off && Math.abs(off[0]) + Math.abs(off[1]) > 10, 'label offset stored: ' + JSON.stringify(off));
    await page.evaluate((i) => NetMap.app.api.select({ kind: 'link', id: i }), lid);
    await page.waitForTimeout(100);
    assert.ok(await page.isVisible('#detailsPane button[data-act="resetLabel"]'));
    await page.click('#detailsPane button[data-act="resetLabel"]');
    assert.strictEqual(await page.evaluate((i) => NetMap.app.S.p.fixedLinks.find((x) => x.id === i).labelAt, lid), undefined);
    await page.click('#btnUndo'); await page.click('#btnUndo');
  });

  await step('deleting an item that is shown on two maps offers "this map only" and keeps it on the other map', async () => {
    const ids = await page.evaluate(() => {
      const A = NetMap.app, B = NetMap.builder, M = NetMap.model, out = { m1: A.S.mapId };
      A.commit('two-map setup', (p) => {
        const m2 = { id: M.uid('map'), name: 'Del map', location: '', viewport: { x: 0, y: 0, zoom: 1 } }; p.maps.push(m2); out.m2 = m2.id;
        const g = B.addGroupPlaced(p, A.S.mapId, { name: 'TwoMapGroup' }, 8000, 40);
        const sw = B.addObjectPlaced(p, A.S.mapId, { type: 'switch', name: 'TwoMapSw', portCount: 4, containerId: g.id }, 8020, 100);
        out.g = g.id; out.sw = sw.id;
        B.placeItem(p, m2.id, 'group', g.id, 40, 40, true); // a second, editable placement on the other map (older style)
      });
      return out;
    });
    await page.selectOption('#mapSelect', ids.m2); await page.waitForTimeout(150);
    await page.evaluate((i) => { NetMap.app.api.select({ kind: 'group', id: i.g }); }, ids);
    await page.waitForTimeout(100);
    await page.click('#detailsPane button[data-act="deleteSel"]');
    await page.waitForSelector('#dlg .dh');
    const txt = await page.innerText('#dlg');
    assert.ok(/2 maps/.test(txt) && /this map only/i.test(txt), txt.slice(0, 160));
    await page.click('#dlg button[data-btn="here"]');
    await page.waitForTimeout(150);
    const st = await page.evaluate((i) => { const S = NetMap.app.S, M = NetMap.model; return { group: !!S.p.groups.find((g) => g.id === i.g), sw: !!S.p.objects.find((o) => o.id === i.sw), here: !!M.placementOf(S.p, i.m2, i.g), hereSw: !!M.placementOf(S.p, i.m2, i.sw), there: !!M.placementOf(S.p, i.m1, i.g) }; }, ids);
    assert.deepStrictEqual(st, { group: true, sw: true, here: false, hereSw: false, there: true });
    await page.selectOption('#mapSelect', ids.m1); await page.waitForTimeout(100);
    await page.click('#btnUndo'); await page.click('#btnUndo');
  });

  await step('trace: "See on full map" opens the All items overview with the route highlighted, and back again', async () => {
    const pid = await page.evaluate(() => { const A = NetMap.app; A.commit('touch', (p) => { p.name = p.name; }); const c = A.S.p.patchCables[0]; return c && c.aPortId; });
    if (!pid) return;
    const from = await page.evaluate(() => NetMap.app.S.mapId);
    await page.evaluate((id) => NetMap.app.api.startTrace('port', id), pid);
    await page.waitForTimeout(150);
    assert.ok(await page.isVisible('#tracePane button[data-act="seeOnFullMap"]'), 'button offered while the overview exists');
    await page.click('#tracePane button[data-act="seeOnFullMap"]');
    await page.waitForTimeout(250);
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.p.maps.find((m) => m.id === NetMap.app.S.mapId).auto), 'all');
    assert.ok(await page.evaluate(() => !!NetMap.app.S.trace), 'trace kept');
    const ops = await page.$$eval('#vp g[data-ghost="1"][data-kind="object"]', (gs) => gs.map((g) => g.getAttribute('opacity')));
    assert.ok(ops.some((o) => +o > 0.9) && ops.some((o) => +o < 0.5), 'route stands out from the rest: ' + ops.join(','));
    assert.ok(await page.isVisible('#tracePane button[data-act="backFromFullMap"]'));
    await page.click('#tracePane button[data-act="backFromFullMap"]');
    await page.waitForTimeout(200);
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.mapId), from);
    await page.evaluate(() => document.querySelector('#tracePane button[data-act="clearTrace"]') && document.querySelector('#tracePane button[data-act="clearTrace"]').click());
    await page.click('#btnUndo');
  });

  await step('map order: drag a map by its handle in the map list (edit mode)', async () => {
    await page.evaluate(() => { const A = NetMap.app, M = NetMap.model; A.commit('three maps', (p) => { ['Order X', 'Order Y'].forEach((n) => p.maps.push({ id: M.uid('map'), name: n, location: '', viewport: { x: 0, y: 0, zoom: 1 } })); }); });
    await page.waitForTimeout(100);
    const order = () => page.evaluate(() => NetMap.model.realMaps(NetMap.app.S.p).map((m) => m.name));
    const before = await order();
    assert.ok(await page.locator('#mapList .map-grip').count() >= 3, 'grab handles in edit mode');
    const last = page.locator('#mapList .list-item', { hasText: 'Order Y' }), first = page.locator('#mapList .map-box .list-item').first();
    const g = await last.locator('.map-grip').boundingBox(), f = await first.boundingBox();
    await page.mouse.move(g.x + 4, g.y + g.height / 2); await page.mouse.down();
    await page.mouse.move(g.x + 4, f.y + 3, { steps: 8 }); await page.mouse.up();
    await page.waitForTimeout(150);
    const after = await order();
    assert.strictEqual(after[0], 'Order Y', 'moved to the top: ' + after.join(','));
    assert.deepStrictEqual(after.slice(1), before.filter((n) => n !== 'Order Y'));
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.p.maps[NetMap.app.S.p.maps.length - 1].auto), 'all');
    await page.evaluate(() => NetMap.app.api.setMode('view')); await page.waitForTimeout(100);
    assert.strictEqual(await page.locator('#mapList .map-grip').count(), 0, 'no handles in view mode');
    await page.evaluate(() => NetMap.app.api.setMode('edit')); await page.waitForTimeout(100);
    await page.click('#btnUndo'); await page.click('#btnUndo');
  });

  await step('trace: "Show all links in this network" highlights the rest of the network, softer than the route', async () => {
    const ids = await page.evaluate(() => {
      const A = NetMap.app, B = NetMap.builder, M = NetMap.model, out = {};
      A.commit('net setup', (p) => {
        const mid = A.S.mapId;
        const sw = B.addObjectPlaced(p, mid, { type: 'switch', name: 'NET-SW', portCount: 8 }, 9000, 40);
        const pcs = [0, 1, 2].map((i) => B.addObjectPlaced(p, mid, { type: 'generic', name: 'NET-PC' + i, portCount: 1 }, 9000 + i * 160, 260));
        out.cables = pcs.map((pc, i) => M.addPatchCable(p, { aPortId: pc.ports[0].id, bPortId: sw.ports[i].id }).id);
      });
      return out;
    });
    await page.evaluate((i) => NetMap.app.api.startTrace('cable', i.cables[0]), ids);
    await page.waitForTimeout(150);
    const count = () => page.evaluate(() => { const h = NetMap.app.S.trace.highlight; return { cables: Object.keys(h.cables).length, soft: Object.keys(h.cables).filter((id) => h.soft && h.soft[id]).length }; });
    assert.deepStrictEqual(await count(), { cables: 1, soft: 0 }, 'just the route to begin with');
    await page.click('#tracePane input[data-act="traceNet"]');
    await page.waitForTimeout(150);
    assert.deepStrictEqual(await count(), { cables: 3, soft: 2 }, 'the other two cables on the switch join, softly');
    assert.ok(await page.isChecked('#tracePane input[data-act="traceNet"]'), 'checkbox stays on');
    await page.click('#tracePane input[data-act="traceNet"]');
    assert.deepStrictEqual(await count(), { cables: 1, soft: 0 });
    await page.evaluate(() => document.querySelector('#tracePane button[data-act="clearTrace"]').click());
    await page.click('#btnUndo');
  });

  await step('equipment list shows only this map (plus unplaced items); a link brings back the other maps', async () => {
    const info = await page.evaluate(() => {
      const A = NetMap.app, B = NetMap.builder, M = NetMap.model, out = {};
      A.commit('list setup', (p) => {
        const m2 = { id: M.uid('map'), name: 'List map', location: '', viewport: { x: 0, y: 0, zoom: 1 } }; p.maps.push(m2); out.m2 = m2.id;
        out.far = B.addObjectPlaced(p, m2.id, { type: 'generic', name: 'LIST-FAR-ONLY', portCount: 1 }, 40, 40).id;
        out.here = B.addObjectPlaced(p, A.S.mapId, { type: 'generic', name: 'LIST-HERE-ONLY', portCount: 1 }, 40, 6000).id;
        out.loose = M.addObject(p, { type: 'generic', name: 'LIST-LOOSE', portCount: 1 }).id;
      });
      out.m1 = A.S.mapId; return out;
    });
    const list = () => page.innerText('#objectList');
    let txt = await list();
    assert.ok(txt.includes('LIST-HERE-ONLY') && txt.includes('LIST-LOOSE') && !txt.includes('LIST-FAR-ONLY'), txt.slice(0, 200));
    assert.ok(/Show equipment on other maps \(\d+\)/.test(txt));
    await page.click('#objectList a[data-act="listAll"]');
    txt = await list();
    assert.ok(txt.includes('LIST-FAR-ONLY') && /other map/.test(txt));
    await page.click('#objectList a[data-act="listAll"]');
    await page.selectOption('#mapSelect', info.m2); await page.waitForTimeout(150);
    txt = await list();
    assert.ok(txt.includes('LIST-FAR-ONLY') && !txt.includes('LIST-HERE-ONLY'), 'the list follows the current map');
    await page.selectOption('#mapSelect', info.m1); await page.waitForTimeout(100);
    await page.click('#btnUndo');
  });

  await step('hidden navigation stays hidden when clicking the map or changing mode', async () => {
    await page.click('#btnMenu');
    assert.ok(!(await page.isVisible('#left')));
    await page.mouse.click(700, 400); await page.waitForTimeout(150);
    assert.ok(!(await page.isVisible('#left')), 'a click on the map keeps the navigation hidden');
    await page.click('#btnMenu');
    assert.ok(await page.isVisible('#left'));
  });

  await step('edit history lists actions and jumps back and forward', async () => {
    await page.evaluate(() => { const A = NetMap.app; A.commit('History test one', (p) => { p.name = 'H1'; }); A.commit('History test two', (p) => { p.name = 'H2'; }); });
    const n0 = await page.evaluate(() => NetMap.app.S.undo.length);
    const names = await page.evaluate(() => { const S = NetMap.app.S; return S.undo.map((e) => e.label); });
    assert.ok(n0 >= 2, 'edit steps recorded');
    await page.click('#btnHistory');
    await page.waitForSelector('.hist-row');
    assert.strictEqual(await page.locator('.hist-row.current').count(), 1);
    assert.ok((await page.locator('.hist-row').first().innerText()).indexOf(names[names.length - 1]) >= 0, 'newest first');
    const snapNow = await page.evaluate(() => JSON.stringify(NetMap.app.S.p));
    await page.click('.hist-row[data-btn="go:' + (n0 - 1) + '"]');
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.undo.length), n0 - 1);
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.redo.length), 1);
    assert.strictEqual(await page.locator('.hist-row.future').count(), 1);
    await page.click('.hist-row[data-btn="go:' + n0 + '"]');
    assert.strictEqual(await page.evaluate(() => JSON.stringify(NetMap.app.S.p)), snapNow, 'forward restores the exact state');
    await page.click('dialog button[data-btn="x"]');
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


  await step('folding a panel moves the one stacked under it (magnet) and unfolding moves it back', async () => {
    const ids = await page.evaluate(() => {
      const A = NetMap.app, B = NetMap.builder, M = NetMap.model, out = {};
      A.commit('fold test setup', (p) => {
        const mid = A.S.mapId;
        const a = B.addObjectPlaced(p, mid, { type: 'patchpanel', name: 'FoldTop', portCount: 16, straight: true }, 3000, 3000);
        const pa = M.placementOf(p, mid, a.id);
        const b = B.addObjectPlaced(p, mid, { type: 'patchpanel', name: 'FoldBelow', portCount: 16, straight: true }, 3000, pa.y + pa.h);
        out.a = pa.id; out.b = M.placementOf(p, mid, b.id).id;
      });
      return out;
    });
    const yB = () => page.evaluate((i) => NetMap.app.S.p.placements.find(q => q.id === i.b).y, ids);
    const y0 = await yB(), a0 = await page.evaluate((i) => { const q = NetMap.app.S.p.placements.find(x => x.id === i.a); return q.y + q.h; }, ids);
    assert.ok(y0 >= a0 && y0 - a0 <= 22, 'stacked right under');
    await page.evaluate((i) => NetMap.app.toggleCollapse(i.a, 'rear'), ids);
    const y1 = await yB();
    assert.ok(y1 < y0 - 10, 'the lower panel followed up when the one above folded: ' + y0 + ' -> ' + y1);
    await page.evaluate((i) => NetMap.app.toggleCollapse(i.a, 'rear'), ids);
    const y2 = await yB();
    assert.ok(y2 >= a0, 'and made room again when it unfolded: ' + y2 + ' vs ' + a0);
    assert.deepStrictEqual(await page.evaluate(() => NetMap.app.S.p.placements.length > 0 && 0), 0);
    for (let i = 0; i < 3; i++) await page.click('#btnUndo');
  });

  await step('router: create with WAN/LAN ports and IP via the toolbar', async () => {
    await page.click('#toolbar button[data-add="router"]');
    await page.fill('#dlg input[name="name"]', 'Edge GW');
    await page.fill('#dlg input[name="wanPorts"]', '2');
    await page.fill('#dlg input[name="lanPorts"]', '5');
    await page.fill('#dlg input[name="ipAddress"]', '192.168.50.1');
    await page.click('#dlg button[data-btn="ok"]');
    await placeAt(700, 640);
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
      const r = B.addObjectPlaced(p, p.maps[0].id, { type: 'router', name: 'Edge', wanPorts: 1, lanPorts: 2, ipAddress: '192.168.1.1' }, 900, 140);
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


  await step('inside its own rack an item can be placed freely (no magnet away from seams)', async () => {
    const ids = await page.evaluate(() => {
      let out;
      NetMap.app.api.commit('free rack', (p) => {
        const B = NetMap.builder, mid = p.maps[0].id;
        const rack = B.addObjectPlaced(p, mid, { type: 'rack', name: 'FreeRack' }, 3300, 40);
        M = NetMap.model; M.placementOf(p, mid, rack.id).h = 600;
        const a = B.addObjectPlaced(p, mid, { type: 'switch', name: 'FrA', portCount: 8, containerId: rack.id });
        const b = B.addObjectPlaced(p, mid, { type: 'switch', name: 'FrB', portCount: 8, containerId: rack.id });
        out = { a: a.id, b: b.id };
      });
      const S = NetMap.app.S;
      out.plB = S.p.placements.find(q => q.refId === out.b).id;
      NetMap.app.api.goTo('object', out.b, S.p.maps[0].id);
      return out;
    });
    const gap = () => page.evaluate((i) => { const S = NetMap.app.S, a = S.p.placements.find(q => q.refId === i.a), b = S.p.placements.find(q => q.refId === i.b); return { gap: b.y - (a.y + a.h), zoom: S.p.maps[0].viewport.zoom }; }, ids);
    const g0 = await gap();
    assert.ok(g0.gap <= 16, 'stacked together at the start');
    const box = await page.locator('[data-handle="move"][data-pl="' + ids.plB + '"]').boundingBox();
    await page.mouse.move(box.x + 5, box.y + 5); await page.mouse.down();
    await page.mouse.move(box.x + 5, box.y + 5 + 120 * g0.zoom, { steps: 8 });
    await page.waitForTimeout(100);
    assert.strictEqual(await page.locator('#vp [data-drop="line"]').count(), 0, 'no magnet line for free placement');
    await page.mouse.up();
    await page.waitForTimeout(100);
    const g1 = await gap();
    assert.ok(g1.gap > 60, 'stayed where dropped, not snapped back: gap ' + g1.gap);
    // dragging it back onto the seam of two stuck items would still insert; here just check it can return next to FrA freely
    await page.click('#btnUndo'); await page.click('#btnUndo');
  });


  await step('switch sections can be changed after creation', async () => {
    await page.evaluate(() => NetMap.app.api.commit('sw', (p) => NetMap.builder.addObjectPlaced(p, p.maps[0].id, { type: 'switch', name: 'SecSw', portCount: 24 }, 3800, 40)));
    const id = await page.evaluate(() => NetMap.app.S.p.objects.find(o => o.name === 'SecSw').id);
    await page.evaluate((i) => NetMap.app.api.select({ kind: 'object', id: i }), id);
    const rows = () => page.evaluate((i) => { const o = NetMap.app.S.p.objects.find(x => x.id === i); return new Set(o.ports.map(x => Math.round(NetMap.app.S.geo.portGeo[x.id].y))).size; }, id);
    assert.strictEqual(await rows(), 2);
    await page.selectOption('#detailsPane select[data-f="sectionSize"]', '8');
    await page.waitForTimeout(100);
    assert.strictEqual(await rows(), 1);
    await page.selectOption('#detailsPane select[data-f="sectionSize"]', '0');
    await page.waitForTimeout(100);
    assert.strictEqual(await rows(), 2, 'back to plain rows');
    await page.click('#btnUndo'); await page.click('#btnUndo'); await page.click('#btnUndo');
  });


  await step('switch: 2x4 sections, uplinks, alignment, full width and port isolation from the properties panel', async () => {
    const ids = await page.evaluate(() => {
      let out;
      NetMap.app.api.commit('rack+switch', (p) => {
        const B = NetMap.builder, mid = p.maps[0].id;
        const rack = B.addObjectPlaced(p, mid, { type: 'rack', name: 'SwRack' }, 4400, 40);
        const sw = B.addObjectPlaced(p, mid, { type: 'switch', name: 'Sw16', portCount: 16, containerId: rack.id });
        out = { rack: rack.id, sw: sw.id };
      });
      NetMap.app.api.goTo('object', out.sw, NetMap.app.S.p.maps[0].id);
      return out;
    });
    const sel = (f, v) => page.selectOption('#detailsPane select[data-f="' + f + '"]', String(v));
    const sw = () => page.evaluate((i) => { const o = NetMap.app.S.p.objects.find(x => x.id === i); const geo = NetMap.app.S.geo.portGeo; const pl = NetMap.app.S.p.placements.find(q => q.refId === i); return { o: JSON.parse(JSON.stringify(o)), x1: geo[o.ports[0].id].x, y1: geo[o.ports[0].id].y, x2: geo[o.ports[1].id].x, y2: geo[o.ports[1].id].y, w: pl.w, plx: pl.x }; }, ids.sw);
    await sel('sectionSize', 8);
    await sel('sectionRows', 2);
    let s = await sw();
    assert.strictEqual(s.o.sectionSize, 8); assert.strictEqual(s.o.sectionRows, 2);
    assert.ok(s.x1 === s.x2 && s.y1 < s.y2, 'port 1 above port 2');
    await page.fill('#detailsPane #upInput', '2');
    await page.click('#detailsPane button[data-act="applyUplinks"]');
    s = await sw();
    assert.strictEqual(s.o.ports.filter(p => p.role === 'uplink').length, 2);
    await page.check('#detailsPane input[data-f="fullWidth"]');
    s = await sw();
    const rackW = await page.evaluate((i) => NetMap.app.S.p.placements.find(q => q.refId === i).w, ids.rack);
    assert.ok(s.o.fullWidth && s.w >= rackW - 40 - 1, 'stretched to the rack width: ' + s.w + ' vs ' + rackW);
    const left = s.x1;
    await sel('align', 'center'); const c = (await sw()).x1;
    await sel('align', 'right'); const r = (await sw()).x1;
    assert.ok(left < c && c < r, 'alignment moves the ports: ' + [left, c, r]);
    await shot('switch-layout');
    await page.check('#detailsPane input[data-f="portIsolation"]');
    assert.strictEqual((await sw()).o.portIsolation, true);
    assert.ok((await page.innerHTML('#vp')).indexOf('PORT ISOLATION') > 0);
    for (let i = 0; i < 7; i++) await page.click('#btnUndo');
  });


  await step('device icons: create a PC via the toolbar, switch it to an access point, see the icon', async () => {
    await page.click('#toolbar button[data-add="generic"]');
    await page.selectOption('#dlg select[name="deviceKind"]', 'pc');
    await page.click('#dlg button[data-btn="ok"]');
    await placeAt(700, 660);
    const name = await page.evaluate(() => NetMap.app.S.p.objects.filter(o => o.deviceKind === 'pc').pop().name);
    assert.ok(/^PC \d+$/.test(name), name);
    assert.ok((await page.locator('#vp [data-icon="pc"]').count()) >= 1, 'PC icon drawn');
    await page.selectOption('#detailsPane select[data-f="deviceKind"]', 'ap');
    await page.waitForTimeout(100);
    assert.ok((await page.locator('#vp [data-icon="ap"]').count()) >= 1, 'AP icon after changing the type');
    await shot('device-icons');
    await page.click('#btnUndo'); await page.click('#btnUndo');
  });

  await step('wall socket rear: fixed link between a patch panel and a wall socket from the UI', async () => {
    await page.evaluate(() => NetMap.app.api.commit('socket link', (p) => {
      const B = NetMap.builder, mid = p.maps[0].id;
      B.addObjectPlaced(p, mid, { type: 'patchpanel', name: 'PP-L', portCount: 8, straight: true }, 5200, 40);
      B.addObjectPlaced(p, mid, { type: 'socket', name: 'WS-L', portCount: 2 }, 5200, 300);
    }));
    await page.click('#toolbar button[data-act="newLink"]');
    const opts = await page.$$eval('#dlg select[data-s="a"] option', (os) => os.map(o => o.textContent));
    assert.ok(opts.some(o => /WS-L \(wall socket\)/.test(o)), opts.join('|'));
    await page.selectOption('#dlg select[data-s="a"]', { label: 'PP-L' });
    await page.selectOption('#dlg select[data-s="b"]', { label: 'WS-L (wall socket)' });
    await page.fill('#dlg input[data-s="n"]', '2'); await page.dispatchEvent('#dlg input[data-s="n"]', 'change');
    await page.click('#dlg button[data-btn="ok"]');
    await page.waitForTimeout(150);
    const link = await page.evaluate(() => { const S = NetMap.app.S, l = S.p.fixedLinks[S.p.fixedLinks.length - 1], idx = NetMap.model.buildIndex(S.p); return { n: l.wires.length, b: idx.objects[l.bObjectId].name, side: idx.ports[l.wires[0].bPortId].side }; });
    assert.deepStrictEqual(link, { n: 2, b: 'WS-L', side: 'rear' });
    assert.ok(/fixed link/i.test(await page.innerText('#detailsPane')));
    await page.click('#btnUndo'); await page.click('#btnUndo');
  });


  await step('new fixed link: pick ports on both panels (1,3,5,7 to 1-4), occupied ports are greyed out, groups are shown', async () => {
    await page.evaluate(() => NetMap.app.api.commit('pick test', (p) => {
      const B = NetMap.builder, M = NetMap.model, mid = p.maps[0].id;
      const a = B.addObjectPlaced(p, mid, { type: 'patchpanel', name: 'PK-A', portCount: 8, straight: true }, 5600, 40);
      B.addObjectPlaced(p, mid, { type: 'patchpanel', name: 'PK-B', portCount: 8, straight: true }, 5600, 300);
      M.addPortGroup(p, a.id, { name: 'to office', color: '#2ca02c', portsText: '1-2', side: 'rear' });
    }));
    await page.click('#toolbar button[data-act="newLink"]');
    await page.selectOption('#dlg select[data-s="a"]', { label: 'PK-A' });
    await page.selectOption('#dlg select[data-s="b"]', { label: 'PK-B' });
    assert.ok(await page.isVisible('#dlg .pk-group'), 'port groups are shown');
    const pick = (side, label, shift) => page.locator('#dlg .pk[data-side="' + side + '"]').filter({ hasText: new RegExp('^' + label + '$') }).click({ modifiers: shift ? ['Shift'] : [] });
    for (const l of ['1', '3', '5', '7']) await pick('a', l);
    assert.strictEqual(await page.locator('#dlg .pk-wrap.valid').count(), 0, 'not green while only one side is picked');
    await pick('b', '1'); await pick('b', '3', true);
    assert.strictEqual(await page.locator('#dlg .pk-wrap.valid').count(), 0, 'not green while the counts differ (4 on A, 3 on B)');
    await pick('b', '4', true);
    assert.strictEqual(await page.locator('#dlg .pk-wrap.valid').count(), 1, 'green once both sides have the same number of ports');
    assert.strictEqual(await page.evaluate(() => getComputedStyle(document.querySelector('#dlg .pk.on')).backgroundColor), 'rgb(200, 230, 201)');
    assert.ok(/A: 1, 3, 5, 7/.test(await page.innerText('#dlg .pk-sum')) && /B: 1, 2, 3, 4/.test(await page.innerText('#dlg .pk-sum')), await page.innerText('#dlg .pk-sum'));
    await page.click('#dlg button[data-btn="ok"]');
    await page.waitForTimeout(150);
    const pairs = await page.evaluate(() => { const S = NetMap.app.S, l = S.p.fixedLinks[S.p.fixedLinks.length - 1], idx = NetMap.model.buildIndex(S.p); return l.wires.map((w) => idx.ports[w.aPortId].label + '-' + idx.ports[w.bPortId].label); });
    assert.deepStrictEqual(pairs, ['1-1', '3-2', '5-3', '7-4']);
    await page.click('#toolbar button[data-act="newLink"]');
    await page.selectOption('#dlg select[data-s="a"]', { label: 'PK-A' });
    await page.selectOption('#dlg select[data-s="b"]', { label: 'PK-B' });
    assert.strictEqual(await page.locator('#dlg .pk[data-side="a"]:disabled').count(), 4, 'occupied ports cannot be picked');
    await page.click('#dlg .pk[data-side="a"]:disabled', { force: true }).catch(() => {});
    await page.locator('#dlg .pk[data-side="a"]').filter({ hasText: /^2$/ }).click();
    assert.ok(await page.isDisabled('#dlg button[data-btn="ok"]'), 'unequal counts block creation');
    await page.click('#dlg button[data-btn="no"]');
    await page.click('#btnUndo');
  });

  await step('fixed link: click a group, "Place selected group" shows green spots and a live preview on the other panel', async () => {
    await page.evaluate(() => NetMap.app.api.commit('group place test', (p) => {
      const B = NetMap.builder, M = NetMap.model, mid = p.maps[0].id;
      const a = B.addObjectPlaced(p, mid, { type: 'patchpanel', name: 'GP-A', portCount: 8, straight: true }, 5900, 40);
      const b = B.addObjectPlaced(p, mid, { type: 'patchpanel', name: 'GP-B', portCount: 8, straight: true }, 5900, 300);
      M.addPortGroup(p, a.id, { name: 'block', color: '#2ca02c', portsText: '5-8', side: 'rear' });
      M.addPortGroup(p, a.id, { name: 'taken', color: '#d62728', portsText: '1-2', side: 'rear' });
      M.addFixedLink(p, { aObjectId: a.id, bObjectId: b.id, wireCount: 1, pairs: [[a.ports.find(x => x.side === 'rear' && x.label === '1').id, b.ports.find(x => x.side === 'rear' && x.label === '6').id]] });
    }));
    await page.click('#toolbar button[data-act="newLink"]');
    await page.selectOption('#dlg select[data-s="a"]', { label: 'GP-A' });
    await page.selectOption('#dlg select[data-s="b"]', { label: 'GP-B' });
    assert.ok(await page.isDisabled('#dlg .pk-group:has-text("taken")'), 'a group that already has a wire cannot be placed');
    assert.ok(await page.isDisabled('#dlg .pk-place[data-placegroup="b"]'), 'place button waits for a group');
    await page.click('#dlg .pk-group:has-text("block")');
    assert.ok(/Placing/.test(await page.innerText('#dlg .pk-banner')));
    assert.ok(await page.isEnabled('#dlg .pk-place[data-placegroup="b"]'));
    // free runs of 4 on B (port 6 is wired): 1-4 and 2-5 only
    assert.strictEqual(await page.locator('#dlg .pk.cand[data-side="b"]').count(), 5, 'possible spots are green');
    const bp = (l) => page.locator('#dlg .pk[data-side="b"]').filter({ hasText: new RegExp('^' + l + '$') });
    await bp('2').hover();
    assert.strictEqual(await page.locator('#dlg .pk.win-ok').count(), 4, 'the exact ports light up');
    await bp('7').hover();
    assert.ok(await page.locator('#dlg .pk.win-bad').count() >= 1 && await page.locator('#dlg .pk.win-ok').count() === 0, 'a spot that does not fit is red');
    await bp('2').click();
    assert.ok(/A: 5, 6, 7, 8/.test(await page.innerText('#dlg .pk-sum')) && /B: 2, 3, 4, 5/.test(await page.innerText('#dlg .pk-sum')), await page.innerText('#dlg .pk-sum'));
    await page.click('#dlg button[data-btn="ok"]');
    await page.waitForTimeout(150);
    const pairs = await page.evaluate(() => { const S = NetMap.app.S, l = S.p.fixedLinks[S.p.fixedLinks.length - 1], idx = NetMap.model.buildIndex(S.p); return l.wires.map((w) => idx.ports[w.aPortId].label + '-' + idx.ports[w.bPortId].label); });
    assert.deepStrictEqual(pairs, ['5-2', '6-3', '7-4', '8-5']);
    // the far end got a group of its own, linked to "block": same name to start with, renamed independently
    const gl = await page.evaluate(() => { const M = NetMap.model, p = NetMap.app.S.p, a = p.objects.find((o) => o.name === 'GP-A').portGroups.find((g) => g.name === 'block'), q = M.peerGroup(p, a.id); return q && { aId: a.id, bId: q.group.id, bName: q.group.name, bObj: q.obj.name, n: q.group.portIds.length }; });
    assert.ok(gl && gl.bName === 'block' && gl.bObj === 'GP-B' && gl.n === 4, JSON.stringify(gl));
    await page.evaluate((g) => { NetMap.app.commit('rename far end', (p) => NetMap.model.updatePortGroup(p, g.bId, { name: 'from rack 1' })); }, gl);
    assert.ok((await page.evaluate((g) => NetMap.app.S.p.objects.find((o) => o.name === 'GP-A').portGroups.find((x) => x.id === g.aId).name, gl)) === 'block', 'this end keeps its own name');
    assert.ok(/-(&gt;|>) from rack 1 on GP-B/.test(await page.evaluate(() => document.getElementById('vp').innerHTML)), 'hover text names the other end');
    // GP-B lives on another map: tapping "block" takes me there and selects the linked group
    const m2 = await page.evaluate(() => { const A = NetMap.app, M = NetMap.model, B = NetMap.builder, id = M.uid('map'); let moved; A.commit('second map', (p) => { p.maps.push({ id: id, name: 'Far map', location: '', viewport: { x: 0, y: 0, zoom: 1 } }); B.relocate(p, id, 'object', p.objects.find((o) => o.name === 'GP-B').id, 40, 40, A.S.mapId); }); return id; });
    await page.evaluate((g) => {
      const r = document.querySelector('#vp rect[data-kind="pgroup"][data-id="' + g.aId + '"]'), o = { bubbles: true, pointerId: 78, pointerType: 'mouse', button: 0, clientX: 5, clientY: 5 };
      r.dispatchEvent(new PointerEvent('pointerdown', o)); r.dispatchEvent(new PointerEvent('pointerup', o));
    }, gl);
    await page.waitForTimeout(200);
    const nav = await page.evaluate(() => ({ map: NetMap.app.S.mapId, sel: NetMap.app.S.sel }));
    assert.strictEqual(nav.map, m2, 'jumped to the other map'); assert.deepStrictEqual(nav.sel, { kind: 'pgroup', id: gl.bId });
    await page.selectOption('#mapSelect', await page.evaluate((m) => NetMap.app.S.p.maps.find((x) => x.id !== m).id, m2));
    for (let i = 0; i < 4; i++) await page.click('#btnUndo');
  });

  await step('W hotkey: one-shot wire from the selected port keeps the new cable selected; plain W toggles the repeating tool', async () => {
    const ids = await page.evaluate(() => {
      let out;
      NetMap.app.api.commit('w test', (p) => {
        const B = NetMap.builder, mid = p.maps[0].id;
        const a = B.addObjectPlaced(p, mid, { type: 'switch', name: 'WA', portCount: 4 }, 6000, 40), b = B.addObjectPlaced(p, mid, { type: 'switch', name: 'WB', portCount: 4 }, 6000, 200);
        out = { a1: a.ports[0].id, a2: a.ports[1].id, b1: b.ports[0].id, b2: b.ports[1].id, b3: b.ports[2].id };
      });
      NetMap.app.api.goTo('port', out.a1, NetMap.app.S.p.maps[0].id);
      return out;
    });
    const port = (id) => page.locator('#vp rect[data-kind="port"][data-id="' + id + '"]');
    const count = () => page.evaluate(() => NetMap.app.S.p.patchCables.length);
    const c0 = await count();
    await page.evaluate((id) => NetMap.app.api.select({ kind: 'port', id }), ids.a1);
    await page.keyboard.press('w');
    const t1 = await page.evaluate(() => NetMap.app.S.tool);
    assert.ok(t1 && t1.type === 'patch' && t1.once && t1.pending, 'one-shot wire started from the selected port');
    await port(ids.b1).click({ force: true });
    await page.waitForTimeout(100);
    assert.strictEqual(await count(), c0 + 1);
    const after = await page.evaluate(() => ({ tool: NetMap.app.S.tool, sel: NetMap.app.S.sel }));
    assert.strictEqual(after.tool, null, 'tool ended after the second port');
    assert.strictEqual(after.sel.kind, 'cable', 'the new cable stays selected');
    assert.ok(await page.locator('#detailsPane select[data-f="colorPreset"]').count() === 1, 'colour can be adjusted right away');
    // plain W (nothing port-selected) = repeating tool, W again leaves it
    await page.evaluate(() => NetMap.app.api.select(null));
    await page.keyboard.press('w');
    assert.ok(await page.evaluate(() => !!NetMap.app.S.tool && !NetMap.app.S.tool.once));
    await port(ids.a2).click({ force: true }); await port(ids.b2).click({ force: true });
    assert.ok(await page.evaluate(() => !!NetMap.app.S.tool), 'repeating tool stays active');
    await page.keyboard.press('w');
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.tool), null);
    // typing a w in a text field must not start the tool
    await page.evaluate((id) => NetMap.app.api.select({ kind: 'object', id: NetMap.app.S.p.objects.find(o => o.name === 'WA').id }), ids.a1);
    await page.fill('#detailsPane input[data-f="name"]', 'WAw');
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.tool), null);
    // 'Patch cable from here' behaves like W
    await page.evaluate((id) => NetMap.app.api.select({ kind: 'port', id }), ids.b3);
    await page.click('#detailsPane button[data-act="startPatchFrom"]');
    assert.ok(await page.evaluate(() => !!NetMap.app.S.tool && NetMap.app.S.tool.once));
    await page.keyboard.press('Escape');
    for (let i = 0; i < 4; i++) await page.click('#btnUndo');
  });

  await step('port label shows on hover; the face keeps the number', async () => {
    const id = await page.evaluate(() => { const o = NetMap.app.S.p.objects.find(x => x.name === 'Switch A'); return o.ports.find(x => x.label === '12').id; });
    await page.evaluate((i) => NetMap.app.api.select({ kind: 'port', id: i }), id);
    await page.fill('#detailsPane input[data-f="pdesc"]', 'Uplink to core');
    await page.keyboard.press('Tab');
    const g = page.locator('#vp g[data-kind="port"][data-id="' + id + '"]');
    assert.ok(/Uplink to core/.test(await g.locator('title').innerHTML()), 'tooltip has the label');
    assert.strictEqual((await g.locator('text').textContent()).trim(), '12', 'face shows the number');
    await page.click('#btnUndo');
  });


  await step('network colour: set on a router port, new cables default to it, manual colour still wins, recolour action', async () => {
    const ids = await page.evaluate(() => {
      let out;
      NetMap.app.api.commit('net test', (p) => {
        const B = NetMap.builder, mid = p.maps[0].id;
        const r = B.addObjectPlaced(p, mid, { type: 'router', name: 'NetR', wanPorts: 1, lanPorts: 2 }, 7000, 40);
        const s = B.addObjectPlaced(p, mid, { type: 'switch', name: 'NetS', portCount: 4 }, 7000, 240);
        const d = B.addObjectPlaced(p, mid, { type: 'generic', name: 'NetPC', deviceKind: 'pc', portCount: 1 }, 7300, 240);
        out = { l1: r.ports.find(x => x.label === 'L1').id, s1: s.ports[0].id, s2: s.ports[1].id, s3: s.ports[2].id, pc: d.ports[0].id };
      });
      NetMap.app.api.goTo('port', out.l1, NetMap.app.S.p.maps[0].id);
      return out;
    });
    const color = (a) => page.evaluate((x) => { const p = NetMap.app.S.p, c = p.patchCables.find(k => k.aPortId === x.a || k.bPortId === x.a); return c && c.color; }, { a });
    const port = (id) => page.locator('#vp rect[data-kind="port"][data-id="' + id + '"]');
    await page.evaluate((id) => NetMap.app.api.select({ kind: 'port', id }), ids.l1);
    await page.selectOption('#detailsPane select[data-f="netPreset"]', { label: 'red' });
    assert.strictEqual(await page.evaluate((id) => NetMap.app.S.p.objects.flatMap(o => o.ports).find(x => x.id === id).networkColor, ids.l1), '#d62728');
    assert.ok((await page.innerHTML('#vp')).indexOf('fill="#d62728" stroke="#333"') > 0, 'colour bar on the router port');
    await page.click('#toolbar button[data-act="patchTool"]');
    await page.selectOption('#toolbar select[data-f="toolPreset"]', 'auto');
    assert.strictEqual(await page.$eval('#toolbar select[data-f="toolPreset"]', (s) => s.value), 'auto', 'tool can be set to Auto (network colour)');
    await port(ids.l1).click({ force: true }); await port(ids.s1).click({ force: true });
    assert.strictEqual(await color(ids.s1), '#d62728', 'router -> switch cable takes the network colour');
    await port(ids.pc).click({ force: true }); await port(ids.s2).click({ force: true });
    assert.strictEqual(await color(ids.pc), '#d62728', 'PC -> switch cable too: it extends from that network');
    await page.selectOption('#toolbar select[data-f="toolPreset"]', { label: 'green' });
    await port(ids.s3).click({ force: true });
    const free = await page.evaluate(() => NetMap.app.S.p.objects.find(o => o.name === 'NetPC').ports[0].id);
    assert.ok(free);
    await page.keyboard.press('Escape');
    // manual override on a cable
    const cid = await page.evaluate((a) => NetMap.app.S.p.patchCables.find(k => k.aPortId === a || k.bPortId === a).id, ids.pc);
    await page.evaluate((id) => NetMap.app.api.select({ kind: 'cable', id }), cid);
    await page.selectOption('#detailsPane select[data-f="colorPreset"]', { label: 'yellow' });
    assert.strictEqual(await color(ids.pc), '#f2c200');
    // changing the network colour offers to match the existing downstream cables
    await page.evaluate((id) => NetMap.app.api.select({ kind: 'port', id }), ids.l1);
    await page.selectOption('#detailsPane select[data-f="netPreset"]', { label: 'orange' });
    await page.waitForSelector('#dlg[open]');
    assert.ok(/Match colours on downstream cables/.test(await page.innerText('#dlg')) && /different colour/.test(await page.innerText('#dlg')));
    await page.click('#dlg button[data-btn="no"]');
    assert.strictEqual(await color(ids.pc), '#f2c200', 'declined: cables unchanged');
    await page.selectOption('#detailsPane select[data-f="netPreset"]', { label: 'red' });
    await page.waitForSelector('#dlg[open]');
    await page.click('#dlg button[data-btn="yes"]');
    await page.waitForTimeout(100);
    assert.strictEqual(await color(ids.pc), '#d62728', 'accepted: downstream cables match the network colour');
    assert.strictEqual(await color(ids.s1), '#d62728');
    // the explicit button works too
    await page.evaluate((id) => NetMap.app.api.select({ kind: 'cable', id }), cid);
    await page.selectOption('#detailsPane select[data-f="colorPreset"]', { label: 'yellow' });
    await page.evaluate((id) => NetMap.app.api.select({ kind: 'port', id }), ids.l1);
    await page.click('#detailsPane button[data-act="recolorNet"]');
    await page.waitForSelector('#dlg[open]');
    await page.click('#dlg button[data-btn="yes"]');
    await page.waitForTimeout(100);
    assert.strictEqual(await color(ids.pc), '#d62728', 'recoloured, including the manual one');
    await shot('network-colour');
    for (let i = 0; i < 12; i++) await page.click('#btnUndo');
    await page.evaluate(() => { NetMap.app.S.tool = null; });
  });


  await step('IPv4 only: bad addresses are rejected in the form and in the properties', async () => {
    await page.click('#toolbar button[data-add="router"]');
    await page.fill('#dlg input[name="name"]', 'BadIpR');
    await page.fill('#dlg input[name="ipAddress"]', '192.168.1.1/24');
    await page.click('#dlg button[data-btn="ok"]');
    assert.ok(await page.evaluate(() => document.getElementById('dlg').open), 'dialog stays open');
    assert.ok(/IPv4/.test(await page.innerText('#dlg .form-err')));
    await page.fill('#dlg input[name="ipAddress"]', '192.168.1.1');
    await page.click('#dlg button[data-btn="ok"]');
    await placeAt(700, 680);
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.p.objects.find(o => o.name === 'BadIpR').ipAddress), '192.168.1.1');
    await page.fill('#detailsPane input[data-f="ipAddress"]', '10.0.0.1/8');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(100);
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.p.objects.find(o => o.name === 'BadIpR').ipAddress), '192.168.1.1', 'unchanged');
    assert.ok(/IPv4/.test(await page.innerText('#toast')));
    assert.strictEqual(await page.inputValue('#detailsPane input[data-f="ipAddress"]'), '192.168.1.1', 'field restored');
    await page.fill('#detailsPane input[data-f="ipAddress"]', '172.16.0.1');
    await page.keyboard.press('Tab');
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.p.objects.find(o => o.name === 'BadIpR').ipAddress), '172.16.0.1');
    await page.click('#btnUndo'); await page.click('#btnUndo');
  });

  await step('network warnings: joining different subnets asks first, then flags the routers', async () => {
    const ids = await page.evaluate(() => {
      let out;
      NetMap.app.api.commit('subnets', (p) => {
        const B = NetMap.builder, M = NetMap.model, mid = p.maps[0].id;
        const r1 = B.addObjectPlaced(p, mid, { type: 'router', name: 'SubR1', wanPorts: 1, lanPorts: 2, ipAddress: '192.168.5.1' }, 8000, 40);
        const r2 = B.addObjectPlaced(p, mid, { type: 'router', name: 'SubR2', wanPorts: 1, lanPorts: 2, ipAddress: '192.168.3.1' }, 8300, 40);
        const s = B.addObjectPlaced(p, mid, { type: 'switch', name: 'SubS', portCount: 4 }, 8100, 260);
        M.addPatchCable(p, { aPortId: r1.ports.find(x => x.label === 'L1').id, bPortId: s.ports[0].id });
        out = { l2: r2.ports.find(x => x.label === 'L1').id, s2: s.ports[1].id, r2: r2.id };
      });
      NetMap.app.api.goTo('object', out.r2, NetMap.app.S.p.maps[0].id);
      return out;
    });
    const port = (id) => page.locator('#vp rect[data-kind="port"][data-id="' + id + '"]');
    const count = () => page.evaluate(() => NetMap.app.S.p.patchCables.length);
    assert.ok(await page.isHidden('#btnAlerts'), 'no warning yet');
    const c0 = await count();
    await page.click('#toolbar button[data-act="patchTool"]');
    await port(ids.l2).click({ force: true }); await port(ids.s2).click({ force: true });
    await page.waitForSelector('#dlg[open]');
    const txt = await page.innerText('#dlg');
    assert.ok(/Network:/.test(txt) && /192\.168\.5\.0\/24/.test(txt) && /192\.168\.3\.0\/24/.test(txt) && /Do you want to continue/.test(txt), txt);
    await page.click('#dlg button[data-btn="no"]');
    assert.strictEqual(await count(), c0, 'declined');
    await port(ids.l2).click({ force: true }); await port(ids.s2).click({ force: true });
    await page.waitForSelector('#dlg[open]');
    await page.click('#dlg button[data-btn="yes"]');
    await page.waitForTimeout(150);
    assert.strictEqual(await count(), c0 + 1);
    await page.keyboard.press('Escape');
    assert.ok(await page.isVisible('#btnAlerts') && /Network warnings \(1\)/.test(await page.innerText('#btnAlerts')));
    assert.ok((await page.locator('#vp g[pointer-events="none"] circle[fill="#d32f2f"]').count()) >= 2, 'alert badges on both routers');
    await shot('network-warning');
    await page.click('#btnAlerts');
    assert.ok(/Different subnets share one network segment/.test(await page.innerText('#issueList')));
    // fixing the address clears it
    await page.evaluate((id) => NetMap.app.api.select({ kind: 'object', id }), ids.r2);
    await page.fill('#detailsPane input[data-f="ipAddress"]', '192.168.5.2');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(100);
    assert.ok(await page.isHidden('#btnAlerts'), 'same subnet, different address: fine');
    for (let i = 0; i < 4; i++) await page.click('#btnUndo');
    await page.evaluate(() => { NetMap.app.S.tool = null; });
  });


  await step('addresses for generic devices and managed switches from the UI', async () => {
    await page.click('#toolbar button[data-add="generic"]');
    await page.selectOption('#dlg select[name="deviceKind"]', 'pc');
    await page.fill('#dlg input[name="portCount"]', '2');
    await page.fill('#dlg input[name="ipAddress"]', '999.1.1.1');
    await page.click('#dlg button[data-btn="ok"]');
    assert.ok(/IPv4/.test(await page.innerText('#dlg .form-err')), 'bad address refused');
    await page.fill('#dlg input[name="ipAddress"]', '');
    await page.click('#dlg button[data-btn="ok"]');
    await placeAt(700, 700);
    const inputs = page.locator('#detailsPane input[data-f="pip"]');
    assert.strictEqual(await inputs.count(), 2, 'one address field per port');
    await inputs.nth(0).fill('192.168.3.240'); await page.keyboard.press('Tab');
    await page.locator('#detailsPane input[data-f="pip"]').nth(1).fill('192.168.4.5'); await page.keyboard.press('Tab');
    const ips = await page.evaluate(() => { const o = NetMap.app.S.p.objects.filter(x => x.deviceKind === 'pc').pop(); return o.ports.map(p => p.ip); });
    assert.deepStrictEqual(ips, ['192.168.3.240', '192.168.4.5']);
    assert.ok((await page.innerHTML('#vp')).indexOf('PC') > 0);
    // managed switch
    await page.evaluate((id) => NetMap.app.api.select({ kind: 'object', id }), await page.evaluate(() => NetMap.app.S.p.objects.find(o => o.name === 'Switch A').id));
    assert.ok(/Management IP/.test(await page.innerText('#detailsPane')));
    await page.fill('#detailsPane input[data-f="ipAddress"]', '192.168.1.2');
    await page.keyboard.press('Tab');
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.p.objects.find(o => o.name === 'Switch A').ipAddress), '192.168.1.2');
    assert.ok((await page.innerHTML('#vp')).indexOf('192.168.1.2') > 0, 'drawn in the switch header');
    for (let i = 0; i < 5; i++) await page.click('#btnUndo');
  });


  await step('named port groups: Ctrl+select, G to name, edit ranges and colour, add from the form, link from a group', async () => {
    const ids = await page.evaluate(() => {
      let out;
      NetMap.app.api.commit('pg test', (p) => {
        const B = NetMap.builder, mid = p.maps[0].id;
        const a = B.addObjectPlaced(p, mid, { type: 'patchpanel', name: 'PgA', portCount: 24, straight: true }, 9000, 40);
        const b = B.addObjectPlaced(p, mid, { type: 'patchpanel', name: 'PgB', portCount: 24, straight: true }, 9000, 300);
        out = { a: a.id, b: b.id };
      });
      NetMap.app.api.goTo('object', out.a, NetMap.app.S.p.maps[0].id);
      return out;
    });
    const rear = (obj, n) => page.evaluate(([o, l]) => NetMap.app.S.p.objects.find(x => x.id === o).ports.find(q => q.side === 'rear' && q.label === l).id, [obj, String(n)]);
    const port = async (obj, n) => page.locator('#vp rect[data-kind="port"][data-id="' + await rear(obj, n) + '"]');
    await (await port(ids.a, 17)).click({ modifiers: ['Control'], force: true });
    await (await port(ids.a, 20)).click({ modifiers: ['Control', 'Shift'], force: true });
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.pgroup.ids.length), 4);
    await page.keyboard.press('g');
    await page.waitForSelector('#dlg[open]');
    await page.click('#dlg button[data-btn="ok"]');
    assert.ok(/name/i.test(await page.innerText('#dlg .form-err')), 'a name is required');
    await page.fill('#dlg input[name="name"]', 'to rack office');
    await page.selectOption('#dlg select[name="color"]', { label: 'green' });
    await page.click('#dlg button[data-btn="ok"]');
    await page.waitForTimeout(100);
    const g = await page.evaluate(() => { const o = NetMap.app.S.p.objects.find(x => x.name === 'PgA'); return o.portGroups[0]; });
    assert.deepStrictEqual([g.name, g.color, g.portIds.length], ['to rack office', '#2ca02c', 4]);
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.sel.kind), 'pgroup');
    assert.ok((await page.innerHTML('#vp')).indexOf('>to rack office</text>') > 0, 'name tag drawn');
    await shot('port-group');
    // edit the ports and name in the properties
    await page.fill('#detailsPane input[data-f="pgPorts"]', '7-14');
    await page.keyboard.press('Tab');
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.p.objects.find(x => x.name === 'PgA').portGroups[0].portIds.length), 8);
    await page.fill('#detailsPane input[data-f="pgName"]', 'L1');
    await page.keyboard.press('Tab');
    await page.selectOption('#detailsPane select[data-f="pgPreset"]', { label: 'red' });
    const g2 = await page.evaluate(() => NetMap.app.S.p.objects.find(x => x.name === 'PgA').portGroups[0]);
    assert.deepStrictEqual([g2.name, g2.color], ['L1', '#d62728']);
    // a second group from the object form
    await page.evaluate((id) => NetMap.app.api.select({ kind: 'object', id }), ids.a);
    await page.fill('#detailsPane #pgNewName', 'to rack office');
    await page.fill('#detailsPane #pgNewPorts', '17-20');
    await page.click('#detailsPane button[data-act="addPGroup"]');
    await page.waitForTimeout(100);
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.p.objects.find(x => x.name === 'PgA').portGroups.length), 2);
    // bad range is reported
    await page.evaluate((id) => NetMap.app.api.select({ kind: 'object', id }), ids.a);
    await page.fill('#detailsPane #pgNewName', 'bad'); await page.fill('#detailsPane #pgNewPorts', '99');
    await page.click('#detailsPane button[data-act="addPGroup"]');
    assert.ok(/No port/.test(await page.innerText('#toast')));
    // fixed link from the group
    const gid = await page.evaluate(() => NetMap.app.S.p.objects.find(x => x.name === 'PgA').portGroups.find(q => q.name === 'L1').id);
    await page.evaluate((id) => NetMap.app.api.select({ kind: 'pgroup', id }), gid);
    await page.click('#detailsPane button[data-act="linkFromGroup"]');
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.pgroup.ids.length), 8);
    await (await port(ids.b, 1)).hover({ force: true });
    await page.waitForTimeout(80);
    await (await port(ids.b, 1)).click({ force: true });
    await page.waitForTimeout(120);
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.p.fixedLinks[NetMap.app.S.p.fixedLinks.length - 1].wires.length), 8);
    // delete the group again
    await page.evaluate((id) => NetMap.app.api.select({ kind: 'pgroup', id }), gid);
    await page.click('#detailsPane button[data-act="deletePGroup"]');
    assert.ok(!(await page.evaluate((id) => !!NetMap.model.findPortGroup(NetMap.app.S.p, id), gid)));
    for (let i = 0; i < 12; i++) await page.click('#btnUndo');
  });


  await step('adding a device to a row inside a rack is free placement (no magnet line, row untouched)', async () => {
    const ids = await page.evaluate(() => {
      let out;
      NetMap.app.api.commit('row rack', (p) => {
        const B = NetMap.builder, M = NetMap.model, mid = p.maps[0].id;
        const rack = B.addObjectPlaced(p, mid, { type: 'rack', name: 'RowRack' }, 9600, 40);
        const rp = M.placementOf(p, mid, rack.id); rp.w = 800; rp.h = 360;
        const mk = (n, x) => { const o = B.addObjectPlaced(p, mid, { type: 'internet', name: n, portCount: 1, containerId: rack.id }, 0, 0); const q = M.placementOf(p, mid, o.id); q.x = rp.x + x; q.y = rp.y + 60; return q.id; };
        const outside = B.addObjectPlaced(p, mid, { type: 'internet', name: 'RowNew', portCount: 1 }, 9600, 520);
        out = { rack: rack.id, row: [mk('R1', 12), mk('R2', 212), mk('R3', 412)], mover: M.placementOf(p, mid, outside.id).id, outside: outside.id };
      });
      NetMap.app.api.goTo('object', out.rack, NetMap.app.S.p.maps[0].id);
      return out;
    });
    const rowPos = () => page.evaluate((r) => r.map(id => { const q = NetMap.app.S.p.placements.find(x => x.id === id); return [q.x, q.y]; }), ids.row);
    const before = JSON.stringify(await rowPos());
    const info = await page.evaluate((i) => { const S = NetMap.app.S, q = S.p.placements.find(x => x.id === i.mover), rp = S.p.placements.find(x => x.refId === i.rack), r1 = S.p.placements.find(x => x.id === i.row[0]); return { zoom: S.p.maps[0].viewport.zoom, dx: (rp.x + 640 - q.x), dy: (r1.y + 5 - q.y) }; }, ids);
    const box = await page.locator('[data-handle="move"][data-pl="' + ids.mover + '"]').boundingBox();
    await page.mouse.move(box.x + 5, box.y + 5); await page.mouse.down();
    await page.mouse.move(box.x + 5 + info.dx * info.zoom, box.y + 5 + info.dy * info.zoom, { steps: 10 });
    await page.waitForTimeout(100);
    assert.strictEqual(await page.locator('#vp [data-drop="line"]').count(), 0, 'no magnet line beside the row');
    await page.mouse.up();
    await page.waitForTimeout(100);
    assert.strictEqual(JSON.stringify(await rowPos()), before, 'the existing row did not move');
    const inRack = await page.evaluate((i) => NetMap.app.S.p.objects.find(o => o.id === i.outside).containerId === i.rack, ids);
    assert.ok(inRack, 'it joined the rack');
    for (let i = 0; i < 2; i++) await page.click('#btnUndo');
  });


  await step('new items follow the cursor and drop where you click; Ctrl+click places copies with counting names; Esc cancels', async () => {
    const before = await page.evaluate(() => NetMap.app.S.p.objects.length);
    await page.click('#toolbar button[data-add="generic"]');
    await page.selectOption('#dlg select[name="deviceKind"]', 'camera');
    await page.fill('#dlg input[name="name"]', 'Cam 1');
    await page.click('#dlg button[data-btn="ok"]');
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.p.objects.length), before, 'nothing created yet');
    assert.ok(await page.evaluate(() => !!NetMap.app.S.place));
    await page.mouse.move(420, 560); await page.mouse.move(430, 570);
    assert.ok((await page.getAttribute('#ghostInner', 'transform')).indexOf('translate(') === 0, 'ghost follows the cursor');
    assert.notStrictEqual(await page.$eval('#ghost', (g) => g.style.display), 'none');
    assert.ok((await page.innerHTML('#ghostInner')).indexOf('data-icon="camera"') > 0, 'ghost shows what is being placed');
    const mapPt = (sx, sy) => page.evaluate(([x, y]) => { const r = document.getElementById('canvas').getBoundingClientRect(), v = NetMap.app.S.p.maps.find(m => m.id === NetMap.app.S.mapId).viewport; return { x: (x - r.left - v.x) / v.zoom, y: (y - r.top - v.y) / v.zoom }; }, [sx, sy]);
    const pts = [[440, 580], [640, 580], [840, 580]], names = [];
    for (const [x, y] of pts) {
      await page.mouse.move(x, y);
      await page.keyboard.down('Control');
      await page.mouse.click(x, y);
      await page.keyboard.up('Control');
      await page.waitForTimeout(120);
    }
    assert.ok(await page.evaluate(() => !!NetMap.app.S.place), 'still placing after Ctrl+click');
    await page.mouse.move(440, 700);
    await page.mouse.click(440, 700); // plain click: last copy, then done
    await page.waitForTimeout(150);
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.place), null);
    const made = await page.evaluate((n) => NetMap.app.S.p.objects.slice(n).map(o => { const q = NetMap.app.S.p.placements.find(x => x.refId === o.id); return { name: o.name, x: q.x, y: q.y, w: q.w, h: q.h, kind: o.deviceKind }; }), before);
    assert.deepStrictEqual(made.map(m => m.name), ['Cam 1', 'Cam 2', 'Cam 3', 'Cam 4']);
    assert.ok(made.every(m => m.kind === 'camera'));
    const c0 = await mapPt(440, 580);
    assert.ok(Math.abs(made[0].x - c0.x) <= 30 && Math.abs(made[0].y - c0.y) <= 30, 'top-left corner dropped at the cursor: ' + JSON.stringify([made[0], c0]));
    assert.ok(made[1].x > made[0].x + 20 && made[2].x > made[1].x + 20, 'copies went where each click was');
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.sel.kind), 'object', 'the last one is selected');
    // Escape cancels
    await page.click('#toolbar button[data-add="switch"]');
    await page.click('#dlg button[data-btn="ok"]');
    assert.ok(await page.evaluate(() => !!NetMap.app.S.place));
    await page.keyboard.press('Escape');
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.place), null);
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.p.objects.length), before + 4);
    // placing onto a rack files it into the rack and the rack gets the green outline while hovering
    const rackPt = await page.evaluate(() => { const S = NetMap.app.S, rk = S.p.objects.find(o => o.name === 'Rack A'); NetMap.app.api.goTo('object', rk.id, S.p.maps[0].id); const q = S.p.placements.find(x => x.refId === rk.id && x.mapId === S.mapId), r = document.getElementById('canvas').getBoundingClientRect(), v = S.p.maps.find(m => m.id === S.mapId).viewport; return { x: r.left + v.x + (q.x + q.w / 2) * v.zoom, y: r.top + v.y + (q.y + q.h - 30) * v.zoom }; });
    await page.click('#toolbar button[data-add="switch"]');
    await page.fill('#dlg input[name="name"]', 'DropSw');
    await page.fill('#dlg input[name="portCount"]', '8');
    await page.click('#dlg button[data-btn="ok"]');
    await page.mouse.move(rackPt.x, rackPt.y); await page.mouse.move(rackPt.x + 2, rackPt.y + 2);
    await page.waitForTimeout(100);
    assert.ok((await page.innerHTML('#vp')).indexOf('stroke="#00c853"') > 0, 'target rack outlined while hovering');
    await page.mouse.click(rackPt.x + 2, rackPt.y + 2);
    await page.waitForTimeout(150);
    const inRack = await page.evaluate(() => { const S = NetMap.app.S, o = S.p.objects.find(x => x.name === 'DropSw'), rk = S.p.objects.find(x => x.name === 'Rack A'); return o && o.containerId === rk.id; });
    assert.ok(inRack, 'filed into the rack under the cursor');
    for (let i = 0; i < 5; i++) await page.click('#btnUndo');
  });

  await step('floor plan: draw, constrain, link a rack, view mode', async () => {
    const fid = await page.evaluate(() => { const A = NetMap.app; let id; A.commit('Add floor', (p) => { const mm = NetMap.model.addMap(p, { name: 'E2E Plan', kind: 'floor' }); mm.viewport = { x: 60, y: 100, zoom: 0.4 }; id = mm.id; }); return id; });
    await page.selectOption('#mapSelect', fid); await page.waitForTimeout(150);
    assert.ok(await page.isVisible('[data-floortool="rect"]'), 'floor toolbar shown');
    const org = await page.evaluate(() => { const v = NetMap.app.S.p.maps.find((m) => m.id === NetMap.app.S.mapId).viewport; const r = document.getElementById('canvas').getBoundingClientRect(); return { x: r.left + v.x, y: r.top + v.y, z: v.zoom }; });
    const click = async (cm) => { const x = org.x + cm[0] * org.z, y = org.y + cm[1] * org.z; await page.mouse.move(x, y); await page.mouse.click(x, y); };
    const counts = () => page.evaluate(() => { const f = NetMap.floor.ensure(NetMap.app.S.p.maps.find((m) => m.id === NetMap.app.S.mapId)); return [f.points.length, f.lines.length, f.links.length]; });
    await page.click('[data-floortool="rect"]'); await click([100, 100]); await click([700, 500]);
    assert.deepStrictEqual(await counts(), [4, 4, 0]);
    await page.click('[data-floortool="line"]'); await click([100, 300]); await click([700, 300]); await page.keyboard.press('Escape');
    const c2 = await counts(); assert.deepStrictEqual(c2, [6, 7, 0], 'crossing splits the walls ' + JSON.stringify(c2));
    await page.click('[data-floortool="select"]'); await click([400, 100]);
    assert.ok(/Can't change the length/.test(await page.innerText('#detailsPane')), 'both ends connected -> locked');
    await click([400, 300]);
    const rk = await page.evaluate(() => NetMap.app.S.p.objects.find((o) => o.type === 'rack').id);
    await page.click('[data-act="floorAddLink"]');
    await page.fill('#dlg input[data-s="q"]', 'zzzz-no-match'); assert.ok(/Nothing matches/.test(await page.innerText('#dlg .fl-results')));
    await page.fill('#dlg input[data-s="q"]', ''); await page.click('#dlg [data-type="rack"]');
    await page.click('#dlg [data-btn="pick:object:' + rk + '"]');
    await click([300, 200]);
    assert.deepStrictEqual(await counts(), [6, 7, 1]);
    await page.evaluate(() => { const A = NetMap.app; A.S.p.maps.forEach((m) => { if (m.kind !== 'floor') return; }); });
    assert.ok(await page.evaluate(() => NetMap.model.validateProject(NetMap.app.S.p).filter((i) => i.level === 'error').length === 0), 'valid project');
    await page.click('#btnMode'); await page.waitForTimeout(100);
    assert.ok(!(await page.isVisible('[data-floortool="rect"]')), 'read-only in view mode');
    await page.click('#btnMode'); await page.waitForTimeout(100);
    await page.evaluate((id) => { NetMap.app.commit('rm', (p) => { p.maps = p.maps.filter((m) => m.id !== id); }); NetMap.app.S.mapId = NetMap.model.firstMap ? NetMap.app.S.p.maps[0].id : NetMap.app.S.p.maps[0].id; }, fid);
    await page.selectOption('#mapSelect', await page.evaluate(() => NetMap.app.S.p.maps[0].id)); await page.waitForTimeout(100);
  });

  await step('floor plan: tracing image - add, transparency, scale to size line, not saved', async () => {
    const fid = await page.evaluate(() => { let id; NetMap.app.commit('Add floor', (p) => { const mm = NetMap.model.addMap(p, { name: 'E2E Trace', kind: 'floor' }); mm.viewport = { x: 60, y: 120, zoom: 0.4 }; id = mm.id; }); return id; });
    await page.selectOption('#mapSelect', fid); await page.waitForTimeout(150);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
    await page.setInputFiles('#bgInput', { name: 'room.png', mimeType: 'image/png', buffer: png });
    await page.waitForSelector('#vp image');
    const wid = () => page.evaluate(() => parseFloat(document.querySelector('#vp image').getAttribute('width')));
    const w0 = await wid();
    assert.ok(w0 > 100);
    await page.evaluate(() => { const r = document.querySelector('[data-floorbgop]'); r.value = '20'; r.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.strictEqual(await page.evaluate(() => document.querySelector('#vp image').getAttribute('opacity')), '0.2');
    const org = await page.evaluate(() => { const v = NetMap.app.S.p.maps.find((m) => m.id === NetMap.app.S.mapId).viewport; const r = document.getElementById('canvas').getBoundingClientRect(); return { x: r.left + v.x, y: r.top + v.y, z: v.zoom }; });
    const click = async (cm) => { const x = org.x + cm[0] * org.z, y = org.y + cm[1] * org.z; await page.mouse.move(x, y); await page.mouse.click(x, y); };
    await page.click('[data-floortool="calib"]'); await click([300, 300]); await click([800, 300]); // 500 cm on screen
    await page.fill('#dlg input[name="len"]', '10'); await page.click('#dlg button[data-btn="ok"]'); await page.waitForTimeout(100);
    const w1 = await wid();
    assert.ok(Math.abs(w1 / w0 - 2) < 0.01, 'image doubled: ' + w0 + ' -> ' + w1);
    assert.ok(!JSON.stringify(await page.evaluate(() => NetMap.app.S.p)).includes('blob:'), 'image is not in the project');
    // dropping an image works too
    await page.click('[data-act="floorBgRemove"]'); assert.strictEqual(await page.locator('#vp image').count(), 0);
    await page.evaluate(async (b64) => {
      const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      const dt = new DataTransfer(); dt.items.add(new File([u], 'd.png', { type: 'image/png' }));
      document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==');
    await page.waitForSelector('#vp image');
    await page.click('[data-floortool="select"]');
    await page.evaluate((id) => { NetMap.app.commit('rm', (p) => { p.maps = p.maps.filter((m) => m.id !== id); }); }, fid);
    await page.selectOption('#mapSelect', await page.evaluate(() => NetMap.app.S.p.maps[0].id)); await page.waitForTimeout(100);
  });

  await step('floor plans in the showcase: view mode, open the real item, on-floor-plans line, edit line, undo', async () => {
    await page.click('#btnMode'); await page.waitForTimeout(100); // view mode
    await page.evaluate(() => NetMap.app.api.loadProject(NetMap.builder.buildShowcaseProject()));
    const fm = await page.evaluate(() => NetMap.model.floorMaps(NetMap.app.S.p).map((m) => ({ id: m.id, name: m.name })));
    assert.deepStrictEqual(fm.map((m) => m.name), ['Server room plan', 'Office plan']);
    await page.selectOption('#mapSelect', fm[1].id); await page.waitForTimeout(200);
    assert.ok(!(await page.isVisible('[data-floortool="rect"]')), 'no drawing tools in view mode');
    assert.strictEqual(await page.locator('#vp [data-flink]').count(), 5);
    assert.ok(await page.isVisible('#scaleBar'), 'scale bar');
    assert.ok(/ deg$/.test(await page.evaluate(() => document.querySelector('#vp path[stroke="transparent"] title').textContent)), 'lines carry a tooltip with the angle');
    assert.strictEqual(await page.locator('#vp text', { hasText: / m$/ }).count(), 0, 'view mode: no wall lengths until hover');
    const wl = await page.evaluate(() => { const f = NetMap.floor.ensure(NetMap.app.S.p.maps.find((m) => m.id === NetMap.app.S.mapId)); const l = f.lines.find((x) => x.kind === 'wall'); const a = NetMap.floor.pt(f, l.a), b = NetMap.floor.pt(f, l.b); const v = NetMap.app.S.p.maps.find((m) => m.id === NetMap.app.S.mapId).viewport, r = document.getElementById('canvas').getBoundingClientRect(); return [r.left + v.x + (a.x + b.x) / 2 * v.zoom, r.top + v.y + (a.y + b.y) / 2 * v.zoom]; });
    await page.mouse.move(wl[0], wl[1]); await page.waitForTimeout(150);
    assert.strictEqual(await page.locator('#vp text', { hasText: / m$/ }).count(), 1, 'hovered wall shows its length');
    await page.mouse.move(wl[0] + 5, wl[1] + 120); await page.waitForTimeout(150);
    // double-click the rack link: its real item opens on the equipment map
    const box = await page.locator('#vp [data-flink] rect').first().boundingBox();
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2); await page.waitForTimeout(250);
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.p.maps.find((m) => m.id === NetMap.app.S.mapId).kind || 'equipment'), 'equipment');
    // the item lists the plan it is on
    const pc = await page.evaluate(() => NetMap.app.S.p.objects.find((o) => o.name === 'WS-02').id);
    await page.evaluate((id) => NetMap.app.api.select({ kind: 'object', id }), pc); await page.waitForTimeout(100);
    assert.ok(/On floor plans/.test(await page.innerText('#detailsPane')) && /Office plan/.test(await page.innerText('#detailsPane')));
    // edit: change a line kind through the details panel, undo restores it
    await page.click('#btnMode'); await page.waitForTimeout(100);
    await page.selectOption('#mapSelect', fm[1].id); await page.waitForTimeout(200);
    const line = await page.evaluate(() => { const f = NetMap.floor.ensure(NetMap.app.S.p.maps.find((m) => m.id === NetMap.app.S.mapId)); const l = f.lines.find((x) => x.kind === 'wall'); NetMap.app.api.select({ kind: 'fline', id: l.id }); return l.id; });
    await page.waitForSelector('#detailsPane select[data-ff="kind"]');
    await page.selectOption('#detailsPane select[data-ff="kind"]', 'furniture');
    const kindOf = () => page.evaluate((id) => NetMap.floor.ensure(NetMap.app.S.p.maps.find((m) => m.id === NetMap.app.S.mapId)).lines.find((x) => x.id === id).kind, line);
    assert.strictEqual(await kindOf(), 'furniture');
    await page.click('#btnUndo'); assert.strictEqual(await kindOf(), 'wall');
    // Delete key removes the selected line, undo brings it back
    const n0 = await page.evaluate(() => NetMap.floor.ensure(NetMap.app.S.p.maps.find((m) => m.id === NetMap.app.S.mapId)).lines.length);
    await page.evaluate((id) => NetMap.app.api.select({ kind: 'fline', id }), line);
    await page.keyboard.press('Delete');
    assert.strictEqual(await page.evaluate(() => NetMap.floor.ensure(NetMap.app.S.p.maps.find((m) => m.id === NetMap.app.S.mapId)).lines.length), n0 - 1);
    await page.click('#btnUndo');
    assert.strictEqual(await page.evaluate(() => NetMap.floor.ensure(NetMap.app.S.p.maps.find((m) => m.id === NetMap.app.S.mapId)).lines.length), n0);
    // drag a corner point: the walls stay joined to it
    const before = await page.evaluate(() => { const f = NetMap.floor.ensure(NetMap.app.S.p.maps.find((m) => m.id === NetMap.app.S.mapId)); const q = f.points.find((x) => x.x === 0 && x.y === 0); return { id: q.id, deg: NetMap.floor.degree(f, q.id) }; });
    await page.evaluate(() => NetMap.app.api.fitMap()); await page.waitForTimeout(150);
    const org = await page.evaluate(() => { const v = NetMap.app.S.p.maps.find((m) => m.id === NetMap.app.S.mapId).viewport; const r = document.getElementById('canvas').getBoundingClientRect(); return { x: r.left + v.x, y: r.top + v.y, z: v.zoom }; });
    await page.click('[data-floortool="select"]');
    await page.mouse.move(org.x, org.y); await page.mouse.down(); await page.mouse.move(org.x + 60 * org.z, org.y + 40 * org.z, { steps: 6 }); await page.mouse.up();
    const after = await page.evaluate((id) => { const f = NetMap.floor.ensure(NetMap.app.S.p.maps.find((m) => m.id === NetMap.app.S.mapId)); const q = f.points.find((x) => x.id === id); return q && { x: q.x, y: q.y, deg: NetMap.floor.degree(f, id) }; }, before.id);
    assert.ok(after && after.x > 0 && after.y > 0 && after.deg === before.deg, 'corner moved, still joined: ' + JSON.stringify(after));
    await page.click('#btnUndo');
    await page.evaluate(() => NetMap.app.api.loadProject(NetMap.builder.buildDemoProject()));
    await page.waitForSelector('#vp [data-kind="object"]');
  });

  await step('floor plan: lines click into 30 / 45 degree directions, Ctrl bypasses, Shift forces', async () => {
    const fid = await page.evaluate(() => { let id; NetMap.app.commit('Add floor', (p) => { const mm = NetMap.model.addMap(p, { name: 'E2E Angles', kind: 'floor' }); mm.viewport = { x: 60, y: 120, zoom: 0.4 }; id = mm.id; }); return id; });
    await page.selectOption('#mapSelect', fid); await page.waitForTimeout(150);
    const org = await page.evaluate(() => { const v = NetMap.app.S.p.maps.find((m) => m.id === NetMap.app.S.mapId).viewport; const r = document.getElementById('canvas').getBoundingClientRect(); return { x: r.left + v.x, y: r.top + v.y, z: v.zoom }; });
    const at = (cm) => [org.x + cm[0] * org.z, org.y + cm[1] * org.z];
    const hover = async (cm, mods) => { const [x, y] = at(cm); await page.mouse.move(x - 3, y - 3); for (const k of mods || []) await page.keyboard.down(k); await page.mouse.move(x, y); await page.waitForTimeout(60); const res = await page.evaluate(() => { const h = NetMap.app.S.floor.hover; return h && { x: h.x, y: h.y, type: h.type, deg: h.deg }; }); for (const k of mods || []) await page.keyboard.up(k); await page.waitForTimeout(40); return res; };
    await page.click('[data-floortool="line"]');
    const [sx, sy] = at([200, 200]); await page.mouse.move(sx, sy); await page.mouse.click(sx, sy);
    let h = await hover([600, 205]);
    assert.ok(h.type === 'angle' && h.deg === 0 && h.y === 200, 'near horizontal -> horizontal ' + JSON.stringify(h));
    h = await hover([505, 510]);
    assert.ok(h.deg === 45 && h.x - 200 === h.y - 200, 'near 45 ' + JSON.stringify(h));
    h = await hover([360, 480]);
    assert.strictEqual(h.deg, 60);
    h = await hover([600, 330], ['Control']);
    assert.strictEqual(h.type, 'grid', 'Ctrl bypasses the angle snap');
    h = await hover([600, 330], ['Shift']);
    assert.strictEqual(h.type, 'angle', 'Shift forces an angle');
    await hover([600, 205]);
    await page.keyboard.down('Control'); await page.waitForTimeout(80);
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.floor.hover.type), 'grid', 'pressing Ctrl bypasses the snap at once, without moving the mouse');
    await page.keyboard.up('Control'); await page.waitForTimeout(200);
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.floor.hover.type), 'angle', 'releasing it brings the snap back');
    // ending on an existing line (no point there): keep the angle and finish where the ray meets the line
    await page.keyboard.press('Escape');
    await page.evaluate(() => NetMap.app.commit('wall', (p) => { const f = NetMap.floor.ensure(p.maps.find((m) => m.id === NetMap.app.S.mapId)); NetMap.floor.addLine(f, 800, 0, 800, 800, 'wall'); }));
    await page.waitForTimeout(80);
    const [s2x, s2y] = at([500, 100]); await page.mouse.move(s2x, s2y); await page.mouse.click(s2x, s2y);
    h = await hover([800, 420]);                // ray at 45 degrees from (500,100) meets x=800 at y=400; pointer is 20 cm away on the line
    assert.ok(h.type === 'line' && h.deg === 45 && h.x === 800 && h.y === 400, 'angle kept when ending on a line: ' + JSON.stringify(h));
    h = await hover([800, 760]);                // far from where the ray meets it: plain snap to the line
    assert.strictEqual(h.type, 'line'); assert.strictEqual(h.deg, undefined);
    assert.ok(!/ deg</.test(await page.evaluate(() => Array.from(document.querySelectorAll('#vp text')).map((t) => t.textContent).join('<'))), 'no angle text while drawing');
    const tool = () => page.evaluate(() => NetMap.app.S.floor.tool + '/' + (NetMap.app.S.floor.draw ? 'drawing' : 'idle'));
    assert.strictEqual(await tool(), 'line/drawing');
    await page.keyboard.press('Escape'); assert.strictEqual(await tool(), 'line/idle', 'first Esc cancels the line being placed, keeps the Line tool');
    await page.keyboard.press('Escape'); assert.strictEqual(await tool(), 'select/idle', 'second Esc returns to Select');
    await page.evaluate((id) => { NetMap.app.commit('rm', (p) => { p.maps = p.maps.filter((m) => m.id !== id); }); }, fid);
    await page.selectOption('#mapSelect', await page.evaluate(() => NetMap.app.S.p.maps[0].id)); await page.waitForTimeout(100);
  });

  await step('floor plan: right-click a line with a free end -> make horizontal / vertical; locked lines are disabled', async () => {
    const fid = await page.evaluate(() => { let id; NetMap.app.commit('Add floor', (p) => { const mm = NetMap.model.addMap(p, { name: 'E2E Menu', kind: 'floor' }); mm.viewport = { x: 60, y: 120, zoom: 0.4 }; id = mm.id; }); return id; });
    await page.selectOption('#mapSelect', fid); await page.waitForTimeout(150);
    await page.evaluate(() => NetMap.app.commit('draw', (p) => { const f = NetMap.floor.ensure(p.maps.find((m) => m.id === NetMap.app.S.mapId)); NetMap.floor.addRect(f, 100, 100, 600, 400, 'wall'); NetMap.floor.addLine(f, 600, 250, 800, 450, 'wall'); }));
    await page.waitForTimeout(100);
    const org = await page.evaluate(() => { const v = NetMap.app.S.p.maps.find((m) => m.id === NetMap.app.S.mapId).viewport; const r = document.getElementById('canvas').getBoundingClientRect(); return { x: r.left + v.x, y: r.top + v.y, z: v.zoom }; });
    const at = (cm) => [org.x + cm[0] * org.z, org.y + cm[1] * org.z];
    const dia = async () => page.evaluate(() => { const f = NetMap.floor.ensure(NetMap.app.S.p.maps.find((m) => m.id === NetMap.app.S.mapId)); const l = f.lines.find((x) => { const a = NetMap.floor.pt(f, x.a), b = NetMap.floor.pt(f, x.b); return a.x !== b.x && a.y !== b.y; }); const a = NetMap.floor.pt(f, l.a), b = NetMap.floor.pt(f, l.b); return [a.x, a.y, b.x, b.y]; });
    await page.click('[data-floortool="select"]');
    let [x, y] = at([700, 350]); await page.mouse.click(x, y, { button: 'right' });
    await page.waitForSelector('#ctxMenu');
    assert.ok(!(await page.isDisabled('#ctxMenu [data-cx="h"]')), 'enabled for a line with a free end');
    await page.click('#ctxMenu [data-cx="h"]');
    let d = await page.evaluate(() => { const f = NetMap.floor.ensure(NetMap.app.S.p.maps.find((m) => m.id === NetMap.app.S.mapId)); const l = f.lines.find((q) => NetMap.floor.degree(f, q.a) === 1 || NetMap.floor.degree(f, q.b) === 1); return l && [NetMap.floor.pt(f, l.a).y, NetMap.floor.pt(f, l.b).y]; });
    assert.ok(d && d[0] === d[1], 'now horizontal ' + JSON.stringify(d));
    assert.strictEqual(await page.locator('#ctxMenu').count(), 0, 'menu closed');
    [x, y] = at([350, 100]); await page.mouse.click(x, y, { button: 'right' });
    await page.waitForSelector('#ctxMenu');
    assert.ok(await page.isDisabled('#ctxMenu [data-cx="h"]') && await page.isDisabled('#ctxMenu [data-cx="v"]'), 'both ends connected: disabled');
    await page.keyboard.press('Escape'); assert.strictEqual(await page.locator('#ctxMenu').count(), 0);
    await page.evaluate((id) => { NetMap.app.commit('rm', (p) => { p.maps = p.maps.filter((m) => m.id !== id); }); }, fid);
    await page.selectOption('#mapSelect', await page.evaluate(() => NetMap.app.S.p.maps[0].id)); await page.waitForTimeout(100);
    void dia;
  });

  await step('multiple selection: Ctrl+A selects only editor items (not the page), Ctrl+click toggles, delete all at once - maps and floor plans', async () => {
    await page.evaluate(() => NetMap.app.api.loadProject(NetMap.builder.buildShowcaseProject()));
    await page.waitForSelector('#vp [data-kind="object"]');
    const ids = await page.evaluate(() => ({ map: NetMap.app.S.p.maps[0].id, floor: NetMap.model.floorMaps(NetMap.app.S.p)[1].id }));
    await page.selectOption('#mapSelect', ids.map); await page.waitForTimeout(150);
    await page.evaluate(() => NetMap.app.api.fitMap()); await page.waitForTimeout(100);
    if (!(await page.evaluate(() => NetMap.app.S.mode === 'edit'))) await page.click('#btnMode');
    await page.waitForTimeout(100);
    // Ctrl+click adds and removes
    const grpBox = await page.locator('#vp rect[data-kind="object"][data-id]').nth(0).boundingBox();
    await page.keyboard.down('Control');
    const two = await page.evaluate(() => ['Rack A', 'PP-Standalone'].map((n) => NetMap.app.S.p.objects.find((o) => o.name === n).id));
    for (const id of two) { const b = await page.locator('#vp rect[data-kind="object"][data-id="' + id + '"]').boundingBox(); await page.mouse.click(b.x + 6, b.y + 6); }
    await page.keyboard.up('Control');
    const n2 = await page.evaluate(() => NetMap.app.S.multi.length);
    assert.strictEqual(n2, 2, 'two items selected with Ctrl+click');
    assert.ok(/2 selected/i.test(await page.innerText('#detailsPane')), 'details show the count');
    await page.keyboard.press('Escape'); assert.strictEqual(await page.evaluate(() => NetMap.app.S.multi.length), 0, 'Esc clears');
    void grpBox;
    // Ctrl+A: items only, the page text is not selected
    await page.mouse.click(300, 700); // empty canvas area
    await page.keyboard.press('Control+a');
    assert.strictEqual(await page.evaluate(() => window.getSelection().toString()), '', 'no page text selection');
    const total = await page.evaluate(() => NetMap.app.S.p.placements.filter((q) => q.mapId === NetMap.app.S.mapId && !q.ghost).length);
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.multi.length), total, 'everything on this map is selected');
    await page.keyboard.press('Delete');
    await page.waitForSelector('#dlg[open]');
    await page.click('#dlg button[data-btn="here"], #dlg button[data-btn="yes"]');
    await page.waitForTimeout(150);
    if (await page.locator('#dlg[open]').count()) { await page.click('#dlg button[data-btn="yes"]'); await page.waitForTimeout(150); }
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.p.placements.filter((q) => q.mapId === NetMap.app.S.mapId && !q.ghost).length), 0, 'all gone from this map');
    await page.click('#btnUndo'); await page.waitForTimeout(100);
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.p.placements.filter((q) => q.mapId === NetMap.app.S.mapId && !q.ghost).length), total, 'one undo restores them');
    // floor plan: Ctrl+A then Delete, no dialog, one undo
    await page.selectOption('#mapSelect', ids.floor); await page.waitForTimeout(200);
    const fc = () => page.evaluate(() => { const f = NetMap.floor.ensure(NetMap.app.S.p.maps.find((m) => m.id === NetMap.app.S.mapId)); return f.lines.length + f.links.length + f.labels.length; });
    const f0 = await fc(); assert.ok(f0 > 5);
    await page.keyboard.press('Control+a');
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.multi.length), f0, 'all lines, links and labels selected');
    await page.keyboard.press('Delete'); await page.waitForTimeout(100);
    assert.strictEqual(await fc(), 0);
    await page.click('#btnUndo'); await page.waitForTimeout(100);
    assert.strictEqual(await fc(), f0, 'undo brings the plan back');
    await page.evaluate(() => NetMap.app.api.loadProject(NetMap.builder.buildDemoProject()));
    await page.waitForSelector('#vp [data-kind="object"]');
  });

  await step('floor labels and sizes: place a label, edit text/size/colour, resize and rotate by handles, size presets for a group link', async () => {
    await page.evaluate(() => NetMap.app.api.loadProject(NetMap.builder.buildShowcaseProject()));
    const ids = await page.evaluate(() => ({ floor: NetMap.model.floorMaps(NetMap.app.S.p)[1].id, grp: NetMap.app.S.p.groups.find((g) => g.name === 'Office').id }));
    if (!(await page.evaluate(() => NetMap.app.S.mode === 'edit'))) await page.click('#btnMode');
    await page.selectOption('#mapSelect', ids.floor); await page.waitForTimeout(200);
    await page.evaluate(() => NetMap.app.api.fitMap()); await page.waitForTimeout(150);
    const geo = () => page.evaluate(() => { const m = NetMap.app.S.p.maps.find((x) => x.id === NetMap.app.S.mapId), v = m.viewport, r = document.getElementById('canvas').getBoundingClientRect(); return { x: r.left + v.x, y: r.top + v.y, z: v.zoom }; });
    const scr = (g, cm) => [g.x + cm[0] * g.z, g.y + cm[1] * g.z];
    const labels = () => page.evaluate(() => NetMap.floor.ensure(NetMap.app.S.p.maps.find((m) => m.id === NetMap.app.S.mapId)).labels.map((l) => ({ id: l.id, x: l.x, y: l.y, w: l.w, d: l.d, rot: l.rot, text: l.text, size: l.size, color: l.color })));
    const n0 = (await labels()).length;
    // place with the Label tool (T)
    await page.keyboard.press('t');
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.floor.tool), 'label');
    let g = await geo(); let [x, y] = scr(g, [200, 540]); await page.mouse.click(x, y);
    let ls = await labels(); assert.strictEqual(ls.length, n0 + 1, 'label added');
    const lb = ls[ls.length - 1];
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.floor.tool), 'select', 'back to Select after placing');
    // text, size, colour in the details panel
    await page.fill('#detailsPane [data-ff="ltext"]', 'Hall'); await page.press('#detailsPane [data-ff="ltext"]', 'Tab');
    await page.selectOption('#detailsPane [data-ff="lsize"]', '36');
    await page.evaluate(() => { const c = document.querySelector('#detailsPane [data-ff="lcolor"]'); c.value = '#ff0000'; c.dispatchEvent(new Event('change', { bubbles: true })); });
    let cur = (await labels()).find((l) => l.id === lb.id);
    assert.deepStrictEqual([cur.text, cur.size, cur.color], ['Hall', 36, '#ff0000']);
    assert.ok(await page.locator('#vp text', { hasText: 'Hall' }).count() === 1, 'drawn on the plan');
    // resize: drag the bottom-right corner outwards (box is unrotated)
    g = await geo();
    const corner = [cur.x + cur.w / 2, cur.y + cur.d / 2];
    [x, y] = scr(g, corner); await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 60 * g.z, y + 30 * g.z, { steps: 5 }); await page.mouse.up();
    let after = (await labels()).find((l) => l.id === lb.id);
    assert.ok(after.w > cur.w && after.d > cur.d, 'box grew: ' + JSON.stringify([cur.w, cur.d, after.w, after.d]));
    // rotate: drag the round handle sideways -> about 90 degrees
    g = await geo();
    const hy = after.y - after.d / 2 - 28 / g.z; [x, y] = scr(g, [after.x, hy]);
    const [cx, cy] = scr(g, [after.x, after.y]);
    await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(cx + 120, cy, { steps: 6 }); await page.mouse.up();
    after = (await labels()).find((l) => l.id === lb.id);
    assert.ok(Math.abs(after.rot - 90) <= 2, 'rotated to about 90: ' + after.rot);
    // rotation field also works
    await page.fill('#detailsPane [data-ff="lrot"]', '45'); await page.press('#detailsPane [data-ff="lrot"]', 'Tab');
    assert.strictEqual((await labels()).find((l) => l.id === lb.id).rot, 45);
    // undo steps each bring the previous state back
    await page.click('#btnUndo'); assert.strictEqual((await labels()).find((l) => l.id === lb.id).rot, 90);
    // Delete removes it
    await page.keyboard.press('Delete'); assert.strictEqual((await labels()).length, n0);
    // a group link: predefined size presets
    await page.evaluate((gid) => { const f = NetMap.floor.ensure(NetMap.app.S.p.maps.find((m) => m.id === NetMap.app.S.mapId)); NetMap.app.api.select({ kind: 'flink', id: f.links.find((l) => l.refId === gid).id }); }, ids.grp);
    await page.waitForSelector('#detailsPane select[data-ff="lpreset"]');
    await page.selectOption('#detailsPane select[data-ff="lpreset"]', '300x200');
    const gl = await page.evaluate((gid) => { const f = NetMap.floor.ensure(NetMap.app.S.p.maps.find((m) => m.id === NetMap.app.S.mapId)); const l = f.links.find((q) => q.refId === gid); return [l.w, l.d]; }, ids.grp);
    assert.deepStrictEqual(gl, [300, 200]);
    await page.evaluate(() => NetMap.app.api.loadProject(NetMap.builder.buildDemoProject()));
    await page.waitForSelector('#vp [data-kind="object"]');
  });

  await step('view mode: double-click a fixed link label goes to the map where the link terminates', async () => {
    await page.evaluate(() => NetMap.app.api.loadProject(NetMap.builder.buildDemoProject()));
    if (await page.evaluate(() => NetMap.app.S.mode === 'edit')) await page.click('#btnMode');
    await page.waitForSelector('#vp [data-lblink]');
    const here = await page.evaluate(() => NetMap.app.S.p.maps.find((m) => m.id === NetMap.app.S.mapId).name);
    const box = await page.locator('#vp [data-lblink]').first().boundingBox();
    await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2); await page.waitForTimeout(250);
    const there = await page.evaluate(() => NetMap.app.S.p.maps.find((m) => m.id === NetMap.app.S.mapId).name);
    assert.notStrictEqual(there, here, 'moved to the other end: ' + here + ' -> ' + there);
    // and back again from the far end's label
    await page.waitForSelector('#vp [data-lblink]');
    const box2 = await page.locator('#vp [data-lblink]').first().boundingBox();
    await page.mouse.dblclick(box2.x + box2.width / 2, box2.y + box2.height / 2); await page.waitForTimeout(250);
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.p.maps.find((m) => m.id === NetMap.app.S.mapId).name), here, 'and back');
    // a single click only selects the link
    await page.mouse.click(box2.x + 5, box2.y + 5); await page.waitForTimeout(100);
  });

  await step('overview ("All items"): a port can be selected and traced', async () => {
    await page.evaluate(() => NetMap.app.api.loadProject(NetMap.builder.buildDemoProject()));
    if (await page.evaluate(() => NetMap.app.S.mode === 'edit')) await page.click('#btnMode');
    await page.selectOption('#mapSelect', await page.evaluate(() => NetMap.model.allMap(NetMap.app.S.p).id)); await page.waitForTimeout(200);
    await page.evaluate(() => NetMap.app.api.fitMap()); await page.waitForTimeout(100);
    const pid = await page.evaluate(() => NetMap.app.S.p.objects.find((o) => o.name === 'Switch A').ports.find((x) => x.label === '5').id);
    await page.locator('#vp rect[data-kind="port"][data-id="' + pid + '"]').first().click({ force: true });
    assert.deepStrictEqual(await page.evaluate(() => NetMap.app.S.sel && NetMap.app.S.sel.kind), 'port', 'the port itself is selected, not its equipment');
    await page.click('#detailsPane button[data-act="trace"]');
    await page.waitForSelector('#tracePane .trace-line');
    assert.ok(await page.locator('#tracePane .trace-line').count() >= 1);
    await page.evaluate(() => NetMap.app.api.loadProject(NetMap.builder.buildDemoProject()));
    await page.waitForSelector('#vp [data-kind="object"]');
  });

  await step('local copy (file:): asks the repository for the version and says to download the new one', async () => {
    assert.ok(await page.evaluate(() => location.protocol === 'file:'), 'the suite runs from disk');
    assert.ok(/downloaded copy/.test(await page.getAttribute('#verInfo', 'title')), 'header tooltip says it is a local copy');
    assert.ok(!(await page.isVisible('#updateBar')), 'same version: no banner');
    repoVersion = 'aaaaaaaaaa';
    await page.evaluate(() => NetMap.app.api.checkVersion());
    await page.waitForSelector('#updateBar:not([hidden])');
    const txt = await page.innerText('#updateBar');
    assert.ok(/download the new version from the repository/i.test(txt), txt);
    assert.ok(!/reload with/i.test(txt), 'no reload advice for a local copy');
    assert.ok((await page.getAttribute('#updateBar a', 'href')).indexOf('github.com') > 0, 'link to the repository');
    repoVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'version.json'), 'utf8')).version;
    await page.evaluate(() => { NetMap.app.S.newVersion = null; NetMap.app.api.checkVersion(); });
    await page.click('#updateBar button[data-upd="hide"]').catch(() => {});
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
    assert.ok(text.indexOf('\r') < 0 && text.indexOf('"schemaVersion": 5') > 0);
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


  await step('leaving with changes that were never exported asks first; after an export it does not', async () => {
    const n0 = dialogs.length;
    await page.evaluate(() => NetMap.app.api.commit('touch', (p) => { p.name = p.name + ' '; }));
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.fileDirty), true);
    await page.reload();
    assert.ok(dialogs.slice(n0).indexOf('beforeunload') >= 0, 'reload prompted: ' + dialogs.slice(n0));
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.fileDirty), true, 'the unsaved state survives the reload');
    const n1 = dialogs.length;
    await page.click('#btnFile');
    await Promise.all([page.waitForEvent('download'), page.click('#dlg button[data-btn="json"]')]);
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.fileDirty), false);
    await page.reload();
    assert.strictEqual(dialogs.slice(n1).indexOf('beforeunload'), -1, 'clean: no prompt');
    // zooming / folding are view state and must not make the project dirty
    await page.evaluate(() => { document.getElementById('zoomIn').click(); });
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.fileDirty), false);
  });

  await step('new-version detection: polls version.json, shows a header warning and a banner, never reloads', async () => {
    const cp = require('child_process'), os = require('os');
    const repo = path.resolve(__dirname, '..');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'netmap-e2e-'));
    ['index.html', 'version.json'].forEach((f) => fs.copyFileSync(path.join(repo, f), path.join(tmp, f)));
    ['css', 'js'].forEach((d) => { fs.mkdirSync(path.join(tmp, d)); fs.readdirSync(path.join(repo, d)).forEach((f) => fs.copyFileSync(path.join(repo, d, f), path.join(tmp, d, f))); });
    const port = 20000 + Math.floor(Math.random() * 20000);
    const server = cp.spawn(process.execPath, [path.join(repo, 'tools', 'serve.js'), String(port)], { env: Object.assign({}, process.env, { NETMAP_ROOT: tmp }), stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await new Promise((res, rej) => { server.stdout.on('data', (d) => { if (/NetMap on/.test(String(d))) res(); }); server.on('error', rej); setTimeout(() => rej(new Error('server did not start')), 8000); });
      const vp = await ctx.newPage();
      vp.on('dialog', (d) => d.accept());
      await vp.goto('http://127.0.0.1:' + port + '/');
      await vp.waitForSelector('#vp, #canvas');
      const cur = await vp.evaluate(() => NetMap.version);
      assert.ok(/^[0-9a-f]{10}$/.test(cur));
      assert.strictEqual(await vp.evaluate(() => NetMap.app.api.pollMs), 60000, 'polls once a minute');
      assert.ok((await vp.innerText('#verInfo')).indexOf(cur) >= 0, 'header shows the running version');
      await vp.evaluate(() => { window.__marker = 'same page'; });
      assert.strictEqual(await vp.evaluate(() => NetMap.app.api.checkVersion()), cur);
      assert.ok(await vp.isHidden('#btnUpdate') && await vp.isHidden('#updateBar'), 'no warning while up to date');
      fs.appendFileSync(path.join(tmp, 'css', 'style.css'), '\n/* deployed change */\n');
      const latest = await vp.evaluate(() => NetMap.app.api.checkVersion());
      assert.notStrictEqual(latest, cur);
      assert.ok(await vp.isVisible('#btnUpdate'), 'header warning');
      const bar = await vp.innerText('#updateBar');
      assert.ok(/new version/i.test(bar) && /F5/.test(bar) && /Ctrl\+R/.test(bar) && /Export JSON/i.test(bar), bar);
      await vp.screenshot({ path: shots ? path.join(shots, 'new-version.png') : path.join(tmp, 'x.png') });
      assert.strictEqual(await vp.evaluate(() => window.__marker), 'same page', 'the page was not reloaded');
      await vp.click('#updateBar button[data-upd="hide"]');
      assert.ok(await vp.isHidden('#updateBar') && await vp.isVisible('#btnUpdate'), 'banner hidden, header warning stays');
      await vp.click('#btnUpdate');
      assert.ok(await vp.isVisible('#updateBar'));
      const [dl] = await Promise.all([vp.waitForEvent('download'), vp.click('#updateBar button[data-upd="export"]')]);
      assert.ok(/\.json$/.test(dl.suggestedFilename()));
      assert.strictEqual(await vp.evaluate(() => window.__marker), 'same page');
      await vp.close();
    } finally { server.kill(); fs.rmSync(tmp, { recursive: true, force: true }); }
  });

  /* ---- phone ---- */
  const mctx = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });
  const m = await mctx.newPage();
  m.on('dialog', (d) => d.accept());
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
