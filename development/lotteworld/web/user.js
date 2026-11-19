import {MagicIslandMap} from './map3d.js';
import {characterPhase, characterProgress, poll, sameWorld} from './live-state.mjs';

const contractVersion = "recommendation.v1";
const signId = new URLSearchParams(location.search).get("sign_id") ?? "magic-island-west";
const character = document.querySelector("#character");
const characterId = document.querySelector("#character-id");
const characterPosition = document.querySelector("#character-position");
const status = document.querySelector("#status");
const retry = document.querySelector("#retry");
const preferences = document.querySelector("#preferences");
const saveButton = preferences.querySelector('button[type="submit"]');
const controls = document.querySelector("#controls");
const list = document.querySelector("#facility-order");
let state;
let order;
let view;
let mapHash;
let shown;
let generation = 0;
let drag;
let acceptCommand;
let accepting = false;
const mapFrame = document.querySelector('#user-map-frame');
const mapScene = document.querySelector('#user-scene');
const destination = document.querySelector('#destination');
const destinationNote = document.querySelector('#destination-note');
const acceptButton = document.querySelector('#accept-recommendation');
const acceptStatus = document.querySelector('#accept-status');
const resumeFollow = document.querySelector('#resume-follow');
const sync = document.querySelector('#character-sync');

async function request(path, method, body) {
  const response = await fetch(`/api/user/${path}`, {
    method,
    headers: {"Content-Type": "application/json"},
    body: body === undefined ? undefined : JSON.stringify({contract_version: contractVersion, ...body}),
    signal: AbortSignal.timeout(5000),
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("서버 응답을 읽을 수 없습니다. 다시 시도해 주세요.");
  }
  if (!response.ok) {
    const error = new Error(data?.error?.message ?? "요청을 처리할 수 없습니다. 다시 시도해 주세요.");
    error.code = data?.error?.code;
    throw error;
  }
  return data;
}

function setSync(message) {
  if (sync.textContent !== message) sync.textContent = message;
}

function showCharacter({character: current, facilities, context, offer, time_scale}) {
  const active = !['awaiting_preferences', 'ready'].includes(current.phase);
  preferences.hidden = active;
  document.querySelector('.intro').hidden = active;
  status.hidden = active;
  acceptButton.hidden = !offer?.recommendation || active;
  characterId.textContent = current.character_id;
  const point = current.position.point;
  characterPosition.textContent = point
    ? `시뮬레이션 속 내 위치 (${point.map(value => Math.round(value * 10) / 10).join(', ')}) m`
    : '시설에서 차량 이용 중';
  document.querySelector('#character-phase').textContent = characterPhase[current.phase];
  const progress = document.querySelector('#character-progress');
  progress.textContent = characterProgress(current);
  progress.hidden = !progress.textContent;
  const preview = current.route_preview;
  const facility = facilities.find(item => item.facility_id === preview?.facility_id);
  destination.hidden = !facility;
  destination.disabled = !view || context.map_hash !== mapHash || mapFrame.hidden;
  destinationNote.hidden = !!facility;
  if (facility) {
    destination.textContent = `모의 추천 목적지 · ${facility.name}`;
    destination.setAttribute('aria-label', `${destination.textContent} 경로 보기`);
  } else {
    destinationNote.textContent = current.phase === 'awaiting_preferences'
      ? '선호를 저장하면 추천 경로를 볼 수 있습니다.' : '표시할 추천 경로가 없습니다.';
  }
  if (!view || context.map_hash !== mapHash) return;
  const newCharacter = shown?.character_id !== current.character_id;
  shown = current;
  view.setCharacters([current], undefined, active ? {sim_time_s: current.position_sim_time_s, time_scale} : undefined);
  view.showCharacterRoute(preview?.route ?? null);
  if (newCharacter) {
    setFollowing(true);
  } else {
    view.render();
  }
}

async function connectMap() {
  try {
    if (!view) {
      const response = await fetch('/api/meta', {signal: AbortSignal.timeout(5000)});
      if (!response.ok) throw new Error();
      const {map, hashes} = await response.json();
      if (!state) return;
      if (hashes.map !== state.context.map_hash) {
        setSync('지도 버전이 다릅니다. 서버 지도 설정을 확인한 뒤 다시 연결해 주세요.');
        return;
      }
      mapFrame.hidden = false;
      view = new MagicIslandMap(mapScene, map);
      mapHash = hashes.map;
      window.inspectMagicMap = () => ({...view.inspect(), context: state?.context});
    }
    if (mapHash !== state.context.map_hash) {
      mapFrame.hidden = true;
      setSync('지도 버전이 바뀌었습니다. 페이지를 새로고침해 주세요.');
      return;
    }
    mapFrame.hidden = false;
    setSync('');
    showCharacter(state);
  } catch {
    mapFrame.hidden = true;
    setSync('3D 지도를 불러오지 못했습니다. 서버 연결과 브라우저의 WebGL 지원을 확인해 주세요.');
  }
}

function setFollowing(active) {
  resumeFollow.hidden = active;
  if (active && shown) view.followCharacter(shown.character_id);
  else view?.stopFollowing();
}

resumeFollow.onclick = () => {
  if (!shown) return;
  setFollowing(true);
};
destination.onclick = () => {
  if (!shown?.route_preview) return;
  setFollowing(false);
  view.focusRoute(shown.route_preview.route.points);
};
destination.disabled = true;
mapScene.addEventListener('map-interaction', () => setFollowing(false));
mapScene.addEventListener('map-error', event => {
  mapFrame.hidden = true;
  destination.disabled = true;
  setSync(event.detail);
});

acceptButton.onclick = async () => {
  const offer = state?.offer;
  const recommendation = offer?.recommendation;
  if (accepting || !recommendation) return;
  const expected = ++generation;
  accepting = true;
  acceptButton.disabled = controls.disabled = true;
  acceptStatus.textContent = '출발을 요청하는 중입니다.';
  if (acceptCommand?.recommendation_id !== recommendation.recommendation_id) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    acceptCommand = {
      context: offer.context, session_id: offer.session_id,
      command_id: Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(''),
      recommendation_id: recommendation.recommendation_id,
      expected_session_revision: offer.session_revision, expected_snapshot_seq: offer.snapshot_seq,
    };
  }
  try {
    await request('recommendation/accept', 'POST', acceptCommand);
    const data = await request('session', 'GET');
    if (expected !== generation) return;
    state = data;
    showCharacter(data);
    if (shown) setFollowing(true);
    acceptStatus.textContent = '';
    character.scrollIntoView({block: 'nearest'});
  } catch (error) {
    acceptStatus.textContent = error.message;
    if (['recommendation_expired', 'recommendation_invalidated', 'revision_mismatch'].includes(error.code)) {
      try {
        await request('recommendation', 'GET');
        const data = await request('session', 'GET');
        if (expected !== generation) return;
        state = data;
        order = [...data.session.preference_order];
        renderOrder();
        showCharacter(data);
        acceptStatus.textContent = '새 추천을 확인한 뒤 수락해 주세요.';
      } catch (refreshError) {
        acceptStatus.textContent = refreshError.message;
      }
    }
  } finally {
    accepting = false;
    acceptButton.disabled = controls.disabled = false;
  }
};

