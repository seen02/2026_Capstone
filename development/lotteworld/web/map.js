import {characterPhase, characterProgress, facilityMetrics, poll} from './live-state.mjs';
import {initializeOperator, renderOperator} from './operator.js';

const get = id => document.getElementById(id);
const host = get('scene');
const panel = get('facility-panel');
const title = get('facility-title');
const simulationPanel = get('simulation-panel');
const tabList = document.querySelector('.workspace-links');
const tabs = [...tabList.querySelectorAll('[role="tab"]')];

let view;
let mapConfig;
let mapLoading = false;
let latestSnapshot;
let selectedId;
let selectionTrigger;
let live;
let selectedCharacter;
let qrTrigger;
const qrPicker = get('qr-characters');
const followButton = get('focus-qr');
const simulationRideFields = ['status', 'queue', 'estimated-wait', 'passengers'];
const vehicleLabels = new Map();

function select(id, trigger) {
  closeCharacter(false);
  const facility = view.map.facilities.find(item => item.id === id);
  selectionTrigger = trigger ?? vehicleLabels.get(id);
  selectedId = id;
  view.select(id);
  title.textContent = facility.name;
  panel.hidden = false;
  renderRide();
  title.focus({preventScroll: true});
}

function closePanel(restoreFocus = true) {
  selectedId = null;
  view.select(null);
  panel.hidden = true;
  const label = selectionTrigger;
  selectionTrigger = null;
  if (restoreFocus) (label?.isConnected && !label.hidden ? label : get('reset')).focus({preventScroll: true});
}

get('close-panel').onclick = () => closePanel();
panel.querySelector('[data-action="focus"]').onclick = () => view?.focus(selectedId);

document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || simulationPanel.hidden) return;
  if (!panel.hidden) closePanel();
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
  get('error').textContent = message;
  get('error').hidden = false;
}

function renderRide() {
  const values = facilityMetrics(live, selectedId);
  get('ride-metrics').hidden = !values;
  if (!values) return;
  for (const field of simulationRideFields) get(`ride-${field}`).textContent = values[field];
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
  get('qr-destination').textContent = facility ? `추천 목적지 · ${facility.name}` : '추천 경로 대기';
  view.showCharacterRoute(preview?.route ?? null);
}

