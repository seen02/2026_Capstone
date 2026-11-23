export const characterPhase = {
  awaiting_preferences: '선호 입력 대기',
  ready: '출발 전 대기 중',
  moving: '시설 입구로 이동 중',
  waiting_at_entrance: '입구에서 줄 합류 대기 중',
  queued: '대기열에 합류함',
  boarding: '탑승 중',
  riding: '시설 이용 중',
  unloading: '하차 중',
  completed: '하차 완료',
};

export function characterProgress({queue_position, vehicle_id}) {
  if (queue_position != null) return `대기 순서 ${queue_position}번째`;
  return vehicle_id != null ? `차량 ${vehicle_id}번` : '';
}

export function sameWorld(left, right) {
  return left.scenario_id === right.scenario_id && left.run_id === right.run_id &&
    left.map_hash === right.map_hash && left.timeline_epoch === right.timeline_epoch;
}

function poseAt(before, after, start, end, time) {
  const {point: [x, z], state, visitor_id: id, aboard, exit_path: exitPath} = before;
  const gateFacility = state === 'approaching_queue_gate' ? before.facility_id : undefined;
  const stationary = {id, x, z, state, aboard, exitPath, gateFacility, dx: 0, dz: 0};
  if (!after?.point) return stationary;
  const boardingArrival = after.state === 'at_boarding_point' ? after.walk_trail?.at(-1)?.[0] : undefined;
  if (boardingArrival !== undefined && time >= boardingArrival) return null;
  const joinsQueue = (state === 'walking_to_queue' || state === 'approaching_queue_gate') &&
    time >= (after.queue_entry_at_sim_s ?? Infinity);
  let from = [start, x, z];
  if (aboard) {
    const departure = after.walk_trail?.[0];
    if (!departure || time < departure[0]) return stationary;
    from = departure;
  }
  let to = [end, ...after.point];
  for (const waypoint of after.walk_trail ?? []) {
    if (waypoint[0] >= time) {
      to = waypoint;
      break;
    }
    if (waypoint[0] >= from[0]) from = waypoint;
  }
  const [dx, dz] = [to[1] - from[1], to[2] - from[2]];
  const span = to[0] - from[0];
  const progress = span > 0 ? Math.min(1, Math.max(0, (time - from[0]) / span)) : 0;
  // 조회 사이에 입구 접근을 시작한 사람도 자기 시설의 전용 경로를 따른다.
  const enteringFacility = state === 'walking_to_queue' && !joinsQueue && after.queue_entry_at_sim_s != null
    ? after.facility_id : gateFacility;
  return {id, x: from[1] + progress * dx, z: from[2] + progress * dz,
    state: joinsQueue ? 'joining_queue' : state, aboard: false, exitPath, gateFacility: enteringFacility, dx, dz};
}

export class VisitorTimeline {
  constructor() {
    this.frames = [];
  }

  clear() {
    this.frames.length = 0;
  }

  push(visitors, {sim_time_s: time, time_scale: scale}, received) {
    const previous = this.frames.at(-1);
    if (previous && previous.scale === scale && previous.time === time) return;
    if (!previous || time < previous.time || scale !== previous.scale ||
        (time - previous.time) / scale > 1.2) {
      this.clear();
      this.anchor = {time, received};
    }
    this.frames.push({time, scale, visitors: new Map(visitors.map(visitor => [visitor.visitor_id, visitor]))});
  }

  sample(now) {
    if (!this.frames.length) return {people: [], pending: false};
    const latest = this.frames.at(-1);
    // 한 번의 조회를 완충해 두고, 받은 엔진 상태 사이에서만 움직인다.
    const time = Math.min(latest.time, this.anchor.time +
      Math.max(0, now - this.anchor.received - 500) * latest.scale / 1000);
    while (this.frames.length > 1 && this.frames[1].time <= time) this.frames.shift();
    const [before, after] = this.frames;
    const people = [];
    for (const [id, person] of before.visitors) {
      if (!person.point || person.state === 'at_boarding_point') continue;
      const pose = poseAt(person, after?.visitors.get(id), before.time, after?.time, time);
      if (pose) people.push(pose);
    }
    return {people, pending: time < latest.time};
  }
}

