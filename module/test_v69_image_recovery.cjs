'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { LuaFactory } = require('./.local-tools/display-validation/node_modules/wasmoon');
const { openCharx } = require('./.local-tools/risuai-charx-toolkit/scripts/charx-io');
const { extractCharx } = require('./.local-tools/risuai-charx-toolkit/scripts/folder-io');
const { Browser, render, makeStored, prepareMarkup, resolveCss, displayProbe } = require('./.work/display_validation_helpers.cjs');
const { patchLua, source, artifact } = require('./build_v69_image_recovery.cjs');

const oldPath = path.join(__dirname, '라이트보드  삽화 4.1.0-soya-v67.module.charx');
const previous = openCharx(oldPath);
const release = openCharx(artifact);
const values = {
  'toggle_lb-xnai.scene.width': '600', 'toggle_lb-xnai.asset.width': '400',
  'toggle_lb-xnai.scene.ar': '5', 'toggle_lb-xnai.asset.ar': '0',
  'toggle_lb-xnai.kv.position': '0', 'toggle_lb-xnai.kv.ar': '5',
};
const restore = text => text.replaceAll('\uE700', '<').replaceAll('\uE701', '>');
const bump = value => JSON.parse(JSON.stringify(value).replaceAll('soya-v67', 'soya-v69'));

function auditArtifact() {
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(oldPath)).digest('hex'),
    'f8f37d7acc14aac3be4eac1916ed242cb7623e29ab289b7c4a0b98cfb9f94385');
  assert.equal(release.lua, patchLua(previous.lua));
  assert.deepEqual(release._card, bump(previous._card));
  const expected = bump(previous._moduleData);
  expected.module.trigger[0].effect[0].code = release.lua;
  assert.deepEqual(release._moduleData, expected);
  for (const key of ['assets', 'risumAssets', 'xMeta', 'css', 'defaultVariables'])
    assert.deepEqual(release[key], previous[key], `preserved ${key}`);
  const extracted = fs.mkdtempSync(path.join(__dirname, '.work/v69-roundtrip-'));
  extractCharx(artifact, extracted);
  for (const name of ['card.json', 'module.json', 'manifest.json'])
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(extracted, name), 'utf8')),
      JSON.parse(fs.readFileSync(path.join(source, name), 'utf8')), `toolkit roundtrip ${name}`);
  assert.equal(fs.readFileSync(path.join(extracted, 'backgroundHTML.md'), 'utf8'),
    fs.readFileSync(path.join(source, 'backgroundHTML.md'), 'utf8'));
  console.log('PASS artifact roundtrip, previous artifact hash, assets, settings and unrelated Lua');
}

