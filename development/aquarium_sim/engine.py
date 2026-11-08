"""재현 가능한 이벤트 기반 관람 흐름. 시각화 프레임 속도와 독립적이다."""
from collections import Counter, deque
from dataclasses import dataclass, field
import heapq
import math
import random
from .hashing import stable_seed, sha256_value
from .shows import ShowOperations
from .movement import Movement, STEP
from .personas import PROFILES, RuleProvider, validate_preferences


def clock_seconds(text):
    h, m = map(int, text.split(":"))
    if not 0 <= h <= 23 or not 0 <= m < 60:
        raise ValueError("시간은 00:00~23:59 형식이어야 합니다.")
    return h * 3600 + m * 60


def clock_text(seconds):
    return f"{int(seconds)//3600:02}:{int(seconds)%3600//60:02}:{int(seconds)%60:02}"


def arrival_weights(config):
    opening,last=(clock_seconds(config[k]) for k in ("opening","last_entry"))
    model=config["arrivals"];minutes=(last-opening)//60
    if model.get("model")!="conditional_poisson_minutes":raise ValueError("지원하지 않는 입장 모형입니다.")
    if model.get("intensity")=="uniform_baseline":
        if model.get("minute_weights") is not None:raise ValueError("균등 기준 모형에는 별도 분별 가중치를 지정하지 않습니다.")
        weights=[1.0]*minutes
    elif model.get("intensity")=="synthetic_peaks":
        baseline=model.get("baseline",0);peaks=model.get("peaks",[])
        if type(baseline) not in (int,float) or not math.isfinite(baseline) or baseline<0:
            raise ValueError("기준 입장률은 유한한 0 이상의 값이어야 합니다.")
        for peak in peaks:
            values=[peak.get(k) for k in ("hour","sigma_hours","weight")]
            if any(type(v) not in (int,float) or not math.isfinite(v) for v in values) or not 0<=values[0]<24 or values[1]<=0 or values[2]<0:
                raise ValueError("피크 시각·너비·가중치 설정을 확인해 주세요.")
        weights=[baseline+sum(p["weight"]*math.exp(-.5*((((opening+i*60+30)/3600)-p["hour"])/p["sigma_hours"])**2) for p in peaks) for i in range(minutes)]
    elif model.get("intensity")=="empirical_minutes":
        weights=model.get("minute_weights")
        if not isinstance(weights,list) or len(weights)!=minutes or not model.get("source"):raise ValueError("실측 분포에는 모든 분별 가중치와 출처가 필요합니다.")
    else:raise ValueError("지원하지 않는 입장률 설정입니다.")
    if any(type(w) not in (int,float) or not math.isfinite(w) or w<0 for w in weights):raise ValueError("분별 가중치는 유한한 0 이상의 숫자여야 합니다.")
    if not 0<sum(weights)<math.inf:raise ValueError("분별 가중치 합은 유한한 양수여야 합니다.")
    return weights


def arrival_schedule(config):
    """일일 합계 조건부 포아송: 분별 인원은 다항분포, 분 안의 시각은 균등분포."""
    count = config["daily_visitors"]
    if type(count) is not int or not 0 <= count <= 20000:
        raise ValueError("하루 입장객은 0~20000명의 정수여야 합니다.")
    if type(config["seed"]) is not int:
        raise ValueError("시드는 정수여야 합니다.")
    opening, last, closing = (clock_seconds(config[k]) for k in ("opening","last_entry","closing"))
    if not opening < last < closing:
        raise ValueError("개장 < 입장 마감 < 폐장 순서여야 합니다.")
    stay = config["stay_minutes"]
    if len(stay)!=2 or any(type(v) not in (int,float) or not math.isfinite(v) for v in stay) or not 0 < stay[0] <= stay[1]:
        raise ValueError("체류시간 범위가 잘못되었습니다.")
    weights=arrival_weights(config);minutes=len(weights)
    rng = random.Random(stable_seed(config["seed"],"arrivals-minute-v2"))
    selected = rng.choices(range(minutes),weights=weights,k=count)
    # 분의 시작에 일괄 생성하지 않고 분 내부까지 분산한다. 개장 순간은 비워 둔다.
    return sorted(opening+minute*60+max(1e-9,rng.random()*60) for minute in selected)