const freeWalking = new Set(['walking_to_queue', 'walking_to_exit', 'waiting_to_exit']);
const walkingRadius = .62;
const cellSize = 2.5;
const maxStep = .75;
const exitTolerance = .55;
// 서로 마주 보는 사람은 각자의 오른쪽부터 빈 공간을 찾는다.
const turns = [0, 36, -36, 65, -65, 90, -90].map(degrees => {
  const angle = degrees * Math.PI / 180;
  return [Math.cos(angle), Math.sin(angle)];
});
const escapeTurns = [45, -45, 90, -90, 135, -135, 180, 0].map(degrees => {
  const angle = degrees * Math.PI / 180;
  return [Math.cos(angle), Math.sin(angle)];
});

class PedestrianGrid {
  constructor() {
    this.rows = new Map();
  }

  bucket(x, z, create = false) {
    const row = Math.floor(z / cellSize), column = Math.floor(x / cellSize);
    if (create && !this.rows.has(row)) this.rows.set(row, new Map());
    const columns = this.rows.get(row);
    if (create && !columns.has(column)) columns.set(column, new Set());
    return columns?.get(column);
  }

  add(person) {
    this.bucket(person.x, person.z, true).add(person);
  }

  move(person, x, z) {
    this.bucket(person.x, person.z).delete(person);
    person.x = x;
    person.z = z;
    this.add(person);
  }

  congestion(x, z) {
    let count = 0;
    const column = Math.floor(x / cellSize), row = Math.floor(z / cellSize);
    for (let r = row - 1; r <= row + 1; r++) {
      const columns = this.rows.get(r);
      if (!columns) continue;
      for (let c = column - 1; c <= column + 1; c++) {
        for (const other of columns.get(c) ?? []) {
          if ((other.x - x) ** 2 + (other.z - z) ** 2 < cellSize ** 2) count++;
        }
      }
    }
    return count;
  }

  isClear(person, x, z) {
    const {id, radius} = person;
    const dx = x - person.x, dz = z - person.z;
    const lengthSq = dx * dx + dz * dz;
    // 최대 한 걸음과 두 사람의 반경 합이 셀 크기보다 작다.
    const column = Math.floor(x / cellSize), row = Math.floor(z / cellSize);
    for (let r = row - 1; r <= row + 1; r++) {
      const columns = this.rows.get(r);
      if (!columns) continue;
      for (let c = column - 1; c <= column + 1; c++) {
        const bucket = columns.get(c);
        if (!bucket) continue;
        for (const other of bucket) {
          if (other.id === id) continue;
          const ox = other.x - person.x, oz = other.z - person.z;
          const t = lengthSq ? Math.max(0, Math.min(1, (ox * dx + oz * dz) / lengthSq)) : 0;
          const spacing = (radius + other.radius) ** 2 - 1e-8;
          // 빈 자리 없이 겹친 상태라면 기존 겹침을 줄이는 방향으로 빠져나갈 수 있다.
          if (lengthSq && t === 0 && ox ** 2 + oz ** 2 < spacing) continue;
          const separationX = ox - t * dx, separationZ = oz - t * dz;
          if (separationX ** 2 + separationZ ** 2 < spacing) return false;
        }
      }
    }
    return true;
  }
}

export class CrowdMovement {
  constructor(navigator, queueRadius) {
    this.navigator = navigator;
    this.queueRadius = queueRadius;
    this.clear();
  }

  clear() {
    this.positions = new Map();
    this.updatedAt = undefined;
    this.departuresPending = false;
  }

