"""미터 좌표 지도 검증과 양방향 최단 보행 경로. 외부 패키지에 의존하지 않는다."""
import heapq
import math
from collections import defaultdict


EPSILON = 1e-8


def _ring_edges(ring):
    return zip(ring, (*ring[1:], *ring[:1]))


def point_in_polygon(point, outline):
    """경계 위의 점을 포함하는 단순 다각형 내부 판정."""
    x, y = point
    inside = False
    left, right = x-EPSILON, x+EPSILON
    top, bottom = y-EPSILON, y+EPSILON
    for a, b in _ring_edges(outline):
        if (a[1] < top and b[1] < top) or (a[1] > bottom and b[1] > bottom):
            continue
        if (not ((a[0] < left and b[0] < left) or (a[0] > right and b[0] > right))
                and distance_to_segment(point, a, b) < EPSILON):
            return True
        if (a[1] > y) != (b[1] > y) and x < (b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]:
            inside = not inside
    return inside


def public_walkable(data, point, radius=0, *, ignore_signpost=None, ignore_ride_access=None):
    """넓은 포장 보행 공간. 참조 그래프의 중심선 폭으로 제한하지 않는다."""
    g = data['geometry']
    if type(radius) not in (int,float) or not math.isfinite(radius) or radius < 0:
        raise ValueError('보행 반경은 유한한 음수 아닌 값이어야 합니다.')
    if not isinstance(point, (list,tuple)) or len(point)!=2 or not all(type(v) in (int,float) and math.isfinite(v) for v in point):
        raise ValueError('보행 위치는 두 개의 유한 좌표여야 합니다.')
    on_land = point_in_polygon(point, g['island_outline'])
    if on_land and radius:
        x, z = point
        left, right, top, bottom = x-radius, x+radius, z-radius, z+radius
        on_land = not any(distance_to_segment(point, a, b) < radius
                          for a, b in _ring_edges(g['island_outline'])
                          if not ((a[0] < left and b[0] < left) or (a[0] > right and b[0] > right)
                                  or (a[1] < top and b[1] < top) or (a[1] > bottom and b[1] > bottom)))
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
    reservations = walk_reservations(g, ignore_signpost=ignore_signpost, ignore_ride_access=ignore_ride_access)
    reservations += [f[key] for f in data['facilities'] for key in ('bounds','queue','exit_area')]
    x,y = point
    for obstacle in reservations:
        a, b, w, h = obstacle_bounds(obstacle)
        if (a-radius <= x <= a+w+radius and b-radius <= y <= b+h+radius
                and (not isinstance(obstacle, dict) or point_obstacle_distance(point, obstacle) <= radius)):
            return False
    return True


def distance_to_segment(point, a, b):
    dx, dy = b[0]-a[0], b[1]-a[1]
    if dx == dy == 0:
        return math.dist(point, a)
    t = max(0, min(1, ((point[0]-a[0])*dx+(point[1]-a[1])*dy)/(dx*dx+dy*dy)))
    return math.dist(point, (a[0]+t*dx, a[1]+t*dy))


def _cross(a, b, c):
    return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])