async function rawCase({ narrative, nodes, manifest, expected, failSlot, manifestStatus = 200 }) {
  const engine = await new LuaFactory().createEngine({ enableProxy: false });
  const session = 'risu_' + 'a'.repeat(64);
  const stored = narrative + '\n\n' + nodes.map(({ slot, content = '{{inlay::saved-' + slot + '}}', asset = false }) =>
    `<lb-xnai ${slot === -1 ? 'kv' : 'scene="' + slot + '"'} session="${session}"${asset ? ' asset="1"' : ''}>${content}</lb-xnai>`).join('\n');
  const target = { role: 'char', data: stored };
  const requests = [], applied = [], alerts = [], events = [];
  let manifests = 0;
  try {
    engine.global.set('test_target', target);
    engine.global.set('test_manifest', manifest);
    engine.global.set('json', { decode: JSON.parse });
    engine.global.set('getFullChat', () => [target]);
    engine.global.set('getChat', () => target);
    engine.global.set('getGlobalVar', (_tid, key) => key === 'toggle_lb-xnai.enabled' ? '1' : '0');
    engine.global.set('getState', () => []);
    engine.global.set('setState', () => {});
    engine.global.set('setChat', (_tid, _index, text) => applied.push(text));
    engine.global.set('reloadChat', () => {});
    engine.global.set('reloadDisplay', () => {});
    engine.global.set('alertNormal', (_tid, text) => alerts.push(text));
    engine.global.set('alertError', (_tid, text) => alerts.push(text));
    engine.global.set('print', text => events.push(String(text)));
    engine.global.set('testManifestRead', () => { manifests++; });
    engine.global.set('testRecordGeneration', slot => requests.push(slot));
    engine.global.set('testManifestBody', JSON.stringify(manifest));
    engine.global.set('testManifestStatus', manifestStatus);
    engine.global.set('testFailSlot', failSlot ?? -999);
    // Keep the real target-selection, manifest parser, generation loop and
    // atomic application. Stub only transport/provider behavior.
    await engine.doString('async=function(f) return f end\nlistenEdit=function() end\n' + release.lua + `
ensureServerConnection=function() return 'https://test.invalid' end
buildPayload=function(tid,chats,sid,index,limit,text,action,slot)
  if action~='generate' then error('unexpected semantic rebuild') end
  return tostring(slot),1
end
requestSlotManifestEnvelope=function()
  testManifestRead()
  return {status=testManifestStatus,data=testManifestBody}
end
generateImage=function(tid,payload)
  local slot=tonumber(payload)
  testRecordGeneration(slot)
  return {await=function()
    if slot==testFailSlot then error('synthetic generation failure') end
    return '{{inlay::new-'..tostring(slot)..'}}'
  end}
end
testRun=function() return generateBatch('fixture',0) end
`);
    engine.global.get('testRun')();
    assert.deepEqual(requests, expected, narrative);
    assert.equal(manifests, 1, 'one authoritative manifest before all generation');
    if (manifestStatus !== 200 || failSlot !== undefined) {
      assert.equal(applied.length, 0, 'failed batch leaves chat untouched');
      assert.ok(alerts.length, 'failure is shown');
      assert.ok(events.some(text => text.includes('failed:')), 'failure is logged');
    } else if (!expected.length) {
      assert.equal(applied.length, 0, 'no usable images causes no chat write');
    } else {
      assert.equal(applied.length, 1, 'successful batch applied once');
      for (const node of nodes) {
        if (!expected.includes(node.slot) || !node.content?.trim() && node.content !== undefined) {
          const attribute = node.slot === -1 ? 'kv' : `scene="${node.slot}"`;
          const original = `<lb-xnai ${attribute} session="${session}"${node.asset ? ' asset="1"' : ''}>${node.content ?? '{{inlay::saved-' + node.slot + '}}'}</lb-xnai>`;
          assert.ok(applied[0].includes(original), `untargeted node preserved: ${node.slot}`);
        }
      }
      assert.ok(applied[0].startsWith(narrative), 'original narrative preserved');
    }
  } catch (error) {
    console.error('RAW fixture failed:', { narrative, requests, applied: applied.length, alerts, events: events.slice(-10) });
    throw error;
  } finally { engine.global.close(); }
}

async function testRaw() {
  await rawCase({ narrative: 'Hana returns to the observatory.',
    nodes: [{ slot: -1 }, { slot: 2 }, { slot: 3, content: '' }, { slot: 4, content: '  ' }, { slot: 9 }],
    manifest: { slots: [-1, 2, 4, 7], animated: [], assets: [] }, expected: [-1, 2] });
  await rawCase({ narrative: 'Minho waits by the pier.',
    nodes: [{ slot: 0 }, { slot: 73 }, { slot: 85, content: '\n' }, { slot: 92 }],
    manifest: { slots: [0, 73, 80, 85], animated: [73], assets: [] }, expected: [0, 73] });
  await rawCase({ narrative: 'All completed scenes remain visible.',
    nodes: [{ slot: -1 }, { slot: 0 }, { slot: 72 }],
    manifest: { slots: [-1, 0, 72], animated: [72], assets: [] }, expected: [-1, 0, 72] });
  await rawCase({ narrative: 'The uploaded painting is kept.',
    nodes: [{ slot: 2 }, { slot: 6, asset: true }, { slot: 8 }, { slot: 2, content: '' }],
    manifest: { slots: [2, 6, 8], animated: [], assets: [6, 8] }, expected: [2] });
  await rawCase({ narrative: 'No completed illustration remains.',
    nodes: [{ slot: 1, content: '' }, { slot: 3 }],
    manifest: { slots: [1, 2], animated: [], assets: [] }, expected: [] });
  await rawCase({ narrative: 'No request starts after a manifest failure.',
    nodes: [{ slot: 2 }], manifest: { error: 'missing_session' }, manifestStatus: 404, expected: [] });
  await rawCase({ narrative: 'A later image failure preserves the original response.',
    nodes: [{ slot: 2 }, { slot: 8 }], manifest: { slots: [2, 8], animated: [], assets: [] },
    expected: [2, 8], failSlot: 8 });
  console.log('PASS RAW holes, sparse slots, removed images, assets, duplicates, normal images and rollback');
}