  update(people, characters, now, scale) {
    const dt = Math.max(0, (now - (this.updatedAt ?? now)) * scale / 1000);
    this.updatedAt = Math.max(now, this.updatedAt ?? now);
    const maxDistance = Math.min(maxStep, dt * 2.25);
    const grid = new PedestrianGrid();
    this.routeChecks = 1;
    this.exitRouteChecks = 1;
    this.departuresPending = false;
    const positions = new Map();
    const walkers = [], newcomers = [], output = [];
    const present = new Set(people.map(person => person.id));
    for (const character of characters) grid.add({...character, radius: walkingRadius});
    for (const pose of people) {
      const approachingGate = pose.state === 'approaching_queue_gate';
      const point = [pose.x, pose.z];
      const approachingQueue = approachingGate && this.navigator.walkable(point);
      const insideAccess = pose.gateFacility != null && this.navigator.clearOfPolygons?.(point) === false &&
        this.navigator.clearOfPolygons(point, undefined, pose.gateFacility);
      if (insideAccess || !freeWalking.has(pose.state) && !approachingQueue) {
        if (approachingGate && !insideAccess && this.navigator.clearOfPolygons?.(point) === false) continue;
        grid.add({...pose, radius: this.queueRadius});
        output.push(pose);
        continue;
      }
      const previous = this.positions.get(pose.id);
      if (previous) walkers.push({pose, person: previous});
      else newcomers.push({pose});
    }
    for (const [id, person] of this.positions) {
      if (!person.exitPath || present.has(id)) continue;
      const [x, z] = person.exitPath.at(-1);
      const edge = this.navigator.bridgeExit?.(person.x, person.z, walkingRadius) ?? {x, z};
      if (Math.hypot(edge.x - person.x, edge.z - person.z) <= exitTolerance) continue;
      walkers.push({pose: {id, x, z, state: 'walking_to_exit', exitPath: person.exitPath}, person, finishing: true});
      this.departuresPending = true;
    }

    // 직전까지 화면에 있던 사람이 처음 나타난 사람 때문에 밀려나지 않게 한다.
    walkers.push(...newcomers);
    for (const entry of walkers) {
      const {pose, person} = entry;
      const origin = person ?? pose;
      const canStay = this.navigator.clearOfPolygons?.([origin.x, origin.z]) !== false;
      if (!person || !canStay || !grid.isClear(person, person.x, person.z)) {
        entry.person = this.findSpace(origin, grid, canStay);
        if (!entry.person && canStay) entry.person = person ??
          {id: pose.id, x: pose.x, z: pose.z, radius: walkingRadius};
      }
      if (entry.person) grid.add(entry.person);
    }
    for (const {pose, person, finishing} of walkers) {
      if (!person) continue;
      const {x, z} = person;
      person.exitPath = pose.exitPath;
      if (finishing) {
        const goal = this.exitGoal(person);
        if (goal) this.walk(person, {...goal, state: pose.state}, grid, maxDistance, now);
      } else if (pose.state !== 'waiting_to_exit') {
        this.walk(person, pose, grid, maxDistance, now);
      }
      positions.set(pose.id, person);
      output.push({...pose, x: person.x, z: person.z, dx: person.x - x, dz: person.z - z});
    }
    this.positions = positions;
    return output;
  }

