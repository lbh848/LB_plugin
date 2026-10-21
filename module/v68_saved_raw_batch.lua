-- Only the saved-server-RAW whole-generation action uses this control channel.
-- Risu request() wraps the server JSON body in {status, data}.
local function readRawBatchStatus(tid, serverEndpoint, batchId, operation)
  if not validLookupKey(batchId) then error('invalid saved RAW batch token', 0) end
  local suffix = operation and ('?' .. operation .. '=1') or ''
  local url = serverEndpoint .. '/b/' .. batchId .. suffix
  if #url > 120 then error('saved RAW batch control URL exceeds 120 characters', 0) end
  local envelope = requestSlotManifestEnvelope(tid, url)
  local decodedOk, state = pcall(json.decode, tostring(envelope.data or ''))
  if not decodedOk or type(state) ~= 'table' then
    error('invalid saved RAW batch response: ' .. safeLogValue(envelope.data), 0)
  end
  if tonumber(envelope.status) ~= 200 then
    error('saved RAW batch HTTP ' .. tostring(envelope.status) .. ': '
      .. safeLogValue(state.error or envelope.data), 0)
  end
  if type(state.state) ~= 'string' then
    error('saved RAW batch response has no state: ' .. safeLogValue(envelope.data), 0)
  end
  return state
end

