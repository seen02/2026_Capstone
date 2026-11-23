import assert from 'node:assert/strict';
import {CrowdMovement, VisitorTimeline} from '../web/live-state.mjs';
import {createNavigator} from '../web/navigation.mjs';

const clock = time => ({sim_time_s: time, time_scale: 6});
const visitor = (point, walk_trail) => ({visitor_id: 1, state: 'walking_to_queue', point, walk_trail});
const timeline = new VisitorTimeline();
timeline.push([visitor([0, 0])], clock(0), 0);
timeline.push([visitor([1, 1.4], [[0, 0, 0], [1, 1, 0], [2.4, 1, 1.4]])], clock(2.4), 400);
for (const [now, expected] of [[600, [.6, 0]], [700, [1, .2]], [950, [1, 1.4]]]) {
  const {people: [person]} = timeline.sample(now);
  assert.ok(Math.abs(person.x - expected[0]) < 1e-8);
  assert.ok(Math.abs(person.z - expected[1]) < 1e-8);
}
assert.equal(timeline.sample(950).pending, false);
timeline.push([visitor([20, 20])], clock(30), 5000);
assert.equal(timeline.sample(5000).people[0].x, 20);
timeline.clear();
assert.deepEqual(timeline.sample(5100).people, []);
timeline.push([{...visitor([50, 50]), aboard: true}], clock(0), 0);
timeline.push([visitor([2, 1], [[1.6, 2, 0], [2.4, 2, 1]])], clock(2.4), 400);
const onRide = timeline.sample(650).people[0];
assert.deepEqual([onRide.x, onRide.z, onRide.aboard], [50, 50, true]);
const unloading = timeline.sample(800).people[0];
assert.equal(unloading.x, 2);
assert.ok(Math.abs(unloading.z - .25) < 1e-8);
assert.equal(unloading.aboard, false);
console.log('보행 경유점 보간, 차량 표식과 하차 위치 전환, 갱신 지연 뒤 복구 검사 통과');

timeline.clear();
timeline.push([{...visitor([0, 0]), state: 'approaching_queue_gate'}], clock(0), 0);
timeline.push([{
  ...visitor([2, 0], [[0, 0, 0], [1.2, 1, 0], [2.4, 2, 0]]),
  state: 'joining_queue', queue_entry_at_sim_s: 1.2,
}], clock(2.4), 400);
assert.equal(timeline.sample(699).people[0].state, 'approaching_queue_gate');
const [atGate] = timeline.sample(700).people;
assert.equal(atGate.state, 'joining_queue');
assert.deepEqual([atGate.x, atGate.z], [1, 0]);

timeline.clear();
timeline.push([{...visitor([0, 0]), state: 'walking_to_board'}], clock(0), 0);
timeline.push([{...visitor([1.4, 0], [[0, 0, 0], [1, 1.4, 0]]), state: 'at_boarding_point'}], clock(2.4), 400);
const [approaching] = timeline.sample(600).people;
assert.ok(Math.abs(approaching.x - .84) < 1e-8);
assert.deepEqual(timeline.sample(700).people, [], '출발 전이어도 탑승 위치에 도착한 사람은 보행 모형에서 숨긴다.');
assert.deepEqual(timeline.sample(950).people, []);
timeline.push([{...visitor(null), state: 'on_ride'}], clock(4.8), 800);
assert.deepEqual(timeline.sample(1300).people, []);
timeline.push([{...visitor([2, 0]), state: 'walking_from_ride'}], clock(7.2), 1200);
assert.equal(timeline.sample(1800).people[0].state, 'walking_from_ride');
console.log('탑승 접근 보간, 출발 전 모형 숨김과 하차 모형 복귀 검사 통과');

function walker(id, x, z = 0) {
  return {id, x, z, state: 'walking_to_queue'};
}

const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const openSpace = {walkable: () => true, visible: () => true};
const passing = new CrowdMovement(openSpace, .345);
let passed;
for (let now = 0; now <= 10000; now += 40) {
  const offset = now / 1000 * 1.4;
  passed = passing.update([walker(1, -6 + offset), walker(2, 6 - offset)], [], now, 1);
  assert.ok(distance(...passed) >= 1.24 - 1e-6, '양방향 보행자가 서로 통과하지 않는다.');
}
assert.ok(passed[0].x > 7 && passed[1].x < -7, '옆으로 비켜 지나간 뒤 다시 진행한다.');

const inNarrowPath = ([, z]) => Math.abs(z) <= .18;
const narrow = new CrowdMovement({walkable: inNarrowPath, visible: (a, b) => inNarrowPath(a) && inNarrowPath(b)}, .345);
const qr = {id: 'qr', x: 0, z: 0};
const spot = {id: 2, x: 0, z: 2, state: 'queued', dx: 0, dz: 0};
for (let now = 0; now <= 10000; now += 40) {
  const [queued, walking] = narrow.update([walker(1, -6 + now / 1000 * 1.4), spot], [qr], now, 1);
  assert.deepEqual(queued, spot, '대기줄 자리는 서버 위치를 따른다.');
  assert.ok(distance(walking, qr) >= 1.24 - 1e-6);
  assert.ok(walking.x < 0 && Math.abs(walking.z) <= .18, '길 밖이나 QR 캐릭터를 통과하지 않고 기다린다.');
}

const crowded = new CrowdMovement(openSpace, .345);
const arrivals = Array.from({length: 30}, (_, id) => walker(id, 0));
const spread = crowded.update(arrivals, [], 0, 6);
assert.equal(spread.length, arrivals.length);
for (let i = 0; i < spread.length; i++) {
  assert.ok(spread.slice(i + 1).every(other => distance(spread[i], other) >= 1.24 - 1e-6));
}

