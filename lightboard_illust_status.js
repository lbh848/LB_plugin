//@name lightboard-illust-status-v42
//@display-name soya comfy manager plugin v1.0.24
//@api 3.0
//@version 42.0.33
//@author soya
//@update-url https://raw.githubusercontent.com/lbh848/LB_plugin/main/lightboard_illust_status.js
//@arg END_POINT string Dashboard endpoint prefill (default: empty)
//@arg POLL_MS int Active status polling interval in milliseconds (default: 1000)
//@arg DISCOVERY_POLL_MS int Generation-triggered discovery interval in milliseconds (default: 2000)
//@arg SIGNAL_WAIT_MS int Time to wait for an illustration session after generation output (default: 30000)
//@arg DEBUG int Diagnostic logging (1: enabled, 0: state changes only)

// Configuration/status-only companion for soya-v60.
// - Importing the plugin never performs a health or status request.
// - The plugin-owned HTTPS endpoint is mirrored to each current character on navigation.
// - Unchanged Risu input/output channels sync configuration and arm session discovery.
// - CALL1 full regeneration, RAW whole/per-slot generation, original-asset
//   reroll, and static-image easy-edit buttons arm discovery without reading
//   their chat-index payloads.
// - Active work switches to the faster POLL_MS interval and stops when it completes.
// - It never reads messages, message indexes, or image data.

