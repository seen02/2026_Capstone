"""연속 유입, 개인 체류, 대기열과 시설 운행을 진행한다."""
from bisect import bisect_left, bisect_right
from collections import deque
from dataclasses import dataclass, field
from heapq import heappop, heappush
from itertools import count
from math import dist
from random import Random
from threading import Lock
from time import monotonic
from uuid import uuid4

from .ride_operations import RideOperation
from .scenario import DEFAULT_PREFERENCE_BEHAVIOR, SCENARIO_ID
from .visitor_routes import FacilityPaths, Path, PUBLIC_WALK_VARIANTS, UNLOAD_GAP_S, WALK_M_PER_S

QR_PHASES = {
    'walking_to_queue': 'moving', 'waiting_at_entrance': 'waiting_at_entrance',
    'in_queue': 'queued', 'walking_to_board': 'boarding', 'at_boarding_point': 'boarding',
    'on_ride': 'riding', 'waiting_for_station': 'riding',
    'awaiting_unload': 'unloading', 'walking_from_ride': 'unloading', 'completed': 'completed',
}
QR_PHASE_ORDER = tuple(dict.fromkeys(QR_PHASES.values()))


@dataclass(frozen=True)
class Motion:
    path: Path
    start: float
    origin: float
    target: float
    speed_m_s: float = WALK_M_PER_S
    # 보행 시작점 기준의 시작 거리, 끝 거리, 구간 속도다.
    slower: tuple[float, float, float] | None = None

    @property
    def end(self):
        return self.start + self.elapsed_at(abs(self.target - self.origin))

    def elapsed_at(self, distance):
        elapsed = distance / self.speed_m_s
        if self.slower:
            start, end, speed = self.slower
            slow_distance = max(0, min(distance, end) - start)
            elapsed += slow_distance * (1 / speed - 1 / self.speed_m_s)
        return elapsed

    def distance_at(self, now):
        if now >= self.end:
            return self.target
        elapsed = now - self.start
        distance = elapsed * self.speed_m_s
        if self.slower:
            start, end, speed = self.slower
            slower_elapsed = min(max(0, elapsed - start / self.speed_m_s), (end - start) / speed)
            distance -= slower_elapsed * (self.speed_m_s - speed)
        direction = 1 if self.target >= self.origin else -1
        return self.origin + distance * direction

    def trail(self, now, lookback):
        start = max(self.start, now - lookback)
        first, last = self.distance_at(start), self.distance_at(now)
        if first == last:
            return None
        low, high = sorted((first, last))
        corners = self.path.offsets[bisect_right(self.path.offsets, low):bisect_left(self.path.offsets, high)]
        if self.slower:
            direction = 1 if self.target >= self.origin else -1
            pace_offsets = (self.origin + direction * d for d in self.slower[:2])
            corners = sorted(set(corners).union(offset for offset in pace_offsets if low < offset < high))
        if first > last:
            corners = reversed(corners)
        points = [[start, *self.path.point_at(first)]]
        points.extend([self.start + self.elapsed_at(abs(offset - self.origin)), *self.path.point_at(offset)]
                      for offset in corners)
        points.append([min(now, self.end), *self.path.point_at(last)])
        return points


@dataclass
class Visitor:
    visitor_id: int | str
    entered_at_sim_s: float
    leave_at_sim_s: float
    phase: str = 'present'
    facility_id: str | None = None
    motion: Motion | None = None
    slot: int | None = None
    has_waited: bool = False
    withdrawing: bool = False
    expired: bool = False
    vehicle_id: int | None = None
    profile: dict | None = None
    wait_patience: float = 0
    waiting_source: str | None = None
    completed_rides: dict[str, int] = field(default_factory=dict)
    walking_variant: int | None = None
    public_speed_m_s: float = WALK_M_PER_S

    def snapshot(self, now, trail_sim_s=0):
        state = self.phase
        if state == 'in_queue':
            if now >= self.motion.end:
                state = 'queued'
            else:
                state = 'advancing_queue' if self.has_waited else 'joining_queue'
        snapshot = {key: getattr(self, key) for key in ('visitor_id', 'entered_at_sim_s', 'leave_at_sim_s')} | {
            'state': state, 'facility_id': self.facility_id, 'queue_slot': self.slot,
            'point': self.motion.path.point_at(self.motion.distance_at(now)) if self.motion else None,
            'departure_requested': self.expired, 'vehicle_id': self.vehicle_id,
            'preference_profile_id': self.profile['id'] if self.profile else None,
            'completed_rides': dict(self.completed_rides),
        }
        if trail_sim_s and self.motion:
            if trail := self.motion.trail(now, trail_sim_s):
                snapshot['walk_trail'] = trail
        return snapshot


