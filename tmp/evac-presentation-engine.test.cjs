const assert = require('node:assert/strict');
require('./evac-presentation-engine.js');

let passed = 0;
function test(name, run) {
  run();
  passed++;
  console.log('PASS ' + name);
}
function fixture() {
  let time = 0;
  const engine = globalThis.EvacEngine.create({ now: () => time });
  return { engine, at: value => { time = value; return engine.tick(); } };
}
function directions(snapshot) {
  return ['S1', 'S2', 'S3'].map(id => snapshot.signs[id].direction);
}

test('Initial routes and costs are L/L/R, 20/10/12', () => {
  const { engine } = fixture();
  const s = engine.snapshot();
  assert.deepEqual(directions(s), ['left', 'left', 'right']);
  assert.deepEqual(['S1', 'S2', 'S3'].map(id => s.signs[id].cost), [20, 10, 12]);
  assert.deepEqual(s.signs.S1.path, ['e1', 'e3']);
  assert.equal(s.crowd + s.waiting, 60);
});

test('Crowd candidate persists 5 seconds; exact boundary changes to R/R/R', () => {
  const { engine, at } = fixture();
  let s = engine.setCrowd(30);
  assert.deepEqual(directions(s), ['left', 'left', 'right']);
  assert.equal(s.signs.S1.pendingSeconds, 5);
  assert.equal(s.signs.S1.pendingDirection, 'right');
  s = at(4999);
  assert.equal(s.signs.S1.direction, 'left');
  assert.ok(s.signs.S1.pendingSeconds > 0);
  assert.deepEqual(directions(at(5000)), ['right', 'right', 'right']);
});

test('Improvement below 15% does not start a candidate', () => {
  const { engine, at } = fixture();
  assert.equal(engine.setCrowd(8).signs.S1.pendingDirection, null);
  assert.equal(at(10000).signs.S1.direction, 'left');
  assert.equal(engine.setCrowd(9).signs.S1.pendingDirection, 'right');
  assert.equal(at(15000).signs.S1.direction, 'right');
});

test('Unstable candidate restarts its own 5-second persistence', () => {
  const { engine, at } = fixture();
  engine.setCrowd(30);
  at(3000);
  engine.setCrowd(0);
  at(4000);
  assert.equal(engine.setCrowd(30).signs.S1.pendingSeconds, 5);
  assert.equal(at(8000).signs.S1.direction, 'left');
  assert.equal(at(9000).signs.S1.direction, 'right');
});

test('Downstream hazard immediately invalidates whole stored route', () => {
  const { engine, at } = fixture();
  engine.setCrowd(30);
  at(5000);
  const s = engine.setRisk('e4', true);
  assert.deepEqual(directions(s), ['left', 'left', 'none']);
  assert.deepEqual(s.signs.S1.path, ['e1', 'e3']);
  assert.equal(s.signs.S3.status, 'stop');
  assert.equal(s.signs.S1.pendingSeconds, 0);
});

test('Both blocked exits give stop, not unknown', () => {
  const { engine } = fixture();
  engine.setRisk('e3', true);
  const s = engine.setRisk('e4', true);
  assert.ok(Object.values(s.signs).every(sign => sign.status === 'stop'));
  assert.ok(Object.values(s.signs).every(sign => sign.cost === null));
});

test('S3 switches off immediately; CLEAR expires to UNKNOWN at exactly 3 seconds', () => {
  const { engine, at } = fixture();
  let s = engine.setS3(true);
  assert.equal(s.signs.S3.status, 'offline');
  assert.equal(s.risks.e4, 'CLEAR');
  assert.equal(at(2999).risks.e4, 'CLEAR');
  assert.equal(at(3000).risks.e4, 'UNKNOWN');
  s = engine.setRisk('e3', true);
  assert.equal(s.signs.S1.status, 'unknown');
  assert.equal(s.signs.S2.status, 'unknown');
  assert.deepEqual(s.signs.S3.path, []);
});

test('BLOCKED stays latched while S3 is offline, including owner clear input', () => {
  const { engine, at } = fixture();
  engine.setRisk('e4', true);
  engine.setS3(true);
  engine.setRisk('e4', false);
  assert.equal(at(10000).risks.e4, 'BLOCKED');
  assert.equal(engine.setS3(false).risks.e4, 'CLEAR');
});

test('A new offline owner hazard is not received until S3 reconnects', () => {
  const { engine, at } = fixture();
  engine.setS3(true);
  assert.equal(engine.setRisk('e4', true).risks.e4, 'CLEAR');
  assert.equal(at(3000).risks.e4, 'UNKNOWN');
  assert.equal(engine.setS3(false).risks.e4, 'BLOCKED');
});