function clickProbe() {
  return [...document.querySelectorAll('.x-risu-lb-xnai-shared-popover')].map(popover => {
    const button = popover.querySelector(':scope > button[popovertarget]');
    const before = popover.getBoundingClientRect();
    const media = popover.querySelector('.x-risu-lb-xnai-server-media');
    const fallback = popover.querySelector('[data-fallback-id],[data-inlay-id]');
    button.click();
    const open = popover.matches(':popover-open');
    const box = popover.getBoundingClientRect();
    const picture = fallback?.getBoundingClientRect();
    const actions = popover.querySelector('.x-risu-lb-xnai-fullsize-actions');
    const visibleToolbar = getComputedStyle(actions).display !== 'none';
    const toolbar = [...actions.querySelectorAll('button')].map(el => ({ title: el.title, signal: el.getAttribute('risu-btn') }));
    const image = fallback?.tagName === 'IMG' ? fallback : fallback?.querySelector('img');
    const naturalRatio = image?.naturalHeight ? image.naturalWidth / image.naturalHeight : null;
    const displayedRatio = picture?.height ? picture.width / picture.height : null;
    const sameMedia = popover.querySelector('.x-risu-lb-xnai-server-media') === media;
    actions.querySelector('button[popovertargetaction="hide"]').click();
    const closed = !popover.matches(':popover-open');
    const restored = popover.getBoundingClientRect();
    return { open, closed, sameMedia, visibleToolbar, toolbar,
      fallbackCount: popover.querySelectorAll('[data-fallback-id],[data-inlay-id]').length,
      naturalRatio, displayedRatio, picture: picture && { w: picture.width, h: picture.height },
      before: { w: before.width, h: before.height }, box: { w: box.width, h: box.height },
      restored: { w: restored.width, h: restored.height },
      animationEdit: popover.querySelector('[risu-btn*="lb-xnai-edit/"]') !== null };
  });
}

