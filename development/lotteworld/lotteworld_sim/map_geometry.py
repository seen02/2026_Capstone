"""미터 좌표 지도 검증과 양방향 최단 보행 경로. 외부 패키지에 의존하지 않는다."""
import heapq
import math


def point_in_polygon(point, outline):
    """경계 위의 점을 포함하는 단순 다각형 내부 판정."""
    x, y = point
    inside = False
    for i, a in enumerate(outline):
        b = outline[(i + 1) % len(outline)]
        if distance_to_segment(point, a, b) < 1e-8:
            return True
        if (a[1] > y) != (b[1] > y) and x < (b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]:
            inside = not inside
    return inside


def public_walkable(data, point, radius=0):
    """넓은 포장 보행 공간. 참조 그래프의 중심선 폭으로 제한하지 않는다."""
    g = data['geometry']
    if type(radius) not in (int,float) or not math.isfinite(radius) or radius < 0:
        raise ValueError('보행 반경은 유한한 음수 아닌 값이어야 합니다.')
    if not isinstance(point, (list,tuple)) or len(point)!=2 or not all(type(v) in (int,float) and math.isfinite(v) for v in point):
        raise ValueError('보행 위치는 두 개의 유한 좌표여야 합니다.')
    on_land = point_in_polygon(point, g['island_outline'])
    if on_land and radius:
        on_land = all(distance_to_segment(point,a,g['island_outline'][(i+1)%len(g['island_outline'])]) >= radius for i,a in enumerate(g['island_outline']))
    if not on_land:
        nodes = {n['id']: n['point'] for n in g['nodes']}
        def bridge_contains(e):
            if e['kind']!='bridge' or e['width']/2 < radius:
                return False
            a,b=nodes[e['source']],nodes[e['target']]
            length=math.dist(a,b)
            t=((point[0]-a[0])*(b[0]-a[0])+(point[1]-a[1])*(b[1]-a[1]))/(length*length)
            return radius/length <= t <= 1-radius/length and distance_to_segment(point,a,b) <= e['width']/2-radius
        if not any(bridge_contains(e) for e in g['edges']):
            return False
    reservations = [g['castle'], *g['scenery_buildings'], *g['landscape_beds']]
    reservations += [f[key] for f in data['facilities'] for key in ('bounds','queue','exit_area')]
    x,y = point
    return not any(a-radius <= x <= a+w+radius and b-radius <= y <= b+h+radius for a,b,w,h in reservations)


def distance_to_segment(point, a, b):
    dx, dy = b[0]-a[0], b[1]-a[1]
    if dx == dy == 0:
        return math.dist(point, a)
    t = max(0, min(1, ((point[0]-a[0])*dx+(point[1]-a[1])*dy)/(dx*dx+dy*dy)))
    return math.dist(point, (a[0]+t*dx, a[1]+t*dy))


def segment_distance(a, b, c, d):
    def side(start, end, point):
        return ((end[0]-start[0])*(point[1]-start[1])
                - (end[1]-start[1])*(point[0]-start[0]))

    if (side(a,b,c)*side(a,b,d) <= 0 and side(c,d,a)*side(c,d,b) <= 0
            and all(max(min(a[i],b[i]),min(c[i],d[i])) <= min(max(a[i],b[i]),max(c[i],d[i]))
                    for i in (0,1))):
        return 0
    return min(distance_to_segment(a,c,d), distance_to_segment(b,c,d),
               distance_to_segment(c,a,b), distance_to_segment(d,a,b))


def segment_rect_distance(a, b, rect):
    x, y, w, h = rect
    corners = [(x,y),(x+w,y),(x+w,y+h),(x,y+h)]
    # 선분이 사각형 내부를 통과하는 경우도 검사한다.
    low, high = 0, 1
    for start, delta, minimum, maximum in [(a[0],b[0]-a[0],x,x+w),(a[1],b[1]-a[1],y,y+h)]:
        if delta == 0:
            if not minimum <= start <= maximum:
                break
        else:
            p, q = sorted(((minimum-start)/delta,(maximum-start)/delta))
            low, high = max(low,p), min(high,q)
            if low > high:
                break
    else:
        return 0
    def to_rect(p):
        return math.hypot(max(x-p[0],0,p[0]-x-w),max(y-p[1],0,p[1]-y-h))
    return min(to_rect(a),to_rect(b),*(distance_to_segment(c,a,b) for c in corners))