function showStatus(message, error = false) {
  status.textContent = message;
  status.toggleAttribute("data-error", error);
}

function renderOrder() {
  const names = new Map(state.facilities.map(facility => [facility.facility_id, facility.name]));
  list.replaceChildren(...order.map((facilityId, index) => {
    const name = names.get(facilityId);
    const row = document.createElement("li");
    const rank = document.createElement("span");
    rank.className = "rank";
    rank.textContent = `${index + 1}순위`;
    const label = document.createElement("span");
    label.className = "facility-name";
    label.textContent = name;
    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "drag-handle";
    handle.setAttribute("aria-label", `${name} 순위 이동`);
    handle.setAttribute("aria-describedby", "order-help");
    handle.addEventListener("pointerdown", event => {
      if (event.button !== 0 || drag) return;
      drag = {row, pointer: event.pointerId, original: [...order],
        grabOffset: event.clientY - row.getBoundingClientRect().top, shift: 0};
      row.dataset.dragging = '';
      list.setPointerCapture(event.pointerId);
    });
    handle.addEventListener("keydown", event => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault();
      const next = event.key === 'ArrowUp' ? row.previousElementSibling : row.nextElementSibling;
      if (!next) return;
      moveRow(row, next, event.key === 'ArrowDown');
      handle.focus();
      showStatus(`${name} ${order.indexOf(facilityId) + 1}순위. 선호를 저장해 주세요.`);
    });
    row.dataset.facility = facilityId;
    row.append(rank, label, handle);
    return row;
  }));
}

function moveRow(row, neighbor, down) {
  list.insertBefore(row, down ? neighbor.nextElementSibling : neighbor);
  order = Array.from(list.children, (item, index) => {
    item.querySelector('.rank').textContent = `${index + 1}순위`;
    return item.dataset.facility;
  });
}

list.addEventListener('pointermove', event => {
  if (drag?.pointer !== event.pointerId) return;
  const {row} = drag;
  const midpoint = item => {
    const {top, height} = item.getBoundingClientRect();
    return top + height / 2;
  };
  while (row.previousElementSibling && event.clientY < midpoint(row.previousElementSibling)) {
    moveRow(row, row.previousElementSibling, false);
  }
  while (row.nextElementSibling && event.clientY > midpoint(row.nextElementSibling)) {
    moveRow(row, row.nextElementSibling, true);
  }
  const bounds = list.getBoundingClientRect();
  const {top, height} = row.getBoundingClientRect();
  const base = top - drag.shift;
  const clamped = Math.min(bounds.bottom - height, Math.max(bounds.top, event.clientY - drag.grabOffset));
  drag.shift = clamped - base;
  row.style.transform = `translateY(${drag.shift}px)`;
});