async function testDisplay() {
  const browser = new Browser();
  let count = 0;
  try {
    await browser.start();
    for (const legacy of [true, false]) for (const background of [true, false])
      for (const sequence of ['live-first', 'fallback-first', 'broken-live', 'broken-fallback'])
        for (const viewport of [320, 1140]) {
          let stored = makeStored({ images: [{ slot: 2 }, { slot: 3, asset: true, animated: true }] });
          if (!legacy) stored = stored.replaceAll('<span class="lb-xnai-server-', '<div class="lb-xnai-server-')
            .replaceAll('</span>', '</div>');
          stored = '# Response\n\n' + stored + '\n\n# Response\n\nTrailing section.';
          const protectedOutput = await render(release.lua, stored, values);
          const filtered = protectedOutput.replace(/<\/?[A-Za-z][\w:-]*(?:[ \t][^>\r\n]*)?>(?=[\s\S]*?^# Response)/gm, '');
          const raw = restore(filtered);
          for (const token of ['probe-0', 'probe-1']) assert.equal(raw.split('{{inlay::' + token + '}}').length, 2);
          assert.equal(raw.includes('<dialog'), false, 'no duplicate image dialog');
          const states = await browser.evaluate(displayProbe, {
            markup: prepareMarkup(raw), css: resolveCss(release.css, values), background, sequence, viewport,
          });
          for (const state of states) {
            assert.equal(state.slots.length, 2);
            assert.equal(state.horizontalOverflow, false);
            for (const slot of state.slots) {
              assert.ok(slot.media && slot.live && slot.fallback);
              assert.equal(slot.paragraphs, 0);
              assert.equal(slot.display, 'grid');
            }
          }
          const popovers = await browser.evaluate(clickProbe, {});
          assert.equal(popovers.length, 2);
          for (const [index, popover] of popovers.entries()) {
            const label = `${legacy}/${background}/${sequence}/${viewport}/${index}`;
            assert.ok(popover.open && popover.closed && popover.sameMedia && popover.visibleToolbar, label);
            assert.equal(popover.fallbackCount, 1, label);
            assert.equal(popover.box.w, viewport, label);
            assert.equal(popover.box.h, 900, label);
            assert.deepEqual(popover.restored, popover.before, label);
            assert.equal(popover.animationEdit, index === 0, label);
            if (sequence !== 'broken-fallback') {
              assert.ok(popover.picture.w > 0 && popover.picture.h > 0, label);
              assert.ok(Math.abs(popover.naturalRatio - popover.displayedRatio) < 0.01, label + ' natural aspect');
            }
          }
          count++;
        }
    const fixture = makeStored();
    const once = await render(release.lua, fixture, values);
    assert.equal(await render(release.lua, once, values), once, 'idempotent display');
    for (const kind of ['keyvisual', 'legacy-inlay', 'uncached']) {
      const stored = kind === 'keyvisual' ? makeStored({ images: [{ slot: -1 }] })
        : kind === 'legacy-inlay' ? '<lb-xnai scene="6">{{inlay::probe-0}}</lb-xnai>' : makeStored();
      const markup = prepareMarkup(restore(await render(release.lua, stored, values)));
      if (kind === 'uncached') markup.html = markup.html.replace(/<img data-fallback-id="(\d+)"[^>]*>/g,
        '<div data-inlay-id="probe-$1" class="risu-inlay-placeholder" style="width:100%;min-height:100px"></div>');
      await browser.evaluate(displayProbe, {
        markup, css: resolveCss(release.css, values), sequence: 'broken-live', viewport: 320,
      });
      const results = await browser.evaluate(clickProbe, {});
      for (const result of results) {
        assert.ok(result.open && result.closed && result.sameMedia && result.visibleToolbar, kind);
        assert.equal(result.fallbackCount, 1, kind);
        assert.equal(result.box.w, 320, kind);
        assert.deepEqual(result.restored, result.before, kind);
        if (kind !== 'uncached') {
          assert.ok(result.picture.w > 0 && result.picture.h > 0, kind);
          assert.ok(Math.abs(result.naturalRatio - result.displayedRatio) < 0.01, kind + ' natural aspect');
        }
      }
      count++;
    }
    console.log(`PASS ${count} display cases: real image clicks, fallback recovery, layout, toolbar and close`);
  } finally { await browser.close(); }
}

async function testPocketRisuParser() {
  const browser = new Browser();
  try {
    const target = await browser.send('Target.createTarget', { url: 'about:blank' });
    browser.session = (await browser.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
    await browser.send('Runtime.enable', {}, browser.session);
    await browser.send('Page.enable', {}, browser.session);
    await browser.send('Page.navigate', { url: 'http://192.168.0.4:6003/api/test_auth' }, browser.session);
    const stored = '# Response\n\n' + makeStored({ images: [{ slot: -1 }, { slot: 2 }, { slot: 3, asset: true, animated: true }] })
      + '\n\n# Response\n\nAnother section.';
    const raw = restore(await render(release.lua, stored, values));
    const results = await browser.evaluate(async ({ raw, css, probe }) => {
      const entry = await (await fetch('/')).text();
      const entryPath = entry.match(/<script[^>]*src="([^"]+)"/)[1];
      const entrySource = await (await fetch(entryPath)).text();
      const bundle = entrySource.match(/database\.svelte-[\w-]+\.js/)[0];
      const runtime = await import('/assets/' + bundle);
      // Vite renames exports on each build. Identify ParseMarkdown by its
      // display-script and rendering-mode branches before invoking it.
      const parsers = Object.values(runtime).filter(value => typeof value === 'function'
        && ['editdisplay', 'notrim', 'back'].every(marker => value.toString().includes(marker)));
      if (parsers.length !== 1) throw new Error(`Expected one PocketRisu Markdown parser; found ${parsers.length}`);
      const images = [[1600, 1100], [1200, 360], [600, 1000]].map(([width, height], index) => {
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        const context = canvas.getContext('2d'); context.fillStyle = ['#2573b3', '#3ba873', '#bf7a2e'][index];
        context.fillRect(0, 0, width, height); return canvas.toDataURL();
      });
      const fixture = raw.replace(/\{\{inlay::probe-(\d+)\}\}/g,
        (_, id) => `<img data-inlay-id="probe-${id}" src="${images[Number(id)]}">`)
        .replace(/https:\/\/probe\.invalid\/live-\d+\.png/g, 'data:image/png;base64,AAAA');
      const html = await parsers[0](fixture, null, 'normal');
      document.head.innerHTML = '<style>' + css + '</style>';
      document.body.innerHTML = '<div class="chattext">' + html + '</div>';
      await Promise.all([...document.querySelectorAll('img')].map(image => image.decode().catch(() => {})));
      return Function('return (' + probe + ')()')();
    }, { raw, css: resolveCss(release.css, values), probe: clickProbe.toString() });
    assert.equal(results.length, 3);
    for (const result of results) {
      assert.ok(result.open && result.closed && result.sameMedia && result.visibleToolbar);
      assert.equal(result.fallbackCount, 1);
      assert.ok(result.picture.w > 0 && result.picture.h > 0);
      assert.ok(Math.abs(result.naturalRatio - result.displayedRatio) < 0.01);
    }
    for (let index = 0; index < results.length; index++) {
      const point = await browser.evaluate(index => {
        const popover = document.querySelectorAll('.x-risu-lb-xnai-shared-popover')[index];
        const button = popover.querySelector(':scope > button');
        button.scrollIntoView({ block: 'center' });
        const box = button.getBoundingClientRect();
        const x = (Math.max(0, box.left) + Math.min(innerWidth, box.right)) / 2;
        const y = (Math.max(0, box.top) + Math.min(innerHeight, box.bottom)) / 2;
        return { x, y, hit: popover.contains(document.elementFromPoint(x, y)) };
      }, index);
      assert.ok(point.hit, 'the visible thumbnail receives the pointer');
      for (const type of ['mousePressed', 'mouseReleased'])
        await browser.send('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 }, browser.session);
      const closePoint = await browser.evaluate(index => {
        const popover = document.querySelectorAll('.x-risu-lb-xnai-shared-popover')[index];
        const close = popover.querySelector('button[popovertargetaction="hide"]');
        const box = close.getBoundingClientRect();
        return { open: popover.matches(':popover-open'), x: box.left + box.width / 2, y: box.top + box.height / 2 };
      }, index);
      assert.ok(closePoint.open, 'a trusted pointer click opens fullscreen');
      for (const type of ['mousePressed', 'mouseReleased'])
        await browser.send('Input.dispatchMouseEvent', { type, x: closePoint.x, y: closePoint.y, button: 'left', clickCount: 1 }, browser.session);
      assert.equal(await browser.evaluate(index =>
        document.querySelectorAll('.x-risu-lb-xnai-shared-popover')[index].matches(':popover-open'), index), false,
      'a trusted pointer click closes fullscreen');
    }
    console.log('PASS deployed PocketRisu parser: keyvisual, scene and animated asset pointer clicks with expired server images');
  } finally { await browser.close(); }
}

(async () => {
  auditArtifact();
  await testRaw();
  await testDisplay();
  if (process.argv.includes('--pocketrisu')) await testPocketRisuParser();
  else console.log('PocketRisu parser check skipped: pass --pocketrisu to use the deployed local server');
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
