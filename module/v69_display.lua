-- The inline media itself enters the top layer. Keep one persistent Risu
-- fallback and one live layer, including after the server URL expires.
local function createFullscreenActions(chatIndex, slot, popID, animated)
  local toolbar = createToolbar(chatIndex, slot, popID, true, animated)
  t_insert(toolbar, h.button['lb-xnai-toolbar-btn'] {
    popovertarget = popID, popovertargetaction = 'hide', type = 'button',
    title = '확대보기 닫기', '닫기',
  })
  return h.div['lb-xnai-fullsize-actions'] { table.unpack(toolbar) }
end

local function renderInline(tid, data, chatIndex)
  local imageNodes = queryNodes('lb-xnai', data)
  if #imageNodes == 0 then return data end
  local out, kv = data, nil
  local hasInlineStyle = false
  for nodeIndex = #imageNodes, 1, -1 do
    local node = imageNodes[nodeIndex]
    local slot = node.attributes.scene or '-1'
    local inlay = normalizeDisplayInlay(trim(node.content))
    local animated = node.attributes.animated == '1'
    local asset = node.attributes.asset == '1'
    if inlay ~= '' then
      local displayInlay = slot == '-1' and keyVisualDisplayInlay(inlay) or inlay
      local popID = 'lb-xnai-pop-' .. tostring(chatIndex) .. '-' .. tostring(nodeIndex)
      local fullscreenActions = createFullscreenActions(chatIndex, slot, popID, animated)
      local inline = h.button {
        popovertarget = popID, type = 'button', title = '크게 보기', rawHTML(displayInlay),
      }
      local rendered
      if slot == '-1' then
        rendered = tostring(h.div['lb-xnai-kv-wrapper'] {
          rawHTML(not hasInlineStyle and INLINE_DISPLAY_STYLE or ''),
          h.div['lb-xnai-kv-actions'] { table.unpack(createToolbar(chatIndex, slot, popID, false, animated)) },
          h.div['lb-xnai-kv'] {
            id = popID, popover = 'auto', class = 'lb-xnai-shared-popover',
            inline, fullscreenActions,
          },
        })
        kv = protectDisplayHTML(rendered)
        rendered = ''
      else
        local wrapperClass = asset and 'lb-xnai-asset-wrapper' or 'lb-xnai-inlay-wrapper'
        local imageClass = asset and 'lb-xnai-asset' or 'lb-xnai-inlay'
        rendered = protectDisplayHTML(tostring(h.div[wrapperClass] {
          rawHTML(not hasInlineStyle and INLINE_DISPLAY_STYLE or ''),
          h.div[imageClass] {
            id = popID, popover = 'auto',
            class = (asset and 'lb-xnai-inlay ' or '') .. 'lb-xnai-inline-layout lb-xnai-shared-popover',
            style = inlineDisplayProperties(tid, asset),
            h.div['lb-xnai-inlay-actions'] { table.unpack(createToolbar(chatIndex, slot, popID, false, animated)) },
            inline, fullscreenActions,
          },
        }))
      end
      hasInlineStyle = true
      out = out:sub(1, node.rangeStart - 1) .. rendered .. out:sub(node.rangeEnd + 1)
    end
  end
  if kv then
    local position = getGlobalVar(tid, 'toggle_lb-xnai.kv.position') or '0'
    if position == '0' then out = insertTopKeyVisual(out, kv)
    else out = out .. '\n\n' .. kv end
  end
  return out
end