function selectCharacter(id, trigger) {
  if (!panel.hidden) closePanel(false);
  if (selectedCharacter !== id) view.stopFollowing();
  selectedCharacter = id;
  updateFollowButton();
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
  view.stopFollowing();
  updateFollowButton();
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

function updateFollowButton() {
  const following = !!selectedCharacter && view?.trackedCharacter === selectedCharacter;
  followButton.setAttribute('aria-pressed', String(following));
  followButton.title = following ? '카메라 고정 해제' : '캐릭터 확대 및 따라가기';
}

followButton.onclick = () => {
  if (!selectedCharacter) return;
  if (view.trackedCharacter === selectedCharacter) view.stopFollowing();
  else view.followCharacter(selectedCharacter);
  updateFollowButton();
};

function showLiveStatus(message) {
  if (!get('error').hidden) return;
  const status = get('map-status');
  if (status.textContent !== message) status.textContent = message;
}

function applyLive(snapshot) {
  if (live?.run_id !== snapshot?.run_id) {
    view.visitorTimeline.clear();
    view.crowd.clear();
    view.setCharacters([]);
  }
  live = snapshot;
  const background = snapshot?.background;
  const characters = snapshot?.qr.characters ?? [];
  get('population').hidden = !snapshot;
  if (background) get('present').textContent = `${background.present_people}명`;
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
  view.setCharacters(characters, selectCharacter, snapshot?.clock);
  view.setVisitors(background?.visitors ?? [], snapshot?.clock);
  renderRide();
  renderCharacter();
  view.render();
}

host.addEventListener('map-error', event => showError(event.detail));
host.addEventListener('map-interaction', updateFollowButton);
host.addEventListener('view-change', event => {
  get('scale').textContent = Math.round(event.detail.zoom * 100) + '%';
});
get('zoom-in').onclick = () => view?.zoom(1.25);
get('zoom-out').onclick = () => view?.zoom(.8);
function showMapOverview(top) {
  view?.stopFollowing();
  updateFollowButton();
  view?.home(top);
}
get('reset').onclick = () => showMapOverview(false);
get('top-view').onclick = () => showMapOverview(true);

function updateMap() {
  if (!view || simulationPanel.hidden || live === latestSnapshot) return;
  if (live?.run_id !== latestSnapshot?.run_id) closeCharacter(false);
  applyLive(latestSnapshot);
}

function renderActiveTab() {
  if (simulationPanel.hidden) renderOperator(latestSnapshot);
  else updateMap();
}

async function initializeMap() {
  if (!mapConfig || mapLoading || simulationPanel.hidden || !get('error').hidden) return;
  mapLoading = true;
  try {
    const {MagicIslandMap} = await import('./map3d.js');
    if (simulationPanel.hidden) return;
    const {map, signs} = mapConfig;
    view = new MagicIslandMap(host, map, select, {signs});
    for (const label of host.querySelectorAll('.facility-label')) vehicleLabels.set(label.dataset.facility, label);
    // 브라우저 검증에 사용하는 읽기 전용 장면 상태.
    window.inspectMagicMap = () => ({...view.inspect(), context: live?.qr.context, clock: live?.clock});
    updateMap();
    get('loading').remove();
  } catch (error) {
    showError('3D 지도를 불러오지 못했습니다. 서버 연결과 브라우저의 WebGL 지원을 확인하세요.');
    get('loading').textContent = '3D 지도를 표시할 수 없습니다.';
    console.error(error);
  } finally {
    mapLoading = false;
  }
}

function activateTab(path, record = false) {
  const selected = tabs.find(tab => tab.dataset.path === path) ?? tabs[0];
  for (const tab of tabs) {
    const active = tab === selected;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    get(tab.getAttribute('aria-controls')).hidden = !active;
  }
  if (record && location.pathname !== path) {
    history.pushState(null, '', path);
    if (simulationPanel.hidden) get('operator-panel').scrollTop = 0;
  }
  document.title = `매직아일랜드 ${selected.textContent}`;
  if (!simulationPanel.hidden) {
    if (view) view.resize();
    else void initializeMap();
  }
  renderActiveTab();
}

for (const tab of tabs) tab.onclick = () => activateTab(tab.dataset.path, true);
tabList.addEventListener('keydown', event => {
  const index = tabs.indexOf(event.target);
  if (index < 0) return;
  const indices = {ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: tabs.length - 1};
  if (!Object.hasOwn(indices, event.key)) return;
  event.preventDefault();
  const tab = tabs[(indices[event.key] + tabs.length) % tabs.length];
  activateTab(tab.dataset.path, true);
  tab.focus();
});
window.addEventListener('popstate', () => activateTab(location.pathname));
activateTab(location.pathname);

async function initialize() {
  try {
    const response = await fetch('/api/meta', {signal: AbortSignal.timeout(5000)});
    if (!response.ok) throw new Error('지도 설정을 가져오지 못했습니다.');
    const {map, hashes, signs = []} = await response.json();
    mapConfig = {map, signs};
    initializeOperator(map, signs);
    void initializeMap();
    showLiveStatus('운영 상태 연결 중');
    void poll(async () => {
      const response = await fetch('/api/state', {signal: AbortSignal.timeout(5000)});
      if (!response.ok) throw new Error('운영 상태를 가져오지 못했습니다.');
      return response.json();
    }, snapshot => {
      if (snapshot.map_hash !== hashes.map || snapshot.qr.context.map_hash !== hashes.map ||
          snapshot.run_id !== snapshot.qr.context.run_id) {
        latestSnapshot = null;
        renderActiveTab();
        showLiveStatus('지도 버전 불일치 · 새로고침 필요');
        return;
      }
      latestSnapshot = snapshot;
      renderActiveTab();
      showLiveStatus('시뮬레이션 연결됨');
    }, () => showLiveStatus(latestSnapshot ? '운영 상태 갱신 지연' : '운영 상태 연결 지연'), 400);
  } catch (error) {
    showError('3D 지도를 불러오지 못했습니다. 서버 연결과 브라우저의 WebGL 지원을 확인하세요.');
    get('loading').textContent = '3D 지도를 표시할 수 없습니다.';
    console.error(error);
  }
}
void initialize();
