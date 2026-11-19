"""대기객을 받아 시설의 차량·편성과 승강장·코스를 운영한다."""
from collections import deque
from dataclasses import dataclass, field
from fractions import Fraction
from math import inf, nextafter
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .background import Visitor


@dataclass
class Vehicle:
    vehicle_id: int
    state: str = 'available'
    station_slot: int | None = None
    boarding_started_at: float = 0
    boarding_until: float = 0
    boarding_complete_at: float = 0
    dispatched_at: float | None = None
    passengers: list['Visitor'] = field(default_factory=list)


class RideOperation:
    def __init__(self, run, queue, settings):
        self.run = run
        self.queue = queue
        self.seats = queue.paths.boarding_capacity
        self.settings = settings
        self.vehicles = [Vehicle(i + 1) for i in range(settings['vehicle_count'])]
        self.available = deque(self.vehicles)
        self.returning = deque()
        self.station = {}
        self.wake_at = None
        self.dispatch_count = 0
        self.last_dispatch_at = None
        self.next_dispatch_at = 0
        self.section_count = settings.get('course_section_count', 1)
        self.section_seconds = Fraction(settings['ride_seconds'], self.section_count)
        self.course_entry_at = 0

    def wake(self, when):
        if self.wake_at is None or when < self.wake_at:
            self.wake_at = when
            # 같은 시각의 보행·만료·승강장 해제를 먼저 처리한다.
            self.run._schedule(when, self._operate, priority=3)

    def _operate(self, now):
        if now != self.wake_at:
            return
        self.wake_at = None
        ready = []
        for vehicle in self.station.values():
            if vehicle.state == 'boarding' and now >= vehicle.boarding_complete_at:
                vehicle.state = 'ready'
            if vehicle.state == 'ready':
                ready.append(vehicle)
        if ready and now >= max(self.next_dispatch_at, self.course_entry_at):
            vehicle = min(ready, key=lambda v: v.boarding_started_at)
            self._dispatch(now, vehicle)
            ready.remove(vehicle)
        if ready:
            self.wake(max(self.next_dispatch_at, self.course_entry_at))

        while self.returning and self._station_has_space():
            self._start_unloading(now, self.returning.popleft())
        self._board_waiting_visitors(now)

        for vehicle in self.station.values():
            if vehicle.state == 'boarding':
                when = vehicle.boarding_until if now < vehicle.boarding_until else vehicle.boarding_complete_at
                self.wake(when)

    def _station_has_space(self):
        return len(self.station) < self.settings['station_capacity']

    def _occupy_station(self, vehicle):
        slot = next(i for i in range(1, len(self.station) + 2) if i not in self.station)
        self.station[slot] = vehicle
        vehicle.station_slot = slot

    def _leave_station(self, vehicle):
        del self.station[vehicle.station_slot]
        vehicle.station_slot = None

    def _board_waiting_visitors(self, now):
        while self.queue.members:
            vehicle = next((v for v in self.station.values()
                            if v.state == 'boarding' and now < v.boarding_until and len(v.passengers) < self.seats), None)
            if vehicle is None and (not self.available or not self._station_has_space()):
                return
            head = self.queue.members[0]
            if head.withdrawing:
                return
            head_ready_at = max(head.motion.end, self.queue.lateral_until)
            if now < head_ready_at:
                self.wake(head_ready_at)
                return
            if vehicle is None:
                vehicle = self.available.popleft()
                self._occupy_station(vehicle)
                vehicle.state = 'boarding'
                vehicle.boarding_started_at = now
                vehicle.boarding_until = now + self.settings['boarding_and_check_seconds']
                vehicle.boarding_complete_at = vehicle.boarding_until
            batch = self.run._take_from_queue(now, self.queue, self.seats - len(vehicle.passengers), vehicle.vehicle_id)
            vehicle.passengers.extend(batch)
            vehicle.boarding_complete_at = max(vehicle.boarding_complete_at, batch[-1].motion.end)

    def _dispatch(self, now, vehicle):
        self._leave_station(vehicle)
        vehicle.state = 'running'
        vehicle.dispatched_at = now
        for passenger in vehicle.passengers:
            passenger.phase = 'on_ride'
            passenger.motion = None
        self.dispatch_count += 1
        self.last_dispatch_at = now
        self.next_dispatch_at = now + self.settings['dispatch_interval_seconds']
        # 모든 차량이 같은 속도로 같은 길이의 가상 구간을 순서대로 통과한다.
        # 첫 구간을 비운 뒤 출발하면 다음 구간에서도 선행 차량과 겹치지 않는다.
        clear = Fraction(now) + self.section_seconds
        self.course_entry_at = float(clear)
        # 소수 초 경계를 시계의 부동소수점 시각으로 올림해 중복 점유를 피한다.
        if self.course_entry_at < clear:
            self.course_entry_at = nextafter(self.course_entry_at, inf)
        self.run._schedule(now + self.settings['ride_seconds'], self._return_from_course, vehicle)

    def _return_from_course(self, now, vehicle):
        vehicle.state = 'waiting_for_station'
        for passenger in vehicle.passengers:
            passenger.phase = 'waiting_for_station'
        self.returning.append(vehicle)
        self.wake(now)

    def _start_unloading(self, now, vehicle):
        self._occupy_station(vehicle)
        vehicle.state = 'unloading'
        last_crossing = self.run._queue_unloading(now, self.queue, vehicle.passengers, vehicle.passengers.remove)
        self.run._schedule(max(now + self.settings['unloading_seconds'], last_crossing), self._finish_unloading, vehicle)

    def _finish_unloading(self, now, vehicle):
        self._leave_station(vehicle)
        vehicle.state = 'available'
        self.available.append(vehicle)
        self.wake(now)

    def _course_section(self, now, vehicle):
        if vehicle.state != 'running':
            return None
        elapsed = Fraction(now) - Fraction(vehicle.dispatched_at)
        return min(self.section_count, 1 + elapsed // self.section_seconds)

    def snapshot(self, now):
        return {
            'vehicle_count': len(self.vehicles), 'station_capacity': self.settings['station_capacity'],
            'seats_per_vehicle': self.seats, 'dispatch_count': self.dispatch_count,
            'last_dispatch_at_sim_s': self.last_dispatch_at, 'next_dispatch_min_at_sim_s': self.next_dispatch_at,
            'course_section_count': self.section_count, 'course_entry_available_at_sim_s': self.course_entry_at,
            'vehicles': [
                {'vehicle_id': v.vehicle_id, 'state': v.state, 'station_slot': v.station_slot,
                 'course_section': self._course_section(now, v),
                 'last_dispatched_at_sim_s': v.dispatched_at,
                 'passenger_ids': [p.visitor_id for p in v.passengers]}
                for v in self.vehicles
            ],
        }
