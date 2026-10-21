'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const toolkit = path.join(__dirname, '.local-tools/risuai-charx-toolkit/scripts');
const { openCharx } = require(path.join(toolkit, 'charx-io'));
const { reassembleCharx } = require(path.join(toolkit, 'folder-io'));
const luaparse = require(path.join(toolkit, 'node_modules/luaparse'));
const source = path.join(__dirname, '.work/v69_image_recovery_source');
const artifact = path.join(__dirname, '라이트보드  삽화 4.1.0-soya-v69.module.charx');

function patchLua(original) {
  let lua = original;
  const display = fs.readFileSync(path.join(__dirname, 'v69_display.lua'), 'utf8').trimEnd();
  const split = display.indexOf('local function renderInline(');
  const helperStart = lua.indexOf('-- The inline fallback token is persistent media,');
  const helperEnd = lua.indexOf('-- HTML img elements expose WebView', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'v67 fullsize helper anchors');
  lua = lua.slice(0, helperStart) + display.slice(0, split) + lua.slice(helperEnd);
  const renderStart = lua.indexOf('local function renderInline(');
  const renderEnd = lua.indexOf("listenEdit('editDisplay'", renderStart);
  assert.ok(renderStart >= 0 && renderEnd > renderStart, 'display renderer anchors');
  lua = lua.slice(0, renderStart) + display.slice(split) + '\n\n' + lua.slice(renderEnd);
  const cssEnd = '</style>]]\n\nlocal function inlineDisplayProperties';
  assert.equal(lua.split(cssEnd).length, 2, 'inline style anchor');
  const css = fs.readFileSync(path.join(__dirname, 'v69_shared_fullscreen.css'), 'utf8').trimEnd();
  lua = lua.replace(cssEnd, () => css + '\n' + cssEnd);
  const rawStart = lua.indexOf('local function generateBatch(');
  const rawEnd = lua.indexOf('-- Rebuild prompts from CHAT through remote CALL1/2/3,', rawStart);
  assert.ok(rawStart >= 0 && rawEnd > rawStart, 'saved RAW generation anchors');
  lua = lua.slice(0, rawStart) + fs.readFileSync(path.join(__dirname, 'v69_raw_generation.lua'), 'utf8').trimEnd()
    + '\n\n' + lua.slice(rawEnd);
  lua = lua.replaceAll('soya-v67', 'soya-v69');
  luaparse.parse(lua, { luaVersion: '5.3' });
  return lua;
}

if (require.main === module) {
  try {
    const mode = process.argv[2];
    if (mode === '--check') {
      const old = openCharx(path.join(__dirname, '라이트보드  삽화 4.1.0-soya-v67.module.charx'));
      console.log('v69 patch and Lua syntax valid; no files written; bytes=' + patchLua(old.lua).length);
    } else if (mode === '--build') {
      assert.equal(fs.existsSync(artifact), false, 'never replace an existing release artifact');
      const modulePath = path.join(source, 'module.json');
      const cardPath = path.join(source, 'card.json');
      const data = JSON.parse(fs.readFileSync(modulePath, 'utf8'));
      const lua = data.module.trigger[0].effect[0].code;
      assert.ok(lua.includes('soya-v67') && !lua.includes('soya-v69'), 'fresh v67 extraction required');
      data.module.trigger[0].effect[0].code = patchLua(lua);
      fs.writeFileSync(modulePath, JSON.stringify(data, null, 2).replaceAll('soya-v67', 'soya-v69'), 'utf8');
      const card = fs.readFileSync(cardPath, 'utf8').replaceAll('soya-v67', 'soya-v69');
      fs.writeFileSync(cardPath, card, 'utf8');
      reassembleCharx(source, artifact);
      console.log('Created new v69 module: ' + artifact);
    } else throw new Error('Usage: node build_v69_image_recovery.cjs --check|--build');
  } catch (error) {
    console.error(error.stack);
    process.exitCode = 1;
  }
}
module.exports = { patchLua, source, artifact };
