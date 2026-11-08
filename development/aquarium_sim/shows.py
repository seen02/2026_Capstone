"""회차별 공연 모집, 선착순 정원 확보, 순차 입장과 종료 처리."""
from collections import deque
from dataclasses import dataclass, field
import math


@dataclass
class Show:
    key: str
    zone: str
    name: str
    start: float
    end: float
    queue_open: float
    admission_open: float
    capacity: int
    reserved: set = field(default_factory=set)
    queue: deque = field(default_factory=deque)
    attended: set = field(default_factory=set)
    completed: set = field(default_factory=set)
    full: set = field(default_factory=set)
    missed: set = field(default_factory=set)
    boarding_scheduled: bool = False
    peak_reserved: int = 0


class ShowOperations:
    def _init_shows(self):
        cfg=self.config.get("performances",{})
        lead=cfg.get("queue_lead_minutes",10)
        admission=cfg.get("admission_lead_minutes",2)
        interval=cfg.get("admission_interval_seconds",1)
        if any(type(v) not in (int,float) or not math.isfinite(v) for v in (lead,admission,interval)) or not 0<admission<lead<=60 or interval<=0:
            raise ValueError("공연 모집·입장 시간과 입장 간격을 확인해 주세요.")
        self.show_admission_interval=interval
        self.shows={}
        for p in self.map_data.get("reference_programs",[]):
            h,m=map(int,p["start"].split(":"));start=h*3600+m*60
            end=start+p["duration_minutes"]*60
            if start<self.now or end>self.closing:continue
            zone=p["node"]
            show=Show(f"{zone}@{p['start']}",zone,p["name"],start,end,start-lead*60,start-admission*60,self.graph.nodes[zone]["capacity"])
            if show.key in self.shows or any(s.zone==zone and show.queue_open<s.end and s.queue_open<show.end for s in self.shows.values()):
                raise ValueError("같은 구역의 공연 모집·관람 시간이 겹칩니다.")
            self.shows[show.key]=show
            for time,kind in [(show.queue_open,"show_call"),(show.admission_open,"show_admit"),(show.start,"show_start"),(show.end,"show_end")]:
                self._push(max(self.now,time),kind,show.key)

    def _gallery_show(self,show):
        return self.graph.nodes[show.zone].get("access_mode")!="controlled_show"

    def _has_show_space(self,a,show):
        # 이미 수조 앞에 있는 사람은 기존 자리를 그대로 쓰므로 추가 정원을 차지하지 않는다.
        own=1 if a.admitted_zone==show.zone else 0
        return self._used_capacity(show.zone)-own<show.capacity

    def _used_capacity(self,zone):
        # 일반 관람객 + 공연 입장객 + 아직 입장하지 않은 정원 확보 인원.
        pending=sum(1 for s in self.shows.values() if s.zone==zone for id in s.reserved
                    if id in self.active and self.active[id].admitted_zone!=zone)
        return self.occupancy[zone]+pending

    def _show_reachable(self,a,s,dist=None):
        if a.must_exit or s.zone in a.seen_shows or s.key in a.skipped_shows or not s.queue_open<=self.now<s.start or s.end>a.deadline:
            return False
        source=a.next_node if a.edge else a.node
        if dist is None:dist,_=self.graph.routes(source,self.edge_load)
        target=s.zone if self._gallery_show(s) else self.graph.nodes[s.zone]["queue_node"]
        travel=dist.get(target,math.inf)
        remaining=max(0,a.move_end-self.now) if a.edge else 0
        # 이동 중 혼잡 증가에 대비한 여유. 입장은 시작 시각에 마감한다.
        return self.now+remaining+travel*1.5+5<s.start

    def _candidate_show(self,a,zone,dist):
        for s in self.shows.values():
            if s.zone!=zone or not self._show_reachable(a,s,dist):continue
            if not self._has_show_space(a,s):
                s.full.add(a.id);a.skipped_shows.add(s.key)
                continue
            return s
        return None

    def _detach_show(self,a):
        if a.show_id is None:return
        s=self.shows[a.show_id]
        s.reserved.discard(a.id)
        try:s.queue.remove(a.id)
        except ValueError:pass
        a.show_id=None;a.redirect_show=False

    def _reject_show(self,a,reason):
        s=self.shows[a.show_id]
        (s.full if reason=="full" else s.missed).add(a.id)
        a.skipped_shows.add(s.key)
        if a.state=="queueing":a.wait_seconds+=self.now-a.queued_at
        self._detach_show(a)
        a.state="walking";a.token+=1
        self._release_queue(s.zone)
        self._choose(a,exclude={s.zone})

    def _target_show(self,a,s):
        if self._gallery_show(s) and a.node==s.zone and a.admitted_zone==s.zone and a.state=="viewing":
            # 기존 관람 위치와 정원은 유지하고 관람 종료 이벤트만 취소한다.
            a.visits[-1]["end"]=self.now
            a.visits[-1]["interrupted_for_show"]=s.key
            a.token+=1;a.show_id=s.key;a.destination=s.zone
            s.reserved.add(a.id);s.peak_reserved=max(s.peak_reserved,len(s.reserved))
            self._begin_show_view(a)
            return
        if a.state=="viewing":
            a.visits[-1]["interrupted_for_show"]=s.key
            a.token+=1;self._leave_view(a)
        elif a.state=="queueing":
            a.wait_seconds+=self.now-a.queued_at
            queue=self.queues[self.graph.nodes[a.node]["zone"]]
            try:queue.remove(a.id)
            except ValueError:pass
        a.queue_slot=None
        a.show_id=s.key;a.destination=s.zone
        if a.edge:
            a.redirect_show=True
        else:self._route_to_show(a)

    def _route_to_show(self,a):
        a.redirect_show=False
        s=self.shows[a.show_id]
        if not self._show_reachable(a,s):self._reject_show(a,"late");return
        if not self._has_show_space(a,s):self._reject_show(a,"full");return
        _,prev=self.graph.routes(a.node,self.edge_load)
        a.route=self.graph.path(prev,a.node,self.graph.nodes[s.zone]["queue_node"])
        self._walk(a)

    def _claim_queue_slot(self,a,s):
        room=next(r for r in self.map_data["geometry"]["rooms"] if r["id"]==s.zone)
        slots=room.get("queue_slots")
        if not slots:return True
        used={v.queue_slot for v in self.active.values() if v.id!=a.id and v.show_id==s.key and v.queue_slot is not None}
        if a.queue_slot is not None and a.queue_slot not in used:return True
        a.queue_slot=next((i for i in range(len(slots)) if i not in used),None)
        return a.queue_slot is not None

    def _join_show(self,a):
        s=self.shows[a.show_id]
        if self.now>=s.start or s.end>a.deadline:self._reject_show(a,"late");return
        if not self._has_show_space(a,s):self._reject_show(a,"full");return
        if not self._claim_queue_slot(a,s):self._reject_show(a,"full");return
        self.movement.ensure(a)
        s.reserved.add(a.id);s.peak_reserved=max(s.peak_reserved,len(s.reserved))
        if len(s.reserved)==s.capacity:self._log(f"{s.name} 정원 {s.capacity}명 마감")
        if self._gallery_show(s):
            # 접근 지점에서는 멈추지 않고 평소 관람 공간으로 바로 이동한다.
            self._admit(a,s.zone)
        else:
            a.state="queueing";a.queued_at=self.now;s.queue.append(a.id)
            s.queue=deque(sorted(s.queue,key=lambda id:self.active[id].queue_slot))
            self._schedule_boarding(s)

    def _schedule_boarding(self,s):
        if not self._gallery_show(s) and not s.boarding_scheduled and s.queue and s.admission_open<=self.now<s.start:
            s.boarding_scheduled=True
            self._push(self.now+self.show_admission_interval,"show_board",s.key)

    def _board_show(self,s):
        s.boarding_scheduled=False
        if self.now>=s.start:return
        while s.queue:
            a=self.active.get(s.queue.popleft())
            if not a or a.show_id!=s.key or a.state!="queueing":continue
            if a.must_exit or self.now>=a.deadline:
                self._deadline(a);continue
            self._admit(a,s.zone)
            break
        self._schedule_boarding(s)

    def _begin_show_view(self,a):
        s=self.shows[a.show_id]
        a.token+=1
        if self.now<s.start:
            a.state="show_waiting" if self._gallery_show(s) else "seated"
            a.queued_at=self.now
            return
        if a.state=="show_waiting":a.wait_seconds+=self.now-a.queued_at
        a.state="viewing";a.seen_shows.add(s.zone);s.attended.add(a.id)
        a.visits.append(dict(node=s.zone,start=self.now,end=None,show=s.key,scheduled_start=s.start,scheduled_end=s.end))

    def _show_event(self,kind,key):
        s=self.shows[key]
        if kind=="show_call":
            self._log(f"{s.name} 대기 모집 시작")
            for a in list(self.active.values()):
                if a.show_id or a.must_exit or a.admitted_zone and a.state!="viewing":continue
                if not self._show_reachable(a,s):continue
                preference=self.preferences[a.persona][self.graph.nodes[s.zone]["tag"]]
                if a.rng.random()>=preference/(1+preference):continue
                if not self._has_show_space(a,s):
                    s.full.add(a.id);a.skipped_shows.add(s.key);continue
                self._target_show(a,s)
        elif kind=="show_admit":self._schedule_boarding(s)
        elif kind=="show_board":self._board_show(s)
        elif kind=="show_start":
            self._log(f"{s.name} 시작")
            for a in list(self.active.values()):
                if a.show_id!=key:continue
                if a.state in {"seated","show_waiting"}:self._begin_show_view(a)
                elif a.id not in s.reserved:
                    a.skipped_shows.add(key);s.missed.add(a.id)
                    if a.edge:a.redirect_show=True
                    else:self._reject_show(a,"late")
                elif a.state=="queueing":self._reject_show(a,"late")
        elif kind=="show_end":
            self._log(f"{s.name} 종료 · 다음 관람 이동")
            for a in list(self.active.values()):
                if a.show_id!=key:continue
                if a.state=="viewing":
                    s.completed.add(a.id);self._leave_view(a);self._choose(a)
                elif a.edge:
                    # 정상 경로에서는 발생하지 않지만, 종료 후 입장을 시작하지 않는다.
                    self._detach_show(a)
                    a.replan_after_edge=True
                else:self._reject_show(a,"late")

    def _show_snapshots(self):
        return [dict(id=s.key,node=s.zone,name=s.name,start=s.start,end=s.end,
                     queue_open=s.queue_open,admission_open=s.queue_open if self._gallery_show(s) else s.admission_open,capacity=s.capacity,
                     waiting_in_gallery=sum(a.show_id==s.key and a.state=="show_waiting" for a in self.active.values()),
                     reserved=len(s.reserved),peak_reserved=s.peak_reserved,
                     queue=sum(1 for id in s.queue if id in self.active and self.active[id].show_id==s.key),
                     attended=len(s.attended),completed=len(s.completed),full_redirects=len(s.full),missed=len(s.missed))
                for s in self.shows.values()]
