import {estimatedWaitLabel, facilityMetrics, queueWaitingCount} from './live-state.mjs';
import {createVisitorFlowChart} from './operator-visuals.js';

const get = id => document.getElementById(`operator-${id}`);
const facilities = new Map();
const signposts = new Map();
const signVideo = get('sign-video');
const signVideoStatus = get('sign-video-status');
const renderTraffic = createVisitorFlowChart(get('traffic-chart'), get('traffic-empty'));
const detailFields = ['status', 'dispatches', 'queue', 'approaching', 'estimated-wait', 'passengers'];
const vehicleStates = {
  available: '출발 대기', boarding: '승차 중', ready: '출발 준비',
  running: '코스 운행', waiting_for_station: '승강장 대기', unloading: '하차 중',
};
const congestedOccupancy = 0.8;
let selectedId;
let selectedSignId;
let snapshot;

export function initializeOperator(map, signs) {
  const positions = get('facility-positions');
  // 성에서 다리를 향하는 정면 축을 기준으로, 다리에서 성을 보는 화면 좌표를 구한다.
  const [frontX, frontZ] = map.geometry.castle_forward;
  const project = ([x, z]) => ({
    depth: x * frontX + z * frontZ,
    screenX: x * frontZ - z * frontX,
  });
  const farToNear = map.facilities.map(({id, name, label_anchor}) => ({id, name, ...project(label_anchor)}))
    .sort((a, b) => a.depth - b.depth);
  const facilityRows = [];
  for (let index = 0; index < farToNear.length; index += 2) {
    const row = farToNear.slice(index, index + 2).sort((a, b) => a.screenX - b.screenX);
    facilityRows.push(row);
  }
  for (const {id, name} of facilityRows.flat()) {
    const marker = document.createElement('button');
    const markerName = document.createElement('span');
    const markerQueue = document.createElement('span');
    const markerCount = document.createElement('span');
    const markerCongestion = document.createElement('span');
    marker.type = 'button';
    marker.className = 'operator-map-marker';
    marker.setAttribute('aria-label', `${name} 선택`);
    marker.setAttribute('aria-controls', 'operator-detail');
    markerName.className = 'operator-map-name';
    markerName.textContent = name;
    markerQueue.className = 'operator-map-queue';
    markerQueue.hidden = true;
    markerCount.className = 'operator-map-count';
    markerCongestion.className = 'operator-congestion-label';
    markerCongestion.textContent = '혼잡';
    markerQueue.append(markerCongestion, markerCount);
    marker.append(markerName, markerQueue);
    marker.onclick = () => selectFacility(id);
    positions.append(marker);
    facilities.set(id, {name, marker, markerQueue, markerCount});
  }
  selectFacility(map.facilities[0]?.id);

  const rowsByAnchor = new Map();
  const projectedSigns = signs.map(sign => ({sign, ...project(sign.position.point)})).sort((a, b) => a.screenX - b.screenX);
  for (const {sign, depth} of projectedSigns) {
    // 고정된 시설 행 사이에서 안내판의 앞뒤 위치를 표시한다.
    const nextRow = facilityRows.find(row => depth < row.reduce((sum, facility) => sum + facility.depth, 0) / row.length);
    const anchor = facilities.get(nextRow?.[0].id)?.marker ?? null;
    let row = rowsByAnchor.get(anchor);
    if (!row) {
      row = document.createElement('div');
      row.className = 'operator-map-signs';
      positions.insertBefore(row, anchor);
      rowsByAnchor.set(anchor, row);
    }
    const marker = document.createElement('button');
    const icon = document.createElement('span');
    marker.type = 'button';
    marker.className = 'operator-sign-marker';
    marker.dataset.signId = sign.sign_id;
    marker.setAttribute('aria-controls', 'signs');
    icon.className = 'operator-sign-icon';
    icon.setAttribute('aria-hidden', 'true');
    marker.append(icon, sign.name);
    marker.onclick = () => selectSign(sign.sign_id);
    row.append(marker);
    const names = sign.facility_ids.map(id => facilities.get(id)?.name).filter(Boolean);
    signposts.set(sign.sign_id, {marker, name: sign.name, destinations: names.join(' · '), videoUrl: sign.video_url});
  }
  selectSign(signs[0]?.sign_id);
}

