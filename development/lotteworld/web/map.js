import {MagicIslandMap} from './map3d.js';
import {characterPhase, characterProgress, poll} from './live-state.mjs';

const get = id => document.getElementById(id);
const host = get('scene');
const panel = get('facility-panel');
const title = get('facility-title');
const buttons = get('facilities');
const routeButton = get('show-routes');
const distances = get('route-distances');
const facilityList = get('facility-list');
const picker = get('facility-picker');
const descriptions = {
  'gyro-drop': '수직 타워를 따라 움직이는 원형 탑승대',
  'gyro-swing': '지지대 사이에서 우측으로 흔들려 올라간 원형 탑승대',
  atlantis: '물길과 고가 레일이 이어지는 코스터',
  'comet-express': '지상 모형의 굽은 레일 위에 놓인 열차',
  'gyro-spin': 'U자형 레일 위의 회전 원판',
  'arcana-ride': '타원형 궤도를 도는 소형 차량',
};

let view;
let selectedId;
let selectionTrigger;
let live;
let selectedCharacter;
let qrTrigger;
const qrPicker = get('qr-characters');
const vehicleStates = {
  available: '출발 대기', boarding: '승차 중', ready: '출발 준비',
  running: '코스 운행', waiting_for_station: '승강장 대기', unloading: '하차 중',
};
const vehicleLabels = new Map();

function setPickerOpen(open) {
  picker.hidden = !open;
  facilityList.setAttribute('aria-expanded', String(open));
}

function setRouteDetails(routes = []) {
  const visible = routes.length > 0;
  routeButton.textContent = visible ? '동선 숨기기' : '동선 보기';
  routeButton.setAttribute('aria-pressed', String(visible));
  distances.hidden = !visible;
  if (visible) {
    get('entry-distance').textContent = routes[0].distance_m.toFixed(1) + 'm';
    get('exit-distance').textContent = routes[1].distance_m.toFixed(1) + 'm';
  }
}

function highlightSelection(id) {
  view.select(id);
  setRouteDetails();
  for (const button of buttons.children) {
    button.setAttribute('aria-pressed', String(button.dataset.facility === id));
  }
}

function select(id, trigger) {
  closeCharacter(false);
  const facility = view.map.facilities.find(item => item.id === id);
  selectionTrigger = trigger ?? facilityList;
  setPickerOpen(false);
  selectedId = id;
  highlightSelection(id);
  title.textContent = facility.name;
  get('facility-description').textContent = descriptions[id] ?? '매직아일랜드 시설 모형';
  panel.hidden = false;
  renderRide();
  title.focus({preventScroll: true});
}

function closePanel(restoreFocus = true) {
  selectedId = null;
  highlightSelection(null);
  panel.hidden = true;
  const focusTarget = selectionTrigger?.hidden ? facilityList : selectionTrigger;
  if (restoreFocus) (focusTarget ?? facilityList).focus({preventScroll: true});
}

facilityList.onclick = () => {
  const open = picker.hidden;
  setPickerOpen(open);
  if (open) (buttons.querySelector('[aria-pressed="true"]') ?? buttons.firstElementChild)?.focus();
};
get('close-panel').onclick = () => closePanel();
routeButton.onclick = () => {
  if (!selectedId) return;
  if (routeButton.getAttribute('aria-pressed') === 'true') {
    view.hideRoutes();
    setRouteDetails();
  } else {
    setRouteDetails(view.showRoutes(selectedId));
  }
};
panel.querySelector('[data-action="focus"]').onclick = () => view?.focus(selectedId);

document.addEventListener('pointerdown', event => {
  if (!picker.hidden && !facilityList.contains(event.target) && !picker.contains(event.target)) setPickerOpen(false);
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (!picker.hidden) {
    setPickerOpen(false);
    facilityList.focus();
  } else if (!panel.hidden) closePanel();
  else if (!get('qr-panel').hidden) closeCharacter();
  else return;
  event.preventDefault();
});

