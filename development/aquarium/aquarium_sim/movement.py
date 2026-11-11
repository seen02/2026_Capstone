"""결정적 0.25초 보행: 몸체 간격, 연속 경로 충돌 검사, 우측 통행과 대기."""
import heapq
import json
import math
import random
from collections import defaultdict
from functools import lru_cache
from .hashing import stable_seed

STEP=.25
CELL=.25
SPEED=1.2
ANGLES=[(math.cos(math.radians(a)),math.sin(math.radians(a))) for a in (0,25,-25,50,-50,80,-80,110,-110,150,-150,180)]


def segment_distance(p,a,b):
    dx,dz=b[0]-a[0],b[1]-a[1]
    t=max(0,min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dz)/(dx*dx+dz*dz or 1)))
    return math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dz)


def swept_distance2(p,end,q,qend):
    x,z=p[0]-q[0],p[1]-q[1]
    vx,vz=end[0]-p[0]-qend[0]+q[0],end[1]-p[1]-qend[1]+q[1]
    vv=vx*vx+vz*vz
    t=max(0,min(1,-(x*vx+z*vz)/vv)) if vv else 0
    return (x+t*vx)**2+(z+t*vz)**2


def front_distance(room,p):
    """실제 수조 유리/무대 경계까지의 거리. ㄱ자 수조의 빈 안쪽도 구분한다."""
    boxes=[b for f in room['features'] for b in f.get('collision_bounds',[f['bounds']])]
    return min(math.hypot(max(x-p[0],0,p[0]-x-w),max(z-p[1],0,p[1]-z-d)) for x,z,w,d in boxes)


def covered(box,rects):
    x,z,xx,zz=box
    if any(a<=x and b<=z and c>=xx and d>=zz for a,b,c,d in rects):return True
    cuts=sorted({x,xx}|{v for r in rects for v in (r[0],r[2]) if x<v<xx})
    for lo,hi in zip(cuts,cuts[1:]):
        spans=sorted((b,d) for a,b,c,d in rects if a<=(lo+hi)/2<=c and d>=z and b<=zz)
        end=z
        for b,d in spans:
            if b>end+1e-9:return False
            end=max(end,d)
        if end<zz-1e-9:return False
    return True


class Geometry:
    def __init__(self,g):
        radius=g.get('human_radius_m',.23)
        self.radius=radius;self.gap=2*radius+.08
        floors=[(x,z,x+w,z+d) for x,z,w,d in (a['bounds'] for a in g['walkable_areas'])]
        walls=[]
        for w in g['walls']:
            (x,z),(xx,zz)=w['a'],w['b'];pad=w['thickness']/2
            walls.append((min(x,xx)-pad,min(z,zz)-pad,max(x,xx)+pad,max(z,zz)+pad))
        for room in g['rooms']:
            for feature in room.get('features',[room['feature']]):
                for x,z,w,d in feature.get('collision_bounds',[feature['bounds']]):walls.append((x,z,x+w,z+d))
        bx,bz,bw,bd=g['bounds'];self.free=set()
        for i in range(math.floor(bx/CELL),math.ceil((bx+bw)/CELL)):
            for j in range(math.floor(bz/CELL),math.ceil((bz+bd)/CELL)):
                box=(i*CELL-radius,j*CELL-radius,(i+1)*CELL+radius,(j+1)*CELL+radius)
                if not covered(box,floors):continue
                if any(box[0]<c and box[2]>a and box[1]<d and box[3]>b for a,b,c,d in walls):continue
                self.free.add((i,j))

    def cell(self,p):return (math.floor(p[0]/CELL),math.floor(p[1]/CELL))
    def center(self,c):return ((c[0]+.5)*CELL,(c[1]+.5)*CELL)
    def valid(self,p):return self.cell(p) in self.free

    def clear(self,a,b):
        # 통과하는 모든 격자 칸을 검사하여 얇은 벽을 건너뛰지 않는다.
        x,z=self.cell(a);end=self.cell(b)
        if (x,z) not in self.free or end not in self.free:return False
        dx,dz=b[0]-a[0],b[1]-a[1];sx=1 if dx>0 else -1;sz=1 if dz>0 else -1
        tx=(((x+1 if dx>0 else x)*CELL-a[0])/dx) if dx else math.inf
        tz=(((z+1 if dz>0 else z)*CELL-a[1])/dz) if dz else math.inf
        stepx=CELL/abs(dx) if dx else math.inf;stepz=CELL/abs(dz) if dz else math.inf
        while (x,z)!=end:
            if x==end[0]:z+=sz;tz+=stepz
            elif z==end[1]:x+=sx;tx+=stepx
            elif abs(tx-tz)<1e-10:
                if (x+sx,z) not in self.free or (x,z+sz) not in self.free:return False
                x+=sx;z+=sz;tx+=stepx;tz+=stepz
            elif tx<tz:x+=sx;tx+=stepx
            else:z+=sz;tz+=stepz
            if (x,z) not in self.free:return False
        return True

    @lru_cache(maxsize=4096)
    def path(self,start,end):
        return self.search(start,end)

    def search(self,start,end,blocked=frozenset(),limit=100000):
        if end in blocked:return ()
        heap=[(0,start)];cost={start:0};prev={};closed=set()
        while heap and limit:
            limit-=1
            _,u=heapq.heappop(heap)
            if u in closed:continue
            closed.add(u)
            if u==end:
                result=[]
                while u!=start:result.append(self.center(u));u=prev[u]
                return tuple(reversed(result))
            for dx,dz in ((1,0),(-1,0),(0,1),(0,-1),(1,1),(1,-1),(-1,1),(-1,-1)):
                v=(u[0]+dx,u[1]+dz)
                if v not in self.free or v in blocked:continue
                if dx and dz and any(c not in self.free or c in blocked for c in ((u[0]+dx,u[1]),(u[0],u[1]+dz))):continue
                score=cost[u]+(1.41421356237 if dx and dz else 1)
                if score>=cost.get(v,math.inf):continue
                cost[v]=score;prev[v]=u
                heapq.heappush(heap,(score+1.4*math.hypot(v[0]-end[0],v[1]-end[1]),v))
        return ()