class MapGraph:
    def __init__(self, data):
        self.data = data
        self.nodes = {n["id"]:n for n in data["nodes"]}
        if len(self.nodes)!=len(data["nodes"]):
            raise ValueError("지도 지점 ID가 중복되었습니다.")
        self.adj = {id:[] for id in self.nodes}
        self.edges = {}
        floors = {f["id"] for f in data["floors"]}
        for n in self.nodes.values():
            if n["floor"] not in floors:
                raise ValueError("존재하지 않는 층입니다.")
            if n["kind"] in {"exhibit","rest"}:
                if type(n["capacity"]) is not int or n["capacity"]<=0:
                    raise ValueError("전시 정원은 양의 정수여야 합니다.")
                lo,hi = n["dwell_minutes"]
                if not 0 < lo <= hi:
                    raise ValueError("전시 관람시간 범위가 잘못되었습니다.")
        for e in data["edges"]:
            if not e.get("routing_enabled",True):continue
            if e["id"] in self.edges or e["a"] not in self.nodes or e["b"] not in self.nodes:
                raise ValueError("중복되거나 존재하지 않는 지도 연결입니다.")
            if not math.isfinite(e["seconds"]) or e["seconds"]<=0:
                raise ValueError("이동시간은 양수여야 합니다.")
            self.edges[e["id"]] = e
            self.adj[e["a"]].append((e["b"],e["id"]))
            if not e.get("directed",False):self.adj[e["b"]].append((e["a"],e["id"]))
        if "entry" not in self.nodes or "exit" not in self.nodes:
            raise ValueError("입구와 출구가 필요합니다.")
        if len(self.routes("entry",allow_exhibit_transit=True)[0])!=len(self.nodes):
            raise ValueError("입구에서 갈 수 없는 지점이 있습니다.")

    def routes(self, source, loads=None, allow_exhibit_transit=False):
        dist, prev, queue = {source:0}, {}, [(0,source)]
        while queue:
            cost, here = heapq.heappop(queue)
            if cost!=dist[here]:
                continue
            # 다른 전시실을 통과하는 우회로는 금지한다. 이미 입장 중인 방에서는 퇴장 가능.
            if (not allow_exhibit_transit and self.nodes[here]["kind"]=="exhibit"
                    and here!=source and here!=self.nodes[source].get("zone")):
                continue
            for nxt,eid in self.adj[here]:
                e = self.edges[eid]
                multiplier = 1 + min(2,(loads or {}).get(eid,0)/max(1,e["width_assumption"]*8))
                new = cost+e["seconds"]*multiplier
                if new < dist.get(nxt,math.inf):
                    dist[nxt],prev[nxt] = new,(here,eid)
                    heapq.heappush(queue,(new,nxt))
        return dist,prev

    @staticmethod
    def path(prev, source, target):
        path=[]
        while target!=source:
            parent,eid=prev[target]
            path.append((target,eid))
            target=parent
        return list(reversed(path))


@dataclass
class Visitor:
    id: int
    persona: int
    entered_at: float
    deadline: float
    rng: random.Random
    node: str = "entry"
    state: str = "walking"
    destination: str = ""
    route: list = field(default_factory=list)
    visited: set = field(default_factory=set)
    visits: list = field(default_factory=list)
    token: int = 0
    must_exit: bool = False
    exit_reason: str = ""
    edge: str | None = None
    next_node: str | None = None
    move_start: float = 0
    move_end: float = 0
    queued_at: float = 0
    wait_seconds: float = 0
    admitted_zone: str | None = None
    queue_slot: int | None = None
    show_id: str | None = None
    redirect_show: bool = False
    replan_after_edge: bool = False
    skipped_shows: set = field(default_factory=set)
    seen_shows: set = field(default_factory=set)
    position: tuple | None = None
    move_goal: tuple | None = None
    motion_status: str = "still"
    blocked_for: float = 0
    movement_wait_seconds: float = 0
    avoidance_steps: int = 0