function selectSign(id) {
  if (id && id === selectedSignId) return;
  selectedSignId = id;
  const sign = signposts.get(id);
  for (const [signId, {marker}] of signposts) {
    marker.setAttribute('aria-pressed', String(signId === id));
  }
  get('sign-name').hidden = !sign;
  get('sign-name').textContent = sign?.name ?? '';
  get('sign-detail').hidden = !sign?.destinations;
  get('sign-facilities').textContent = sign?.destinations ?? '';

  const url = sign?.videoUrl;
  signVideo.hidden = !url;
  signVideoStatus.hidden = Boolean(url);
  signVideoStatus.textContent = sign ? '연결된 영상이 없습니다' : '등록된 안내판이 없습니다';
  if (url) {
    signVideo.setAttribute('aria-label', `${sign.name} 현장 영상`);
    signVideo.src = url;
  } else if (signVideo.hasAttribute('src')) {
    signVideo.removeAttribute('src');
    signVideo.load();
  }
}

signVideo.addEventListener('error', () => {
  if (!signVideo.error) return;
  signVideo.hidden = true;
  signVideoStatus.textContent = '영상을 불러오지 못했습니다';
  signVideoStatus.hidden = false;
});

function selectFacility(id) {
  const detail = get('detail');
  if (selectedId !== id) detail.scrollTop = 0;
  selectedId = id;
  detail.dataset.facilityId = id ?? '';
  for (const [facilityId, {marker}] of facilities) {
    marker.setAttribute('aria-pressed', String(facilityId === id));
  }
  get('detail-title').textContent = facilities.get(id)?.name ?? '시설 상세';
  renderFacility();
}

function renderFacility() {
  const metrics = facilityMetrics(snapshot, selectedId);
  const vehicles = snapshot?.rides[selectedId]?.vehicles ?? [];
  if (metrics && vehicles.length) {
    metrics.status = vehicles.length === 1
      ? vehicleStates[vehicles[0].state] ?? metrics.status
      : `코스 운행 ${metrics.runningVehicles}대`;
  }
  for (const field of detailFields) get(`ride-${field}`).textContent = metrics?.[field] ?? '—';
  const showVehicleList = vehicles.length > 1;
  get('vehicle-details').hidden = !showVehicleList;
  const list = get('ride-vehicles');
  const rows = (showVehicleList ? vehicles : []).map(vehicle => {
    const number = `${vehicle.vehicle_id}번`;
    const state = vehicleStates[vehicle.state];
    const place = vehicle.station_slot !== null ? `승강장 ${vehicle.station_slot}`
      : vehicle.course_section !== null ? `코스 구간 ${vehicle.course_section}` : '';
    return {number, state, place};
  });
  if (list.textContent !== rows.map(({number, state, place}) => `${number} ${state} ${place}`).join('')) {
    list.replaceChildren(...rows.map(({number, state, place}) => {
      const row = document.createElement('li');
      const label = Object.assign(document.createElement('span'), {className: 'operator-vehicle-number', textContent: number});
      const value = Object.assign(document.createElement('span'), {className: 'operator-vehicle-state', textContent: state});
      const location = Object.assign(document.createElement('span'), {className: 'operator-vehicle-place', textContent: place});
      row.append(label, ' ', value, ' ', location);
      return row;
    }));
  }
}

function isCongested(queue) {
  return queue.capacity > 0 && queue.reserved_count / queue.capacity >= congestedOccupancy;
}

export function renderOperator(value) {
  snapshot = value;
  const background = snapshot?.background;
  renderTraffic(background?.visitor_flow ?? [], snapshot?.run_id);
  let waiting = 0;
  let busy = 0;
  let longest;
  for (const [id, {name, marker, markerQueue, markerCount}] of facilities) {
    const queue = background?.queues[id];
    markerQueue.hidden = !queue;
    if (!queue) {
      markerCount.textContent = '';
      delete marker.dataset.load;
      marker.removeAttribute('aria-description');
      continue;
    }
    const congested = isCongested(queue);
    const count = queueWaitingCount(queue);
    waiting += count;
    busy += Number(congested);
    const seconds = queue.estimated_wait_sim_s;
    if (Number.isFinite(seconds) && (!longest || seconds > longest.seconds)) longest = {name, seconds};
    marker.dataset.load = congested ? 'congested' : 'normal';
    const queueText = `${count}명`;
    if (markerCount.textContent !== queueText) markerCount.textContent = queueText;
    marker.setAttribute('aria-description', `대기 ${queueText}, ${congested ? '혼잡' : '여유'}`);
  }
  get('present').textContent = background ? `${background.present_people.toLocaleString('ko-KR')}명` : '—';
  get('waiting').textContent = background ? `${waiting.toLocaleString('ko-KR')}명` : '—';
  get('busy').textContent = background ? `${busy}곳` : '—';
  get('longest-wait').textContent = estimatedWaitLabel(longest?.seconds);
  get('longest-facility').textContent = longest?.name ?? '';
  get('longest-facility').title = longest?.name ?? '';
  get('longest-facility').hidden = !longest;
  renderFacility();
}