@lru_cache(maxsize=4)
def geometry(serialized):return Geometry(json.loads(serialized))


@lru_cache(maxsize=4)
def public_geometry(serialized):
    base=geometry(serialized)
    lanes=[r.get('queue_access_area',r['queue_area']) for r in json.loads(serialized)['rooms'] if r.get('queue_path')]
    if not lanes:return base
    result=Geometry.__new__(Geometry);result.radius=base.radius;result.gap=base.gap
    result.free={c for c in base.free if not any(x<=base.center(c)[0]<x+w and z<=base.center(c)[1]<z+d for x,z,w,d in lanes)}
    return result


@lru_cache(maxsize=128)
def scattered_positions(geom,node_id,areas,passages,spacing):
    """격자 없이 간격을 유지하는 후보 위치. 재시작 때도 같은 도면은 같은 후보를 쓴다."""
    rng=random.Random(stable_seed('scattered-view-v1',node_id))
    points=[];buckets=defaultdict(list);extent=math.ceil(spacing)
    weights=[w*d for _,_,w,d in areas]
    for _ in range(8000):
        x,z,w,d=rng.choices(areas,weights=weights)[0]
        p=(x+rng.random()*w,z+rng.random()*d)
        if not geom.valid(p) or any(segment_distance(p,a,b)<1.1 for a,b in passages):continue
        cell=(math.floor(p[0]),math.floor(p[1]))
        if any(math.dist(p,q)<spacing for i in range(cell[0]-extent,cell[0]+extent+1) for j in range(cell[1]-extent,cell[1]+extent+1) for q in buckets[i,j]):continue
        points.append(p);buckets[cell].append(p)
    return tuple(points)