@dataclass
class FacilityQueue:
    paths: FacilityPaths
    members: list[Visitor] = field(default_factory=list)
    batch: list[Visitor] = field(default_factory=list)
    next_entry: float = 0
    approaching_people: int = 0
    lateral_until: float = 0
    next_withdrawal_merge: float = 0
    next_unload: float = 0
    entrance_waiters: deque = field(default_factory=deque)

    @property
    def capacity(self):
        return len(self.paths.slots)


@dataclass
class QRVisitor(Visitor):
    completed_at: float | None = None


class BackgroundRun:
    def __init__(self, config, routes=None, *, map_hash=None, ride_operations=None,
                 ride_operations_hash=None, preferences=None, preferences_hash=None, clock=monotonic):
        self.run_id = f"continuous-{uuid4().hex}"
        self.clock = clock
        self.lock = Lock()
        self.target = config['target_people']
        self.interval = config['admission_interval_sim_s']
        self.stay_range = config['stay_sim_s']
        self.time_scale = config['time_scale']
        self.stays = Random(config['seed'])
        initial_ages = Random(config['seed'] + 1)
        self.profile_random = Random(config['seed'] + 2)
        self.choice_random = Random(config['seed'] + 3)
        self.walk_random = Random(config['seed'] + 4)
        self.profiles = preferences['profiles'] if preferences is not None else None
        self.behavior = (preferences.get('behavior', DEFAULT_PREFERENCE_BEHAVIOR)
                         if preferences is not None else DEFAULT_PREFERENCE_BEHAVIOR)
        self.routes = routes
        self.map_hash = map_hash
        self.ride_operations_hash = ride_operations_hash
        self.preferences_hash = preferences_hash
        self.queues = {key: FacilityQueue(paths) for key, paths in routes.facilities.items()} if routes else {}
        self.facility_ids = tuple(self.queues)
        self.walk_gap = routes.queue_headway_m / WALK_M_PER_S if routes else 0
        self.visitors = {}
        self.qr_visitors = {}
        self.events = []
        self.event_order = count()
        self.entered_total = 0
        self.exited_total = 0
        self.admission_pending = False
        self.rides = {key: RideOperation(self, self.queues[key], settings)
                      for key, settings in (ride_operations or {}).items()}
        self.queue_times = {key: self._queue_times(queue, self.rides.get(key)) for key, queue in self.queues.items()}
        for _ in range(config['initial_people']):
            self._admit(0, initial_ages.random())
        self._schedule_admission(0)
        self.started = self.clock()

    def _schedule(self, when, action, *args, priority=0):
        heappush(self.events, (when, priority, next(self.event_order), action, args))

    def _schedule_admission(self, now):
        if not self.admission_pending and len(self.visitors) < self.target:
            self.admission_pending = True
            self._schedule(now + self.interval, self._admit, priority=2)

    def _admit(self, now, elapsed_fraction=None):
        duration = self.stays.uniform(*self.stay_range)
        entered = now - duration * (elapsed_fraction or 0)
        self.entered_total += 1
        visitor = Visitor(self.entered_total, entered, entered + duration)
        if self.profiles is not None:
            visitor.profile = self.profile_random.choice(self.profiles)
            visitor.wait_patience = self.profile_random.uniform(*self.behavior['wait_patience_sim_s'])
            visitor.walking_variant = self.walk_random.randrange(PUBLIC_WALK_VARIANTS)
            visitor.public_speed_m_s = self.walk_random.uniform(1.15, 1.65)
        self.visitors[visitor.visitor_id] = visitor
        self._schedule(visitor.leave_at_sim_s, self._expire, visitor)
        if self.routes:
            self._seek_queue(now, visitor, self.routes.boundary, fraction=elapsed_fraction or 0)
        if elapsed_fraction is None:
            self.admission_pending = False
            self._schedule_admission(now)

    def _walk(self, now, visitor, phase, path, arrival, *args, origin=0, target=None, slower=None):
        visitor.phase = phase
        speed = visitor.public_speed_m_s if phase in ('walking_to_queue', 'walking_to_exit') else WALK_M_PER_S
        visitor.motion = Motion(path, now, origin, path.length if target is None else target, speed, slower)
        self._schedule(visitor.motion.end, arrival, visitor, *args)

    def _public_path(self, visitor, source, target):
        return self.routes.visitor_path(source, target, visitor.walking_variant)

    def _seek_queue(self, now, visitor, source, fraction=0, *, avoid=None):
        if visitor.expired:
            visitor.facility_id = None
            path = self._public_path(visitor, source, self.routes.boundary)
            self._walk(now, visitor, 'walking_to_exit', path, self._depart)
            return
        if visitor.profile is not None:
            self._seek_preferred_queue(now, visitor, source, fraction, avoid)
            return
        ids = self.facility_ids
        start = (ids.index(visitor.facility_id) + 1 if visitor.facility_id else visitor.visitor_id - 1) % len(ids)
        order = ids[start:] + ids[:start]
        if visitor.facility_id:
            order = order[:-1]
        candidates = [(key, self.queues[key]) for key in order]
        for key, queue in candidates:
            if len(queue.members) < queue.capacity and (queue.paths.approach != source or self._can_enter(now, queue)):
                break
        else:
            # 여러 시설이 같은 연결점을 쓰는 지도에서도 만석 재시도가 한 시각에 반복되지 않는다.
            next_stop = next(((key, queue) for key, queue in candidates
                              if self.routes.public_path(source, queue.paths.approach).length), None)
            if next_stop is None:
                path = self._public_path(visitor, source, self.routes.boundary)
                self._walk(now, visitor, 'walking_to_queue', path, self._seek_queue, self.routes.boundary)
                return
            key, queue = next_stop
        path = self._public_path(visitor, source, queue.paths.approach)
        self._walk_to_queue(now, visitor, key, path, fraction)

    @staticmethod
    def _queue_times(queue, ride):
        paths = queue.paths
        head_walk = paths.slots[-1] / WALK_M_PER_S
        board_walk = paths.queue.length / WALK_M_PER_S - head_walk
        if ride is None:
            return head_walk, 0
        settings = ride.settings
        boarding = max(board_walk, settings['boarding_and_check_seconds'])
        unloading = settings['unloading_seconds']
        travel = settings['ride_seconds']
        headway = max(settings['dispatch_interval_seconds'], float(ride.section_seconds),
                      (boarding + travel + unloading) / len(ride.vehicles),
                      (boarding + unloading) / settings['station_capacity'])
        return head_walk, headway

    def _estimated_wait(self, key):
        head_walk, headway = self.queue_times[key]
        queue = self.queues[key]
        committed = len(queue.members) + queue.approaching_people
        return max(head_walk, committed * headway / queue.paths.boarding_capacity)

    @staticmethod
    def _wait_limit(visitor, key):
        score = visitor.profile['preferences'][key]
        return visitor.wait_patience * (0.5 + score / 10)

    @staticmethod
    def _can_enter(now, queue):
        return not queue.entrance_waiters and len(queue.members) < queue.capacity and now >= queue.next_entry

    def _seek_preferred_queue(self, now, visitor, source, fraction, avoid):
        destinations, weights = [], []
        can_reach_queue = False
        for key, queue in self.queues.items():
            score = visitor.profile['preferences'][key]
            if not score:
                continue
            wait_limit = self._wait_limit(visitor, key)
            if self.queue_times[key][0] >= wait_limit:
                continue
            wait = self._estimated_wait(key)
            available = (key != avoid and len(queue.members) + queue.approaching_people < queue.capacity
                         and wait < wait_limit
                         and (source != queue.paths.approach or self._can_enter(now, queue)))
            if not available and can_reach_queue:
                continue
            path = self._public_path(visitor, source, queue.paths.approach)
            origin = fraction * path.length
            pace = self._recommendation_pace(visitor, path, origin)
            walk = Motion(path, now, origin, path.length, visitor.public_speed_m_s, pace).elapsed_at(path.length - origin)
            if now + walk >= visitor.leave_at_sim_s:
                continue
            can_reach_queue = True
            if not available:
                continue
            repeat = self.behavior['repeat_weight'] if key in visitor.completed_rides else 1
            cost = 1 + (walk + wait) / self.behavior['time_cost_scale_sim_s']
            destinations.append((key, path))
            weights.append(self.behavior['facility_weights'][key] * score * repeat / cost)

        if destinations:
            (key, path), = self.choice_random.choices(destinations, weights)
            self._walk_to_queue(now, visitor, key, path, fraction)
            return
        visitor.facility_id = None
        if not can_reach_queue and not (isinstance(source, tuple) or source in self.routes.approach_nodes):
            visitor.phase = 'waiting_to_exit'
            visitor.waiting_source = source
            visitor.motion = Motion(self.routes.public_path(source, source), now, 0, 0)
            return
        # 당장 갈 시설이 없으면 입구를 돌지 않고 열린 광장을 걷다가 다시 확인한다.
        desired_span = 50 + visitor.visitor_id % 8 * 5
        stop = self.routes.plaza_stop(source, desired_span)
        if stop is not None:
            path = self._public_path(visitor, source, stop)
            pace = self._recommendation_pace(visitor, path, 0)
            self._walk(now, visitor, 'walking_to_queue', path, self._seek_queue, stop, slower=pace)
            return
        self._schedule(now + self.walk_gap, self._seek_queue, visitor, source)

    @staticmethod
    def _recommendation_pace(visitor, path, origin):
        if visitor.profile is None or origin > 0:
            return None
        start = 6 + visitor.visitor_id % 7
        end = min(path.length - 4, start + 3 + (visitor.visitor_id // 7) % 5)
        if end > start:
            return start, end, visitor.public_speed_m_s * (.60 + visitor.visitor_id % 5 * .05)

    def _walk_to_queue(self, now, visitor, key, path, fraction):
        visitor.facility_id = key
        visitor.has_waited = False
        self.queues[key].approaching_people += 1
        origin = fraction * path.length
        pace = self._recommendation_pace(visitor, path, origin)
        self._walk(now, visitor, 'walking_to_queue', path, self._arrive_at_queue, origin=origin, slower=pace)

    def _arrive_at_queue(self, now, visitor):
        key = visitor.facility_id
        queue = self.queues[key]
        queue.approaching_people -= 1
        if visitor.expired or not self._can_enter(now, queue):
            self._seek_queue(now, visitor, queue.paths.approach, avoid=key)
            return
        self._join_queue(now, visitor, queue)

    def _join_queue(self, now, visitor, queue, *, origin=0):
        queue.next_entry = now + self.walk_gap
        visitor.phase = 'in_queue'
        visitor.slot = queue.capacity - 1 - len(queue.members)
        visitor.motion = Motion(queue.paths.queue, now, origin, queue.paths.slots[visitor.slot])
        queue.members.append(visitor)
        if ride := self.rides.get(visitor.facility_id):
            ride.wake(now)

    def start_qr_visit(self, character_id, facility_id, path):
        with self.lock:
            now = self._advance()
            visitor = QRVisitor(character_id, now, float('inf'), facility_id=facility_id)
            self.qr_visitors[character_id] = visitor
            # 입구를 먼저 차지한 방문객이 통과하도록 마지막 공공 보행점에서 기다린다.
            hold = max(path.offsets[-2], path.length - .8)
            self.queues[facility_id].approaching_people += 1
            self._walk(now, visitor, 'walking_to_queue', path, self._arrive_qr, target=hold)

    def _arrive_qr(self, now, visitor):
        if visitor.expired:
            return
        visitor.phase = 'waiting_at_entrance'
        queue = self.queues[visitor.facility_id]
        queue.entrance_waiters.append(visitor)
        if len(queue.entrance_waiters) == 1:
            self._admit_qr_waiter(now, queue)

    def _admit_qr_waiter(self, now, queue):
        while queue.entrance_waiters and queue.entrance_waiters[0].expired:
            queue.entrance_waiters.popleft()
        if not queue.entrance_waiters:
            return
        gate = queue.paths.queue.offsets[2]
        tail_clear = (not queue.members or
                      queue.members[-1].motion.distance_at(now) >= gate + self.routes.queue_headway_m - 1e-8)
        if len(queue.members) >= queue.capacity or now < queue.next_entry or not tail_clear:
            self._schedule(max(now + 1, queue.next_entry), self._admit_qr_waiter, queue)
            return
        visitor = queue.entrance_waiters[0]
        self._walk(now, visitor, 'waiting_at_entrance', visitor.motion.path, self._join_qr_at_gate, queue,
                   origin=visitor.motion.target)

    def _join_qr_at_gate(self, now, visitor, queue):
        queue.entrance_waiters.popleft()
        if not visitor.expired:
            queue.approaching_people -= 1
            self._join_queue(now, visitor, queue, origin=queue.paths.queue.offsets[2])
        self._admit_qr_waiter(now, queue)

    def _compact(self, now, queue):
        for i, visitor in enumerate(queue.members):
            slot = queue.capacity - 1 - i
            if visitor.slot == slot:
                continue
            visitor.slot = slot
            visitor.has_waited |= now >= visitor.motion.end
            visitor.motion = Motion(queue.paths.queue, now, visitor.motion.distance_at(now), queue.paths.slots[slot])

    def _expire(self, now, visitor):
        # 대기열에 합류했다면 하차할 때 이 표식을 보고 출구로 향한다.
        visitor.expired = True
        if not self.routes:
            self._depart(now, visitor)
        elif visitor.phase == 'waiting_to_exit':
            self._seek_queue(now, visitor, visitor.waiting_source)

    def _try_qr_retirement(self, now, visitor):
        queue = self.queues[visitor.facility_id]
        resume = max(visitor.motion.end, queue.lateral_until)
        if resume > now:
            self._schedule(resume, self._try_qr_retirement, visitor, priority=1)
            return
        paths = queue.paths
        point = paths.queue.point_at(paths.slots[visitor.slot])
        shoulder_offset = paths.withdrawal_slots[visitor.slot]
        shoulder = paths.withdrawal.point_at(shoulder_offset)
        travel_time = (dist(point, shoulder) + shoulder_offset) / WALK_M_PER_S
        earliest_start = queue.next_withdrawal_merge - travel_time
        if earliest_start > now + 1e-8:
            self._schedule(earliest_start, self._try_qr_retirement, visitor, priority=1)
            return
        queue.next_withdrawal_merge = now + travel_time + self.walk_gap
        self._walk(now, visitor, 'retiring_qr', Path([point, shoulder]), self._vacate_qr_slot)
        queue.lateral_until = visitor.motion.end

    def _vacate_qr_slot(self, now, visitor):
        queue = self.queues[visitor.facility_id]
        queue.members.remove(visitor)
        visitor.slot = None
        self._compact(now, queue)
        if ride := self.rides.get(visitor.facility_id):
            ride.wake(now)

    def retire_qr_visit(self, character_id):
        with self.lock:
            now = self._advance()
            visitor = self.qr_visitors.pop(character_id, None)
            if visitor is not None:
                visitor.expired = True
                if visitor.phase in ('walking_to_queue', 'waiting_at_entrance'):
                    self.queues[visitor.facility_id].approaching_people -= 1
                elif visitor.phase == 'in_queue':
                    visitor.withdrawing = True
                    self._schedule(now, self._try_qr_retirement, visitor, priority=1)

    def _depart(self, now, visitor):
        del self.visitors[visitor.visitor_id]
        self.exited_total += 1
        self._schedule_admission(now)

    def current_sim_time(self):
        return (self.clock() - self.started) * self.time_scale

    def _advance(self):
        now = self.current_sim_time()
        while self.events and self.events[0][0] <= now:
            when, _, _, action, args = heappop(self.events)
            action(when, *args)
        return now

    def advance(self):
        with self.lock:
            self._advance()

    def board_next(self, facility_id, seats=None):
        """첫 대기객부터 준비된 한 묶음을 탑승 지점까지 걷도록 보낸다."""
        with self.lock:
            now = self._advance()
            queue = self.queues[facility_id]
            capacity = queue.paths.boarding_capacity
            if seats is None:
                seats = capacity
            if type(seats) is not int or not 1 <= seats <= capacity:
                raise ValueError('승차 요청 인원은 1회 탑승 정원 이내여야 합니다.')
            if facility_id in self.rides or queue.batch:
                return ()
            queue.batch = self._take_from_queue(now, queue, seats)
            return tuple(visitor.visitor_id for visitor in queue.batch)

    def _take_from_queue(self, now, queue, seats, vehicle_id=None):
        batch = []
        if now < queue.lateral_until:
            return batch
        for visitor in queue.members[:seats]:
            if visitor.withdrawing or now < visitor.motion.end:
                break
            self._walk(now, visitor, 'walking_to_board', queue.paths.queue, self._finish_boarding,
                       origin=queue.paths.slots[visitor.slot])
            visitor.slot = None
            visitor.vehicle_id = vehicle_id
            batch.append(visitor)
        if batch:
            del queue.members[:len(batch)]
            self._compact(now, queue)
        return batch

    def _finish_boarding(self, now, visitor):
        visitor.phase = 'at_boarding_point'

    def unload(self, facility_id):
        """호출자가 운행을 마친 묶음을 하차 시작점에서 순서대로 내보낸다."""
        with self.lock:
            now = self._advance()
            queue = self.queues[facility_id]
            if any(visitor.phase != 'at_boarding_point' for visitor in queue.batch):
                return ()
            batch, queue.batch = queue.batch, []
            self._queue_unloading(now, queue, batch)
            return tuple(visitor.visitor_id for visitor in batch)

    def _queue_unloading(self, now, queue, batch, on_leave=None):
        last_crossing = now
        for visitor in batch:
            visitor.phase = 'awaiting_unload'
            start = max(now, queue.next_unload)
            self._schedule(start, self._unload_visitor, visitor, queue.paths, on_leave)
            queue.next_unload = start + UNLOAD_GAP_S
            last_crossing = start + queue.paths.unloading.offsets[1] / WALK_M_PER_S
        return last_crossing

    def _unload_visitor(self, now, visitor, paths, on_leave):
        if on_leave is not None:
            on_leave(visitor)
        key = visitor.facility_id
        visitor.completed_rides[key] = visitor.completed_rides.get(key, 0) + 1
        visitor.vehicle_id = None
        if isinstance(visitor, QRVisitor):
            self._walk(now, visitor, 'walking_from_ride', paths.unloading, self._finish_qr_visit)
        elif visitor.walking_variant is not None:
            offset, release = paths.exit_releases[visitor.walking_variant % len(paths.exit_releases)]
            self._walk(now, visitor, 'walking_from_ride', paths.unloading, self._seek_queue, release, target=offset)
        else:
            self._walk(now, visitor, 'walking_from_ride', paths.unloading, self._seek_queue, paths.exit_merge)

    def _finish_qr_visit(self, now, visitor):
        visitor.phase = 'completed'
        visitor.completed_at = now

    def _qr_visit_state(self, visitor, now):
        at = visitor.completed_at if visitor.completed_at is not None else now
        queue = self.queues[visitor.facility_id]
        snap = visitor.snapshot(at, self.time_scale * 1.2)
        phase = QR_PHASES[visitor.phase]
        tick = int((at - visitor.entered_at_sim_s) * 10 / self.time_scale)
        return {
            'phase': phase,
            'revision_delta': tick * len(QR_PHASE_ORDER) + QR_PHASE_ORDER.index(phase),
            'position': {'point': list(snap['point']) if snap['point'] is not None else None,
                         'node_id': queue.paths.exit_merge if phase == 'completed' else None},
            'position_sim_time_s': at,
            'walk_trail': snap.get('walk_trail'),
            'map_point': list(queue.paths.queue.points[-1]) if snap['point'] is None else None,
            'queue_position': queue.members.index(visitor) + 1 if phase == 'queued' else None,
            'vehicle_id': visitor.vehicle_id,
        }

    def qr_visit_state(self, character_id):
        with self.lock:
            now = self._advance()
            return self._qr_visit_state(self.qr_visitors[character_id], now)

    def snapshot(self, *, with_motion=False, with_qr=False):
        with self.lock:
            now = self._advance()
            snapshot = {
                'scenario_id': SCENARIO_ID,
                'run_id': self.run_id,
                'map_hash': self.map_hash,
                'ride_operations_hash': self.ride_operations_hash,
                'preferences_hash': self.preferences_hash,
                'status': 'continuous_running',
                'clock': {'sim_time_s': now, 'time_scale': self.time_scale},
                'rides': {key: ride.snapshot(now) for key, ride in self.rides.items()},
                'background': {
                    'target_people': self.target,
                    'entered_total': self.entered_total,
                    'present_people': len(self.visitors),
                    'exited_total': self.exited_total,
                    'visitors': [visitor.snapshot(now, self.time_scale * 1.2 if with_motion else 0)
                                 for visitor in self.visitors.values()],
                    'queues': {key: {'capacity': queue.capacity, 'reserved_count': len(queue.members),
                                     'approaching_count': queue.approaching_people,
                                     'estimated_wait_sim_s': self._estimated_wait(key),
                                     'queued_count': sum(v.phase == 'in_queue' and v.motion.end <= now
                                                         for v in queue.members),
                                     'qr_reserved_count': sum(isinstance(v, QRVisitor) for v in queue.members),
                                     'qr_queued_count': sum(isinstance(v, QRVisitor) and v.motion.end <= now
                                                            for v in queue.members)}
                               for key, queue in self.queues.items()},
                },
            }
            if with_qr:
                snapshot['qr_visits'] = {key: self._qr_visit_state(visitor, now)
                                         for key, visitor in self.qr_visitors.items()}
            return snapshot