(async () => {
  const PLUGIN_ID = 'lightboard-illust-status-v42';
  const ROOT_ID = 'lb-illust-status-v42-root';
  const ROOT_Z_INDEX = 1387;
  const FLOAT_STACK_CLASS = 'lb-illust-v42-floating-stack';
  const FLOAT_WINDOW_CLASS = 'lb-illust-v42-floating-window';
  const FLOAT_Z_INDEX = 1261;
  const SETTINGS_KEY = 'lightboard-illust-v42-settings';
  const ENDPOINT_VARIABLE_V2 = 'lb-xnai-server-endpoint-v2';
  const ENDPOINT_VARIABLE_LEGACY = 'lb-xnai-server-endpoint';
  const LOOKUP_KEY_LENGTH = 24;
  const SLOT_MEDIA_QUERY_LENGTH = '?m=1'.length;
  const MAX_EXACT_SLOT_COUNT = 65;
  const ACTION_BUTTON_SELECTOR = [
    'button[risu-btn^="lb-xnai-regenerate-all/"]',
    'button[risu-btn^="lb-xnai-generate-all/"]',
    'button[risu-btn^="lb-xnai-reroll-assets/"]',
    'button[risu-btn^="lb-xnai-gen/"]',
    'button[risu-btn^="lb-xnai-edit/"]',
  ].join(',');
  const LOG = '[illust-status-v42]';
  const SETTINGS_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15a4 4 0 0 1 4-4h8a4 4 0 0 1 4 4v4H4z"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/><path d="M9 19v2m6-2v2"/></svg>';

  let endpointPrefill = '';
  let baseEndpoint = '';
  let endpointDraft = '';
  let endpointEditing = false;
  let pollMs = 1000;
  let discoveryPollMs = 2000;
  let signalWaitMs = 30000;
  let debugEnabled = false;
  let timer = null;
  let polling = false;
  let dashboardOpen = false;
  let watchEnabled = true;
  let armedUntil = 0;
  let watchSawActive = false;
  let inactiveConfirmationPolls = 0;
  let lastSignature = '';
  let floatingWindow = null;
  let floatingUnavailableLogged = false;
  let floatingSignature = '';
  let healthCheckedAt = 0;
  let generationInputHookRegistered = false;
  let generationHookRegistered = false;
  let regenerationObserver = null;
  let regenerationBinding = false;
  let illustrationSignalRoot = null;
  let illustrationSignalListenerId = '';
  let regenerationBridgeUnavailableLogged = false;
  let endpointPersistWarning = '';
  let characterSyncTimer = null;
  let characterSyncPromise = null;
  let lastSynchronizedCharacterId = '';
  let lastCharacterSyncError = '';
  const HEALTH_CACHE_MS = 5 * 60 * 1000;
  const COMPLETION_CONFIRM_POLLS = 3;
  const CHARACTER_SYNC_DEBOUNCE_MS = 150;
  const TERMINAL_SESSION_STATES = new Set(['ready', 'error', 'failed', 'cancelled', 'canceled', 'missing']);
  const manifestCache = new Map();
  const manifestFailureCache = new Map();
  let settings = {
    endpoint: '',
    configured: false,
    floatingEnabled: true,
    floatingAlwaysVisible: false,
    floatingZIndex: FLOAT_Z_INDEX,
    floatingOffsetX: 14,
    floatingOffsetY: 14,
  };
  let state = {
    online: false,
    error: '',
    checkedAt: 0,
    health: null,
    sessions: [],
  };
  let botState = {
    loading: false,
    saving: false,
    bots: [],
    selected: '',
    draft: '',
    error: '',
  };

  const errorText = (error) => String(error?.message || error || 'unknown error')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 500);

  const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const safeNumber = (value, fallback = 0) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  };

  const getArgument = async (name, fallback) => {
    try {
      const value = await Risuai.getArgument(name);
      return value === null || value === undefined || value === '' ? fallback : value;
    } catch (error) {
      console.warn(LOG, 'argument.read_failed', name, errorText(error));
      return fallback;
    }
  };

  const normalizeEndpoint = (value) => {
    const endpoint = String(value || '').trim().replace(/\/+$/, '');
    if (!endpoint) throw new Error('서버 HTTPS 주소를 입력하세요.');
    if (!/^https:\/\//i.test(endpoint)) throw new Error('서버 주소는 https://로 시작해야 합니다.');
    const parsed = new URL(endpoint);
    if (parsed.search || parsed.hash) throw new Error('서버 주소에는 쿼리 또는 # 조각을 넣을 수 없습니다.');
    const manifestLength = endpoint.length + '/s/'.length + LOOKUP_KEY_LENGTH
      + SLOT_MEDIA_QUERY_LENGTH;
    if (manifestLength > 120) {
      throw new Error(`Risu request URL 제한을 넘습니다: ${manifestLength}/120자`);
    }
    return endpoint;
  };

  const loadSettings = async () => {
    try {
      const stored = await Risuai.pluginStorage?.getItem?.(SETTINGS_KEY);
      if (stored && typeof stored === 'object') {
        settings = {
          endpoint: String(stored.endpoint || ''),
          configured: stored.configured === true,
          floatingEnabled: stored.floatingEnabled !== false,
          floatingAlwaysVisible: stored.floatingAlwaysVisible === true,
          floatingZIndex: Number.isFinite(Number(stored.floatingZIndex)) ? Number(stored.floatingZIndex) : FLOAT_Z_INDEX,
          floatingOffsetX: Number.isFinite(Number(stored.floatingOffsetX)) ? Number(stored.floatingOffsetX) : 14,
          floatingOffsetY: Number.isFinite(Number(stored.floatingOffsetY)) ? Number(stored.floatingOffsetY) : 14,
        };
      }
    } catch (error) {
      console.warn(LOG, 'settings.load_failed', errorText(error));
    }
  };

  const saveSettings = async () => {
    try {
      await Risuai.pluginStorage?.setItem?.(SETTINGS_KEY, settings);
    } catch (error) {
      console.warn(LOG, 'settings.save_failed', errorText(error));
    }
  };

  const upsertDefaultVariable = (source, key, value) => {
    const lines = String(source || '').replace(/\r\n/g, '\n').split('\n');
    const prefix = `${key}=`;
    const out = [];
    let replaced = false;
    for (const line of lines) {
      if (line.startsWith(prefix)) {
        if (!replaced) out.push(`${prefix}${value}`);
        replaced = true;
      } else if (line !== '' || out.length > 0) {
        out.push(line);
      }
    }
    if (!replaced) out.push(`${prefix}${value}`);
    return out.join('\n').replace(/^\n+|\n+$/g, '');
  };

  const endpointDefaultVariables = (source, endpoint) => {
    let next = upsertDefaultVariable(source, ENDPOINT_VARIABLE_V2, endpoint);
    next = upsertDefaultVariable(next, ENDPOINT_VARIABLE_LEGACY, endpoint);
    return next;
  };

  const persistEndpointForCurrentCharacter = async (endpoint) => {
    if (typeof Risuai.getCharacter !== 'function' || typeof Risuai.setCharacter !== 'function') {
      throw new Error('현재 Risu에서 캐릭터 설정 저장 API를 사용할 수 없습니다.');
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const character = await Risuai.getCharacter();
      if (!character || typeof character !== 'object') throw new Error('현재 캐릭터를 찾을 수 없습니다.');
      const characterId = String(character.chaId || '');
      if (!characterId) throw new Error('현재 캐릭터의 안정 ID를 찾을 수 없습니다.');
      const next = endpointDefaultVariables(character.defaultVariables, endpoint);
      if (String(character.defaultVariables || '') === next) {
        return { changed: false, characterId };
      }

      // setCharacter() always targets the character selected at call time. Re-read
      // once so a navigation in progress cannot apply the previous snapshot to it.
      const latest = await Risuai.getCharacter();
      if (!latest || String(latest.chaId || '') !== characterId) continue;
      const latestNext = endpointDefaultVariables(latest.defaultVariables, endpoint);
      if (String(latest.defaultVariables || '') === latestNext) {
        return { changed: false, characterId };
      }
      latest.defaultVariables = latestNext;
      await Risuai.setCharacter(latest);
      return { changed: true, characterId };
    }
    throw new Error('캐릭터 전환이 끝나지 않아 서버 주소 동기화를 보류했습니다.');
  };

  const synchronizeEndpointForCurrentCharacter = async (source) => {
    if (!settings.configured || !baseEndpoint) return false;
    while (characterSyncPromise) await characterSyncPromise;
    const task = (async () => {
      try {
        const result = await persistEndpointForCurrentCharacter(baseEndpoint);
        lastSynchronizedCharacterId = result.characterId;
        lastCharacterSyncError = '';
        endpointPersistWarning = '';
        if (result.changed || debugEnabled) {
          console.log(LOG, 'character_endpoint.synced', JSON.stringify({
            source,
            changed: result.changed,
            characterId: result.characterId,
            key: ENDPOINT_VARIABLE_V2,
          }));
        }
        return result.changed;
      } catch (error) {
        const message = errorText(error);
        if (message !== lastCharacterSyncError) {
          lastCharacterSyncError = message;
          console.warn(LOG, 'character_endpoint.sync_deferred', source, message);
        }
        if (dashboardOpen) {
          endpointPersistWarning = `현재 캐릭터에는 서버 주소를 반영하지 못했습니다: ${message}`;
        }
        return false;
      }
    })();
    characterSyncPromise = task;
    try {
      return await task;
    } finally {
      if (characterSyncPromise === task) characterSyncPromise = null;
    }
  };

  const scheduleEndpointSyncForCurrentCharacter = (source, delay = CHARACTER_SYNC_DEBOUNCE_MS) => {
    if (!settings.configured || !baseEndpoint) return;
    if (characterSyncTimer !== null) clearTimeout(characterSyncTimer);
    characterSyncTimer = setTimeout(async () => {
      characterSyncTimer = null;
      if (lastSynchronizedCharacterId && typeof Risuai.getCurrentCharacterIndex === 'function') {
        try {
          const selected = String(await Risuai.getCurrentCharacterIndex() ?? '');
          if (selected === lastSynchronizedCharacterId) return;
        } catch (_) {}
      }
      void synchronizeEndpointForCurrentCharacter(source);
    }, delay);
  };

  const fetchJson = async (pathname, options = {}) => {
    const method = String(options.method || 'GET').toUpperCase();
    const requestOptions = {
      method,
      networkRoute: 'local_network',
      requestTimeoutMs: 8000,
    };
    if (options.body !== undefined) {
      requestOptions.headers = { 'Content-Type': 'application/json' };
      requestOptions.body = JSON.stringify(options.body);
    }
    const response = await Risuai.nativeFetch(`${baseEndpoint}${pathname}`, {
      ...requestOptions,
    });
    if (!response?.ok) {
      let detail = '';
      try {
        const payload = await response.json();
        detail = String(payload?.error || '');
      } catch (_) {}
      throw new Error(detail || `${pathname} HTTP ${response?.status ?? 'unknown'}`);
    }
    const value = await response.json();
    if (!value || typeof value !== 'object') throw new Error(`${pathname} returned invalid JSON`);
    return value;
  };

  const normalizeBotPayload = (payload) => {
    const bots = [];
    const seen = new Set();
    for (const raw of Array.isArray(payload?.bots) ? payload.bots : []) {
      const name = String(raw || '').trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      bots.push(name);
    }
    const selected = String(payload?.bot_selected || '').trim();
    return { bots, selected };
  };

  const loadBotSelection = async () => {
    if (!settings.configured || !baseEndpoint) return;
    botState = { ...botState, loading: true, error: '' };
    renderDashboard();
    try {
      const payload = await fetchJson('/api/illustration_context/bridge/bots');
      const normalized = normalizeBotPayload(payload);
      botState = {
        loading: false,
        saving: false,
        bots: normalized.bots,
        selected: normalized.selected,
        draft: normalized.selected,
        error: '',
      };
    } catch (error) {
      botState = { ...botState, loading: false, saving: false, error: errorText(error) };
    }
    renderDashboard(true);
  };

  const saveBotSelection = async (selected) => {
    const previous = botState.selected;
    botState = { ...botState, saving: true, draft: selected, error: '' };
    renderDashboard(true);
    try {
      const payload = await fetchJson('/api/illustration_context/bridge/bots', {
        method: 'POST',
        body: { bot_selected: selected },
      });
      const normalized = normalizeBotPayload(payload);
      botState = {
        loading: false,
        saving: false,
        bots: normalized.bots,
        selected: normalized.selected,
        draft: normalized.selected,
        error: '',
      };
    } catch (error) {
      botState = {
        ...botState,
        saving: false,
        selected: previous,
        draft: previous,
        error: errorText(error),
      };
    }
    renderDashboard(true);
  };

  const exactSlots = (detail) => {
    if (!Array.isArray(detail?.items)) return [];
    const slots = [];
    const seen = new Set();
    for (const item of detail.items) {
      const slot = Number(item?.slot);
      if (!Number.isInteger(slot) || slot < -1 || seen.has(slot)) continue;
      seen.add(slot);
      slots.push(slot);
    }
    return slots;
  };

  const enrichSession = async (summary) => {
    const sessionId = String(summary?.session_id || '');
    const status = String(summary?.status || 'missing');
    const phase = String(summary?.progress?.phase || '');
    if (phase === 'regenerating') return { ...summary, slots: [] };
    if (!sessionId || status !== 'ready') return { ...summary, slots: [] };
    const updatedAt = safeNumber(summary?.updated_at);
    const cached = manifestCache.get(sessionId);
    if (cached && cached.updatedAt === updatedAt) return { ...summary, slots: cached.slots };
    const detail = await fetchJson(
      `/api/illustration_context/bridge/session/${encodeURIComponent(sessionId)}`,
    );
    const slots = exactSlots(detail);
    if (slots.length < 1 || slots.length > MAX_EXACT_SLOT_COUNT) {
      throw new Error(`invalid exact slot manifest: session=${sessionId} count=${slots.length}`);
    }
    manifestCache.set(sessionId, { updatedAt, slots });
    return { ...summary, status: detail.status || status, progress: detail.progress || summary.progress, slots };
  };

  const enrichSessionSafely = async (summary) => {
    const sessionId = String(summary?.session_id || '');
    try {
      const enriched = await enrichSession(summary);
      manifestFailureCache.delete(sessionId);
      return { ...enriched, manifestError: '' };
    } catch (error) {
      const message = errorText(error);
      const signature = `${safeNumber(summary?.updated_at)}:${message}`;
      if (manifestFailureCache.get(sessionId) !== signature) {
        manifestFailureCache.set(sessionId, signature);
        console.warn(LOG, 'session.manifest_failed', JSON.stringify({ session: sessionId, error: message }));
      }
      return { ...summary, slots: [], manifestError: message };
    }
  };

  const activeSessions = () => state.sessions.filter((session) => {
    const status = String(session?.status || 'missing').toLowerCase();
    const phase = String(session?.progress?.phase || '').toLowerCase();
    // Regeneration keeps the underlying session ready while work is active.
    if (phase === 'regenerating') return true;
    // Failed/cancelled sessions are terminal just like successful ready sessions.
    // Leaving them active keeps the floating progress window open forever.
    return !TERMINAL_SESSION_STATES.has(status) && !TERMINAL_SESSION_STATES.has(phase);
  });

  const stopTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const shouldContinuePolling = () => settings.configured && Boolean(baseEndpoint) && watchEnabled && (
    dashboardOpen
    || (state.online && activeSessions().length > 0)
    || watchSawActive
    || (!watchSawActive && Date.now() < armedUntil)
  );

  const schedulePoll = () => {
    stopTimer();
    if (!shouldContinuePolling()) return;
    const delay = state.online && (activeSessions().length > 0 || watchSawActive)
      ? pollMs
      : discoveryPollMs;
    timer = setTimeout(() => {
      timer = null;
      void poll();
    }, delay);
  };

  const pollNow = () => {
    stopTimer();
    if (!shouldContinuePolling() || polling) return;
    timer = setTimeout(() => {
      timer = null;
      void poll();
    }, 0);
  };

  const armSessionDiscovery = (source, waitMs = signalWaitMs) => {
    if (settings.configured && baseEndpoint && settings.floatingEnabled) {
      const wasWatching = watchSawActive || Date.now() < armedUntil;
      watchEnabled = true;
      armedUntil = Math.max(armedUntil, Date.now() + waitMs);
      if (!wasWatching) pollNow();
      if (debugEnabled) console.debug(LOG, 'session.discovery_signal', source);
    }
  };

  const generationInputHandler = async (content) => {
    if (characterSyncTimer !== null) {
      clearTimeout(characterSyncTimer);
      characterSyncTimer = null;
    }
    let alreadySynchronized = false;
    if (lastSynchronizedCharacterId && typeof Risuai.getCurrentCharacterIndex === 'function') {
      try {
        // Current Risu returns its selected character key here. The actual write
        // still verifies the stable character.chaId before setCharacter().
        const selected = String(await Risuai.getCurrentCharacterIndex() ?? '');
        alreadySynchronized = selected === lastSynchronizedCharacterId;
      } catch (_) {}
    }
    if (!alreadySynchronized) {
      await synchronizeEndpointForCurrentCharacter('generation-input');
    }
    return content;
  };

  const generationOutputHandler = (content) => {
    armSessionDiscovery('generation-output');
    return content;
  };

  const illustrationActionPointerHandler = async (event) => {
    const clientX = Number(event?.clientX);
    const clientY = Number(event?.clientY);
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return;
    try {
      const root = await Risuai.getRootDocument?.();
      if (!root) return;
      const buttons = await root.querySelectorAll(ACTION_BUTTON_SELECTOR);
      const length = await buttons.length();
      for (let index = 0; index < length; index += 1) {
        const button = await buttons.at(index);
        if (!button) continue;
        const rect = await button.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0) continue;
        if (clientX < rect.left || clientX > rect.right
          || clientY < rect.top || clientY > rect.bottom) continue;
        armSessionDiscovery('illustration-action-button');
        return;
      }
    } catch (error) {
      if (debugEnabled) console.debug(LOG, 'illustration.pointer_signal_skipped', errorText(error));
    }
  };

  const bindIllustrationActionSignal = async (body) => {
    if (illustrationSignalListenerId || regenerationBinding || !settings.configured || !baseEndpoint) return;
    regenerationBinding = true;
    try {
      if (!body) throw new Error('main DOM body unavailable');
      illustrationSignalListenerId = await body.addEventListener(
        'pointerdown', illustrationActionPointerHandler,
      );
      illustrationSignalRoot = body;
      regenerationBridgeUnavailableLogged = false;
    } catch (error) {
      if (!regenerationBridgeUnavailableLogged) {
        regenerationBridgeUnavailableLogged = true;
        console.warn(LOG, 'regeneration.signal_bridge_unavailable', errorText(error));
      }
    } finally {
      regenerationBinding = false;
    }
  };

  const initIllustrationActionSignalBridge = async () => {
    if (regenerationObserver || !settings.configured || !baseEndpoint) return;
    try {
      const root = await Risuai.getRootDocument?.();
      if (!root) throw new Error('main DOM access denied');
      const body = await root.querySelector('body');
      if (!body) throw new Error('main DOM body unavailable');
      await synchronizeEndpointForCurrentCharacter('signal-bridge-init');
      await bindIllustrationActionSignal(body);
      if (typeof Risuai.createMutationObserver !== 'function') {
        throw new Error('Risuai.createMutationObserver is unavailable');
      }
      regenerationObserver = await Risuai.createMutationObserver(() => {
        scheduleEndpointSyncForCurrentCharacter('character-navigation');
      });
      // Risu's SafeMutationObserver wraps mutation.target as SafeElement. A
      // characterData mutation targets a Text node and crashes that wrapper.
      await regenerationObserver.observe(body, { childList: true, subtree: true });
    } catch (error) {
      regenerationObserver = null;
      if (!regenerationBridgeUnavailableLogged) {
        regenerationBridgeUnavailableLogged = true;
        console.warn(LOG, 'regeneration.signal_bridge_unavailable', errorText(error));
      }
    }
  };

  const removeFloatingWindow = async () => {
    if (floatingWindow) {
      try { await floatingWindow.remove(); } catch (_) {}
    }
    floatingWindow = null;
    floatingSignature = '';
    try {
      const root = await Risuai.getRootDocument?.();
      const stack = await root?.querySelector?.(`.${FLOAT_STACK_CLASS}`);
      if (stack) await stack.remove();
    } catch (_) {}
  };

  const ensureFloatingWindow = async () => {
    const root = await Risuai.getRootDocument?.();
    if (!root) throw new Error('main DOM access denied');
    const body = await root.querySelector('body');
    if (!body) throw new Error('main DOM body unavailable');
    let stack = await root.querySelector(`.${FLOAT_STACK_CLASS}`);
    if (!stack) {
      stack = await root.createElement('div');
      await stack.addClass(FLOAT_STACK_CLASS);
      await stack.setInnerHTML(`<div style="position:fixed;top:14px;right:14px;z-index:${FLOAT_Z_INDEX};display:flex;flex-direction:column;gap:10px;pointer-events:none"></div>`);
      await body.appendChild(stack);
    }
    await stack.setStyle('display', '');
    const container = await root.querySelector(`.${FLOAT_STACK_CLASS} > div`);
    if (!container) throw new Error('floating stack container unavailable');
    await container.setStyle('position', 'fixed');
    await container.setStyle('top', `${settings.floatingOffsetY}px`);
    await container.setStyle('right', `${settings.floatingOffsetX}px`);
    await container.setStyle('zIndex', String(settings.floatingZIndex));
    await container.setStyle('display', 'flex');
    await container.setStyle('flexDirection', 'column');
    await container.setStyle('gap', '10px');
    await container.setStyle('pointerEvents', 'none');
    floatingWindow = await root.querySelector(`.${FLOAT_STACK_CLASS} > div > .${FLOAT_WINDOW_CLASS}`);
    if (!floatingWindow) {
      floatingWindow = await root.createElement('div');
      await floatingWindow.addClass(FLOAT_WINDOW_CLASS);
      await container.appendChild(floatingWindow);
    }
    return floatingWindow;
  };

  const renderFloatingWindow = async () => {
    const active = activeSessions();
    const showAlways = settings.floatingEnabled && settings.floatingAlwaysVisible;
    if (!settings.floatingEnabled || (!showAlways && (!state.online || active.length === 0))) {
      await removeFloatingWindow();
      return;
    }
    try {
      const floating = await ensureFloatingWindow();
      if (active.length > 0) {
        const rows = active.slice(0, 4).map((session) => {
          const progress = session?.progress || {};
          const phase = String(progress.phase || session?.status || 'processing');
          const percent = Math.max(0, Math.min(100, safeNumber(progress.value)));
          const done = Math.max(0, Math.trunc(safeNumber(progress.done)));
          const total = Math.max(0, Math.trunc(safeNumber(progress.total)));
          return `<div style="min-width:230px;max-width:310px;background:rgb(23 28 39 / 94%);color:#eaf0ff;border:1px solid #39445b;border-left:4px solid #68a7ff;border-radius:9px;padding:10px 12px;box-shadow:0 10px 28px rgb(0 0 0 / 35%);font:12px/1.45 Inter,system-ui,sans-serif">
            <div style="display:flex;justify-content:space-between;gap:10px"><strong>LightBoard 삽화</strong><span style="color:#9eabc5">${escapeHtml(phase)}</span></div>
            <div style="margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(progress.label || '서버 처리 중')}</div>
            <div style="height:5px;background:#293043;border-radius:99px;overflow:hidden;margin-top:8px"><i style="display:block;width:${percent}%;height:100%;background:linear-gradient(90deg,#5e8cff,#55d6be)"></i></div>
            <div style="display:flex;justify-content:space-between;color:#9eabc5;margin-top:5px"><span>${percent.toFixed(1)}%</span><span>${total > 0 ? `${done}/${total}` : ''}</span></div>
          </div>`;
        }).join('');
        await floating.setInnerHTML(rows);
        const nextFloatingSignature = active.map((session) => `${session?.session_id}:${session?.progress?.phase}:${session?.progress?.value}`).join('|');
        if (nextFloatingSignature !== floatingSignature) {
          floatingSignature = nextFloatingSignature;
          console.log(LOG, 'floating.shown', JSON.stringify({ count: active.length, zIndex: settings.floatingZIndex }));
        }
      } else {
        const placeholder = `<div style="min-width:230px;max-width:310px;background:rgb(23 28 39 / 94%);color:#eaf0ff;border:1px solid #39445b;border-left:4px solid #9eabc5;border-radius:9px;padding:10px 12px;box-shadow:0 10px 28px rgb(0 0 0 / 35%);font:12px/1.45 Inter,system-ui,sans-serif">
          <div style="display:flex;justify-content:space-between;gap:10px"><strong>LightBoard 삽화</strong><span style="color:#9eabc5">대기</span></div>
          <div style="margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">위치 확인용 미리보기 (활성 작업 없음)</div>
          <div style="height:5px;background:#293043;border-radius:99px;overflow:hidden;margin-top:8px"></div>
          <div style="display:flex;justify-content:space-between;color:#9eabc5;margin-top:5px"><span>항상 보이기</span><span>z ${settings.floatingZIndex}</span></div>
        </div>`;
        await floating.setInnerHTML(placeholder);
        floatingSignature = '';
      }
      await floating.setStyle('display', 'flex');
      await floating.setStyle('flexDirection', 'column');
      await floating.setStyle('gap', '8px');
      await floating.setStyle('visibility', 'visible');
      await floating.setStyle('opacity', '1');
      await floating.setStyle('pointerEvents', 'auto');
      floatingUnavailableLogged = false;
    } catch (error) {
      floatingWindow = null;
      if (!floatingUnavailableLogged) {
        floatingUnavailableLogged = true;
        console.warn(LOG, 'floating.unavailable', errorText(error));
      }
    }
  };

  const publishStateChange = () => {
    const signature = JSON.stringify({
      online: state.online,
      error: state.error,
      sessions: state.sessions.map((session) => ({
        id: session?.session_id,
        status: session?.status,
        phase: session?.progress?.phase,
        value: session?.progress?.value,
        done: session?.progress?.done,
        total: session?.progress?.total,
        slots: session?.slots,
        manifestError: session?.manifestError,
      })),
    });
    if (signature !== lastSignature) {
      lastSignature = signature;
      console.log(LOG, 'status.changed', signature);
    } else if (debugEnabled) {
      console.debug(LOG, 'status.unchanged');
    }
  };

  const renderDashboard = (force = false) => {
    if (!dashboardOpen) return;
    const liveEndpointInput = document.getElementById('lb-v42-endpoint');
    if (liveEndpointInput) {
      endpointDraft = String(liveEndpointInput.value || '');
    }
    const activeEl = document.activeElement;
    const activeId = activeEl && activeEl.id ? String(activeEl.id) : '';
    const editingInput = activeId === 'lb-v42-endpoint'
      || activeId === 'lb-v42-float-z'
      || activeId === 'lb-v42-float-x'
      || activeId === 'lb-v42-float-y';
    if (!force && (endpointEditing || editingInput)) return;
    const configured = settings.configured && Boolean(baseEndpoint);
    const endpointValue = endpointDraft || (configured ? baseEndpoint : (settings.endpoint || endpointPrefill));
    const connectionLabel = !configured ? '설정 전' : state.online ? '온라인' : state.checkedAt ? '연결 실패' : '확인 전';
    const dotColor = !configured ? '#7e8799' : state.online ? '#42d392' : '#ff647c';
    const armed = !watchSawActive && Date.now() < armedUntil;
    const botValue = String(botState.draft || '');
    const botNames = [...botState.bots];
    if (botValue && !botNames.includes(botValue)) botNames.unshift(botValue);
    const botOptions = [
      `<option value="" ${botValue === '' ? 'selected' : ''}>선택 안 함</option>`,
      ...botNames.map((name) => (
        `<option value="${escapeHtml(name)}" ${name === botValue ? 'selected' : ''}>${escapeHtml(name)}</option>`
      )),
    ].join('');
    const rows = state.sessions.map((session) => {
      const progress = session?.progress || {};
      const percent = Math.max(0, Math.min(100, safeNumber(progress.value)));
      const done = Math.max(0, Math.trunc(safeNumber(progress.done)));
      const total = Math.max(0, Math.trunc(safeNumber(progress.total)));
      const phase = String(progress.phase || session?.status || 'building');
      const status = String(session?.status || 'missing');
      return `<article class="session ${status === 'ready' ? 'ready' : status === 'error' ? 'error' : 'working'}">
        <div class="session-head"><code>${escapeHtml(session?.session_id || '')}</code><span class="badge">${escapeHtml(phase)}</span></div>
        <div class="label">${escapeHtml(progress.label || '처리 중')}</div>
        <div class="bar"><i style="width:${percent}%"></i></div>
        <div class="meta"><span>${percent.toFixed(1)}%</span><span>${total > 0 ? `${done} / ${total}` : ''}</span></div>
        ${Array.isArray(session?.slots) && session.slots.length ? `<div class="slots">slots: ${escapeHtml(session.slots.join(', '))}</div>` : ''}
        ${session?.manifestError ? `<div class="manifest-error">슬롯 메타데이터 경고: ${escapeHtml(session.manifestError)}</div>` : ''}
      </article>`;
    }).join('');

    document.documentElement.style.cssText = 'margin:0;width:100%;height:100%;overflow:hidden;';
    document.body.style.cssText = 'margin:0;width:100%;height:100%;overflow:hidden;background:#10131a;';
    document.body.innerHTML = `
      <style>
        #${ROOT_ID}{position:fixed;inset:0;z-index:${ROOT_Z_INDEX};overflow:auto;background:#10131a;color:#eef2ff;font-family:Inter,system-ui,sans-serif}
        #${ROOT_ID},#${ROOT_ID} *{box-sizing:border-box} #${ROOT_ID} .shell{max-width:900px;margin:0 auto;padding:24px}
        #${ROOT_ID} header,#${ROOT_ID} .session-head,#${ROOT_ID} .meta{display:flex;gap:12px;align-items:center;justify-content:space-between}
        #${ROOT_ID} h1{font-size:22px;margin:0} #${ROOT_ID} .sub,#${ROOT_ID} small{color:#aab3c8}
        #${ROOT_ID} button{border:1px solid #4d5870;background:#202838;color:#fff;border-radius:9px;padding:9px 14px;cursor:pointer}
        #${ROOT_ID} input[type=text],#${ROOT_ID} select{width:100%;border:1px solid #4d5870;background:#0f1420;color:#fff;border-radius:9px;padding:10px 12px}
        #${ROOT_ID} .config,#${ROOT_ID} .option,#${ROOT_ID} .server{border:1px solid #30394d;border-radius:12px;background:#171c27;padding:14px;margin:14px 0}
        #${ROOT_ID} .config-row{display:flex;gap:9px;margin-top:9px} #${ROOT_ID} .config-row input{flex:1}
        #${ROOT_ID} .option{display:flex;align-items:center;justify-content:space-between;gap:16px} #${ROOT_ID} .option label{display:flex;gap:9px;align-items:center;font-weight:650}
        #${ROOT_ID} .bot-select{align-items:flex-start} #${ROOT_ID} .bot-select label{min-width:120px;padding-top:10px} #${ROOT_ID} .bot-control{flex:1;display:flex;flex-direction:column;gap:7px}
        #${ROOT_ID} .floating-pos{flex-direction:column;align-items:stretch;gap:10px} #${ROOT_ID} .float-controls{display:flex;gap:10px;flex-wrap:wrap;margin-top:4px} #${ROOT_ID} .float-controls label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:#aab3c8} #${ROOT_ID} .float-controls input{width:92px;border:1px solid #4d5870;background:#0f1420;color:#fff;border-radius:9px;padding:8px 10px}
        #${ROOT_ID} .server{display:flex;gap:10px;align-items:center} #${ROOT_ID} .dot{width:10px;height:10px;border-radius:50%;background:${dotColor}}
        #${ROOT_ID} .error-text{color:#ff98a8;margin-left:auto;font-size:12px} #${ROOT_ID} .warning-text{display:block;color:#ffd479;margin-top:8px}
        #${ROOT_ID} .session{border:1px solid #30394d;border-left:4px solid #68a7ff;border-radius:12px;padding:14px;background:#171c27;margin:10px 0}
        #${ROOT_ID} .session.ready{border-left-color:#42d392} #${ROOT_ID} .session.error{border-left-color:#ff647c}
        #${ROOT_ID} code{font-size:12px;color:#c8d3ef;overflow-wrap:anywhere} #${ROOT_ID} .badge{font-size:11px;padding:3px 7px;border-radius:999px;background:#273149}
        #${ROOT_ID} .label{margin:12px 0 8px} #${ROOT_ID} .bar{height:7px;border-radius:999px;overflow:hidden;background:#293043}
        #${ROOT_ID} .bar i{display:block;height:100%;background:linear-gradient(90deg,#5e8cff,#55d6be)} #${ROOT_ID} .meta,#${ROOT_ID} .slots{font-size:12px;color:#9fa9be;margin-top:7px}
        #${ROOT_ID} .manifest-error{font-size:12px;color:#ffd479;margin-top:7px;overflow-wrap:anywhere}
        #${ROOT_ID} .empty{color:#9fa9be;padding:30px 0;text-align:center;border:1px dashed #3b455b;border-radius:12px}
        @media(max-width:640px){#${ROOT_ID} .shell{padding:14px}#${ROOT_ID} .config-row{flex-direction:column}}
      </style>
      <main id="${ROOT_ID}"><div class="shell">
        <header><div><h1>soya comfy manager v1.0.24</h1><div class="sub">v42.0.33 · 자동/수동 삽화 버튼 감시 · 에셋 리롤 · KEYVISUAL 안정화</div></div><button id="lb-v42-close">닫기</button></header>
        <section class="config"><strong>서버 HTTPS 주소</strong><div class="config-row"><input id="lb-v42-endpoint" type="text" value="${escapeHtml(endpointValue)}" placeholder="https://example.trycloudflare.com"><button id="lb-v42-save-check">저장 및 연결 확인</button><button id="lb-v42-refresh" ${configured ? '' : 'disabled'}>새로고침</button></div><div class="config-row"><button id="lb-v42-arm" ${configured ? '' : 'disabled'}>수동 감시 (10분)</button><button id="lb-v42-disarm" ${armed || watchSawActive ? '' : 'disabled'}>감시 중지</button><small>${armed ? '삽화 세션을 기다리는 중입니다.' : watchSawActive ? '활성 삽화 세션을 추적 중입니다.' : '일반 생성과 모듈의 전체/개별 생성 버튼을 자동 감지합니다.'}</small></div><small>한 번 저장하면 같은 서버 주소를 캐릭터 전환 시 자동 반영합니다. 짧은 슬롯 URL은 120자 이하여야 합니다.</small>${endpointPersistWarning ? `<small class="warning-text">${escapeHtml(endpointPersistWarning)}</small>` : ''}</section>
        <section class="option bot-select"><label for="lb-v42-bot-select">백엔드 활성 봇</label><div class="bot-control"><select id="lb-v42-bot-select" ${!configured || botState.loading || botState.saving ? 'disabled' : ''}>${botOptions}</select><small>${!configured ? '서버 주소를 먼저 저장하세요.' : botState.loading ? '백엔드 봇 목록을 불러오는 중입니다.' : botState.saving ? '활성 봇을 저장하는 중입니다.' : `${botState.bots.length}개 봇 · 선택 즉시 백엔드에 저장됩니다.`}</small>${botState.error ? `<small class="warning-text">${escapeHtml(botState.error)}</small>` : ''}</div></section>
        <section class="option"><label><input id="lb-v42-floating-enabled" type="checkbox" ${settings.floatingEnabled ? 'checked' : ''}>플로팅 진행창 활성화</label><small>활성 작업을 발견하면 provider-manager 방식의 창을 표시합니다.</small></section>
        <section class="option floating-pos"><label>플로팅 창 위치 · z-index</label><div class="float-controls"><label>z-index<input id="lb-v42-float-z" type="number" min="0" max="99999" value="${settings.floatingZIndex}"></label><label>오른쪽 여백<input id="lb-v42-float-x" type="number" min="0" max="4000" value="${settings.floatingOffsetX}"></label><label>위쪽 여백<input id="lb-v42-float-y" type="number" min="0" max="4000" value="${settings.floatingOffsetY}"></label></div><small>다른 플러그인 DOM과 겹칠 때 z-index를 낮추면 상대방 닫기 버튼이 위로 올라옵니다. 대시보드를 닫아야 플로팅 창이 보입니다.</small></section>
        <section class="option"><label><input id="lb-v42-float-always" type="checkbox" ${settings.floatingAlwaysVisible ? 'checked' : ''}>항상 보이기 (위치 잡기용)</label><small>활성 작업이 없어도 플로팅 창을 띄워 둡니다. 위치를 잡은 뒤 끄면 됩니다.</small></section>
        <section class="option"><label>대기 중 서버 요청</label><small>없음 · generation 신호 후 ${Math.round(discoveryPollMs / 1000)}초, 활성 작업 중 ${Math.round(pollMs / 1000)}초 간격 · Health 5분 캐시</small></section>
        <section class="server"><span class="dot"></span><div><strong>${connectionLabel}</strong><small>${configured ? ` · ${escapeHtml(baseEndpoint)}` : ' · 주소 저장 후 확인을 시작합니다.'}</small></div>${state.error ? `<span class="error-text">${escapeHtml(state.error)}</span>` : ''}</section>
        ${rows || '<div class="empty">조회된 삽화 세션이 없습니다.</div>'}
      </div></main>`;

    document.getElementById('lb-v42-endpoint')?.addEventListener('input', (event) => {
      endpointDraft = String(event.currentTarget?.value || '');
      endpointEditing = true;
    });
    document.getElementById('lb-v42-close')?.addEventListener('click', async () => {
      dashboardOpen = false;
      await Risuai.hideContainer();
      schedulePoll();
    });
    document.getElementById('lb-v42-bot-select')?.addEventListener('change', (event) => {
      const selected = String(event.currentTarget?.value || '');
      void saveBotSelection(selected);
    });
    document.getElementById('lb-v42-floating-enabled')?.addEventListener('change', async (event) => {
      settings.floatingEnabled = Boolean(event.currentTarget?.checked);
      await saveSettings();
      await renderFloatingWindow();
      schedulePoll();
    });
    document.getElementById('lb-v42-float-always')?.addEventListener('change', async (event) => {
      settings.floatingAlwaysVisible = Boolean(event.currentTarget?.checked);
      await saveSettings();
      await renderFloatingWindow();
      schedulePoll();
    });
    const bindFloatPositionInput = (id, key, min, max) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', (event) => {
        const v = safeNumber(event.currentTarget?.value);
        if (Number.isFinite(v)) settings[key] = Math.max(min, Math.min(max, Math.trunc(v)));
      });
      el.addEventListener('change', async () => {
        const current = document.getElementById(id);
        if (current) current.value = String(settings[key]);
        await saveSettings();
        await renderFloatingWindow();
      });
    };
    bindFloatPositionInput('lb-v42-float-z', 'floatingZIndex', 0, 99999);
    bindFloatPositionInput('lb-v42-float-x', 'floatingOffsetX', 0, 4000);
    bindFloatPositionInput('lb-v42-float-y', 'floatingOffsetY', 0, 4000);
    document.getElementById('lb-v42-save-check')?.addEventListener('click', async () => {
      try {
        const endpointInput = document.getElementById('lb-v42-endpoint');
        const endpoint = normalizeEndpoint(endpointInput ? endpointInput.value : endpointDraft);
        endpointDraft = endpoint;
        endpointEditing = false;
        baseEndpoint = endpoint;
        settings.endpoint = endpoint;
        settings.configured = true;
        watchEnabled = true;
        healthCheckedAt = 0;
        manifestCache.clear();
        manifestFailureCache.clear();
        state = { online: false, error: '', checkedAt: 0, health: null, sessions: [] };
        botState = {
          loading: false, saving: false, bots: [], selected: '', draft: '', error: '',
        };
        await saveSettings();
        try {
          const result = await persistEndpointForCurrentCharacter(endpoint);
          lastSynchronizedCharacterId = result.characterId;
          if (result.changed || debugEnabled) {
            console.log(LOG, 'character_endpoint.synced', JSON.stringify({
              source: 'dashboard-save',
              changed: result.changed,
              characterId: result.characterId,
              key: ENDPOINT_VARIABLE_V2,
            }));
          }
          lastCharacterSyncError = '';
          endpointPersistWarning = '';
        } catch (error) {
          endpointPersistWarning = `서버 주소는 저장되었습니다. 현재 캐릭터에는 반영하지 못했습니다: ${errorText(error)} 캐릭터 채팅에서 대시보드를 다시 열면 자동으로 재시도합니다.`;
          console.warn(LOG, 'character_endpoint.save_deferred', errorText(error));
        }
        renderDashboard();
        void initIllustrationActionSignalBridge();
        await poll();
        await loadBotSelection();
      } catch (error) {
        state = { ...state, online: false, error: errorText(error), checkedAt: Date.now() };
        renderDashboard(true);
      }
    });
    document.getElementById('lb-v42-refresh')?.addEventListener('click', async () => {
      watchEnabled = true;
      await poll();
      await loadBotSelection();
    });
    document.getElementById('lb-v42-arm')?.addEventListener('click', async () => {
      watchEnabled = true;
      watchSawActive = false;
      inactiveConfirmationPolls = 0;
      armedUntil = Date.now() + (10 * 60 * 1000);
      renderDashboard();
      await poll();
    });
    document.getElementById('lb-v42-disarm')?.addEventListener('click', async () => {
      armedUntil = 0;
      watchSawActive = false;
      watchEnabled = false;
      stopTimer();
      state = { ...state, sessions: [] };
      await renderFloatingWindow();
      renderDashboard();
    });
  };

  const getCompatibleHealth = async () => {
    const now = Date.now();
    if (state.health && now - healthCheckedAt < HEALTH_CACHE_MS) return state.health;
    const health = await fetchJson('/api/illustration_context/bridge/health');
    if (health?.ok !== true || safeNumber(health?.version) < 10
        || health?.short_slot_manifest !== true || safeNumber(health?.lookup_key_length) !== 24
        || safeNumber(health?.max_slot_manifest_count) !== MAX_EXACT_SLOT_COUNT
        || health?.bot_selection !== true || health?.easy_edit !== true
        || health?.slot_animation_metadata !== true
        || health?.asset_display_metadata !== true
        || health?.asset_reroll !== true) {
      throw new Error('server does not advertise the v42 protocol 10 controls');
    }
    healthCheckedAt = now;
    return health;
  };

  async function poll() {
    if (polling || !settings.configured || !baseEndpoint) return;
    polling = true;
    stopTimer();
    try {
      const health = await getCompatibleHealth();
      const [sessionData, botPayload] = await Promise.all([
        fetchJson('/api/illustration_context/bridge/sessions?limit=20'),
        fetchJson('/api/illustration_context/bridge/bots').catch((e) => {
          console.warn(LOG, 'poll.bot_selection.fetch_failed', errorText(e));
          return null;
        }),
      ]);
      // 봇 선택 동기화 — 사용자가 드롭다운을 편집 중이거나 저장 중일 때는 덮어쓰지 않는다.
      // (프론트 삽화 백업 탭이나 다른 곳에서 활성봇을 바꾼 경우 폴링 주기 내 반영)
      if (botPayload && !botState.saving && botState.draft === botState.selected) {
        const normalized = normalizeBotPayload(botPayload);
        if (normalized.bots.length) botState = { ...botState, bots: normalized.bots };
        if (normalized.selected !== botState.selected) {
          botState = { ...botState, selected: normalized.selected, draft: normalized.selected };
        }
      }
      if (!Array.isArray(sessionData?.sessions)) throw new Error('sessions response has no array');
      const sessions = await Promise.all(sessionData.sessions.map(enrichSessionSafely));
      state = { online: true, error: '', checkedAt: Date.now(), health, sessions };
      if (activeSessions().length > 0) {
        watchSawActive = true;
        inactiveConfirmationPolls = 0;
      } else if (watchSawActive) {
        inactiveConfirmationPolls += 1;
        if (inactiveConfirmationPolls >= COMPLETION_CONFIRM_POLLS) {
          watchSawActive = false;
          inactiveConfirmationPolls = 0;
          armedUntil = 0;
        }
      }
    } catch (error) {
      state = { ...state, online: false, error: errorText(error), checkedAt: Date.now(), sessions: [] };
    } finally {
      polling = false;
      publishStateChange();
      renderDashboard();
      await renderFloatingWindow();
      schedulePoll();
    }
  }

  const openDashboard = async () => {
    dashboardOpen = true;
    watchEnabled = true;
    if (!endpointDraft) endpointDraft = settings.endpoint || baseEndpoint || endpointPrefill;
    await Risuai.showContainer('fullscreen');
    if (settings.configured && baseEndpoint) {
      try {
        const result = await persistEndpointForCurrentCharacter(baseEndpoint);
        lastSynchronizedCharacterId = result.characterId;
        if (result.changed || debugEnabled) {
          console.log(LOG, 'character_endpoint.synced', JSON.stringify({
            source: 'dashboard-open',
            changed: result.changed,
            characterId: result.characterId,
            key: ENDPOINT_VARIABLE_V2,
          }));
        }
        lastCharacterSyncError = '';
        endpointPersistWarning = '';
      } catch (error) {
        endpointPersistWarning = `현재 캐릭터에는 서버 주소를 반영하지 못했습니다: ${errorText(error)} 캐릭터 채팅에서 대시보드를 다시 열면 자동으로 재시도합니다.`;
        console.warn(LOG, 'character_endpoint.save_deferred', errorText(error));
      }
    }
    renderDashboard();
    if (settings.configured && baseEndpoint) {
      await poll();
      await loadBotSelection();
    }
  };

  try {
    endpointPrefill = String(await getArgument('END_POINT', '')).trim().replace(/\/+$/, '');
    pollMs = Math.max(500, Math.min(10000, Math.trunc(Number(await getArgument('POLL_MS', 1000)) || 1000)));
    discoveryPollMs = Math.max(500, Math.min(10000, Math.trunc(Number(await getArgument('DISCOVERY_POLL_MS', 2000)) || 2000)));
    signalWaitMs = Math.max(5000, Math.min(120000, Math.trunc(Number(await getArgument('SIGNAL_WAIT_MS', 30000)) || 30000)));
    debugEnabled = String(await getArgument('DEBUG', '0')) === '1';
    await loadSettings();
    if (settings.configured) {
      try { baseEndpoint = normalizeEndpoint(settings.endpoint); }
      catch (_) { settings.configured = false; baseEndpoint = ''; }
    }
    if (typeof Risuai.registerSetting !== 'function') throw new Error('Risuai.registerSetting is unavailable');
    await Risuai.registerSetting('soya comfy 플러그인', openDashboard, SETTINGS_ICON, 'html');
    if (typeof Risuai.addRisuScriptHandler === 'function') {
      await Risuai.addRisuScriptHandler('input', generationInputHandler);
      generationInputHookRegistered = true;
      await Risuai.addRisuScriptHandler('output', generationOutputHandler);
      generationHookRegistered = true;
    } else {
      console.warn(LOG, 'generation.output_hook_unavailable; use manual watcher for every run');
    }
    console.log(LOG, 'plugin.boot', JSON.stringify({
      module_expected: 'soya-v60',
      expected_module_connection_gate_ms: 5000,
      role: 'endpoint-config-and-status-observer',
      initial_health_request: false,
      polling: 'idle=off; generation-signal=discovery; active=fast',
      generation_input_endpoint_sync: generationInputHookRegistered,
      generation_output_hook: generationHookRegistered,
      character_endpoint_sync: 'event-driven; polling=off',
      endpoint_variable_priority: [ENDPOINT_VARIABLE_V2, ENDPOINT_VARIABLE_LEGACY],
      illustration_action_button_signals: ['regenerate-all', 'generate-all', 'reroll-assets', 'gen', 'edit'],
      raw_regeneration_floating: true,
      manual_after_reply_mode: true,
      module_image_transport: 'all-slots-media-metadata+asset-display-controls+server-url+persistent-risu-png-fallback',
      completion_confirm_polls: COMPLETION_CONFIRM_POLLS,
      discovery_poll_ms: discoveryPollMs,
      signal_wait_ms: signalWaitMs,
      active_poll_ms: pollMs,
      health_cache_ms: HEALTH_CACHE_MS,
      lookup_key_length: LOOKUP_KEY_LENGTH,
      max_exact_slot_count: MAX_EXACT_SLOT_COUNT,
      character_config_access: true,
      message_array_access: false,
      target_message_index_access: false,
      image_transport: false,
      fullscreen_z_index: ROOT_Z_INDEX,
      floating_z_index: settings.floatingZIndex,
      floating_always_visible: settings.floatingAlwaysVisible,
      floating_position: { right: settings.floatingOffsetX, top: settings.floatingOffsetY },
    }));
    if (settings.configured && baseEndpoint) void initIllustrationActionSignalBridge();
    void renderFloatingWindow();
    await Risuai.onUnload(async () => {
      watchEnabled = false;
      stopTimer();
      if (characterSyncTimer !== null) clearTimeout(characterSyncTimer);
      characterSyncTimer = null;
      dashboardOpen = false;
      if (regenerationObserver) {
        try { await regenerationObserver.disconnect(); } catch (_) {}
        regenerationObserver = null;
      }
      if (illustrationSignalRoot && illustrationSignalListenerId) {
        try {
          await illustrationSignalRoot.removeEventListener(
            'pointerdown', illustrationSignalListenerId,
          );
        } catch (_) {}
      }
      illustrationSignalRoot = null;
      illustrationSignalListenerId = '';
      if (generationHookRegistered && typeof Risuai.removeRisuScriptHandler === 'function') {
        try { await Risuai.removeRisuScriptHandler('output', generationOutputHandler); } catch (_) {}
      }
      if (generationInputHookRegistered && typeof Risuai.removeRisuScriptHandler === 'function') {
        try { await Risuai.removeRisuScriptHandler('input', generationInputHandler); } catch (_) {}
      }
      await removeFloatingWindow();
      console.log(LOG, 'plugin.unload');
    });
  } catch (error) {
    stopTimer();
    await removeFloatingWindow();
    console.error(LOG, 'plugin.boot_failed', errorText(error));
    try { await Risuai.alertError(`삽화 v42 상태 플러그인 시작 실패:\n${errorText(error)}`); } catch (_) {}
  }
})();
