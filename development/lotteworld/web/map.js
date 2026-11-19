import {MagicIslandMap} from './map3d.js';

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
  const facility = view.map.facilities.find(item => item.id === id);
  selectionTrigger = trigger ?? facilityList;
  setPickerOpen(false);
  selectedId = id;
  highlightSelection(id);
  title.textContent = facility.name;
  get('facility-description').textContent = descriptions[id] ?? '매직아일랜드 시설 모형';
  panel.hidden = false;
  title.focus({preventScroll: true});
}

function closePanel() {
  selectedId = null;
  highlightSelection(null);
  panel.hidden = true;
  const focusTarget = selectionTrigger?.hidden ? facilityList : selectionTrigger;
  (focusTarget ?? facilityList).focus({preventScroll: true});
}

facilityList.onclick = () => {
  const open = picker.hidden;
  setPickerOpen(open);
  if (open) (buttons.querySelector('[aria-pressed="true"]') ?? buttons.firstElementChild)?.focus();
};
get('close-panel').onclick = closePanel;
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
    const {map} = await response.json();
    view = new MagicIslandMap(host, map, select);
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
    get('map-status').textContent = '정적 지도';
    // 브라우저 검증에 사용하는 읽기 전용 장면 상태.
    window.inspectMagicMap = () => view.inspect();
  } catch (error) {
    showError('3D 지도를 불러오지 못했습니다. 서버 연결과 브라우저의 WebGL 지원을 확인하세요.');
    get('loading').textContent = '3D 지도를 표시할 수 없습니다.';
    console.error(error);
  }
}
initialize();
