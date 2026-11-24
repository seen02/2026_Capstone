import {poll, sameWorld} from './live-state.mjs';

const contractVersion = 'recommendation.v1';
const signId = new URLSearchParams(location.search).get('sign_id') ?? 'magic-island-west';
const element = id => document.getElementById(id);
const splash = element('splash');
const splashDuration = Number(getComputedStyle(splash).getPropertyValue('--splash-duration-ms'));
const roundRecommendationRetryMs = 3000;
const app = element('app');
const connection = element('connection');
const preferences = element('preferences');
const controls = element('controls');
const list = element('facility-order');
const recommendationCard = element('recommendation');
const acceptButton = element('accept-recommendation');
const refreshButton = element('refresh-recommendation');
const recommendationStatus = element('recommendation-status');
const mapFrame = element('user-map-frame');
const mapScene = element('user-scene');
const mapStatus = element('map-status');

let state;
let order;
let desiredOrder;
let drag;
let view;
let mapHash;
let shown;
let generation = 0;
let saving = false;
let saveFailed = false;
let accepting = false;
let refreshing = false;
let delayed = false;
let notice = '';
let acceptCommand;
let nextRoundRecommendationRetry = 0;

const disconnectedCodes = ['session_expired', 'session_required', 'session_mismatch', 'context_mismatch'];
const sameOrder = (left, right) => left.length === right.length && left.every((id, index) => id === right[index]);
const canEdit = data => ['awaiting_preferences', 'ready', 'completed'].includes(data?.character.phase);
const expired = rec => !!rec && Date.now() >= Date.parse(rec.expires_at);
const ridePhase = {
  moving: '이동 중',
  waiting_at_entrance: '대기 중',
  queued: '대기 중',
  boarding: '탑승 중',
  riding: '이용 중',
  unloading: '하차 중',
};

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