test('G retains last delivered crowd until exactly 5 seconds, then immediately falls back', () => {
  const { engine, at } = fixture();
  engine.setCrowd(30);
  at(5000);
  engine.setGateway(true);
  engine.setCrowd(0);
  assert.equal(at(9999).signs.S1.direction, 'right');
  const s = at(10000);
  assert.equal(s.stale, true);
  assert.deepEqual(directions(s), ['left', 'left', 'right']);
  assert.equal(s.signs.S1.pendingSeconds, 0);
  assert.equal(s.signs.S1.cost, 20);
});

test('G recovery uses normal crowd hysteresis, not immediate rerouting', () => {
  const { engine, at } = fixture();
  engine.setCrowd(30);
  at(5000);
  engine.setGateway(true);
  at(10000);
  const s = engine.setGateway(false);
  assert.equal(s.stale, false);
  assert.equal(s.signs.S1.direction, 'left');
  assert.equal(s.signs.S1.pendingSeconds, 5);
  assert.equal(at(15000).signs.S1.direction, 'right');
});

test('Repeated disconnect commands do not extend timeout deadlines', () => {
  const { engine, at } = fixture();
  engine.setGateway(true);
  engine.setS3(true);
  at(2000);
  engine.setS3(true);
  assert.equal(at(3000).risks.e4, 'UNKNOWN');
  at(4000);
  engine.setGateway(true);
  assert.equal(at(5000).stale, true);
});

test('People reset preserves hazards and disconnected sources', () => {
  const { engine } = fixture();
  engine.setCrowd(30);
  engine.setRisk('e3', true);
  engine.setRisk('e4', true);
  engine.setGateway(true);
  engine.setS3(true);
  const s = engine.resetPeople();
  assert.equal(s.crowd, 0);
  assert.equal(s.waiting, 60);
  assert.equal(s.gatewayDown, true);
  assert.equal(s.s3Down, true);
  assert.equal(s.risks.e3, 'BLOCKED');
  assert.equal(s.risks.e4, 'BLOCKED');
});

test('People reset discards pending and hold history, restarting candidates', () => {
  const { engine, at } = fixture();
  engine.setCrowd(30);
  at(5000);
  engine.setCrowd(0);
  at(7000);
  const s = engine.resetPeople();
  assert.equal(s.signs.S1.pendingSeconds, 5);
  assert.equal(at(11999).signs.S1.direction, 'right');
  assert.equal(at(12000).signs.S1.direction, 'left');
});

test('Restore clears risks and faults, retains crowd input', () => {
  const { engine } = fixture();
  engine.setCrowd(30);
  engine.setRisk('e3', true);
  engine.setRisk('e4', true);
  engine.setGateway(true);
  engine.setS3(true);
  const s = engine.restore();
  assert.equal(s.crowd, 30);
  assert.equal(s.waiting, 30);
  assert.equal(s.gatewayDown, false);
  assert.equal(s.s3Down, false);
  assert.ok(Object.values(s.risks).every(risk => risk === 'CLEAR'));
  assert.deepEqual(directions(s), ['right', 'right', 'right']);
});

test('Snapshot nested data is isolated from engine internals', () => {
  const { engine } = fixture();
  const s = engine.snapshot();
  s.risks.e1 = 'BLOCKED';
  s.signs.S1.path.length = 0;
  s.events[0].message = 'mutated';
  const next = engine.snapshot();
  assert.equal(next.risks.e1, 'CLEAR');
  assert.deepEqual(next.signs.S1.path, ['e1', 'e3']);
  assert.notEqual(next.events[0].message, 'mutated');
});

test('Backwards injected clock cannot reverse timers', () => {
  const { engine, at } = fixture();
  engine.setCrowd(30);
  at(3000);
  assert.equal(at(1000).signs.S1.pendingSeconds, 2);
  assert.equal(at(5000).signs.S1.direction, 'right');
});

test('Inputs clamp crowd but preserve fixed e2/e5 CLEAR ownership', () => {
  const { engine } = fixture();
  assert.equal(engine.setCrowd(100).crowd, 40);
  assert.equal(engine.setCrowd(-10).crowd, 0);
  assert.equal(engine.setCrowd(3.6).crowd, 4);
  assert.throws(() => engine.setCrowd(NaN), TypeError);
  assert.throws(() => engine.setRisk('e2', true), RangeError);
  assert.throws(() => engine.setRisk('missing', true), RangeError);
});

console.log('\n' + passed + ' engine checks passed.');