const fullscreen = get('fullscreen');
fullscreen.hidden = !document.fullscreenEnabled;
fullscreen.onclick = async () => {
  get('screen-message').hidden = true;
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    get('screen-message').textContent = '브라우저에서 전체 화면으로 전환할 수 없습니다.';
    get('screen-message').hidden = false;
  }
};
document.addEventListener('fullscreenchange', () => {
  const isFullscreen = Boolean(document.fullscreenElement);
  const label = isFullscreen ? '전체 화면 종료' : '전체 화면';
  fullscreen.setAttribute('aria-pressed', String(isFullscreen));
  fullscreen.setAttribute('aria-label', label);
  fullscreen.querySelector('.fullscreen-label').textContent = label;
});

function showError(message) {
  get('map-status').textContent = '지도 표시 오류';
  get('map-status').dataset.error = '';
  get('error').textContent = message;
  get('error').hidden = false;
}

function renderRide() {
  const ride = live?.rides[selectedId];
  const queue = live?.background.queues[selectedId];
  const metrics = get('ride-metrics');
  metrics.hidden = !ride || !queue;
  if (metrics.hidden) return;
  const running = ride.vehicles.filter(vehicle => vehicle.state === 'running').length;
  get('ride-status').textContent = running ? `코스 운행 ${running}대` : '코스 운행 차량 없음';
  get('ride-dispatches').textContent = `${ride.dispatch_count}회`;
  get('ride-queue').textContent = `${queue.queued_count}명`;
  get('ride-passengers').textContent = `${ride.riding_people}명`;
  const vehicles = get('ride-vehicles');
  const rows = ride.vehicles.map((vehicle, index) => {
    const place = vehicle.station_slot !== null ? ` · 승강장 ${vehicle.station_slot}`
      : vehicle.course_section !== null ? ` · 코스 구간 ${vehicle.course_section}` : '';
    return `${index + 1}번 · ${vehicleStates[vehicle.state]}${place}`;
  });
  if (vehicles.textContent !== rows.join('')) {
    vehicles.replaceChildren(...rows.map(text => Object.assign(document.createElement('li'), {textContent: text})));
  }
}

function renderCharacter() {
  const person = live?.qr.characters.find(character => character.character_id === selectedCharacter);
  if (!person) {
    closeCharacter(false);
    return;
  }
  const preview = person.route_preview;
  const facility = view.map.facilities.find(item => item.id === preview?.facility_id);
  get('qr-title').textContent = `QR 캐릭터 · ${person.character_id.slice(-6)}`;
  get('qr-phase').textContent = characterPhase[person.phase];
  const progress = characterProgress(person);
  get('qr-progress').textContent = progress;
  get('qr-progress').hidden = !progress;
  get('qr-destination').textContent = facility ? `모의 추천 목적지 · ${facility.name}` : '추천 경로 대기';
  view.showCharacterRoute(preview?.route ?? null);
}

function selectCharacter(id, trigger) {
  if (!panel.hidden) closePanel(false);
  setPickerOpen(false);
  selectedCharacter = id;
  qrTrigger = trigger;
  qrPicker.value = id;
  view.characters.forEach(({element}, key) => element.setAttribute('aria-pressed', String(key === id)));
  get('qr-panel').hidden = false;
  renderCharacter();
  if (trigger === qrPicker) centerCharacter();
  else view.render();
  get('qr-title').focus({preventScroll: true});
}

function closeCharacter(restoreFocus = true) {
  if (!selectedCharacter) return;
  selectedCharacter = null;
  qrPicker.value = '';
  view.characters.forEach(({element}) => element.setAttribute('aria-pressed', 'false'));
  get('qr-panel').hidden = true;
  view.showCharacterRoute(null);
  view.render();
  if (restoreFocus) (qrTrigger?.isConnected && !qrTrigger.hidden ? qrTrigger : qrPicker).focus();
}

qrPicker.onchange = () => qrPicker.value ? selectCharacter(qrPicker.value, qrPicker) : closeCharacter(false);
get('close-qr').onclick = () => closeCharacter();
function centerCharacter() {
  const person = live?.qr.characters.find(character => character.character_id === selectedCharacter);
  if (person) view.focusPoint(person.position.point ?? person.map_point);
}
get('focus-qr').onclick = centerCharacter;

