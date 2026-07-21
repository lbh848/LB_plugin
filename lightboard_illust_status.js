//@name lightboard-illust-status-v42
//@display-name LightBoard Illust Status v42 (Generation-triggered Floating)
//@api 3.0
//@version 42.0.5
//@author soya
//@update-url https://raw.githubusercontent.com/lbh848/LB_plugin/main/lightboard_illust_status.js
//@arg END_POINT string Dashboard endpoint prefill (default: empty)
//@arg POLL_MS int Active status polling interval in milliseconds (default: 1000)
//@arg DISCOVERY_POLL_MS int Generation-triggered discovery interval in milliseconds (default: 2000)
//@arg SIGNAL_WAIT_MS int Time to wait for an illustration session after generation output (default: 30000)
//@arg DEBUG int Diagnostic logging (1: enabled, 0: state changes only)

// Configuration/status-only companion for soya-v42.
// - Importing the plugin never performs a health or status request.
// - The dashboard saves an HTTPS endpoint to the current character before checking health.
// - The unchanged Risu generation-output channel arms short-lived session discovery.
// - CALL1 full regeneration, RAW whole generation, and RAW per-slot regeneration
//   buttons all arm discovery without reading their chat-index payloads.
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
  const ENDPOINT_VARIABLE = 'lb-xnai-server-endpoint';
  const LOOKUP_KEY_LENGTH = 24;
  const ACTION_BUTTON_SELECTOR = [
    'button[risu-btn^="lb-xnai-regenerate-all/"]',
    'button[risu-btn^="lb-xnai-generate-all/"]',
    'button[risu-btn^="lb-xnai-gen/"]',
  ].join(',');
  const ACTION_BOUND_ATTRIBUTE = 'x-lb-illust-v42-status-bound';
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
  let generationHookRegistered = false;
  let regenerationObserver = null;
  let regenerationBinding = false;
  let regenerationBridgeUnavailableLogged = false;
  const HEALTH_CACHE_MS = 5 * 60 * 1000;
  const COMPLETION_CONFIRM_POLLS = 3;
  const manifestCache = new Map();
  let settings = {
    endpoint: '',
    configured: false,
    floatingEnabled: true,
  };
  let state = {
    online: false,
    error: '',
    checkedAt: 0,
    health: null,
    sessions: [],
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
    const manifestLength = endpoint.length + '/s/'.length + LOOKUP_KEY_LENGTH;
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

  const persistEndpointForCurrentCharacter = async (endpoint) => {
    if (typeof Risuai.getCharacter !== 'function' || typeof Risuai.setCharacter !== 'function') {
      throw new Error('현재 Risu에서 캐릭터 설정 저장 API를 사용할 수 없습니다.');
    }
    const character = await Risuai.getCharacter();
    if (!character || typeof character !== 'object') throw new Error('현재 캐릭터를 찾을 수 없습니다.');
    const next = upsertDefaultVariable(character.defaultVariables, ENDPOINT_VARIABLE, endpoint);
    if (String(character.defaultVariables || '') !== next) {
      character.defaultVariables = next;
      await Risuai.setCharacter(character);
    }
  };

  const fetchJson = async (pathname) => {
    const response = await Risuai.nativeFetch(`${baseEndpoint}${pathname}`, {
      method: 'GET',
      networkRoute: 'local_network',
      requestTimeoutMs: 8000,
    });
    if (!response?.ok) throw new Error(`${pathname} HTTP ${response?.status ?? 'unknown'}`);
    const value = await response.json();
    if (!value || typeof value !== 'object') throw new Error(`${pathname} returned invalid JSON`);
    return value;
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
    if (slots.length < 1 || slots.length > 16) {
      throw new Error(`invalid exact slot manifest: session=${sessionId} count=${slots.length}`);
    }
    manifestCache.set(sessionId, { updatedAt, slots });
    return { ...summary, status: detail.status || status, progress: detail.progress || summary.progress, slots };
  };

  const activeSessions = () => state.sessions.filter((session) => {
    const status = String(session?.status || 'missing');
    const phase = String(session?.progress?.phase || '');
    return status !== 'ready' || phase === 'regenerating';
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

  const generationOutputHandler = (content) => {
    armSessionDiscovery('generation-output');
    return content;
  };

  const illustrationActionClickHandler = () => {
    armSessionDiscovery('illustration-action-button');
  };

  const bindIllustrationActionButtons = async () => {
    if (regenerationBinding || !settings.configured || !baseEndpoint) return;
    regenerationBinding = true;
    try {
      const root = await Risuai.getRootDocument?.();
      if (!root) throw new Error('main DOM access denied');
      const buttons = await root.querySelectorAll(ACTION_BUTTON_SELECTOR);
      const length = await buttons.length();
      for (let index = 0; index < length; index += 1) {
        const button = await buttons.at(index);
        if (!button) continue;
        if (await button.getAttribute(ACTION_BOUND_ATTRIBUTE) === '1') continue;
        await button.setAttribute(ACTION_BOUND_ATTRIBUTE, '1');
        await button.addEventListener('click', illustrationActionClickHandler);
      }
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
      await bindIllustrationActionButtons();
      if (typeof Risuai.createMutationObserver !== 'function') {
        throw new Error('Risuai.createMutationObserver is unavailable');
      }
      regenerationObserver = await Risuai.createMutationObserver(() => {
        void bindIllustrationActionButtons();
      });
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
    if (floatingWindow) return floatingWindow;
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
    await container.setStyle('top', '14px');
    await container.setStyle('right', '14px');
    await container.setStyle('zIndex', String(FLOAT_Z_INDEX));
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
    if (!settings.floatingEnabled || !state.online || active.length === 0) {
      await removeFloatingWindow();
      return;
    }
    try {
      const floating = await ensureFloatingWindow();
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
      await floating.setStyle('display', 'flex');
      await floating.setStyle('flexDirection', 'column');
      await floating.setStyle('gap', '8px');
      await floating.setStyle('visibility', 'visible');
      await floating.setStyle('opacity', '1');
      await floating.setStyle('pointerEvents', 'auto');
      const nextFloatingSignature = active.map((session) => `${session?.session_id}:${session?.progress?.phase}:${session?.progress?.value}`).join('|');
      if (nextFloatingSignature !== floatingSignature) {
        floatingSignature = nextFloatingSignature;
        console.log(LOG, 'floating.shown', JSON.stringify({ count: active.length, zIndex: FLOAT_Z_INDEX }));
      }
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
      if (!force && (endpointEditing || document.activeElement === liveEndpointInput)) return;
    }
    const configured = settings.configured && Boolean(baseEndpoint);
    const endpointValue = endpointDraft || (configured ? baseEndpoint : (settings.endpoint || endpointPrefill));
    const connectionLabel = !configured ? '설정 전' : state.online ? '온라인' : state.checkedAt ? '연결 실패' : '확인 전';
    const dotColor = !configured ? '#7e8799' : state.online ? '#42d392' : '#ff647c';
    const armed = !watchSawActive && Date.now() < armedUntil;
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
        #${ROOT_ID} input[type=text]{width:100%;border:1px solid #4d5870;background:#0f1420;color:#fff;border-radius:9px;padding:10px 12px}
        #${ROOT_ID} .config,#${ROOT_ID} .option,#${ROOT_ID} .server{border:1px solid #30394d;border-radius:12px;background:#171c27;padding:14px;margin:14px 0}
        #${ROOT_ID} .config-row{display:flex;gap:9px;margin-top:9px} #${ROOT_ID} .config-row input{flex:1}
        #${ROOT_ID} .option{display:flex;align-items:center;justify-content:space-between;gap:16px} #${ROOT_ID} .option label{display:flex;gap:9px;align-items:center;font-weight:650}
        #${ROOT_ID} .server{display:flex;gap:10px;align-items:center} #${ROOT_ID} .dot{width:10px;height:10px;border-radius:50%;background:${dotColor}}
        #${ROOT_ID} .error-text{color:#ff98a8;margin-left:auto;font-size:12px}
        #${ROOT_ID} .session{border:1px solid #30394d;border-left:4px solid #68a7ff;border-radius:12px;padding:14px;background:#171c27;margin:10px 0}
        #${ROOT_ID} .session.ready{border-left-color:#42d392} #${ROOT_ID} .session.error{border-left-color:#ff647c}
        #${ROOT_ID} code{font-size:12px;color:#c8d3ef;overflow-wrap:anywhere} #${ROOT_ID} .badge{font-size:11px;padding:3px 7px;border-radius:999px;background:#273149}
        #${ROOT_ID} .label{margin:12px 0 8px} #${ROOT_ID} .bar{height:7px;border-radius:999px;overflow:hidden;background:#293043}
        #${ROOT_ID} .bar i{display:block;height:100%;background:linear-gradient(90deg,#5e8cff,#55d6be)} #${ROOT_ID} .meta,#${ROOT_ID} .slots{font-size:12px;color:#9fa9be;margin-top:7px}
        #${ROOT_ID} .empty{color:#9fa9be;padding:30px 0;text-align:center;border:1px dashed #3b455b;border-radius:12px}
        @media(max-width:640px){#${ROOT_ID} .shell{padding:14px}#${ROOT_ID} .config-row{flex-direction:column}}
      </style>
      <main id="${ROOT_ID}"><div class="shell">
        <header><div><h1>LightBoard 삽화 서버 상태</h1><div class="sub">v42.0.4 · generation/전체/개별 재생성 신호가 있을 때만 조회 · 이미지 및 메시지 인덱스 접근 없음</div></div><button id="lb-v42-close">닫기</button></header>
        <section class="config"><strong>서버 HTTPS 주소</strong><div class="config-row"><input id="lb-v42-endpoint" type="text" value="${escapeHtml(endpointValue)}" placeholder="https://example.trycloudflare.com"><button id="lb-v42-save-check">저장 및 연결 확인</button><button id="lb-v42-refresh" ${configured ? '' : 'disabled'}>새로고침</button></div><div class="config-row"><button id="lb-v42-arm" ${configured ? '' : 'disabled'}>수동 감시 (10분)</button><button id="lb-v42-disarm" ${armed || watchSawActive ? '' : 'disabled'}>감시 중지</button><small>${armed ? '삽화 세션을 기다리는 중입니다.' : watchSawActive ? '활성 삽화 세션을 추적 중입니다.' : '일반 생성과 모듈의 전체/개별 생성 버튼을 자동 감지합니다.'}</small></div><small>저장하면 현재 캐릭터의 모듈 설정에 반영됩니다. 짧은 슬롯 URL은 120자 이하여야 합니다.</small></section>
        <section class="option"><label><input id="lb-v42-floating-enabled" type="checkbox" ${settings.floatingEnabled ? 'checked' : ''}>플로팅 진행창 활성화</label><small>활성 작업을 발견하면 provider-manager 방식의 창을 표시합니다.</small></section>
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
    document.getElementById('lb-v42-floating-enabled')?.addEventListener('change', async (event) => {
      settings.floatingEnabled = Boolean(event.currentTarget?.checked);
      await saveSettings();
      await renderFloatingWindow();
      schedulePoll();
    });
    document.getElementById('lb-v42-save-check')?.addEventListener('click', async () => {
      try {
        const endpoint = normalizeEndpoint(endpointDraft || document.getElementById('lb-v42-endpoint')?.value);
        await persistEndpointForCurrentCharacter(endpoint);
        endpointDraft = endpoint;
        endpointEditing = false;
        baseEndpoint = endpoint;
        settings.endpoint = endpoint;
        settings.configured = true;
        watchEnabled = true;
        healthCheckedAt = 0;
        state = { ...state, online: false, error: '', checkedAt: 0, sessions: [] };
        await saveSettings();
        renderDashboard();
        void initIllustrationActionSignalBridge();
        await poll();
      } catch (error) {
        state = { ...state, online: false, error: errorText(error), checkedAt: Date.now() };
        renderDashboard(true);
      }
    });
    document.getElementById('lb-v42-refresh')?.addEventListener('click', async () => {
      watchEnabled = true;
      await poll();
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
      await removeFloatingWindow();
      renderDashboard();
    });
  };

  const getCompatibleHealth = async () => {
    const now = Date.now();
    if (state.health && now - healthCheckedAt < HEALTH_CACHE_MS) return state.health;
    const health = await fetchJson('/api/illustration_context/bridge/health');
    if (health?.ok !== true || safeNumber(health?.version) < 5
        || health?.short_slot_manifest !== true || safeNumber(health?.lookup_key_length) !== 24) {
      throw new Error('server does not advertise the v42 short-slot protocol');
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
      const sessionData = await fetchJson('/api/illustration_context/bridge/sessions?limit=20');
      if (!Array.isArray(sessionData?.sessions)) throw new Error('sessions response has no array');
      const sessions = await Promise.all(sessionData.sessions.map(enrichSession));
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
      try { await persistEndpointForCurrentCharacter(baseEndpoint); } catch (error) {
        state = { ...state, error: errorText(error) };
      }
    }
    renderDashboard();
    if (settings.configured && baseEndpoint) await poll();
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
    await Risuai.registerSetting('삽화 서버 상태', openDashboard, SETTINGS_ICON, 'html');
    if (typeof Risuai.addRisuScriptHandler === 'function') {
      await Risuai.addRisuScriptHandler('output', generationOutputHandler);
      generationHookRegistered = true;
    } else {
      console.warn(LOG, 'generation.output_hook_unavailable; use manual watcher for every run');
    }
    console.log(LOG, 'plugin.boot', JSON.stringify({
      module_expected: 'soya-v42',
      role: 'endpoint-config-and-status-observer',
      initial_health_request: false,
      polling: 'idle=off; generation-signal=discovery; active=fast',
      generation_output_hook: generationHookRegistered,
      illustration_action_button_signals: ['regenerate-all', 'generate-all', 'gen'],
      raw_regeneration_floating: true,
      completion_confirm_polls: COMPLETION_CONFIRM_POLLS,
      discovery_poll_ms: discoveryPollMs,
      signal_wait_ms: signalWaitMs,
      active_poll_ms: pollMs,
      health_cache_ms: HEALTH_CACHE_MS,
      lookup_key_length: LOOKUP_KEY_LENGTH,
      character_config_access: true,
      message_array_access: false,
      target_message_index_access: false,
      image_transport: false,
      fullscreen_z_index: ROOT_Z_INDEX,
      floating_z_index: FLOAT_Z_INDEX,
    }));
    if (settings.configured && baseEndpoint) void initIllustrationActionSignalBridge();
    await Risuai.onUnload(async () => {
      watchEnabled = false;
      stopTimer();
      dashboardOpen = false;
      if (generationHookRegistered && typeof Risuai.removeRisuScriptHandler === 'function') {
        try { await Risuai.removeRisuScriptHandler('output', generationOutputHandler); } catch (_) {}
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