def segment_distance(a, b, c, d):
    if (_cross(a,b,c)*_cross(a,b,d) <= 0 and _cross(c,d,a)*_cross(c,d,b) <= 0
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


def _named_walk_reservations(geometry, *, ignore_signpost=None, ignore_ride_access=None):
    castle = {'outline': geometry['castle_footprint']} if 'castle_footprint' in geometry else geometry['castle']
    yield 'castle', castle
    yield from ((f'building-{i}', rect) for i, rect in enumerate(geometry['scenery_buildings']))
    if 'landscape_areas' in geometry:
        yield from ((area['id'], area) for area in geometry['landscape_areas'])
    else:
        yield from ((f'planting-{i}', rect) for i, rect in enumerate(geometry['landscape_beds']))
    for sign_id, signpost in geometry.get('signposts', {}).items():
        if sign_id == ignore_signpost:
            continue
        x, z = signpost['point']
        r = signpost['clearance_radius_m']
        yield sign_id, {'outline': ((x-r, z-r), (x+r, z-r), (x+r, z+r), (x-r, z+r))}
    for area in geometry.get('ride_access_areas', ()):
        if area['facility_id'] != ignore_ride_access:
            yield area['facility_id'] + ':ride-access', area


def walk_reservations(geometry, *, ignore_signpost=None, ignore_ride_access=None):
    """공용 포장의 고정 장애물을 사각형 또는 외곽선과 구멍으로 반환한다."""
    return [obstacle for _, obstacle in _named_walk_reservations(
        geometry, ignore_signpost=ignore_signpost, ignore_ride_access=ignore_ride_access)]


def _outline_bounds(outline):
    x_values, z_values = zip(*outline)
    left, top = min(x_values), min(z_values)
    return left, top, max(x_values)-left, max(z_values)-top


def obstacle_bounds(obstacle):
    """사각형 또는 다각형 장애물의 축 정렬 경계를 (x, z, 폭, 깊이)로 반환한다."""
    return _outline_bounds(obstacle['outline']) if isinstance(obstacle, dict) else tuple(obstacle)


def _obstacle_rings(obstacle):
    if isinstance(obstacle, dict):
        return obstacle['outline'], *obstacle.get('holes', ())
    x, z, w, d = obstacle
    return (((x, z), (x+w, z), (x+w, z+d), (x, z+d)),)


def _solid_contains(point, rings):
    return point_in_polygon(point, rings[0]) and not any(point_in_polygon(point, hole) for hole in rings[1:])


def point_obstacle_distance(point, obstacle):
    """점에서 장애물의 점유 영역까지 거리. 내부와 경계에서는 0이다."""
    if not isinstance(obstacle, dict):
        x, z, w, d = obstacle
        return math.hypot(max(x-point[0], 0, point[0]-x-w), max(z-point[1], 0, point[1]-z-d))
    rings = _obstacle_rings(obstacle)
    if _solid_contains(point, rings):
        return 0
    distance = min(distance_to_segment(point, a, b) for ring in rings for a, b in _ring_edges(ring))
    return 0 if distance < EPSILON else distance


def segment_obstacle_distance(a, b, obstacle, *, limit=math.inf):
    """선분에서 점유 영역까지 거리. 접촉하면 0, 더 멀면 최대 limit를 반환한다."""
    if limit <= 0:
        return limit
    if not isinstance(obstacle, dict):
        return min(limit, segment_rect_distance(a, b, obstacle))
    rings = _obstacle_rings(obstacle)
    left, right = sorted((a[0], b[0]))
    top, bottom = sorted((a[1], b[1]))
    distance = limit
    for ring in rings:
        for c, d in _ring_edges(ring):
            if (max(c[0], d[0]) <= left-distance or min(c[0], d[0]) >= right+distance
                    or max(c[1], d[1]) <= top-distance or min(c[1], d[1]) >= bottom+distance):
                continue
            distance = min(distance, segment_distance(a, b, c, d))
            if distance == 0:
                return 0
    return 0 if _solid_contains(a, rings) else distance


def _bounds_overlap(first, second):
    x, z, w, d = first
    a, b, c, e = second
    return min(x+w, a+c)-max(x, a) > EPSILON and min(z+d, b+e)-max(z, b) > EPSILON


def _edge_bounds(a, b):
    return min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1])


def _edges_meet(first, second):
    x1, z1, x2, z2 = first
    a1, b1, a2, b2 = second
    return max(x1, a1) <= min(x2, a2)+EPSILON and max(z1, b1) <= min(z2, b2)+EPSILON


def _bounded_edges(ring):
    return [(a, b, _edge_bounds(a, b)) for a, b in _ring_edges(ring)]