function showLiveStatus(message, error = false) {
  if (!get('error').hidden) return;
  const status = get('map-status');
  if (status.textContent !== message) status.textContent = message;
  status.toggleAttribute('data-error', error);
}

function applyLive(snapshot) {
  if (live?.run_id !== snapshot?.run_id) {
    view.visitorTimeline.clear();
    view.setCharacters([]);
  }
  live = snapshot;
  const background = snapshot?.background;
  const characters = snapshot?.qr.characters ?? [];
  get('population').hidden = !snapshot;
  if (background) {
    get('entered').textContent = `${background.entered_total}명`;
    get('present').textContent = `${background.present_people}명`;
    get('exited').textContent = `${background.exited_total}명`;
  }
  if (qrPicker.options.length !== characters.length + 1 ||
      characters.some((person, index) => qrPicker.options[index + 1]?.value !== person.character_id)) {
    qrPicker.replaceChildren(new Option(`${characters.length}명`, ''), ...characters.map(person =>
      new Option(`QR · ${person.character_id.slice(-6)}`, person.character_id)));
    qrPicker.value = selectedCharacter ?? '';
    qrPicker.disabled = !characters.length;
  }
  for (const [id, label] of vehicleLabels) {
    const vehicles = snapshot?.rides[id]?.vehicles;
    label.dataset.operation = vehicles?.some(v => v.state === 'running') ? 'running' : vehicles ? 'station' : '';
  }
  view.setVisitors(background?.visitors ?? [], snapshot?.clock);
  view.setCharacters(characters, selectCharacter, snapshot?.clock);
  renderRide();
  renderCharacter();
  view.render();
}

host.addEventListener('map-error', event => showError(event.detail));
host.addEventListener('view-change', event => {
  get('scale').textContent = Math.round(event.detail.zoom * 100) + '%';
});
get('zoom-in').onclick = () => view?.zoom(1.25);
get('zoom-out').onclick = () => view?.zoom(.8);
get('reset').onclick = () => view?.home(false);
get('top-view').onclick = () => view?.home(true);

async function initialize() {
  try {
    const response = await fetch('/api/meta');
    if (!response.ok) throw new Error('지도 설정을 가져오지 못했습니다.');
    const {map, hashes} = await response.json();
    view = new MagicIslandMap(host, map, select);
    for (const label of host.querySelectorAll('.facility-label')) vehicleLabels.set(label.dataset.facility, label);
    for (const facility of map.facilities) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.facility = facility.id;
      button.setAttribute('aria-pressed', 'false');
      button.textContent = facility.name;
      button.onclick = () => select(facility.id, facilityList);
      buttons.append(button);
    }
    get('loading').remove();
    showLiveStatus('운영 상태 연결 중');
    // 브라우저 검증에 사용하는 읽기 전용 장면 상태.
    window.inspectMagicMap = () => ({...view.inspect(), context: live?.qr.context, clock: live?.clock});
    poll(async () => {
      const response = await fetch('/api/state', {signal: AbortSignal.timeout(5000)});
      if (!response.ok) throw new Error('운영 상태를 가져오지 못했습니다.');
      return response.json();
    }, snapshot => {
      if (snapshot.map_hash !== hashes.map || snapshot.qr.context.map_hash !== hashes.map ||
          snapshot.run_id !== snapshot.qr.context.run_id) {
        if (live) applyLive(null);
        showLiveStatus('지도 버전 불일치 · 새로고침 필요', true);
        return;
      }
      if (live?.run_id !== snapshot.run_id) closeCharacter(false);
      applyLive(snapshot);
      showLiveStatus('시뮬레이션 연결됨');
    }, () => showLiveStatus(live ? '운영 상태 갱신 지연' : '운영 상태 연결 지연', true), 400);
  } catch (error) {
    showError('3D 지도를 불러오지 못했습니다. 서버 연결과 브라우저의 WebGL 지원을 확인하세요.');
    get('loading').textContent = '3D 지도를 표시할 수 없습니다.';
    console.error(error);
  }
}
initialize();
