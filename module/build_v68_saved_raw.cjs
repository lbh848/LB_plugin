'use strict';
// --check is read-only. --build assembles a NEW v68 artifact with the Risu
// toolkit; it never replaces the existing v67 source or release file.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const root = __dirname;
const source = path.join(root, '.work', 'v67_final_source');
const output = path.join(root, '.work', 'v68_saved_raw_source');
const artifact = path.join(root, '라이트보드  삽화 4.1.0-soya-v68.module.charx');
const moduleData = JSON.parse(fs.readFileSync(path.join(source, 'module.json'), 'utf8'));
const cardData = JSON.parse(fs.readFileSync(path.join(source, 'card.json'), 'utf8'));
let lua = moduleData.module.trigger[0].effect[0].code;

function replaceOnce(before, after, label) {
  assert.equal(lua.split(before).length - 1, 1, `expected exactly one ${label} anchor`);
  lua = lua.replace(before, () => after);
}

replaceOnce(
  '  targetSource, action, slot, targetSlottedOverride)',
  '  targetSource, action, slot, targetSlottedOverride, rawBatchId, rawBatchIndex)',
  'shared payload builder signature',
);
replaceOnce(
  `  local slotField = slot ~= nil and (',"slot":' .. tostring(slot)) or ''
  local payload = CONTEXT_PREFIX`,
  `  local slotField = slot ~= nil and (',"slot":' .. tostring(slot)) or ''
  local rawBatchField = rawBatchId and (',"raw_batch_id":"' .. jsonEscape(rawBatchId)
    .. '","raw_batch_index":' .. tostring(rawBatchIndex)) or ''
  local payload = CONTEXT_PREFIX`,
  'shared payload builder batch fields',
);
replaceOnce(
  `    .. '","action":"' .. jsonEscape(actionName) .. '"' .. slotField
`,
  `    .. '","action":"' .. jsonEscape(actionName) .. '"' .. slotField .. rawBatchField
`,
  'shared payload builder JSON',
);
// Existing callers keep the endpoint return value. Only saved-RAW whole
// generation consults the extra health capability before sending slot zero.
replaceOnce(
  `  stage(run, '17A', 'CONNECTION_CHECK_END', 'online=true')
  return serverEndpoint
end

local function ensureServerConnection(tid, run)`,
  `  stage(run, '17A', 'CONNECTION_CHECK_END', 'online=true')
  return serverEndpoint, health
end

local function ensureServerConnection(tid, run)`,
  'health capability return',
);
replaceOnce(
  `  local ok, serverEndpoint = pcall(requireServerConnection, tid, run)
  if ok then return serverEndpoint end`,
  `  local ok, serverEndpoint, health = pcall(requireServerConnection, tid, run)
  if ok then return serverEndpoint, health end`,
  'health capability forwarding',
);

const begin = '-- Generate every current image from stored RAW descriptors only.\n';
const end = '-- Rebuild prompts from CHAT through remote CALL1/2/3, then atomically replace all images.\n';
assert.equal(lua.split(begin).length - 1, 1, 'unique saved-RAW button begin');
assert.equal(lua.split(end).length - 1, 1, 'unique separate CALL1/2/3 button');
const start = lua.indexOf(begin);
const stop = lua.indexOf(end);
assert.ok(stop > start, 'saved-RAW button precedes CALL1/2/3 button');
const replacement = fs.readFileSync(path.join(root, 'v68_saved_raw_batch.lua'), 'utf8').trimEnd();
lua = lua.slice(0, start) + replacement + '\n\n' + lua.slice(stop);
lua = lua.replaceAll('soya-v67', 'soya-v68');
assert.equal(lua.includes('soya-v67'), false, 'no stale module version');
assert.equal(lua.split('local function generateBatch(tid, targetChatIndex)').length - 1, 1);
assert.equal(lua.split('local function regenerateBatch(tid, targetChatIndex)').length - 1, 1);
// Check the assembled source, not just the patch inputs: dropping either
// return value makes every v68 saved-RAW request reject even a capable server.
const requireConnection = lua.slice(
  lua.indexOf('local function requireServerConnection(tid, run)'),
  lua.indexOf('local function ensureServerConnection(tid, run)'),
);
const ensureConnection = lua.slice(
  lua.indexOf('local function ensureServerConnection(tid, run)'),
  lua.indexOf('local function validLookupKey(value)'),
);
assert.match(requireConnection, /return serverEndpoint, health\s*end\s*$/,
  'health must leave the existing validated connection check');
assert.match(ensureConnection,
  /local ok, serverEndpoint, health = pcall\(requireServerConnection, tid, run\)\s*if ok then return serverEndpoint, health end/,
  'health must pass through the existing error-handling wrapper');
assert.match(ensureConnection, /local message = safeLogValue\(serverEndpoint\)[\s\S]*alertError\(tid/,
  'connection failures must still show the existing error');
const generateAll = lua.slice(
  lua.indexOf('local function generateBatch(tid, targetChatIndex)'),
  lua.indexOf('-- Rebuild prompts from CHAT through remote CALL1/2/3, then atomically replace all images.'),
);
assert.match(generateAll,
  /local serverEndpoint, health = ensureServerConnection\(tid, run\)\s*if not serverEndpoint then return end\s*if type\(health\) ~= 'table' or health.raw_batch_stop ~= true then[\s\S]*?raw_batch_stop[\s\S]*?alertError\(tid, reason\)\s*return\s*end/,
  'unsupported servers must show the capability error and return');
assert.ok(generateAll.indexOf('generateImage(') > generateAll.indexOf('alertError(tid, reason)'),
  'unsupported servers must exit before the first image request');
const luaParser = require(path.join(root, '.local-tools', 'risuai-charx-toolkit',
  'scripts', 'node_modules', 'luaparse'));
luaParser.parse(lua, {luaVersion: '5.3'});
moduleData.module.trigger[0].effect[0].code = lua;
const versionedModule = JSON.stringify(moduleData, null, 2).replaceAll('soya-v67', 'soya-v68');
const versionedCard = JSON.stringify(cardData, null, 2).replaceAll('soya-v67', 'soya-v68');
assert.ok(versionedModule.includes('4.1.0-soya-v68'));
assert.ok(versionedCard.includes('4.1.0-soya-v68'));
assert.ok(!versionedModule.includes('soya-v67') && !versionedCard.includes('soya-v67'));

const mode = process.argv[2];
if (mode === '--check') {
  console.log(`v68 source patch valid; Lua length=${lua.length}; no files written`);
} else if (mode === '--build') {
  if (fs.existsSync(output) || fs.existsSync(artifact)) {
    throw new Error(`Refusing to replace existing output: ${output} or ${artifact}`);
  }
  fs.cpSync(source, output, {
    recursive: true,
    filter: filename => !['module.json', 'card.json'].includes(path.basename(filename)),
  });
  fs.writeFileSync(path.join(output, 'module.json'), versionedModule, {encoding: 'utf8', flag: 'wx'});
  fs.writeFileSync(path.join(output, 'card.json'), versionedCard, {encoding: 'utf8', flag: 'wx'});
  const {reassembleCharx} = require(path.join(root, '.local-tools',
    'risuai-charx-toolkit', 'scripts', 'folder-io'));
  reassembleCharx(output, artifact);
  console.log(`Created new v68 source and artifact: ${artifact}`);
} else {
  throw new Error('Usage: node build_v68_saved_raw.cjs --check|--build');
}