def _edge_contacts(a, b, c, d):
    """선분 ab가 cd와 만나는 위치를 ab의 0~1 매개변수로 반환한다."""
    dx, dz = b[0]-a[0], b[1]-a[1]
    ex, ez = d[0]-c[0], d[1]-c[1]
    cx, cz = c[0]-a[0], c[1]-a[1]
    determinant = dx*ez-dz*ex
    length = math.hypot(dx, dz)
    if length <= EPSILON:
        return (0,) if distance_to_segment(a, c, d) <= EPSILON else ()
    tolerance = EPSILON/length
    if determinant != 0:
        t = (cx*ez-cz*ex)/determinant
        u = (cx*dz-cz*dx)/determinant
        other_tolerance = EPSILON/math.hypot(ex, ez)
        if -tolerance <= t <= 1+tolerance and -other_tolerance <= u <= 1+other_tolerance:
            return (max(0, min(1, t)),)
        # 끝점의 반올림 오차를 허용하되 선분이 만나는 구간은 유지한다.
        return tuple(t for t, p in ((0, a), (1, b)) if distance_to_segment(p, c, d) <= EPSILON)
    if abs(cx*dz-cz*dx) > EPSILON*length:
        return ()
    ends = sorted(((cx*dx+cz*dz)/length**2, ((cx+ex)*dx+(cz+ez)*dz)/length**2))
    low, high = max(0, ends[0]), min(1, ends[1])
    return (min(1, low), max(0, high)) if low <= high+tolerance else ()


def _signed_ring_area(ring):
    return sum(a[0]*b[1]-b[0]*a[1] for a, b in _ring_edges(ring))/2


def _simple_ring(ring):
    if len({tuple(p) for p in ring}) != len(ring) or abs(_signed_ring_area(ring)) <= EPSILON:
        return False
    edges = _bounded_edges(ring)
    for i, (a, b, bounds) in enumerate(edges):
        if math.dist(a, b) <= EPSILON:
            return False
        for j in range(i+1, len(edges)):
            c, d, other_bounds = edges[j]
            if not _edges_meet(bounds, other_bounds):
                continue
            contacts = _edge_contacts(a, b, c, d)
            if not contacts:
                continue
            if j == i+1 or (i == 0 and j == len(edges)-1):
                if math.dist(a, b)*(max(contacts)-min(contacts)) <= EPSILON:
                    continue
            return False
    return True


def _ring_inside(inner, outer, *, strict=False):
    if not all(point_in_polygon(p, outer) for p in inner):
        return False
    shore = _bounded_edges(outer)
    for a, b, bounds in _bounded_edges(inner):
        contacts = [t for c, d, other_bounds in shore if _edges_meet(bounds, other_bounds)
                    for t in _edge_contacts(a, b, c, d)]
        if strict and contacts:
            return False
        if contacts:
            # A concave coast can put the interior of an edge outside while both vertices remain on land.
            breaks = sorted({0, 1, *contacts})
            for first, last in zip(breaks, breaks[1:]):
                t = (first+last)/2
                p = (a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t)
                if not point_in_polygon(p, outer):
                    return False
    return True


def _rings_meet(first, second):
    second_edges = _bounded_edges(second)
    return any(_edge_contacts(a, b, c, d)
               for a, b, bounds in _bounded_edges(first) for c, d, other_bounds in second_edges
               if _edges_meet(bounds, other_bounds))


def _scanline_intervals(edges, z):
    crossings = sorted(a[0]+(b[0]-a[0])*(z-a[1])/(b[1]-a[1])
                       for a, b, (_, low, _, high) in edges if low < z < high)
    return zip(crossings[::2], crossings[1::2])