class Movement:
    def __init__(self,sim):
        self.sim=sim;self.nodes=sim.graph.nodes
        self.rooms={r['id']:r for r in sim.map_data['geometry']['rooms']}
        self.geometry=geometry(json.dumps(sim.map_data['geometry'],sort_keys=True))
        self.public_geometry=public_geometry(json.dumps(sim.map_data['geometry'],sort_keys=True))
        self.gap2=self.geometry.gap**2
        self.claims={};self.paths={};self.detours={};self.stalls={};self.queue_paths={};self.scheduled=False;self.steps=0
        self.slots={}
        passages=[]
        for e in sim.map_data.get('edges',[]):
            a,b=self.nodes[e['a']],self.nodes[e['b']]
            if a['kind']=='junction' and b['kind']=='junction':passages.append(((a['x'],a['z']),(b['x'],b['z'])))
        for node in self.nodes.values():
            if node['kind'] not in {'queue','exhibit'}:continue
            room=self.rooms[node['zone']]
            areas=[room['queue_area']] if node['kind']=='queue' else room.get('view_areas',[room['view_area']])
            self.slots[node['id']]=scattered_positions(self.geometry,node['id'],tuple(map(tuple,areas)),
                tuple(passages) if node['kind']=='queue' else (),1.15 if node['kind']=='exhibit' else .85)


    def vacant(self,p,ignore=None):
        return all(a.id==ignore or a.position is None or (p[0]-a.position[0])**2+(p[1]-a.position[1])**2>=self.gap2 for a in self.sim.active.values())

    def spawn(self,node,ignore=None):
        n=self.nodes[node];base=(n['x'],n['z'])
        for dx,dz in [(0,0)]+[(x*.65,z*.65) for z in range(-2,3) for x in range(-2,3) if x or z]:
            p=(base[0]+dx,base[1]+dz)
            if self.geometry.valid(p) and self.vacant(p,ignore):return p
        return None

    def ensure(self,a):
        if a.position is not None:return
        n=self.nodes[a.node];room=self.rooms.get(n.get('zone'))
        if n['kind']=='queue' and room.get('queue_slots') and a.queue_slot is not None:
            point=tuple(room['queue_slots'][a.queue_slot])
            if self.vacant(point,a.id):a.position=point;return
        if n['kind']=='queue' and room.get('queue_path') and a.queue_slot is None:
            # 정원을 확보하지 못한 초기 방문자는 이미 찬 줄 안에 배치하지 않는다.
            a.position=self.spawn('show_lobby',a.id)
            if a.position is not None:return
        candidates=self.slots.get(a.node,[])
        a.position=next((p for p in candidates if self.vacant(p,a.id)),None) or self.spawn(a.node,a.id)
        if a.position is None:
            # 복원·실험에서 직접 배치한 초기 인원도 서로 겹치지 않게 둔다.
            for radius in range(2,13):
                points=[(n['x']+i*.75,n['z']+j*.75) for i in range(-radius,radius+1) for j in range(-radius,radius+1) if max(abs(i),abs(j))==radius]
                a.position=next((p for p in points if self.geometry.valid(p) and self.vacant(p,a.id)),None)
                if a.position is not None:break
        if a.position is None:raise RuntimeError('초기 보행 위치를 확보할 수 없습니다.')

    def goal(self,a):
        node=self.nodes[a.next_node];room=self.rooms.get(node.get('zone'))
        stopping=self.stopping(a)
        if stopping and node['kind']=='queue' and room.get('queue_slots') and a.queue_slot is not None:
            return tuple(room['queue_slots'][a.queue_slot])
        if stopping and node['id'] in self.slots:
            existing=self.claims.get(a.id)
            if existing and existing[0]==node['id']:return existing[1]
            used=[p for id,(_,p) in self.claims.items() if id!=a.id]
            points=[p for p in self.slots[node['id']] if all(math.dist(p,q)>=self.geometry.gap for q in used)]
            # 같은 행·열을 채우지 않고 수조 앞의 가까운 빈자리를 각자 고른다.
            rng=random.Random(stable_seed(a.id,node['id'],'front-preference-v1'))
            scores={p:front_distance(room,p)+rng.uniform(0,.9) for p in points}
            points.sort(key=scores.get)
            p=next((p for p in points if self.vacant(p,a.id)),None)
            if p:self.claims[a.id]=(node['id'],p)
            return p
        start=self.nodes[a.node];dx,dz=node['x']-start['x'],node['z']-start['z'];length=math.hypot(dx,dz) or 1
        if node['id']=='show_lobby':
            return (node['x'],43.4) if a.node=='queue_F' else (node['x'],node['z'])
        p=(node['x']-dz/length*.6,node['z']+dx/length*.6)
        return p if self.geometry.valid(p) else (node['x'],node['z'])

    def stopping(self,a):
        node=self.nodes[a.next_node]
        return node['kind']=='exhibit' or (node['kind']=='queue' and a.destination==node.get('zone') and not a.must_exit)

    def full_queues(self):
        used={p for _,p in self.claims.values()}
        return {n['zone'] for n in self.nodes.values() if n['kind']=='queue' and not self.rooms[n['zone']].get('queue_slots')
                and not any(p not in used and self.vacant(p) for p in self.slots[n['id']])}

    def begin(self,a):
        self.ensure(a);self.claims.pop(a.id,None);self.paths.pop(a.id,None)
        self.detours.pop(a.id,None);self.stalls.pop(a.id,None)
        a.move_goal=self.goal(a);a.motion_status='moving'
        self.queue_paths.pop(a.id,None)
        node=self.nodes[a.next_node];room=self.rooms.get(node.get('zone'))
        if room and room.get('queue_path') and node['kind']=='queue' and self.stopping(a) and a.queue_slot is not None:
            # 줄 사이를 가로지르지 않고 위쪽 합류 → 오른쪽 회전 → 아래쪽 앞자리로 간다.
            path=room['queue_path']
            turning=[tuple(p) for p in path[1:3]] if a.queue_slot<len(room['queue_slots'])//2 else []
            self.queue_paths[a.id]=[tuple(path[0])]+turning+[a.move_goal]
        elif room and room.get('queue_path') and a.node==room['queue_node'] and a.next_node in {'show_before','show_lobby'}:
            # 관람을 포기할 때도 줄을 거슬러 다른 대기자와 마주치지 않는다.
            path=room['queue_path']
            turning=[]
            if a.position[1]<path[2][1]-.15:
                if a.position[1]<=path[1][1]+.15:turning.append(tuple(path[1]))
                turning.append(tuple(path[2]))
            if a.position[0]<room['queue_access_area'][0]:turning=[]
            self.queue_paths[a.id]=turning+[tuple(path[-1]),a.move_goal]
        if not self.scheduled:
            self.scheduled=True;self.sim._push(self.sim.now+STEP,'movement')

    def priority(self,a):
        if self.queue_paths.get(a.id):
            room=self.rooms[self.nodes[a.next_node]['zone']];path=room['queue_path']
            # 두 줄의 직선 거리 대신 실제 줄을 따라 입구까지 남은 길이를 쓴다.
            best=(math.inf,0);remaining=0
            for p,q in reversed(list(zip(path,path[1:]))):
                dx,dz=q[0]-p[0],q[1]-p[1];length=math.hypot(dx,dz)
                t=max(0,min(1,((a.position[0]-p[0])*dx+(a.position[1]-p[1])*dz)/(length*length)))
                distance=math.dist(a.position,(p[0]+dx*t,p[1]+dz*t))
                if distance<best[0]:best=(distance,remaining+length*(1-t))
                remaining+=length
            return best[1],a.id
        return (math.dist(a.position,a.move_goal) if a.move_goal else math.inf,a.id)

    def step(self):
        # 도착 처리에서 다음 구간이 시작되어도 같은 시각의 틱을 중복 예약하지 않는다.
        self.scheduled=True;self.steps+=1
        active=self.sim.active
        for a in active.values():self.ensure(a)
        old={id:a.position for id,a in active.items()};new=dict(old)
        buckets=defaultdict(list)
        for id,(x,z) in old.items():buckets[(math.floor(x),math.floor(z))].append(id)
        movers=[a for a in active.values() if a.edge]
        # 출구·갈림길 앞의 사람부터 움직여 뒤따르는 사람이 빈 공간으로 전진한다.
        movers.sort(key=self.priority)
        arrived=[]
        for a in movers:
            p=old[a.id];goal=a.move_goal or self.goal(a);a.move_goal=goal
            if goal is None:a.motion_status='waiting';a.blocked_for+=STEP;a.movement_wait_seconds+=STEP;continue
            distance_to_goal=math.dist(p,goal)
            kind=self.nodes[a.next_node]['kind']
            tolerance=.025 if self.stopping(a) else (.15 if a.node=='queue_F' else .8) if a.next_node=='show_lobby' else .4 if kind in {'door','exit'} else 2.0
            queue_path=self.queue_paths.get(a.id,[])
            while len(queue_path)>1 and math.dist(p,queue_path[0])<.15:queue_path.pop(0)
            merging=bool(queue_path and queue_path[0]==tuple(self.rooms[self.nodes[a.next_node]['zone']]['queue_path'][0]))
            admission=getattr(self.sim.graph,'edges',{}).get(a.edge,{}).get('kind')=='admission'
            nav=self.geometry if queue_path or admission else self.public_geometry
            if distance_to_goal<tolerance and not queue_path:arrived.append(a);continue
            best,since=self.stalls.get(a.id,(distance_to_goal,self.sim.now))
            if distance_to_goal<best-.4:best,since=distance_to_goal,self.sim.now
            self.stalls[a.id]=(best,since)
            if self.sim.now-since>=3 and not queue_path:
                blocked=set()
                radius=self.geometry.gap+.02
                for id,q in old.items():
                    if id==a.id or math.dist(p,q)>6:continue
                    for i in range(math.floor((q[0]-radius)/CELL),math.ceil((q[0]+radius)/CELL)+1):
                        for j in range(math.floor((q[1]-radius)/CELL),math.ceil((q[1]+radius)/CELL)+1):
                            c=(i,j);v=self.geometry.center(c)
                            if math.dist(q,v)<radius:blocked.add(c)
                blocked.discard(self.geometry.cell(p))
                path=nav.search(nav.cell(p),nav.cell(goal),blocked,limit=1500)
                if path:self.detours[a.id]=path
                self.stalls[a.id]=(distance_to_goal,self.sim.now)
            target=queue_path[0] if queue_path else goal
            detour=self.detours.get(a.id,())
            while detour and math.dist(p,detour[0])<.1:detour=detour[1:]
            self.detours[a.id]=detour
            if detour and not queue_path:target=detour[0]
            elif not nav.clear(p,target):
                path=self.paths.get(a.id,())
                while path and math.dist(p,path[0])<.3:path=path[1:]
                if not path or not nav.clear(p,path[0]):path=nav.path(nav.cell(p),nav.cell(target))
                # 직선으로 접근할 수 있는 중간 지점까지 이동한다.
                index=0
                for i in range(min(len(path),12)):
                    if nav.clear(p,path[i]):index=i
                    else:break
                if path:target=path[index];path=path[index:]
                self.paths[a.id]=path
            else:self.paths.pop(a.id,None)
            dx,dz=target[0]-p[0],target[1]-p[1];distance=math.hypot(dx,dz)
            if distance<1e-8:continue
            dt=min(STEP,max(0,self.sim.now-a.move_start));step=min(distance,SPEED*dt)
            neighbors=[]
            for i in range(math.floor(p[0]-1.2),math.floor(p[0]+1.2)+1):
                for j in range(math.floor(p[1]-1.2),math.floor(p[1]+1.2)+1):neighbors.extend(buckets.get((i,j),()))
            neighbors=[id for id in neighbors if id!=a.id and math.dist(p,old[id])<self.geometry.gap+2*SPEED*STEP+.001]
            chosen=None;choice=0
            # 합류 목에서는 서로 양보·우회하고, 줄 안에 들어서면 추월하지 않는다.
            options=ANGLES[:1] if queue_path and not merging else ANGLES if a.blocked_for>=1 else ANGLES[:7]
            for k,scale in [(0,1),(0,.5)]+[(k,scale) for scale in (1,.5) for k in range(1,len(options))]:
                c,s=options[k]
                end=(p[0]+(dx*c-dz*s)/distance*step*scale,p[1]+(dz*c+dx*s)/distance*step*scale)
                # 합류점을 지나쳐 줄 앞에서 거꾸로 되돌아오는 우회는 허용하지 않는다.
                if merging and end[0]>queue_path[0][0]+1e-9:continue
                if not nav.clear(p,end):continue
                if any(swept_distance2(p,end,old[id],new[id])<self.gap2-1e-10 for id in neighbors):continue
                chosen=end;choice=k;break
            if chosen is None:
                a.motion_status='waiting';a.blocked_for+=dt;a.movement_wait_seconds+=dt
                a.move_end=self.sim.now+math.dist(p,goal)/SPEED
                continue
            new[a.id]=chosen;a.position=chosen
            a.motion_status='avoiding' if choice else 'moving'
            a.avoidance_steps+=bool(choice)
            progress=math.dist(p,goal)-math.dist(chosen,goal)
            a.blocked_for=0 if progress>.01 else a.blocked_for+dt
            a.move_end=self.sim.now+math.dist(chosen,goal)/SPEED
            if math.dist(chosen,goal)<tolerance and len(queue_path)<=1:
                self.queue_paths.pop(a.id,None);arrived.append(a)
        for a in arrived:
            a.motion_status='still';a.blocked_for=0
            self.sim._arrived(a)
        if any(a.edge for a in active.values()):
            self.scheduled=True;self.sim._push(self.sim.now+STEP,'movement')
        else:self.scheduled=False
