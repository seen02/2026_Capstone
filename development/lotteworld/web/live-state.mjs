export const characterPhase = {
  awaiting_preferences: '선호 입력 대기',
  ready: '표지판 주변에서 대기 중',
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
  const {point: [x, z], state, visitor_id: id, aboard} = before;
  const stationary = {id, x, z, state, aboard, dx: 0, dz: 0};
  if (!after?.point) return stationary;
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
  return {id, x: from[1] + progress * dx, z: from[2] + progress * dz, state, aboard: false, dx, dz};
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
      if (person.point) people.push(poseAt(person, after?.visitors.get(id), before.time, after?.time, time));
    }
    return {people, pending: time < latest.time};
  }
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