async function request(path, method, body) {
  const response = await fetch('/api/user/' + path, {
    method,
    headers: {'Content-Type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify({contract_version: contractVersion, ...body}),
    signal: AbortSignal.timeout(5000),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    const error = new Error(data?.error?.message ?? '서버 응답을 읽을 수 없습니다. 다시 시도해 주세요.');
    error.code = data?.error?.code;
    throw error;
  }
  return data;
}

function requireSameSession(data) {
  if (sameWorld(data.context, state.context) && data.session.session_id === state.session.session_id &&
      data.character.character_id === state.character.character_id) return;
  const error = new Error('연결된 캐릭터가 변경되었습니다. 다시 연결해 주세요.');
  error.code = 'session_required';
  throw error;
}

function setContentVisible(visible) {
  preferences.hidden = recommendationCard.hidden = mapFrame.hidden = !visible;
  connection.hidden = visible;
}

function disconnect(error) {
  const canReconnect = disconnectedCodes.includes(error.code) ||
    error instanceof TypeError || error.name === 'TimeoutError';
  const message = canReconnect ? '인터넷 연결을 확인한 뒤 다시 시도해 주세요.' : error.message;
  generation++;
  state = shown = drag = null;
  saveFailed = delayed = false;
  acceptCommand = null;
  if (view) {
    view.stopFollowing();
    view.setCharacters([]);
    view.showCharacterRoute(null);
  }
  setText(element('status'), message);
  setContentVisible(false);
}

function syncOrder(data) {
  const current = data.session.preference_order.length
    ? data.session.preference_order : data.facilities.map(facility => facility.facility_id);
  desiredOrder = [...current];
  if (order && sameOrder(order, current) && !drag) return;
  drag = null;
  order = [...current];
  renderOrder();
}

function renderControls() {
  controls.disabled = !canEdit(state) || accepting;
  element('save-error').hidden = !saveFailed;
  acceptButton.disabled = !!drag || saving || saveFailed || accepting || refreshing || delayed;
  refreshButton.disabled = !!drag || saving || saveFailed || refreshing;
  setText(recommendationStatus, notice || (delayed ? '추천 정보를 다시 확인하는 중입니다.' : ''));
}

function renderState() {
  const {character, offer, facilities} = state;
  const active = !canEdit(state);
  const completed = character.phase === 'completed';
  const queued = character.phase === 'queued';
  const rec = offer?.recommendation;
  const validOffer = rec && !expired(rec) ? rec : null;
  const facilityId = active ? character.route_preview?.facility_id : validOffer?.facility_id;
  const name = facilities.find(facility => facility.facility_id === facilityId)?.name;
  const rideName = element('ride-name');
  setText(element('recommendation-title'), active ? '이용 놀이기구' : '추천 놀이기구');
  rideName.toggleAttribute('data-empty', !name);
  setText(rideName, name ?? (saving || refreshing ? '추천을 찾는 중입니다.'
    : completed ? '하차 완료' : '지금 추천할 기구가 없어요'));
  const waitSeconds = validOffer?.wait_seconds;
  element('ride-wait').hidden = !Number.isFinite(waitSeconds);
  setText(element('wait-minutes'), Number.isFinite(waitSeconds) ? String(Math.ceil(waitSeconds / 60)) : '');
  const queueWait = character.queue_wait_sim_s;
  element('queue-metrics').hidden = !queued;
  element('queue-wait').hidden = !Number.isFinite(queueWait);
  setText(element('queue-wait-minutes'), Number.isFinite(queueWait) ? String(Math.ceil(queueWait / 60)) : '');
  setText(element('queue-position'), queued ? String(character.queue_position) : '');
  acceptButton.hidden = active || !validOffer;
  acceptButton.firstChild.nodeValue = accepting ? '출발 요청 중 ' : '수락하고 출발 ';
  refreshButton.hidden = active || refreshing || !!validOffer || !['ready', 'completed'].includes(state.session.phase);
  element('ride-status').hidden = !active;
  setText(element('character-phase'), ridePhase[character.phase] ?? '');
  renderControls();
  renderMap();
}

function renderMap() {
  if (!view || mapScene.hidden || state.context.map_hash !== mapHash) return;
  const {character, time_scale} = state;
  const orderPending = canEdit(state) && !sameOrder(desiredOrder, state.session.preference_order);
  const route = character.phase === 'completed' || orderPending || expired(state.offer?.recommendation)
    ? null : character.route_preview;
  const newCharacter = shown?.character_id !== character.character_id;
  shown = character;
  const clock = canEdit(state) ? undefined : {sim_time_s: character.position_sim_time_s, time_scale};
  view.setCharacters([character], undefined, clock);
  view.showCharacterRoute(route?.route ?? null);
  if (newCharacter) {
    view.followCharacter(character.character_id);
  } else {
    view.render();
  }
}

function showMapProblem(message) {
  mapScene.hidden = true;
  mapStatus.hidden = false;
  setText(mapStatus, message);
}

async function connectMap() {
  const sessionId = state.session.session_id;
  try {
    if (!view) {
      const [{MagicIslandMap}, response] = await Promise.all([
        import('./map3d.js'), fetch('/api/meta', {signal: AbortSignal.timeout(5000)}),
      ]);
      if (!response.ok) throw new Error();
      const {map, hashes} = await response.json();
      if (state?.session.session_id !== sessionId) return;
      if (hashes.map !== state.context.map_hash) {
        showMapProblem('지도 설정이 바뀌었습니다. 페이지를 다시 열어 주세요.');
        return;
      }
      mapScene.hidden = false;
      view = new MagicIslandMap(mapScene, map, undefined, {keepCharacterCentered: true});
      mapHash = hashes.map;
      window.inspectMagicMap = () => ({...view.inspect(), context: state?.context});
    }
    if (mapHash !== state.context.map_hash) {
      showMapProblem('지도 설정이 바뀌었습니다. 페이지를 다시 열어 주세요.');
      return;
    }
    mapScene.hidden = false;
    mapStatus.hidden = true;
    renderMap();
  } catch {
    if (state?.session.session_id === sessionId) showMapProblem('지도를 불러오지 못했어요.');
  }
}

mapScene.addEventListener('map-error', event => showMapProblem(event.detail));

function updateRanks() {
  order = Array.from(list.children, (row, index) => {
    row.querySelector('.rank').textContent = index + 1;
    return row.dataset.facility;
  });
}

function moveRow(row, neighbor, down) {
  list.insertBefore(row, down ? neighbor.nextElementSibling : neighbor);
  updateRanks();
}

function queueOrder() {
  desiredOrder = [...order];
  void saveOrder();
}

function renderOrder() {
  const names = new Map(state.facilities.map(facility => [facility.facility_id, facility.name]));
  list.replaceChildren(...order.map((id, index) => {
    const row = document.createElement('li');
    row.dataset.facility = id;
    const rank = Object.assign(document.createElement('span'), {className: 'rank', textContent: index + 1});
    const name = Object.assign(document.createElement('span'), {className: 'facility-name', textContent: names.get(id)});
    const handle = Object.assign(document.createElement('button'), {className: 'drag-handle', type: 'button'});
    handle.setAttribute('aria-label', name.textContent + ' 순위 이동');
    handle.setAttribute('aria-describedby', 'order-help');
    handle.onpointerdown = event => {
      if (event.button !== 0 || drag) return;
      drag = {row, pointer: event.pointerId, original: [...order], offset: event.clientY - row.getBoundingClientRect().top};
      row.dataset.dragging = '';
      list.setPointerCapture(event.pointerId);
      renderControls();
    };
    handle.onkeydown = event => {
      if (!['ArrowUp', 'ArrowDown'].includes(event.key) || drag) return;
      event.preventDefault();
      const down = event.key === 'ArrowDown';
      const neighbor = down ? row.nextElementSibling : row.previousElementSibling;
      if (!neighbor) return;
      moveRow(row, neighbor, down);
      handle.focus({preventScroll: true});
      queueOrder();
    };
    row.append(rank, name, handle);
    return row;
  }));
}

list.addEventListener('pointermove', event => {
  if (drag?.pointer !== event.pointerId) return;
  const {row, offset} = drag;
  const bounds = list.getBoundingClientRect();
  const height = row.getBoundingClientRect().height;
  const top = Math.max(bounds.top, Math.min(bounds.bottom - height, event.clientY - offset));
  const center = top + height / 2;
  const midpoint = item => {
    const {top, height} = item.getBoundingClientRect();
    return top + height / 2;
  };
  while (row.previousElementSibling && center <= midpoint(row.previousElementSibling)) {
    moveRow(row, row.previousElementSibling, false);
  }
  while (row.nextElementSibling && center >= midpoint(row.nextElementSibling)) {
    moveRow(row, row.nextElementSibling, true);
  }
  row.style.transform = '';
  row.style.transform = 'translateY(' + (top - row.getBoundingClientRect().top) + 'px)';
});

function finishDrag(event) {
  if (drag?.pointer !== event.pointerId) return;
  const {row, original} = drag;
  drag = null;
  delete row.dataset.dragging;
  row.style.transform = '';
  if (event.type === 'pointerup') {
    if (!sameOrder(order, original)) queueOrder();
  } else if (!sameOrder(order, original)) {
    order = original;
    renderOrder();
  }
  renderControls();
}

for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) list.addEventListener(event, finishDrag);

async function saveOrder() {
  if (!canEdit(state) || saving || accepting || refreshing) return;
  if (sameOrder(desiredOrder, state.session.preference_order)) {
    saveFailed = false;
    renderControls();
    return;
  }
  ++generation;
  saving = true;
  saveFailed = false;
  notice = '';
  setText(element('save-announcement'), '');
  renderControls();
  let rebased = false;
  try {
    while (canEdit(state) && !sameOrder(desiredOrder, state.session.preference_order)) {
      try {
        const data = await request('preferences', 'PUT', {
          context: state.context,
          session_id: state.session.session_id,
          expected_revision: state.session.revision,
          preference_order: desiredOrder,
        });
        requireSameSession(data);
        state = data;
        rebased = false;
      } catch (error) {
        if (rebased || !['revision_mismatch', 'session_not_ready'].includes(error.code)) throw error;
        const data = await request('session', 'GET');
        requireSameSession(data);
        state = data;
        rebased = true;
      }
    }
    delayed = false;
    if (!canEdit(state)) syncOrder(state);
    setText(element('save-announcement'), '선호 순위를 저장했습니다.');
  } catch (error) {
    if (disconnectedCodes.includes(error.code)) disconnect(error);
    else saveFailed = true;
  } finally {
    saving = false;
    if (state) renderState();
  }
}

element('retry-save').onclick = saveOrder;

async function refreshRecommendation() {
  await request('recommendation', 'GET');
  return request('session', 'GET');
}

async function loadRecommendation() {
  if (!canEdit(state) || refreshButton.disabled || accepting) return;
  generation++;
  refreshing = true;
  notice = '';
  renderState();
  try {
    const data = await refreshRecommendation();
    requireSameSession(data);
    const editingOrder = !!drag || !sameOrder(desiredOrder, state.session.preference_order);
    state = data;
    if (!editingOrder || !canEdit(data)) syncOrder(data);
    delayed = false;
  } catch (error) {
    if (disconnectedCodes.includes(error.code)) disconnect(error);
    else notice = '추천을 새로고침하지 못했어요.';
  } finally {
    refreshing = false;
    if (canEdit(state) && !sameOrder(desiredOrder, state.session.preference_order)) {
      void saveOrder();
    } else if (state) {
      renderState();
    }
  }
}
refreshButton.onclick = loadRecommendation;

acceptButton.onclick = async () => {
  const offer = state?.offer;
  const rec = offer?.recommendation;
  if (acceptButton.disabled || !rec || expired(rec) || !canEdit(state)) return;
  generation++;
  accepting = true;
  notice = '';
  renderState();
  if (acceptCommand?.recommendation_id !== rec.recommendation_id) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    acceptCommand = {
      context: offer.context, session_id: offer.session_id,
      command_id: Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(''),
      recommendation_id: rec.recommendation_id,
      expected_session_revision: offer.session_revision, expected_snapshot_seq: offer.snapshot_seq,
    };
  }
  try {
    await request('recommendation/accept', 'POST', acceptCommand);
    const data = await request('session', 'GET');
    requireSameSession(data);
    state = data;
  } catch (error) {
    if (disconnectedCodes.includes(error.code)) disconnect(error);
    else notice = error.message;
    if (['recommendation_expired', 'recommendation_invalidated', 'revision_mismatch', 'session_conflict'].includes(error.code)) {
      try {
        let data = await request('session', 'GET');
        if (canEdit(data)) data = await refreshRecommendation();
        requireSameSession(data);
        state = data;
        syncOrder(data);
        notice = canEdit(data) ? '새 추천을 확인한 뒤 수락해 주세요.' : '';
      } catch (refreshError) {
        if (disconnectedCodes.includes(refreshError.code)) disconnect(refreshError);
        else {
          delayed = true;
          notice = '추천을 다시 확인하는 중입니다.';
        }
      }
    }
  } finally {
    accepting = false;
    if (state) renderState();
  }
};

