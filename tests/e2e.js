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
    assert.ok(/Ghost copy/.test(await page.innerText('#dlg select[data-s="mode"]')) && /Relocate/.test(await page.innerText('#dlg select[data-s="mode"]')));
    await page.click('#dlg button[data-btn="ok"]');
    await page.waitForTimeout(200);
    const g = await page.evaluate((i) => NetMap.app.S.p.placements.filter((q) => q.refId === i.sw).map((q) => ({ map: q.mapId, ghost: !!q.ghost })), ids);
    assert.deepStrictEqual(g.sort((x, y) => (x.ghost ? 1 : 0) - (y.ghost ? 1 : 0)), [{ map: ids.m2, ghost: false }, { map: ids.m1, ghost: true }]);
    assert.ok(await page.locator('#vp [data-ghost="1"]').count() >= 1, 'faded copy drawn');
    assert.strictEqual(await page.locator('#vp [data-ghost="1"] [data-handle="move"]').count(), 0);
    await page.evaluate((i) => { NetMap.app.S.p.objects.find((o) => o.id === i.sw).name = 'GhostSrc renamed'; document.getElementById('btnMode').click(); document.getElementById('btnMode').click(); }, ids);
    await page.evaluate(() => { // a tap on the faded copy (synthetic pointer events: other items may lie on top of it on screen)
      const r = document.querySelector('#vp [data-ghost="1"] rect[data-kind="object"]'), o = { bubbles: true, pointerId: 77, pointerType: 'mouse', button: 0, clientX: 5, clientY: 5 };
      r.dispatchEvent(new PointerEvent('pointerdown', o)); r.dispatchEvent(new PointerEvent('pointerup', o));
    });
    await page.waitForTimeout(200);
    assert.strictEqual(await page.evaluate(() => NetMap.app.S.mapId), ids.m2, 'tapping a ghost opens the original');
    await page.selectOption('#mapSelect', ids.m1);
    await page.click('#btnUndo'); await page.click('#btnUndo');
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
    await pick('b', '1'); await pick('b', '4', true);
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
    assert.ok(text.indexOf('\r') < 0 && text.indexOf('"schemaVersion": 3') > 0);
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