  exitGoal(person) {
    const edge = this.navigator.bridgeExit?.(person.x, person.z, walkingRadius);
    if (edge) return edge;
    if (!person.exitSteps) {
      if (!this.exitRouteChecks) return null;
      this.exitRouteChecks--;
      const start = [person.x, person.z];
      const path = person.exitPath;
      // 남아 있는 퇴장 경로 중 현재 모형이 안전하게 연결할 수 있는 가장 앞 지점을 고른다.
      const approach = path.findLastIndex((point, index) => index < path.length - 1 && this.navigator.visible(start, point));
      if (approach >= 0) {
        person.exitSteps = path.slice(approach);
      } else {
        const nearest = path.slice(0, -1).reduce((best, point, index) =>
          Math.hypot(point[0] - person.x, point[1] - person.z) <
          Math.hypot(path[best][0] - person.x, path[best][1] - person.z) ? index : best, 0);
        try {
          const connection = this.navigator.between(start, path[nearest]);
          person.exitSteps = [...connection.slice(1, -1), ...path.slice(nearest)];
        } catch {
          person.exitSteps = path.slice(nearest);
        }
      }
      person.route = null;
      person.detour = null;
    }
    while (person.exitSteps.length > 1 &&
           Math.hypot(person.exitSteps[0][0] - person.x, person.exitSteps[0][1] - person.z) <= exitTolerance) {
      person.exitSteps.shift();
    }
    const [x, z] = person.exitSteps[0];
    return {x, z};
  }

  findSpace({id, x, z}, grid, canStay) {
    const person = {id, x, z, radius: walkingRadius};
    if (canStay && grid.isClear(person, x, z)) return person;
    // 새로 들어오거나 하차한 사람이 같은 지점에 겹치면 근처의 빈 보행면에서 표시한다.
    const origin = [x, z];
    for (let ring = 1; ring <= 7; ring++) {
      const spots = 8 * ring, distance = ring * walkingRadius * 2;
      for (let spot = 0; spot < spots; spot++) {
        const angle = 2 * Math.PI * ((spot + id % 8) % spots) / spots;
        person.x = x + Math.cos(angle) * distance;
        person.z = z + Math.sin(angle) * distance;
        const candidate = [person.x, person.z];
        if (grid.isClear(person, person.x, person.z) && this.navigator.walkable(candidate) &&
            (!canStay || this.navigator.clearOfPolygons?.(origin, candidate) !== false)) return person;
      }
    }
    return null;
  }

  walk(person, pose, grid, maxDistance, now) {
    const lag = Math.hypot(pose.x - person.x, pose.z - person.z);
    const last = person.progress;
    if (!last || Math.hypot(last.x - person.x, last.z - person.z) >= .75) {
      person.progress = {x: person.x, z: person.z, at: now};
    }
    if (person.detour && (now >= person.detour.expires || Math.hypot(
      person.detour.x - person.x, person.detour.z - person.z) < .55)) person.detour = null;
    const stalledFor = now - person.progress.at;
    const routeGoal = this.rejoin(person, pose, lag, now, stalledFor);
    if (!person.detour && lag > 2 && stalledFor > 550 && now >= (person.retryAt ?? 0)) {
      person.retryAt = now + 480;
      person.detour = this.findDetour(person, routeGoal, grid, now, stalledFor > 1200);
    }
    const goal = person.detour ?? routeGoal;
    if (this.takeStep(person, goal, grid, maxDistance, turns, goal === pose)) return;
    if (lag > 2 && stalledFor > 400) {
      this.takeStep(person, goal, grid, maxDistance * .55, escapeTurns, false);
    }
  }

  rejoin(person, pose, lag, now, stalledFor) {
    if (lag < 3 || now >= person.routeExpires) person.route = null;
    if (!person.route?.length && lag > 8 && stalledFor > 900 && this.navigator.between &&
        this.routeChecks > 0 && now >= (person.routeCheckAt ?? 0)) {
      const origin = [person.x, person.z];
      const ahead = [person.x + (pose.x - person.x) * .65 / lag, person.z + (pose.z - person.z) * .65 / lag];
      if (pose.state === 'walking_to_exit' || !this.navigator.walkable(ahead) ||
          this.navigator.clearOfPolygons?.(origin, ahead) === false) {
        // 뒤처진 사람은 건물 너머의 좌표를 직선으로 쫓지 않고 광장 경로를 다시 찾는다.
        this.routeChecks--;
        person.routeCheckAt = now + 1600 + (person.id % 7) * 80;
        try {
          const points = this.navigator.between(origin, [pose.x, pose.z]);
          person.route = points.slice(1, -1).map(([x, z]) => ({x, z}));
          person.routeExpires = now + 3600;
        } catch {
          // 공공 보행 경계에 걸쳐 있으면 짧은 옆걸음으로 공간을 먼저 확보한다.
        }
      }
    }
    while (person.route?.length && Math.hypot(person.route[0].x - person.x, person.route[0].z - person.z) < .85) {
      person.route.shift();
    }
    return person.route?.[0] ?? pose;
  }