function endDrag(event) {
  if (drag?.pointer !== event.pointerId) return;
  const {row, original} = drag;
  drag = undefined;
  delete row.dataset.dragging;
  row.style.transform = '';
  if (event.type !== 'pointerup') {
    order = original;
    renderOrder();
  } else if (order.some((id, index) => id !== original[index])) {
    showStatus('순위를 변경했습니다. 선호를 저장해 주세요.');
  }
}
list.addEventListener('pointerup', endDrag);
list.addEventListener('pointercancel', endDrag);
list.addEventListener('lostpointercapture', endDrag);

let saveTouch;
saveButton.addEventListener('touchstart', event => {
  saveTouch = event.touches.length === 1 ? event.changedTouches[0] : null;
}, {passive: true});
saveButton.addEventListener('touchcancel', () => { saveTouch = null; });
saveButton.addEventListener('touchend', event => {
  const start = saveTouch;
  saveTouch = null;
  const touch = event.changedTouches[0];
  if (!start || start.identifier !== touch.identifier || controls.disabled ||
      Math.hypot(touch.clientX - start.clientX, touch.clientY - start.clientY) > 10) return;
  // 드래그 직후 Chrome이 다음 탭의 click을 생략해도 저장을 실행한다.
  event.preventDefault();
  preferences.requestSubmit(saveButton);
}, {passive: false});

async function connect() {
  generation++;
  retry.hidden = true;
  showStatus("가상 캐릭터를 연결하는 중입니다.");
  try {
    state = await request("session", "POST", {sign_id: signId});
    const {session, facilities} = state;
    order = session.preference_order.length
      ? [...session.preference_order]
      : facilities.map(facility => facility.facility_id);
    renderOrder();
    character.hidden = false;
    preferences.hidden = false;
    showCharacter(state);
    void connectMap();
    showStatus(session.preference_order.length ? "저장한 선호 순위를 불러왔습니다." : "아직 저장한 선호 순위가 없습니다.");
  } catch (error) {
    showStatus(error instanceof TypeError ? "서버에 연결할 수 없습니다. 다시 시도해 주세요." : error.message, true);
    retry.hidden = false;
  }
}

preferences.addEventListener("submit", async event => {
  event.preventDefault();
  if (controls.disabled) return;
  const saving = ++generation;
  controls.disabled = true;
  showStatus("선호 순위를 저장하는 중입니다.");
  try {
    const result = await request("preferences", "PUT", {
      context: state.context,
      session_id: state.session.session_id,
      expected_revision: state.session.revision,
      preference_order: order,
    });
    if (saving !== generation) return;
    state = result;
    acceptStatus.textContent = '';
    showCharacter(state);
    showStatus("선호 순위를 저장했습니다.");
  } catch (error) {
    showStatus(error instanceof TypeError ? "서버에 연결할 수 없습니다. 다시 저장해 주세요." : error.message, true);
  } finally {
    controls.disabled = false;
  }
});

retry.addEventListener("click", connect);
connect();

poll(async () => {
  if (!state || controls.disabled) return null;
  const expected = generation;
  try {
    let data = await request('session', 'GET');
    const expires = data.offer?.recommendation?.expires_at;
    if (expires && Date.now() >= Date.parse(expires) && expected === generation) {
      await request('recommendation', 'GET');
      data = await request('session', 'GET');
    }
    return {expected, data};
  } catch (error) {
    if (expected !== generation) return null;
    throw error;
  }
}, result => {
  if (!result || result.expected !== generation || !state) return;
  const {data} = result;
  if (!sameWorld(data.context, state.context) || data.character.character_id !== state.character.character_id) {
    const error = new Error('연결된 캐릭터가 변경되었습니다. 다시 연결해 주세요.');
    error.code = 'session_required';
    throw error;
  }
  if (sync.textContent === '캐릭터 상태 갱신 지연') setSync('');
  const current = data.character;
  const changed = !shown || current.revision > shown.revision || current.phase !== shown.phase ||
      current.position_sim_time_s > shown.position_sim_time_s ||
      data.offer?.recommendation?.recommendation_id !== state.offer?.recommendation?.recommendation_id;
  if (changed) {
    const phaseChanged = current.phase !== state.character.phase;
    state = data;
    showCharacter(data);
    if (phaseChanged && current.phase !== 'ready') acceptStatus.textContent = '';
  }
}, error => {
  if (['session_expired', 'session_required'].includes(error.code)) {
    generation++;
    state = shown = null;
    view?.setCharacters([]);
    view?.showCharacterRoute(null);
    view?.render();
    character.hidden = preferences.hidden = true;
    document.querySelector('.intro').hidden = status.hidden = false;
    retry.hidden = false;
    showStatus(error.message, true);
  } else if (!mapFrame.hidden) setSync('캐릭터 상태 갱신 지연');
}, 400);