class Simulation(ShowOperations):
    def __init__(self, map_data, config, provider=None):
        self.config, self.map_data = config, map_data
        self.graph = MapGraph(map_data)
        self.schedule = arrival_schedule(config)
        self.now = clock_seconds(config["opening"])
        self.closing = clock_seconds(config["closing"])
        self.horizon = self.closing + 3600
        self.provider = provider or RuleProvider()
        self.preferences = [validate_preferences(self.provider.map(p,{"map_hash":sha256_value(map_data)})) for p in PROFILES]
        self.active, self.completed = {}, []
        self.entered, self.exited, self.peak = 0,0,0
        self.events, self.serial = [],0
        self.edge_load = Counter()
        self.occupancy = Counter()
        self.queues = {n:deque() for n in self.graph.nodes}
        self.history = []
        self.recent = deque(maxlen=12)
        self.program_events = deque(maxlen=24)
        self.exit_reasons = Counter()
        self.movement=Movement(self)
        self.actual_arrivals=[]
        self._init_shows()
        for id,t in enumerate(self.schedule,1):self._push(t,"birth",id)
        self._push(self.closing,"close")
        for t in range(int(self.now),int(self.horizon)+1,300):self._push(t,"sample")
        self.advance_to(self.now)

    def _push(self, time, kind, id=0, token=0):
        self.serial+=1
        heapq.heappush(self.events,(time,self.serial,kind,id,token))

    def _log(self, text, kind='flow'):
        target=self.program_events if kind=='show' else self.recent
        target.appendleft({"time":clock_text(self.now),"text":text})

    def _birth(self, id):
        point=self.movement.spawn('entry')
        if point is None:
            self._push(self.now+STEP,'birth',id)
            return
        rng = random.Random(stable_seed(self.config["seed"],id,"visitor-v1"))
        persona = rng.randrange(len(PROFILES))
        deadline = min(self.closing,self.now+rng.uniform(*self.config["stay_minutes"])*60)
        a = Visitor(id,persona,self.now,deadline,rng)
        a.position=point
        self.actual_arrivals.append(self.now)
        self.active[id]=a
        self.entered+=1
        self.peak=max(self.peak,len(self.active))
        self._push(deadline,"deadline",id)
        self._choose(a)
        if id==1 or id%100==0:self._log(f"누적 {self.entered:,}명 입장")

    def _choose(self,a,exclude=None):
        dist,prev = self.graph.routes(a.node,self.edge_load)
        if a.must_exit or self.now>=a.deadline:
            self._go_exit(a,prev)
            return
        choices=[]
        for id,n in self.graph.nodes.items():
            if n["kind"] not in {"exhibit","rest"} or id in (exclude or set()):continue
            preference=self.preferences[a.persona][n["tag"]]
            show=self._candidate_show(a,id,dist) if n.get("program") else None
            if show:
                score=preference*3/(1+dist[id]/240)
                choices.append((id,max(.001,score),show))
                continue
            if n.get("access_mode")=="controlled_show" or id in a.visited:continue
            # 이번 회차가 만석이라 포기한 구역 대신 다른 전시를 고른다.
            if any(k in a.skipped_shows and s.zone==id and s.queue_open<=self.now<s.end for k,s in self.shows.items()):continue
            if self.now+dist[id]+n["dwell_minutes"][0]*60 > a.deadline:continue
            score=preference/(1+dist[id]/240)
            choices.append((id,max(.001,score),None))
        if not choices:
            a.exit_reason="관람 완료"
            self._go_exit(a,prev)
            return
        target,_,show=a.rng.choices(choices,weights=[x[1] for x in choices])[0]
        if show:
            self._target_show(a,show)
            return
        a.destination=target
        queue_node=self.graph.nodes[target].get("queue_node",target)
        a.route=self.graph.path(prev,a.node,queue_node)
        self._walk(a)

    def _go_exit(self,a,prev=None):
        if a.show_id:
            zone=self.shows[a.show_id].zone
            self._detach_show(a);self._release_queue(zone)
        if a.admitted_zone is not None:
            zone=a.admitted_zone
            self.occupancy[zone]-=1
            a.admitted_zone=None
            self._release_queue(zone)
        a.must_exit=True
        if not a.exit_reason:a.exit_reason="폐장" if self.now>=self.closing else "체류시간 종료"
        if a.node=="exit":
            self._finish(a)
            return
        if prev is None:_,prev=self.graph.routes(a.node,self.edge_load)
        a.destination="exit"
        a.route=self.graph.path(prev,a.node,"exit")
        self._walk(a)

    def _walk(self,a):
        if not a.route:
            if a.node=="exit":self._finish(a)
            elif self.graph.nodes[a.node]["kind"]=="queue":self._at_exhibit(a)
            elif a.admitted_zone==a.node:self._begin_view(a)
            else:raise RuntimeError("전시실 입장 절차를 거치지 않은 경로입니다.")
            return
        nxt,eid=a.route[0]
        if a.show_id and nxt==self.graph.nodes[self.shows[a.show_id].zone]["queue_node"]:
            if not self._claim_queue_slot(a,self.shows[a.show_id]):
                self._reject_show(a,"full")
                return
        a.route.pop(0)
        edge=self.graph.edges[eid]
        duration=edge["seconds"]*(1+min(2,self.edge_load[eid]/max(1,edge["width_assumption"]*8)))
        a.token+=1
        a.state="exiting" if a.must_exit else "walking"
        a.edge,a.next_node=eid,nxt
        a.move_start,a.move_end=self.now,self.now+duration
        self.edge_load[eid]+=1
        self.movement.begin(a)
        if a.move_goal is None and self.graph.nodes[nxt]['kind']=='queue':
            # 대기 공간이 통로까지 넘치기 전에 다른 전시를 선택한다.
            self.edge_load[eid]-=1;a.edge=a.next_node=None
            if a.show_id:self._reject_show(a,'full')
            else:self._choose(a,exclude=self.movement.full_queues()|{self.graph.nodes[nxt]['zone']})

    def _at_exhibit(self,a):
        if a.must_exit:
            self._go_exit(a)
            return
        zone=self.graph.nodes[a.node]["zone"]
        n=self.graph.nodes[zone]
        if a.show_id:
            self._join_show(a)
            return
        if self._used_capacity(zone)>=n["capacity"]:
            a.state="queueing"
            a.queued_at=self.now
            self.queues[zone].append(a.id)
        else:self._admit(a,zone)

    def _admit(self,a,zone):
        if a.state=="queueing":a.wait_seconds+=self.now-a.queued_at
        a.admitted_zone=zone
        self.occupancy[zone]+=1
        _,prev=self.graph.routes(a.node,self.edge_load)
        a.route=self.graph.path(prev,a.node,zone)
        self._walk(a)

    def _begin_view(self,a):
        if a.show_id:
            self._begin_show_view(a)
            return
        a.state="viewing"
        a.token+=1
        end=min(a.deadline,self.now+a.rng.uniform(*self.graph.nodes[a.node]["dwell_minutes"])*60)
        a.visits.append({"node":a.node,"start":self.now,"end":None})
        self._push(end,"view_end",a.id,a.token)

    def _leave_view(self,a):
        self._detach_show(a)
        self.occupancy[a.node]-=1
        a.admitted_zone=None
        a.visits[-1]["end"]=self.now
        a.visited.add(a.node)
        a.state="walking"
        self._release_queue(a.node)

    def _release_queue(self,node):
        queue=self.queues[node]
        while queue and self._used_capacity(node)<self.graph.nodes[node]["capacity"]:
            a=self.active.get(queue.popleft())
            if a and not a.show_id and a.state=="queueing" and self.graph.nodes[a.node].get("zone")==node and self.now<a.deadline:
                self._admit(a,node)

    def _deadline(self,a):
        a.must_exit=True
        a.exit_reason="폐장" if self.now>=self.closing else "체류시간 종료"
        if a.edge is not None:
            a.state="exiting"
            return  # 진행 중 구간 끝에서 출구 경로로 전환한다. 순간 이동하지 않는다.
        a.token+=1
        if a.state=="viewing":self._leave_view(a)
        elif a.state in {"queueing","show_waiting"}:a.wait_seconds+=self.now-a.queued_at
        self._go_exit(a)

    def _finish(self,a):
        if a.node!="exit" or a.edge is not None:
            raise RuntimeError("출구에 도착하기 전에는 퇴장 처리할 수 없습니다.")
        self.completed.append(dict(id=a.id,persona=PROFILES[a.persona]["id"],entered_at=a.entered_at,
                                   exited_at=self.now,stay_minutes=(self.now-a.entered_at)/60,
                                   wait_seconds=a.wait_seconds,movement_wait_seconds=a.movement_wait_seconds,avoidance_steps=a.avoidance_steps,visits=a.visits,skipped_shows=sorted(a.skipped_shows),reason=a.exit_reason))
        self.movement.claims.pop(a.id,None);self.movement.paths.pop(a.id,None)
        self.movement.detours.pop(a.id,None);self.movement.stalls.pop(a.id,None)
        self.movement.queue_paths.pop(a.id,None)
        del self.active[a.id]
        self.exited+=1
        self.exit_reasons[a.exit_reason]+=1
        if self.exited==1 or self.exited%100==0:self._log(f"누적 {self.exited:,}명 퇴장")

    def _arrived(self,a):
        self.edge_load[a.edge]-=1
        a.node=a.next_node
        a.edge=a.next_node=None
        if a.must_exit:self._go_exit(a)
        elif a.redirect_show:self._route_to_show(a)
        elif a.replan_after_edge:
            a.replan_after_edge=False
            if a.admitted_zone:
                zone=a.admitted_zone;self.occupancy[zone]-=1;a.admitted_zone=None;self._release_queue(zone)
            self._choose(a)
        else:self._walk(a)

    def advance_to(self,target):
        if type(target) not in (int,float) or not math.isfinite(target) or target<self.now:
            raise ValueError("시뮬레이션은 현재 시간 이후로만 진행할 수 있습니다.")
        target=min(target,self.horizon)
        while self.events and self.events[0][0]<=target:
            self.now,_,kind,id,token=heapq.heappop(self.events)
            if kind=="movement":self.movement.step()
            elif kind.startswith("show_"):self._show_event(kind,id)
            elif kind=="birth":self._birth(id)
            elif kind=="sample":
                self.history.append(dict(time=self.now,entered=self.entered,inside=len(self.active),exited=self.exited))
            elif kind=="close":
                self._log("입장 종료 · 남은 관람객의 퇴장 진행")
                for a in list(self.active.values()):self._deadline(a)
            else:
                a=self.active.get(id)
                if a is None:continue
                if kind=="deadline":self._deadline(a)
                elif token==a.token:
                    if kind=="view_end":
                        self._leave_view(a)
                        self._choose(a)
        self.now=target

    def motion_snapshot(self,compact=False):
        visitors=[]
        queue_order={};queue_counts=Counter()
        for queued in sorted((a for a in self.active.values() if a.state=="queueing"),key=lambda a:(a.queued_at,a.id)):
            zone=self.graph.nodes[queued.node]["zone"]
            queue_order[queued.id]=queue_counts[zone];queue_counts[zone]+=1
        for a in self.active.values():
            node=self.graph.nodes[a.node]
            progress=0
            if a.edge:
                progress=max(0,min(1,(self.now-a.move_start)/(a.move_end-a.move_start)))
            if compact:
                visitors.append([a.id,a.persona,a.state,a.node,a.next_node,progress,
                                 queue_order.get(a.id),queue_counts.get(node.get("zone"),0),a.queue_slot,list(a.position) if a.position is not None else None,a.motion_status])
                continue
            visitors.append(dict(id=a.id,persona=a.persona,state=a.state,node=a.node,next_node=a.next_node,
                                 queue_rank=queue_order.get(a.id),queue_count=queue_counts.get(node.get("zone"),0),queue_slot=a.queue_slot,
                                 position=list(a.position) if a.position is not None else None,motion_status=a.motion_status,
                                 progress=progress,destination=a.destination,entered_at=a.entered_at,
                                 floor=node["floor"],visited=len(a.visited),edge=a.edge,
                                 transition_kind=self.graph.edges[a.edge]["kind"] if a.edge else None))
        return dict(time=self.now,visitors=visitors)

    def snapshot(self):
        visitors=self.motion_snapshot()["visitors"]
        queued=Counter(self.graph.nodes[a.node]["zone"] for a in self.active.values() if a.state=="queueing")
        zones=[dict(id=n,inside=self.occupancy[n],queue=queued[n],capacity=d["capacity"])
               for n,d in self.graph.nodes.items() if d["kind"] in {"exhibit","rest"}]
        done=self.entered==self.config["daily_visitors"] and not self.active
        weights=arrival_weights(self.config);total=sum(weights);opening=clock_seconds(self.config["opening"])
        minute_counts=Counter(int((t-opening)//60) for t in self.actual_arrivals if t<=self.now)
        arrival_series=[dict(time=opening+i*60,expected=self.config["daily_visitors"]*w/total,
                             actual=minute_counts[i] if opening+(i+1)*60<=self.now else None) for i,w in enumerate(weights)]
        return dict(shows=self._show_snapshots(),time=self.now,clock=clock_text(self.now),opening=clock_seconds(self.config["opening"]),
                    closing=self.closing,horizon=self.horizon,done=done,
                    metrics=dict(planned=self.config["daily_visitors"],pending=self.config["daily_visitors"]-self.entered,
                                 entered=self.entered,inside=len(self.active),exited=self.exited,peak=self.peak,
                                 queueing=sum(queued.values())),
                    visitors=visitors,zones=zones,history=self.history,recent=list(self.recent),
                    exit_reasons=dict(self.exit_reasons),provider=self.provider.source_name,
                    arrival_series=arrival_series,arrival_model=self.config["arrivals"],
                    transitions=[dict(id=eid,kind=e["kind"],inside=self.edge_load[eid],name=e.get("name",eid)) for eid,e in self.graph.edges.items() if self.graph.nodes[e["a"]]["floor"]!=self.graph.nodes[e["b"]]["floor"]])

    def report(self):
        opening=clock_seconds(self.config["opening"])
        counts=Counter(int((t-opening)//60) for t in self.schedule)
        arrivals=[dict(time=clock_text(opening+i*60),count=counts[i])
                  for i in range((clock_seconds(self.config["last_entry"])-opening)//60)]
        return dict(schema_version=1,config=self.config,map_hash=sha256_value(self.map_data),
                    config_hash=sha256_value(self.config),provider=self.provider.source_name,
                    complete=self.entered==self.config["daily_visitors"] and not self.active,
                    snapshot=self.snapshot(),completed_visitors=self.completed,arrival_minutes=arrivals,
                    limitations=self.map_data["assumptions"]+[self.map_data["program_status"]])