  findDetour(person, goal, grid, now, requireClearStep) {
    const lag = Math.hypot(goal.x - person.x, goal.z - person.z);
    if (lag < .01) return null;
    const dx = (goal.x - person.x) / lag, dz = (goal.z - person.z) / lag;
    const start = [person.x, person.z];
    let best = null, bestCost = Infinity;
    for (const [cos, sin] of escapeTurns) {
      const sideX = dx * cos + dz * sin, sideZ = dz * cos - dx * sin;
      if (requireClearStep && !grid.isClear(person, person.x + sideX * .4, person.z + sideZ * .4)) continue;
      const x = person.x + sideX * 4.5;
      const z = person.z + sideZ * 4.5;
      if (!this.navigator.visible(start, [x, z])) continue;
      const cost = grid.congestion(x, z) * 2 + Math.hypot(goal.x - x, goal.z - z) - lag;
      if (cost >= bestCost) continue;
      best = {x, z, expires: now + 1400};
      bestCost = cost;
    }
    return best;
  }

  takeStep(person, goal, grid, maxDistance, directions, onRoute) {
    const dx = goal.x - person.x, dz = goal.z - person.z;
    const distance = Math.hypot(dx, dz);
    const step = Math.min(distance, maxDistance);
    if (step < .005) return;
    const origin = [person.x, person.z];
    for (const [cos, sin] of directions) {
      const x = person.x + (dx * cos + dz * sin) * step / distance;
      const z = person.z + (dz * cos - dx * sin) * step / distance;
      // 다리 바깥 경계처럼 엔진이 지정한 경계점에도 닿을 수 있게 한다.
      const atRoutePoint = onRoute && cos === 1 && step === distance;
      const next = [x, z];
      if (grid.isClear(person, x, z) && (atRoutePoint || this.navigator.walkable(next)) &&
          this.navigator.clearOfPolygons?.(origin, next) !== false) {
        grid.move(person, x, z);
        return true;
      }
    }
    return false;
  }
}

export function estimatedWaitLabel(seconds) {
  return Number.isFinite(seconds) ? `약 ${Math.ceil(seconds / 60)}분` : '—';
}

export function queueWaitingCount(queue) {
  return queue.waiting_count ?? queue.queued_count;
}

export function facilityMetrics(snapshot, id) {
  const ride = snapshot?.rides[id];
  const queue = snapshot?.background.queues[id];
  if (!ride || !queue) return null;
  const running = ride.vehicles.filter(vehicle => vehicle.state === 'running').length;
  return {
    status: running ? `코스 운행 ${running}대` : '코스 운행 차량 없음',
    runningVehicles: running,
    dispatches: `${ride.dispatch_count}회`,
    queue: `${queueWaitingCount(queue)}명`,
    approaching: Number.isInteger(queue.approaching_count) ? `${queue.approaching_count}명` : '—',
    'estimated-wait': estimatedWaitLabel(queue.estimated_wait_sim_s),
    passengers: `${ride.riding_people}명`,
  };
}

// 한 번에 하나의 요청만 실행한다. 백그라운드 탭은 다시 보일 때 최신 상태를 받는다.
export async function poll(read, apply, onError, delay) {
  for (;;) {
    if (!document.hidden) {
      try {
        await apply(await read());
      } catch (error) {
        onError(error);
      }
    }
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}