def _obstacles_overlap(first, second, first_bounds, second_bounds):
    """두 점유 영역이 닿는 경우를 제외하고 실제 면적이 겹치는지 판정한다."""
    if not _bounds_overlap(first_bounds, second_bounds):
        return False
    if not isinstance(first, dict) and not isinstance(second, dict):
        return True
    first_rings, second_rings = _obstacle_rings(first), _obstacle_rings(second)
    first_edges = [edge for ring in first_rings for edge in _bounded_edges(ring)]
    second_edges = [edge for ring in second_rings for edge in _bounded_edges(ring)]
    for a, b, bounds in first_edges:
        for c, d, other_bounds in second_edges:
            if not _edges_meet(bounds, other_bounds):
                continue
            u, v = _cross(a, b, c), _cross(a, b, d)
            s, t = _cross(c, d, a), _cross(c, d, b)
            if min(u, v) < -EPSILON and max(u, v) > EPSILON and min(s, t) < -EPSILON and max(s, t) > EPSILON:
                return True
    # Without transverse crossings, x ordering is constant between consecutive vertex heights.
    top = max(first_bounds[1], second_bounds[1])
    bottom = min(first_bounds[1]+first_bounds[3], second_bounds[1]+second_bounds[3])
    levels = sorted({top, bottom, *(p[1] for ring in (*first_rings, *second_rings) for p in ring if top < p[1] < bottom)})
    for low, high in zip(levels, levels[1:]):
        if high-low <= EPSILON:
            continue
        z = (low+high)/2
        second_intervals = list(_scanline_intervals(second_edges, z))
        if any(min(b, d)-max(a, c) > EPSILON for a, b in _scanline_intervals(first_edges, z)
               for c, d in second_intervals):
            return True
    return False


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


def _ride_access_edges(edges, facilities, access_areas):
    """각 시설 입구의 지선과 첫 공공 합류점까지 이어지는 하차 전용 연결을 찾는다."""
    if not access_areas:
        return {}
    portals = {facility[key] for facility in facilities.values() for key in ('entrance', 'exit')}
    public_nodes = set()
    exit_links = defaultdict(list)
    entrances = defaultdict(set)
    for edge in edges:
        a, b, kind = edge['source'], edge['target'], edge['kind']
        if kind == 'exit':
            exit_links[a].append((b, edge['id']))
            exit_links[b].append((a, edge['id']))
        else:
            public_nodes.update((a, b))
            if kind == 'branch':
                if b not in portals:
                    entrances[a].add(edge['id'])
                if a not in portals:
                    entrances[b].add(edge['id'])
    public_nodes -= portals
    private_edges = {}
    exit_owners = defaultdict(set)
    for facility_id, facility in facilities.items():
        start = facility['exit']
        private_edges[facility_id] = entrances[facility['entrance']].copy()
        visited, pending = {start}, [start]
        while pending:
            node = pending.pop()
            for other, edge_id in exit_links[node]:
                if other in portals and other != start:
                    continue
                exit_owners[edge_id].add(facility_id)
                if other not in visited and other not in public_nodes:
                    visited.add(other)
                    pending.append(other)
    for edge_id, owners in exit_owners.items():
        if len(owners) == 1:
            private_edges[next(iter(owners))].add(edge_id)
    return private_edges


