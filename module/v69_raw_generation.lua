-- Regenerate visible completed illustrations only. Empty candidate nodes and
-- ready-session omissions are not requests; original assets use asset reroll.
local function generateBatch(tid, targetChatIndex)
  local run = nextRun()
  stage(run, '50', 'BUTTON', 'action=generate-all chatIndex=' .. tostring(targetChatIndex))
  local enabled = getGlobalVar(tid, 'toggle_lb-xnai.enabled')
  if enabled ~= '1' and enabled ~= '2' then
    print('[soya-v69][RAW_ALL] skip: mode=' .. tostring(enabled))
    alertNormal(tid, '삽화 작동 모드를 자동 또는 수동으로 설정해주세요.')
    return
  end
  if running then
    print('[soya-v69][RAW_ALL] skip: another illustration operation is running')
    alertNormal(tid, '다른 삽화 작업이 진행 중입니다.')
    return
  end
  local serverEndpoint = ensureServerConnection(tid, run)
  if not serverEndpoint then return end
  local sessionId, sessionSource = resolveSessionId(tid, targetChatIndex, nil)
  if not sessionId and sessionSource ~= 'mixed' then
    local recoverOk, recovered, recoveredSource = pcall(deriveLegacySessionId, tid, targetChatIndex)
    if recoverOk then sessionId, sessionSource = recovered, recoveredSource end
  end
  if not validSessionId(sessionId) then
    local reason = sessionSource == 'mixed' and 'mixed embedded sessions' or 'session unavailable'
    stage(run, '90', 'ERROR', 'location=GENERATE_ALL message=' .. reason)
    alertNormal(tid, '현재 응답의 RAW 세션을 복구할 수 없습니다.')
    return
  end
  local fullChat = getFullChat(tid) or {}
  local targetLuaIndex = tonumber(targetChatIndex) and (tonumber(targetChatIndex) + 1) or nil
  local target = targetLuaIndex and fullChat[targetLuaIndex] or nil
  if not target or target.role ~= 'char' then
    print('[soya-v69][RAW_ALL] target unavailable: chatIndex=' .. tostring(targetChatIndex))
    alertNormal(tid, '전체 생성할 대상 응답을 찾지 못했습니다.')
    return
  end
  local nodes = queryNodes('lb-xnai', target.data or '')
  local targetSource = removeIllustrationNodes(target.data or '')
  local contextLimit = transportLimit(tid)
  running = true
  local errorLocation, errorSlot = 'GENERATE_ALL_MANIFEST', nil
  local ok, err = pcall(function()
    -- Read the complete manifest once before sending any generation request.
    -- A manually removed image may still be in this manifest, so intersect
    -- with populated nodes instead of restoring every server slot.
    local actualSlots, animatedSlots, assetSlots = fetchSessionMedia(
      tid, run, serverEndpoint, lookupKeyFromSessionId(sessionId), nil)
    local available = {}
    for _, slot in ipairs(actualSlots) do available[tostring(slot)] = true end
    local slots, seen = {}, {}
    for _, node in ipairs(nodes) do
      local slot = normalizeNodeSlot(node)
      local reason
      if trim(node.content) == '' then reason = 'empty image node'
      elseif not available[slot] then reason = 'slot absent from ready session'
      elseif assetSlots[slot] or node.attributes.asset == '1' then reason = 'original asset preserved'
      elseif seen[slot] then reason = 'duplicate slot'
      end
      if reason then
        print('[soya-v69][RAW_ALL] skip: session=' .. tostring(sessionId)
          .. ' slot=' .. slot .. ' reason=' .. reason)
      else
        seen[slot] = true
        slots[#slots + 1] = tonumber(slot)
      end
    end
    table.sort(slots, function(a, b) return a < b end)
    if #slots == 0 then
      print('[soya-v69][RAW_ALL] no visible completed RAW images: session=' .. tostring(sessionId))
      stage(run, '50A', 'SKIP', 'reason=no_visible_completed_raw_images')
      alertNormal(tid, '현재 응답에 RAW로 다시 생성할 완성 삽화가 없습니다.')
      return
    end
    stage(run, '50A', 'GENERATE_ALL_TARGETS', 'session=' .. tostring(sessionId)
      .. ' slots=' .. t_concat(slots, ','))
    errorLocation = 'GENERATE_ALL_SEND'
    local inlays = {}
    for _, node in ipairs(nodes) do
      if trim(node.content) ~= '' then inlays[normalizeNodeSlot(node)] = node.content end
    end
    local replacements = {}
    for _, slot in ipairs(slots) do
      errorSlot = slot
      local payload, selectedCount = buildPayload(tid, fullChat, sessionId,
        targetLuaIndex, contextLimit, targetSource, 'generate', slot)
      if selectedCount == 0 then error('empty CHAT context', 0) end
      stage(run, '51', 'GENERATE_ALL_SLOT_BEGIN', 'slot=' .. tostring(slot))
      local generated = generateImage(tid, payload, ''):await()
      if not validInlay(generated) then error('invalid slot result: ' .. tostring(generated), 0) end
      local key = tostring(slot)
      replacements[key] = serverImageMarkup(serverEndpoint, sessionId, slot,
        generated, animatedSlots[key] == true)
      inlays[key] = replacements[key]
      stage(run, '52', 'GENERATE_ALL_SLOT_END', 'slot=' .. key)
    end
    errorLocation, errorSlot = 'GENERATE_ALL_APPLY', nil
    local out = target.data or ''
    for i = #nodes, 1, -1 do
      local node = nodes[i]
      local slot = normalizeNodeSlot(node)
      local value = replacements[slot]
      -- A duplicate empty placeholder for this slot must also stay empty.
      if value and trim(node.content) ~= '' then
        local attribute = slot == '-1'
          and ('kv session="' .. tostring(sessionId) .. '"' .. animationAttribute(animatedSlots, slot))
          or ('scene="' .. slot .. '" session="' .. tostring(sessionId)
            .. '"' .. animationAttribute(animatedSlots, slot))
        out = out:sub(1, node.rangeStart - 1) .. '<lb-xnai ' .. attribute .. '>'
          .. value .. '</lb-xnai>' .. out:sub(node.rangeEnd + 1)
      end
    end
    out = ensureLazyMarker(out)
    setChat(tid, targetChatIndex, out)
    persistState(tid, targetChatIndex, sessionId, inlays)
    reloadChat(tid, targetChatIndex)
    reloadDisplay(tid)
  end)
  running = false
  if not ok then
    local slotText = errorSlot ~= nil and (' slot=' .. tostring(errorSlot)) or ''
    print('[soya-v69][RAW_ALL] failed: session=' .. tostring(sessionId)
      .. ' location=' .. errorLocation .. slotText .. ' error=' .. safeLogValue(err))
    print(debug.traceback(tostring(err)))
    stage(run, '90', 'ERROR', 'location=' .. errorLocation .. slotText .. ' message=' .. safeLogValue(err))
    alertNormal(tid, '현재 응답 전체 생성 중 오류가 발생했습니다. 재생성으로 자동 전환하지 않습니다.\n' .. safeLogValue(err))
  else
    stage(run, '53', 'COMPLETE')
  end
end
