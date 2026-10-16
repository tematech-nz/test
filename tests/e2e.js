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