def walking_route(map_data, source, target, *, edge_kinds=None, excluded=()):
    """양방향 그래프의 경로와 미터 거리를 반환한다."""
    g = map_data['geometry']
    points = {n['id']: n['point'] for n in g['nodes']}
    if source not in points or target not in points:
        raise ValueError('경로의 시작·도착 노드가 없습니다.')
    adjacency = {key: [] for key in points}
    for e in g['edges']:
        a,b=e['source'],e['target']
        if (edge_kinds is not None and e['kind'] not in edge_kinds) or a in excluded or b in excluded:
            continue
        length=math.dist(points[a],points[b])
        adjacency[a].append((b,length)); adjacency[b].append((a,length))
    pending=[(0,source,[source])]; visited=set()
    while pending:
        length, key, route=heapq.heappop(pending)
        if key in visited: continue
        if key == target: return dict(nodes=route,distance_m=length)
        visited.add(key)
        for other, step in adjacency[key]:
            if other not in visited: heapq.heappush(pending,(length+step,other,route+[other]))
    raise ValueError('다리와 시설 사이 보행 경로가 끊겼습니다.')


def validate_geometry(data, require, number):
    g=data['geometry']
    require(data['status']=='map_ready' and g['units']=='m' and g['axis']=='x-right-y-down','지도 상태·미터 좌표계가 올바르지 않습니다.')
    bounds=g['bounds']
    require(isinstance(bounds,list) and len(bounds)==4 and bounds[:2]==[0,0] and all(number(v,1,10000) for v in bounds[2:]),'지도 범위가 올바르지 않습니다.')
    def point(p):
        return isinstance(p,list) and len(p)==2 and all(number(v,0,bounds[i+2]) for i,v in enumerate(p))
    def rect(r):
        return isinstance(r,list) and len(r)==4 and point(r[:2]) and all(number(v,0.1,10000) for v in r[2:]) and r[0]+r[2]<=bounds[2] and r[1]+r[3]<=bounds[3]
    for key in ('island','lake','castle','plaza'): require(rect(g[key]),'배경 구획 좌표가 올바르지 않습니다.')
    require(g['render_style'] == 'guide-map-3d', '3D 안내도 표시 계약이 필요합니다.')
    require(g['bridge_placement'] == 'castle-forecourt-to-southeast', '다리는 성 앞에서 남동쪽으로 이어져야 합니다.')
    require(g['public_space'] == 'island-minus-reservations', '섬 내부의 넓은 보행 공간 정의가 필요합니다.')
    require(isinstance(g['landscape_beds'],list) and all(rect(r) for r in g['landscape_beds']), '식재 구획 좌표가 올바르지 않습니다.')
    trees = g.get('landscape_trees', [])
    require(isinstance(trees, list) and all(point(tree) for tree in trees), '나무 좌표가 올바르지 않습니다.')
    require(number(g['castle_height_m'], 1, 100), '성의 표시 높이가 올바르지 않습니다.')
    require(isinstance(g['castle_forward'],list) and len(g['castle_forward'])==2 and all(number(v,.01,10000) for v in g['castle_forward']), '성 정면의 남동쪽 방향 벡터가 필요합니다.')
    require(number(g['castle_model_scale_xz'],.1,1) and number(g['forecourt_width_m'],12,30), '성 모형 배율·정면 광장 폭이 올바르지 않습니다.')
    outline = g['island_outline']
    require(isinstance(outline, list) and len(outline) >= 5 and all(point(p) for p in outline), '섬 윤곽은 유한 미터 좌표의 다각형이어야 합니다.')
    require(len({tuple(p) for p in outline}) == len(outline), '섬 윤곽의 꼭짓점이 중복됩니다.')
    def cross(a, b, c):
        return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])
    def intersects(a, b, c, d):
        return (cross(a,b,c)*cross(a,b,d) <= 0 and cross(c,d,a)*cross(c,d,b) <= 0
                and max(min(a[0],b[0]),min(c[0],d[0])) <= min(max(a[0],b[0]),max(c[0],d[0]))
                and max(min(a[1],b[1]),min(c[1],d[1])) <= min(max(a[1],b[1]),max(c[1],d[1])))
    for i, a in enumerate(outline):
        b = outline[(i+1) % len(outline)]
        for j in range(i+1, len(outline)):
            if j == i+1 or (i == 0 and j == len(outline)-1):
                continue
            require(not intersects(a, b, outline[j], outline[(j+1) % len(outline)]), '섬 윤곽이 스스로 교차합니다.')
    area = abs(sum(p[0]*outline[(i+1) % len(outline)][1]-outline[(i+1) % len(outline)][0]*p[1] for i,p in enumerate(outline))) / 2
    require(area > 1, '섬 윤곽의 면적이 없습니다.')
    require(isinstance(g['scenery_buildings'], list) and all(rect(r) for r in g['scenery_buildings']), '배경 건물 구획이 올바르지 않습니다.')
    require(isinstance(g['nodes'],list) and bool(g['nodes']),'보행 노드가 필요합니다.')
    points={}
    for n in g['nodes']:
        require(isinstance(n['id'],str) and bool(n['id']) and n['id'] not in points and point(n['point']),'보행 노드 ID·좌표가 올바르지 않습니다.')
        points[n['id']]=n['point']
    require(g['boundary'] in points,'다리 경계 노드가 필요합니다.')
    require(isinstance(g['edges'],list) and bool(g['edges']),'보행 연결이 필요합니다.')
    ids=set(); pairs=set(); bridge=False
    for e in g['edges']:
        a,b=e['source'],e['target']; kind=e['kind']
        require(isinstance(e['id'],str) and bool(e['id']) and e['id'] not in ids,'보행 연결 ID가 없거나 중복됩니다.')
        require(a in points and b in points and a!=b and points[a]!=points[b],'연결 노드·길이가 올바르지 않습니다.')
        require(frozenset((a,b)) not in pairs,'보행 연결이 중복됩니다.')
        require(kind in ('main','bridge','branch','exit') and number(e['width'],{'main':8,'bridge':8,'branch':5,'exit':3}.get(kind,1),20),'보행로 종류·유효 폭이 올바르지 않습니다.')
        for p in (points[a],points[b]):
            require(e['width']/2<=p[0]<=bounds[2]-e['width']/2 and e['width']/2<=p[1]<=bounds[3]-e['width']/2,'보행로 폭이 지도 밖으로 나갑니다.')
        bridge |= kind=='bridge' and g['boundary'] in (a,b)
        ids.add(e['id']);pairs.add(frozenset((a,b)))
    require(bridge,'다리 경계는 다리 연결 위에 있어야 합니다.')
    bridges=[e for e in g['edges'] if e['kind']=='bridge']
    require(len(bridges)==1 and 'bridge-island' in points, '성 앞과 외부 경계를 직접 연결하는 다리 한 개가 필요합니다.')
    start,end=points['bridge-island'],points[g['boundary']]
    require(end[0]>start[0] and end[1]>start[1] and start[1]>=g['castle'][1]+g['castle'][3], '다리의 시작·끝은 성 앞에서 오른쪽 아래 방향이어야 합니다.')
    cx,cy=g['castle'][0]+g['castle'][2]/2,g['castle'][1]+g['castle'][3]/2
    dx,dy=g['castle_forward']
    for x,y in (start,end):
        require(abs((x-cx)*dy-(y-cy)*dx)<1e-6, '성 정면과 다리의 시작·끝이 같은 축이어야 합니다.')
    require({bridges[0]['source'],bridges[0]['target']}=={'bridge-island',g['boundary']}, '다리는 성 앞과 외부 경계를 곧게 연결해야 합니다.')
    obstacles=[('castle',g['castle']), *[(f'building-{i}', r) for i,r in enumerate(g['scenery_buildings'])], *[(f'planting-{i}',r) for i,r in enumerate(g['landscape_beds'])]]
    for f in data['facilities']:
        require(f['shape'] in ('drop','swing','disk','water-coaster','comet-coaster','speedway'),'지원하지 않는 시설 형상입니다.')
        require(type(f['level']) is int and f['level']==0 and (f['shape']=='comet-coaster')==(f['id']=='comet-express'),'6개 시설은 지상 모형이며 혜성특급은 전용 코스 형상을 사용합니다.')
        require(number(f['model_height_m'], 1, 100), '시설 모형 높이가 올바르지 않습니다.')
        require('cutaway_depth_m' not in f, '현재 지상 시설 모형 계약을 사용해야 합니다.')
        require(point(f['label_anchor']), '시설 이름표 좌표가 올바르지 않습니다.')
        for key in ('bounds','queue','exit_area'):
            require(rect(f[key]),'시설·대기·하차 구획이 지도 범위를 벗어났습니다.')
            obstacles.append((f['id']+':'+key,f[key]))
        require(f['entrance'] in points and f['exit'] in points and f['entrance']!=f['exit'],'입구·출구 노드가 필요합니다.')
        x,y,w,h=f['queue']; px,py=points[f['entrance']]
        require(x<=px<=x+w and y<=py<=y+h and (px in (x,x+w) or py in (y,y+h)),'입구는 대기 구획 경계에 있어야 합니다.')
        x,y,w,h=f['exit_area'];px,py=points[f['exit']]
        require(x<=px<=x+w and y<=py<=y+h,'출구는 하차 합류 구획에 있어야 합니다.')
        for key,kind in [('entrance','branch'),('exit','exit')]:
            require(any(e['kind']==kind and f[key] in (e['source'],e['target']) for e in g['edges']),'입구·출구 전용 연결이 필요합니다.')
            walking_route(data,g['boundary'],f[key]);walking_route(data,f[key],g['boundary'])
    # 모든 노드도 같은 연결 요소에 속해야 한다.
    for key in points: walking_route(data,g['boundary'],key)
    for i,(name,r) in enumerate(obstacles):
        x,y,w,h=r
        require(all(point_in_polygon(p, outline) for p in ((x,y),(x+w,y),(x+w,y+h),(x,y+h))), f'시설·대기·하차·배경 구획이 섬 윤곽 밖입니다: {name}')
        for other,s in obstacles[i+1:]:
            require(not (x<s[0]+s[2] and s[0]<x+w and y<s[1]+s[3] and s[1]<y+h),'시설·대기·하차 구획이 겹칩니다.')
        for e in g['edges']:
            ends=(e['source'],e['target'])
            # 대기 입구와 전용 하차 구획의 접속부만 예외다.
            owner=next((f for f in data['facilities'] if name.startswith(f['id']+':')),None)
            if owner and name.endswith(':queue') and owner['entrance'] in ends and e['kind']=='branch':
                px,py=points[owner['entrance']]
                ox,oy=points[ends[1] if ends[0]==owner['entrance'] else ends[0]]
                require((px==x and ox<px) or (px==x+w and ox>px) or (py==y and oy<py) or (py==y+h and oy>py), '입구 지선은 대기 구획 바깥에서 접근해야 합니다.')
                continue
            if owner and name.endswith(':exit_area') and owner['exit'] in ends and e['kind']=='exit':
                continue
            margin=1.5 if name.endswith(':queue') else 0
            require(segment_rect_distance(points[ends[0]],points[ends[1]],r)>=e['width']/2+margin-1e-8,f"시설·대기·하차 구획이 보행로 유효 폭 또는 대기 완충을 침범합니다: {name}, {e['id']}")
    for e in g['edges']:
        if e['kind'] == 'bridge':
            continue
        a,b=points[e['source']],points[e['target']]
        length=math.dist(a,b)
        steps=max(1, math.ceil(length))
        nx,ny=-(b[1]-a[1])/length,(b[0]-a[0])/length
        for i in range(steps+1):
            for side in (-1, 0, 1):
                p=(a[0]+(b[0]-a[0])*i/steps+nx*e['width']/2*side,
                   a[1]+(b[1]-a[1])*i/steps+ny*e['width']/2*side)
                require(point_in_polygon(p, outline), f"다리가 아닌 보행로의 유효 폭이 섬 밖으로 나갑니다: {e['id']}")
    require(all(any(x+.5 <= px <= x+w-.5 and z+.5 <= pz <= z+d-.5
                    for x,z,w,d in g['landscape_beds']) for px,pz in trees),
            '나무의 줄기는 식재 구획 가장자리에서 0.5m 이상 떨어져야 합니다.')
