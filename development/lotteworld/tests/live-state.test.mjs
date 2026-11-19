import assert from 'node:assert/strict';
import {VisitorTimeline} from '../web/live-state.mjs';

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