const blocked = new CrowdMovement(openSpace, .345);
const side = 1.24 * Math.sqrt(3) / 2;
const stopped = [{id: 'front', x: 1.24, z: 0}, {id: 'left', x: .62, z: side}, {id: 'right', x: .62, z: -side}];
let retreated = false, escaped;
for (let now = 0; now <= 10000; now += 40) {
  [escaped] = blocked.update([walker(1, now / 1000 * 1.4)], stopped, now, 1);
  retreated ||= escaped.x < -1;
  assert.ok(stopped.every(other => distance(escaped, other) >= 1.24 - 1e-6));
}
assert.ok(retreated && escaped.x > 8, '앞이 막힌 보행자가 뒤로 물러나 옆으로 빠져나간다.');

const outsideBuilding = ([x, z]) => !(x >= 2 && x <= 6 && Math.abs(z) <= 2);
const aroundBuilding = new CrowdMovement({
  walkable: outsideBuilding,
  visible: (a, b) => Array.from({length: 11}, (_, i) => [
    a[0] + (b[0] - a[0]) * i / 10, a[1] + (b[1] - a[1]) * i / 10,
  ]).every(outsideBuilding),
  between: (a, b) => [a, [1.2, -3], [7, -3], b],
}, .345);
let rejoined;
for (let now = 0; now <= 12000; now += 40) {
  [rejoined] = aroundBuilding.update([walker(1, now ? 11 : 0)], [], now, 1);
  assert.ok(outsideBuilding([rejoined.x, rejoined.z]));
}
assert.ok(rejoined.x > 10, '건물 너머의 경로로 돌아갈 때 포장면을 따라 우회한다.');
console.log('양방향 보행 간격, 좁은 길 대기, QR 우선, 대기줄 위치와 동시 합류 검사 통과');

const crowdedGate = new CrowdMovement({walkable: ([x]) => x >= 0 && x < .5}, .345);
crowdedGate.update([walker(1, 0)], [], 0, 1);
const crowdedAtStart = crowdedGate.update([walker(1, 0), walker(2, 0)], [], 40, 1);
assert.equal(crowdedAtStart.length, 2, '빈자리를 못 찾은 보행자도 화면에 남긴다.');
const separating = crowdedGate.update([walker(1, .4), walker(2, 0)], [], 80, 1);
assert.ok(separating[0].x > separating[1].x, '겹친 상태에서도 거리를 벌리는 걸음은 허용한다.');

const exitPath = [[1, 0], [1, -3], [7, -3], [11, 0]];
const exitTimeline = new VisitorTimeline();
const exiting = new CrowdMovement(aroundBuilding.navigator, .345);
exitTimeline.push([{...visitor([0, 0]), state: 'walking_to_exit', exit_path: exitPath}], clock(0), 0);
const sampleExit = now => exiting.update(exitTimeline.sample(now).people, [], now, 1);
let [lastVisible] = sampleExit(0);
exitTimeline.push([], clock(20), 4000);
let finished = false;
for (let now = 4000; now <= 20000; now += 40) {
  const [person] = sampleExit(now);
  if (!person) {
    assert.ok(distance(lastVisible, {x: 11, z: 0}) <= .55, '서버 퇴장 이후에도 경계까지 걸어간다.');
    assert.equal(exiting.departuresPending, false);
    finished = true;
    break;
  }
  assert.ok(outsideBuilding([person.x, person.z]), '남은 퇴장 동선은 건물을 우회한다.');
  assert.ok(distance(lastVisible, person) <= .75 + 1e-8, '조회가 오래 끊겨도 모형을 순간 이동시키지 않는다.');
  assert.equal(exiting.departuresPending, true);
  lastVisible = person;
}
assert.ok(finished, '화면에 남은 방문객도 퇴장을 마친다.');

const protectedMap = {facilities: [], geometry: {
  bounds: [0, 0, 60, 60], island_outline: [[0, 0], [60, 0], [60, 60], [0, 60]],
  castle: [53, 53, 4, 4], scenery_buildings: [], landscape_beds: [], nodes: [], edges: [],
  ride_access_areas: [{facility_id: 'ride', outline: [[26, 8], [46, 8], [46, 42], [26, 42]]}],
}};
const protectedNav = createNavigator(protectedMap, {radius: .345});
const protectedCrowd = new CrowdMovement(protectedNav, .345);
let [previousPublic] = protectedCrowd.update([walker(1, 24, 22)], [], 0, 1);
for (let now = 40; now < 3600; now += 40) {
  const [publicPose] = protectedCrowd.update([walker(1, 29, 22)], [], now, 1);
  assert.ok(protectedNav.clearOfPolygons([previousPublic.x, previousPublic.z], [publicPose.x, publicPose.z]));
  previousPublic = publicPose;
}
timeline.clear();
timeline.push([{...visitor([24, 22]), facility_id: 'ride'}], clock(0), 0);
timeline.push([{
  ...visitor([27, 22], [[0, 24, 22], [2.4, 27, 22]]),
  state: 'approaching_queue_gate', facility_id: 'ride', queue_entry_at_sim_s: 4,
}], clock(2.4), 400);
const [switching] = timeline.sample(850).people;
assert.ok(switching.x > 26);
const [allowed] = protectedCrowd.update([switching], [], 3600, 1);
assert.equal(allowed.x, switching.x, '아직 다음 조회 전이어도 자기 시설 입구 접근은 보간 위치를 따른다.');
const wrongFacility = {...switching, state: 'approaching_queue_gate', gateFacility: 'other'};
assert.equal(protectedCrowd.update([wrongFacility], [], 3640, 1).length, 0);
console.log('공용 보행 전용 구역 회피와 자기 시설 입구 접근 검사 통과');