async function connect() {
  const started = performance.now();
  ++generation;
  app.hidden = true;
  splash.hidden = false;
  notice = '';
  try {
    state = await request('session', 'POST', {sign_id: signId});
    syncOrder(state);
    if (!state.session.preference_order.length) await saveOrder();
    else if (expired(state.offer?.recommendation)) {
      try {
        const data = await refreshRecommendation();
        requireSameSession(data);
        state = data;
        syncOrder(data);
      } catch (error) {
        if (disconnectedCodes.includes(error.code)) throw error;
        delayed = true;
      }
    }
    if (state) {
      setContentVisible(true);
      renderState();
    }
  } catch (error) {
    disconnect(error);
  }
  await new Promise(resolve => setTimeout(resolve, Math.max(0, splashDuration - (performance.now() - started))));
  splash.hidden = true;
  app.hidden = false;
  if (state) {
    void connectMap();
    if (state.character.phase === 'completed') void loadRecommendation();
  }
}

element('retry').onclick = connect;
void connect();

poll(async () => {
  if (!state || app.hidden || saving || accepting || refreshing || drag) return null;
  const expected = generation;
  try {
    let data = await request('session', 'GET');
    const now = performance.now();
    const retryRound = now >= nextRoundRecommendationRetry && data.offer?.result === 'no_candidate' &&
      data.offer.excluded.some(({codes}) => codes.includes('round_start_recent_ride'));
    if (!saveFailed && expected === generation && !drag && (expired(data.offer?.recommendation) || retryRound)) {
      if (retryRound) nextRoundRecommendationRetry = now + roundRecommendationRetryMs;
      data = await refreshRecommendation();
    }
    return {expected, data};
  } catch (error) {
    if (expected !== generation || drag) return null;
    throw error;
  }
}, result => {
  if (!result || result.expected !== generation || !state || drag) return;
  const {data} = result;
  requireSameSession(data);
  const before = state;
  const wasDelayed = delayed;
  const recoveredSave = saveFailed && sameOrder(desiredOrder, data.session.preference_order);
  if (recoveredSave || !canEdit(data)) saveFailed = false;
  state = data;
  delayed = false;
  if (!saveFailed) syncOrder(data);
  if (wasDelayed || before.character.phase !== data.character.phase) notice = '';
  if (data.character.phase === 'completed' && before.character.phase !== 'completed') {
    void loadRecommendation();
    return;
  }
  if (wasDelayed || recoveredSave || data.character.phase !== before.character.phase ||
      data.character.revision !== before.character.revision ||
      data.character.position_sim_time_s !== before.character.position_sim_time_s ||
      data.offer?.recommendation?.recommendation_id !== before.offer?.recommendation?.recommendation_id) renderState();
}, error => {
  if (disconnectedCodes.includes(error.code)) disconnect(error);
  else if (state) {
    delayed = true;
    renderState();
  }
}, 400);
