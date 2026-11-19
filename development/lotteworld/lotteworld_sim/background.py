"""연속 유입, 개인 체류, 대기열과 시설 운행을 진행한다."""
from dataclasses import dataclass, field
from heapq import heappop, heappush
from itertools import count
from math import dist
from random import Random
from threading import Lock
from time import monotonic
from uuid import uuid4

from .ride_operations import RideOperation
from .scenario import SCENARIO_ID
from .visitor_routes import FacilityPaths, Path, UNLOAD_GAP_S, WALK_M_PER_S


@dataclass(frozen=True)
class Motion:
    path: Path
    start: float
    origin: float
    target: float

    @property
    def end(self):
        return self.start + abs(self.target - self.origin) / WALK_M_PER_S

    def distance_at(self, now):
        if now >= self.end:
            return self.target
        direction = 1 if self.target >= self.origin else -1
        return self.origin + (now - self.start) * WALK_M_PER_S * direction


@dataclass
class Visitor:
    visitor_id: int
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

    def snapshot(self, now):
        state = self.phase
        if state == 'in_queue':
            if now >= self.motion.end:
                state = 'queued'
            else:
                state = 'advancing_queue' if self.has_waited else 'joining_queue'
        return {key: getattr(self, key) for key in ('visitor_id', 'entered_at_sim_s', 'leave_at_sim_s')} | {
            'state': state, 'facility_id': self.facility_id, 'queue_slot': self.slot,
            'point': self.motion.path.point_at(self.motion.distance_at(now)) if self.motion else None,
            'departure_requested': self.expired, 'vehicle_id': self.vehicle_id,
        }


@dataclass
class FacilityQueue:
    paths: FacilityPaths
    members: list[Visitor] = field(default_factory=list)
    batch: list[Visitor] = field(default_factory=list)
    next_entry: float = 0
    lateral_until: float = 0
    next_withdrawal_merge: float = 0
    next_unload: float = 0

    @property
    def capacity(self):
        return len(self.paths.slots)