def validate_geometry(data, require, number):
    g=data['geometry']
    require(data['status']=='map_ready' and g['units']=='m' and g['axis']=='x-right-y-down','지도 상태·미터 좌표계가 올바르지 않습니다.')
    bounds=g['bounds']
    require(isinstance(bounds,list) and len(bounds)==4 and bounds[:2]==[0,0] and all(number(v,1,10000) for v in bounds[2:]),'지도 범위가 올바르지 않습니다.')
    def point(p):
        return isinstance(p,list) and len(p)==2 and all(number(v,0,bounds[i+2]) for i,v in enumerate(p))
    def rect(r):
        return isinstance(r,list) and len(r)==4 and point(r[:2]) and all(number(v,0.1,10000) for v in r[2:]) and r[0]+r[2]<=bounds[2] and r[1]+r[3]<=bounds[3]
    def ring(r):
        return isinstance(r, list) and len(r) >= 3 and all(point(p) for p in r) and _simple_ring(r)
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
    require(abs(_signed_ring_area(outline)) > 1, '섬 윤곽의 면적이 없습니다.')
    require(_simple_ring(outline), '섬 윤곽이 스스로 교차합니다.')
    require(all(point_in_polygon(p, outline) for p in _obstacle_rings(g['castle'])[0]), '성의 기준 구획이 섬 윤곽 밖입니다.')
    if 'castle_footprint' in g:
        footprint = g['castle_footprint']
        require(ring(footprint) and _ring_inside(footprint, outline), '성의 바닥 윤곽은 섬 안의 단순 다각형이어야 합니다.')
    if 'landscape_areas' in g:
        areas = g['landscape_areas']
        require(isinstance(areas, list), '녹지 구획은 목록이어야 합니다.')
        area_ids = set()
        for area in areas:
            require(isinstance(area, dict) and isinstance(area.get('id'), str) and bool(area['id'])
                    and area['id'] not in area_ids, '녹지 구획 ID가 없거나 중복됩니다.')
            area_ids.add(area['id'])
            exterior = area.get('outline')
            require(ring(exterior), f"녹지 윤곽은 단순 다각형이어야 합니다: {area['id']}")
            holes = area.get('holes', [])
            require(isinstance(holes, list) and all(ring(hole) for hole in holes), f"녹지 내부 구멍이 올바르지 않습니다: {area['id']}")
            for i, hole in enumerate(holes):
                require(_ring_inside(hole, exterior, strict=True), f"녹지 내부 구멍이 외곽과 닿거나 벗어납니다: {area['id']}")
                for other in holes[i+1:]:
                    require(not (_rings_meet(hole, other) or point_in_polygon(hole[0], other)
                                 or point_in_polygon(other[0], hole)), f"녹지 내부 구멍이 겹치거나 닿습니다: {area['id']}")
    require(isinstance(g['scenery_buildings'], list) and all(rect(r) for r in g['scenery_buildings']), '배경 건물 구획이 올바르지 않습니다.')
    signposts = g.get('signposts', {})
    require(isinstance(signposts, dict), '안내판 목록이 올바르지 않습니다.')
    facilities = {facility['id']: facility for facility in data['facilities']}
    facility_ids = set(facilities)
    access_areas = g.get('ride_access_areas', [])
    require(isinstance(access_areas, list), '시설 전용 구역은 목록이어야 합니다.')
    access_owners = {}
    area_facilities = set()
    for area in access_areas:
        require(isinstance(area, dict) and isinstance(area.get('facility_id'), str)
                and area['facility_id'] in facility_ids and area['facility_id'] not in area_facilities,
                '시설 전용 구역의 시설 ID가 없거나 중복되거나 올바르지 않습니다.')
        facility_id = area['facility_id']
        area_facilities.add(facility_id)
        access_owners[id(area)] = facilities[facility_id]
        exterior = area.get('outline')
        require('holes' not in area and ring(exterior) and _ring_inside(exterior, outline),
                f'시설 전용 구역은 섬 안의 단순 다각형이어야 합니다: {facility_id}')
    for sign_id, signpost in signposts.items():
        require(isinstance(sign_id, str) and bool(sign_id.strip()) and isinstance(signpost, dict)
                and isinstance(signpost.get('name'), str) and bool(signpost['name'].strip())
                and point(signpost.get('point')) and number(signpost.get('clearance_radius_m'), .15, 1),
                '안내판 정보 또는 기둥 여유 범위가 올바르지 않습니다.')
        destinations = signpost.get('facility_ids')
        require(isinstance(destinations, list) and bool(destinations)
                and all(isinstance(dest, str) and dest in facility_ids for dest in destinations)
                and len(set(destinations)) == len(destinations), f'안내 대상 시설이 올바르지 않습니다: {sign_id}')
    for sign_id, signpost in signposts.items():
        require(public_walkable(data, signpost['point'], signpost['clearance_radius_m'] * math.sqrt(2), ignore_signpost=sign_id),
                f'표지판 기둥은 공공 보행 구역에 있어야 합니다: {sign_id}')
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
    landscape_members = {id(area) for area in g.get('landscape_areas', [])}
    obstacles = []
    for name, obstacle in _named_walk_reservations(g):
        owner = access_owners.get(id(obstacle))
        obstacles.append((name, obstacle, owner, 'ride_access' if owner else None))
    for f in data['facilities']:
        require(f['shape'] in ('drop','swing','disk','water-coaster','comet-coaster','speedway'),'지원하지 않는 시설 형상입니다.')
        require(type(f['level']) is int and f['level']==0 and (f['shape']=='comet-coaster')==(f['id']=='comet-express'),'6개 시설은 지상 모형이며 혜성특급은 전용 코스 형상을 사용합니다.')
        require(number(f['model_height_m'], 1, 100), '시설 모형 높이가 올바르지 않습니다.')
        require('cutaway_depth_m' not in f, '현재 지상 시설 모형 계약을 사용해야 합니다.')
        require(point(f['label_anchor']), '시설 이름표 좌표가 올바르지 않습니다.')
        for key in ('bounds','queue','exit_area'):
            require(rect(f[key]),'시설·대기·하차 구획이 지도 범위를 벗어났습니다.')
            obstacles.append((f['id']+':'+key,f[key],f,key))
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
    private_edges = _ride_access_edges(g['edges'], facilities, access_areas)
    obstacle_boxes = [obstacle_bounds(entry[1]) for entry in obstacles]
    for i,(name,obstacle,owner,key) in enumerate(obstacles):
        x,y,w,h=obstacle_boxes[i]
        if not isinstance(obstacle, dict):
            require(all(point_in_polygon(p, outline) for p in _obstacle_rings(obstacle)[0]), f'시설·대기·하차·배경 구획이 섬 윤곽 밖입니다: {name}')
        for j in range(i+1, len(obstacles)):
            other_name, other, other_owner, other_key = obstacles[j]
            if owner is not None and owner is other_owner and 'ride_access' in (key, other_key):
                continue
            # Rendered landscaping can follow a rounded ride floor inside its collision box.
            if (id(obstacle) in landscape_members or id(other) in landscape_members) and not (
                    key in ('queue', 'exit_area') or other_key in ('queue', 'exit_area')):
                continue
            require(not _obstacles_overlap(obstacle, other, obstacle_boxes[i], obstacle_boxes[j]),
                    f'시설·대기·하차 구획이 겹칩니다: {name}, {other_name}')
        for e in g['edges']:
            ends=(e['source'],e['target'])
            # 대기 입구와 전용 하차 구획의 접속부만 예외다.
            if key=='queue' and owner['entrance'] in ends and e['kind']=='branch':
                px,py=points[owner['entrance']]
                ox,oy=points[ends[1] if ends[0]==owner['entrance'] else ends[0]]
                require((px==x and ox<px) or (px==x+w and ox>px) or (py==y and oy<py) or (py==y+h and oy>py), '입구 지선은 대기 구획 바깥에서 접근해야 합니다.')
                continue
            if key=='exit_area' and owner['exit'] in ends and e['kind']=='exit':
                continue
            if key == 'ride_access' and e['id'] in private_edges[owner['id']]:
                continue
            margin=1.5 if key=='queue' else 0
            width=e['width']/2+margin-EPSILON
            a,b=points[ends[0]],points[ends[1]]
            if segment_rect_distance(a,b,obstacle_boxes[i]) >= width:
                continue
            require(segment_obstacle_distance(a,b,obstacle,limit=width)>=width,f"시설·대기·하차 구획이 보행로 유효 폭 또는 대기 완충을 침범합니다: {name}, {e['id']}")
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
