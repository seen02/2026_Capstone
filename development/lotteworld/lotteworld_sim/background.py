"""개인별 예정 퇴장과 빈자리 보충을 처리하는 연속 시연 인구 상태."""
from dataclasses import dataclass
from heapq import heappop, heappush
from math import inf
from random import Random
from threading import Lock
from time import monotonic
from uuid import uuid4

from .scenario import SCENARIO_ID


@dataclass(order=True, frozen=True)
class Visitor:
    leave_at_sim_s: float
    visitor_id: int
    entered_at_sim_s: float


class BackgroundRun:
    def __init__(self, config, *, clock=monotonic):
        self.run_id = f"continuous-{uuid4().hex}"
        self.clock = clock
        self.lock = Lock()
        self.target = config["target_people"]
        self.interval = config["admission_interval_sim_s"]
        self.stay_range = config["stay_sim_s"]
        self.time_scale = config["time_scale"]
        self.stays = Random(config["seed"])
        initial_ages = Random(config["seed"] + 1)
        self.visitors = []
        self.entered_total = 0
        self.exited_total = 0
        for _ in range(config["initial_people"]):
            self._admit(0, initial_ages.random())
        self.next_admission = self.interval if len(self.visitors) < self.target else inf
        self.started = self.clock()

    def _admit(self, sim_time, elapsed_fraction=0):
        duration = self.stays.uniform(*self.stay_range)
        entered = sim_time - duration * elapsed_fraction
        self.entered_total += 1
        heappush(self.visitors, Visitor(entered + duration, self.entered_total, entered))

    def _advance(self):
        sim_time = (self.clock() - self.started) * self.time_scale
        while True:
            departure = self.visitors[0].leave_at_sim_s if self.visitors else inf
            event = min(departure, self.next_admission)
            if event > sim_time:
                return sim_time
            if departure <= self.next_admission:
                heappop(self.visitors)
                self.exited_total += 1
                if self.next_admission == inf:
                    self.next_admission = departure + self.interval
            else:
                self._admit(event)
                self.next_admission = event + self.interval if len(self.visitors) < self.target else inf

    def advance(self):
        with self.lock:
            self._advance()

    def snapshot(self):
        with self.lock:
            sim_time = self._advance()
            return {
                "scenario_id": SCENARIO_ID,
                "run_id": self.run_id,
                "status": "continuous_running",
                "clock": {"sim_time_s": sim_time, "time_scale": self.time_scale},
                "background": {
                    "target_people": self.target,
                    "entered_total": self.entered_total,
                    "present_people": len(self.visitors),
                    "exited_total": self.exited_total,
                    "visitors": [
                        {"visitor_id": visitor.visitor_id, "entered_at_sim_s": visitor.entered_at_sim_s,
                         "leave_at_sim_s": visitor.leave_at_sim_s}
                        for visitor in sorted(self.visitors, key=lambda visitor: visitor.visitor_id)
                    ],
                },
            }