class BackgroundRun:
    def __init__(self, config, routes=None, *, map_hash=None, ride_operations=None, clock=monotonic):
        self.run_id = f"continuous-{uuid4().hex}"
        self.clock = clock
        self.lock = Lock()
        self.target = config['target_people']
        self.interval = config['admission_interval_sim_s']
        self.stay_range = config['stay_sim_s']
        self.time_scale = config['time_scale']
        self.stays = Random(config['seed'])
        initial_ages = Random(config['seed'] + 1)
        self.routes = routes
        self.map_hash = map_hash
        self.queues = {key: FacilityQueue(paths) for key, paths in routes.facilities.items()} if routes else {}
        self.facility_ids = tuple(self.queues)
        self.walk_gap = routes.queue_headway_m / WALK_M_PER_S if routes else 0
        self.visitors = {}
        self.events = []
        self.event_order = count()
        self.entered_total = 0
        self.exited_total = 0
        self.admission_pending = False
        self.rides = {key: RideOperation(self, self.queues[key], settings)
                      for key, settings in (ride_operations or {}).items()}
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
        self.visitors[visitor.visitor_id] = visitor
        self._schedule(visitor.leave_at_sim_s, self._expire, visitor)
        if self.routes:
            self._seek_queue(now, visitor, self.routes.boundary, fraction=elapsed_fraction or 0)
        if elapsed_fraction is None:
            self.admission_pending = False
            self._schedule_admission(now)

    def _walk(self, now, visitor, phase, path, arrival, *args, origin=0, target=None):
        visitor.phase = phase
        visitor.motion = Motion(path, now, origin, path.length if target is None else target)
        self._schedule(visitor.motion.end, arrival, visitor, *args)

    def _seek_queue(self, now, visitor, source, fraction=0):
        if visitor.expired:
            visitor.facility_id = None
            path = self.routes.public_path(source, self.routes.boundary)
            self._walk(now, visitor, 'walking_to_exit', path, self._depart)
            return
        ids = self.facility_ids
        start = (ids.index(visitor.facility_id) + 1 if visitor.facility_id else visitor.visitor_id - 1) % len(ids)
        order = ids[start:] + ids[:start]
        if visitor.facility_id:
            order = order[:-1]
        candidates = [(key, self.queues[key]) for key in order]
        for key, queue in candidates:
            if len(queue.members) < queue.capacity and (queue.paths.approach != source or now >= queue.next_entry):
                break
        else:
            # 여러 시설이 같은 연결점을 쓰는 지도에서도 만석 재시도가 한 시각에 반복되지 않는다.
            next_stop = next(((key, queue) for key, queue in candidates
                              if self.routes.public_path(source, queue.paths.approach).length), None)
            if next_stop is None:
                path = self.routes.public_path(source, self.routes.boundary)
                self._walk(now, visitor, 'walking_to_queue', path, self._seek_queue, self.routes.boundary)
                return
            key, queue = next_stop
        visitor.facility_id = key
        visitor.has_waited = False
        visitor.withdrawing = False
        path = self.routes.public_path(source, queue.paths.approach)
        self._walk(now, visitor, 'walking_to_queue', path, self._arrive_at_queue, origin=fraction * path.length)

    def _arrive_at_queue(self, now, visitor):
        queue = self.queues[visitor.facility_id]
        if visitor.expired or len(queue.members) == queue.capacity or now < queue.next_entry:
            self._seek_queue(now, visitor, queue.paths.approach)
            return
        queue.next_entry = now + self.walk_gap
        visitor.phase = 'in_queue'
        visitor.slot = queue.capacity - 1 - len(queue.members)
        visitor.motion = Motion(queue.paths.queue, now, 0, queue.paths.slots[visitor.slot])
        queue.members.append(visitor)
        if ride := self.rides.get(visitor.facility_id):
            ride.wake(now)

    def _compact(self, now, queue):
        for i, visitor in enumerate(queue.members):
            slot = queue.capacity - 1 - i
            if visitor.slot == slot:
                continue
            visitor.slot = slot
            visitor.has_waited |= now >= visitor.motion.end
            visitor.motion = Motion(queue.paths.queue, now, visitor.motion.distance_at(now), queue.paths.slots[slot])

    def _expire(self, now, visitor):
        visitor.expired = True
        if not self.routes:
            self._depart(now, visitor)
        elif visitor.phase == 'in_queue':
            self._request_withdrawal(now, visitor)

    def _request_withdrawal(self, now, visitor):
        if visitor.withdrawing:
            return False
        visitor.withdrawing = True
        self._schedule(now, self._try_withdrawal, visitor, priority=1)
        return True

    def _try_withdrawal(self, now, visitor):
        queue = self.queues[visitor.facility_id]
        resume = max(visitor.motion.end, queue.lateral_until)
        if resume > now:
            self._schedule(resume, self._try_withdrawal, visitor, priority=1)
            return
        paths = queue.paths
        point = paths.queue.point_at(paths.slots[visitor.slot])
        shoulder_offset = paths.withdrawal_slots[visitor.slot]
        shoulder = paths.withdrawal.point_at(shoulder_offset)
        travel_time = (dist(point, shoulder) + shoulder_offset) / WALK_M_PER_S
        earliest_start = queue.next_withdrawal_merge - travel_time
        if earliest_start > now + 1e-8:
            self._schedule(earliest_start, self._try_withdrawal, visitor, priority=1)
            return
        queue.next_withdrawal_merge = now + travel_time + self.walk_gap
        self._walk(now, visitor, 'leaving_queue', Path([point, shoulder]), self._vacate_slot, shoulder_offset)
        queue.lateral_until = visitor.motion.end

    def _vacate_slot(self, now, visitor, shoulder_offset):
        queue = self.queues[visitor.facility_id]
        queue.members.remove(visitor)
        visitor.slot = None
        self._compact(now, queue)
        if ride := self.rides.get(visitor.facility_id):
            ride.wake(now)
        self._walk(now, visitor, 'leaving_queue', queue.paths.withdrawal, self._seek_queue,
                   queue.paths.withdrawal_merge, origin=shoulder_offset, target=0)

    def _depart(self, now, visitor):
        del self.visitors[visitor.visitor_id]
        self.exited_total += 1
        self._schedule_admission(now)

    def _advance(self):
        now = (self.clock() - self.started) * self.time_scale
        while self.events and self.events[0][0] <= now:
            when, _, _, action, args = heappop(self.events)
            action(when, *args)
        return now

    def advance(self):
        with self.lock:
            self._advance()

    def withdraw(self, visitor_id):
        """대기열에서 옆 통로로 나오도록 요청한다."""
        with self.lock:
            now = self._advance()
            visitor = self.visitors.get(visitor_id)
            return bool(visitor and visitor.phase == 'in_queue' and self._request_withdrawal(now, visitor))

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
        visitor.vehicle_id = None
        self._walk(now, visitor, 'walking_from_ride', paths.unloading, self._seek_queue, paths.exit_merge)

    def snapshot(self):
        with self.lock:
            now = self._advance()
            return {
                'scenario_id': SCENARIO_ID,
                'run_id': self.run_id,
                'map_hash': self.map_hash,
                'status': 'continuous_running',
                'clock': {'sim_time_s': now, 'time_scale': self.time_scale},
                'rides': {key: ride.snapshot(now) for key, ride in self.rides.items()},
                'background': {
                    'target_people': self.target,
                    'entered_total': self.entered_total,
                    'present_people': len(self.visitors),
                    'exited_total': self.exited_total,
                    'visitors': [visitor.snapshot(now) for visitor in self.visitors.values()],
                    'queues': {key: {'capacity': queue.capacity, 'reserved_count': len(queue.members),
                                     'queued_count': sum(v.phase == 'in_queue' and v.motion.end <= now
                                                         for v in queue.members)}
                               for key, queue in self.queues.items()},
                },
            }