-- Generate every current image from stored RAW descriptors only.
-- Missing state/session is an error; this path never falls back to CALL1/2/3.
local function generateBatch(tid, targetChatIndex)
  local run = nextRun()
  stage(run, '50', 'BUTTON', 'action=generate-all chatIndex=' .. tostring(targetChatIndex))
  local enabled = getGlobalVar(tid, 'toggle_lb-xnai.enabled')
  if enabled ~= '1' and enabled ~= '2' then
    alertNormal(tid, '대화 삽화 모드를 자동 또는 수동으로 설정해주세요.')
    return
  end
  if running then
    alertNormal(tid, '다른 삽화 작업이 진행 중입니다.')
    return
  end
  local serverEndpoint, health = ensureServerConnection(tid, run)
  if not serverEndpoint then return end
  if type(health) ~= 'table' or health.raw_batch_stop ~= true then
    local reason = '서버가 저장 RAW 전체 생성 중단 기능(raw_batch_stop)을 지원하지 않습니다. 서버를 업데이트한 뒤 다시 시도해주세요.'
    print('[soya-v68][RAW_BATCH] 기능 확인 실패: endpoint=' .. tostring(serverEndpoint)
      .. ' version=' .. tostring(health and health.version)
      .. ' raw_batch_stop=' .. tostring(health and health.raw_batch_stop))
    stage(run, '90', 'ERROR', 'location=GENERATE_ALL_CAPABILITY message=' .. reason)
    alertError(tid, reason)
    return
  end

  local sessionId, sessionSource = resolveSessionId(tid, targetChatIndex, nil)
  if not sessionId and sessionSource ~= 'mixed' then
    local recoverOk, recovered, recoveredSource = pcall(
      deriveLegacySessionId, tid, targetChatIndex)
    if recoverOk then sessionId, sessionSource = recovered, recoveredSource end
  end
  if not validSessionId(sessionId) then
    local reason = sessionSource == 'mixed' and 'mixed embedded sessions' or 'session unavailable'
    stage(run, '90', 'ERROR', 'location=GENERATE_ALL message=' .. reason)
    alertNormal(tid, '저장된 서버 RAW 세션을 확인할 수 없습니다.')
    return
  end
  stage(run, '41', 'SESSION_RESOLVE', 'source=' .. tostring(sessionSource)
    .. ' session=' .. tostring(sessionId))
  local fullChat = getFullChat(tid) or {}
  local targetLuaIndex = tonumber(targetChatIndex) and (tonumber(targetChatIndex) + 1) or nil
  local target = targetLuaIndex and fullChat[targetLuaIndex] or nil
  if not target or target.role ~= 'char' then
    alertNormal(tid, '대상 응답의 삽화 메시지를 찾지 못했습니다.')
    return
  end

  local nodes = queryNodes('lb-xnai', target.data or '')
  local slots, seen = {}, {}
  for _, node in ipairs(nodes) do
    local slot = normalizeNodeSlot(node)
    if not seen[slot] then
      seen[slot] = true
      slots[#slots + 1] = tonumber(slot)
    end
  end
  table.sort(slots, function(a, b) return a < b end)
  if #slots == 0 then
    alertNormal(tid, '현재 응답에 대체할 삽화가 없습니다.')
    return
  end

  local targetSource = removeIllustrationNodes(target.data or '')
  local contextLimit = transportLimit(tid)
  running = true
  local errorLocation, errorSlot = 'GENERATE_ALL_SEND', nil
  local batchId, stopped = nil, false
  local ok, err = pcall(function()
    local digest = hash(tid, 'soya-v68:raw-batch:' .. tostring(sessionId)
      .. ':' .. tostring(tid) .. ':' .. tostring(run) .. ':' .. tostring(os.time())):await()
    batchId = tostring(digest or ''):sub(1, LOOKUP_KEY_LENGTH)
    if not validLookupKey(batchId) then error('invalid saved RAW batch hash', 0) end
    stage(run, '50A', 'GENERATE_ALL_BATCH', 'batch=' .. batchId)

    local function requireBatchState(operation, expected)
      local status = readRawBatchStatus(tid, serverEndpoint, batchId, operation)
      if status.state == 'cancelled' then
        stopped = true
        error(status.error ~= '' and status.error or '저장 RAW 전체 생성이 중단되었습니다', 0)
      end
      if status.state ~= expected then
        error('unexpected saved RAW batch state: ' .. tostring(status.state)
          .. ' expected=' .. expected, 0)
      end
    end

    local fallbackInlays = {}
    for index, slot in ipairs(slots) do
      errorSlot = slot
      -- The first prompt registers this batch. All later prompts must consult
      -- the server before sending a new image-generation request.
      if index > 1 then requireBatchState(nil, 'active') end
      local payload, selectedCount = buildPayload(
        tid, fullChat, sessionId, targetLuaIndex, contextLimit,
        targetSource, 'generate', slot, nil, batchId, index - 1)
      if selectedCount == 0 then error('empty CHAT context', 0) end
      stage(run, '51', 'GENERATE_ALL_SLOT_BEGIN', 'slot=' .. tostring(slot))
      local generated = generateImage(tid, payload, ''):await()
      -- Stop may arrive while this image is running. Let that image finish,
      -- then refuse the remaining slots and the final chat overwrite.
      requireBatchState(nil, 'active')
      if not validInlay(generated) then
        error('invalid slot result: ' .. tostring(generated), 0)
      end
      fallbackInlays[tostring(slot)] = generated
      stage(run, '52', 'GENERATE_ALL_SLOT_END', 'slot=' .. tostring(slot))
    end
    local _, animatedSlots, assetSlots = fetchSessionMedia(
      tid, run, serverEndpoint, lookupKeyFromSessionId(sessionId), slots)
    local inlays = {}
    for _, slot in ipairs(slots) do
      local key = tostring(slot)
      inlays[key] = serverImageMarkup(
        serverEndpoint, sessionId, slot, fallbackInlays[key], animatedSlots[key] == true)
    end

    errorLocation, errorSlot = 'GENERATE_ALL_APPLY', nil
    -- A single server transition arbitrates Stop versus applying the result.
    -- If Stop wins, no setChat() or whole-batch success follows.
    requireBatchState('p', 'finalizing')
    local out = target.data or ''
    local currentNodes = queryNodes('lb-xnai', out)
    for i = #currentNodes, 1, -1 do
      local node = currentNodes[i]
      local slot = normalizeNodeSlot(node)
      local value = inlays[slot]
      if value then
        local animatedAttribute = animationAttribute(animatedSlots, slot)
        local assetAttributeValue = assetAttribute(assetSlots, slot)
        local attribute = slot == '-1'
          and ('kv session="' .. tostring(sessionId) .. '"' .. animatedAttribute)
          or ('scene="' .. slot .. '" session="' .. tostring(sessionId)
            .. '"' .. animatedAttribute .. assetAttributeValue)
        out = out:sub(1, node.rangeStart - 1)
          .. '<lb-xnai ' .. attribute .. '>' .. value .. '</lb-xnai>'
          .. out:sub(node.rangeEnd + 1)
      end
    end
    out = ensureLazyMarker(out)
    setChat(tid, targetChatIndex, out)
    persistState(tid, targetChatIndex, sessionId, inlays)
    reloadChat(tid, targetChatIndex)
    reloadDisplay(tid)
    requireBatchState('f', 'completed')
  end)

  if not ok and batchId then
    if not stopped then
      local statusOk, status = pcall(readRawBatchStatus, tid, serverEndpoint, batchId)
      if statusOk and status.state == 'cancelled' then
        stopped = true
        err = status.error ~= '' and status.error or '저장 RAW 전체 생성이 중단되었습니다'
      else
        local abortOk, abortError = pcall(readRawBatchStatus,
          tid, serverEndpoint, batchId, 'a')
        if not abortOk then
          print('[soya-v68][RAW_BATCH_ABORT] batch=' .. batchId
            .. ' cause=' .. safeLogValue(err) .. ' cleanup=' .. safeLogValue(abortError))
        end
      end
    end
  end
  running = false
  if not ok then
    local slotText = errorSlot ~= nil and (' slot=' .. tostring(errorSlot)) or ''
    stage(run, '90', stopped and 'CANCELLED' or 'ERROR',
      'location=' .. errorLocation .. slotText .. ' message=' .. safeLogValue(err))
    if stopped then
      alertNormal(tid, '저장된 서버 RAW 전체 생성을 중단했습니다. 이미 시작한 이미지는 완료될 수 있지만 이후 슬롯은 생성하지 않습니다.\n'
        .. safeLogValue(err))
    else
      alertNormal(tid, '저장 RAW 전체 생성 중 오류가 발생했습니다. 컨텍스트로 자동 전환하지 않습니다.\n'
        .. safeLogValue(err))
    end
  else
    stage(run, '53', 'COMPLETE')
  end
end
