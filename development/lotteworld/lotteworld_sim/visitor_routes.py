"""지도 그래프와 대기줄 중심선에서 방문객의 보행 경로를 만든다."""
from bisect import bisect_left, bisect_right
from dataclasses import dataclass
from functools import cached_property
from heapq import heappop, heappush
from itertools import accumulate, combinations, pairwise
from math import cos, dist, sin, tau

from .map_geometry import (distance_to_segment, obstacle_bounds, point_in_polygon,
                           public_walkable, segment_distance, segment_obstacle_distance,
                           walk_reservations, walking_route)

WALK_M_PER_S = 1.4
UNLOAD_GAP_S = 1.0
UNLOAD_SPREAD_M = (1.25, -1.25, 2.5, -2.5)
PUBLIC_WALK_VARIANTS = 13


class Path:
    def __init__(self, points):
        self.points = tuple(map(tuple, points))
        self.offsets = tuple(accumulate((dist(a, b) for a, b in pairwise(self.points)), initial=0.0))
        self.length = self.offsets[-1]

    def point_at(self, distance):
        if distance >= self.length:
            return self.points[-1]
        i = bisect_right(self.offsets, distance) - 1
        fraction = (distance - self.offsets[i]) / (self.offsets[i+1] - self.offsets[i])
        return tuple(a + (b - a) * fraction for a, b in zip(self.points[i], self.points[i+1]))

    def keeps_spacing(self, headway, minimum, follower=None):
        # 두 사람이 같은 속도로 움직이면 두 위치의 차는 경유점 사이에서 선형이다.
        follower = self if follower is None else follower
        last = min(self.length, follower.length + headway)
        breaks = sorted({headway, last, *self.offsets, *(d + headway for d in follower.offsets)})
        differences = [tuple(a - b for a, b in zip(self.point_at(d), follower.point_at(d - headway)))
                       for d in breaks if headway <= d <= last]
        if len(differences) == 1:
            return dist((0, 0), differences[0]) >= minimum - 1e-8
        return all(distance_to_segment((0, 0), a, b) >= minimum - 1e-8 for a, b in pairwise(differences))


@dataclass(frozen=True)
class FacilityPaths:
    approach: str
    queue: Path
    slots: tuple
    withdrawal: Path
    withdrawal_slots: tuple
    withdrawal_merge: str
    unloading: Path
    exit_merge: str
    exit_releases: tuple
    boarding_capacity: int
    unloading_variants: tuple = ()

    @property
    def queue_gate_offset(self):
        # 공공 보행 연결점과 입구 바깥점을 지난 뒤 초록색 입구를 밟는다.
        return self.queue.offsets[2]


class VisitorRoutes:
    def __init__(self, map_data, reports):
        geometry = map_data['geometry']
        self.nodes = {node['id']: node['point'] for node in geometry['nodes']}
        self.boundary = geometry['boundary']
        self.map = map_data
        self.cache = {}
        self._visible_paths = {}
        self.public_kinds = {'main', 'bridge', 'branch'}
        self.portals = {facility[key] for facility in map_data['facilities'] for key in ('entrance', 'exit')}
        public_nodes = {edge[key] for edge in geometry['edges'] if edge['kind'] in self.public_kinds
                        for key in ('source', 'target')} - self.portals
        self.land_nodes = sorted(public_nodes - {self.boundary})
        self.exit_connections = {}
        rules = geometry['queue_rules']
        self.radius = rules['person_radius_m']
        self.queue_scale = rules.get('layout_scale', 1)
        self.outline = geometry['island_outline']
        self.shore = tuple(pairwise([*self.outline, self.outline[0]]))
        self.shore_bounds = tuple((a, b, min(a[0], b[0]), max(a[0], b[0]), min(a[1], b[1]), max(a[1], b[1]))
                                  for a, b in self.shore)
        self.ride_access_areas = {area['facility_id']: area for area in geometry.get('ride_access_areas', [])}
        self.fixed_reservations = tuple(walk_reservations(geometry))
        reservations = (*self.fixed_reservations,
                        *(facility[key] for facility in map_data['facilities']
                          for key in ('bounds', 'queue', 'exit_area')))
        self.reservation_bounds = tuple((obstacle, obstacle_bounds(obstacle)) for obstacle in reservations)
        bridge = next(edge for edge in geometry['edges'] if edge['kind'] == 'bridge')
        self.bridge_width = bridge['width']
        self.bridge_landing = bridge['target'] if bridge['source'] == self.boundary else bridge['source']
        self.public_variants = {}
        # 줄 입구의 직각 구간에서도 이동 중인 두 사람의 몸체가 닿지 않도록 거리를 둔다.
        self.queue_headway_m = max(self.queue_scale, rules['spacing_m'])
        for node in public_nodes - {self.boundary}:
            if not public_walkable(map_data, self.nodes[node], self.radius):
                raise ValueError(f'공공 보행 연결점이 보행 면 밖에 있습니다: {node}')
        for node in public_nodes:
            self.public_path(self.boundary, node)
        self.facilities = {facility['id']: self._facility_paths(facility, reports[facility['id']], public_nodes)
                           for facility in map_data['facilities']}
        self.approach_nodes = {paths.approach for paths in self.facilities.values()}

    def public_path(self, source, target):
        key = (source, target)
        if key not in self.cache:
            if isinstance(source, tuple):
                self.cache[key] = self._path_from_exit(source, target)
            else:
                route = walking_route(self.map, *key, edge_kinds=self.public_kinds, excluded=self.portals)
                self.cache[key] = Path(self.nodes[node] for node in route['nodes'])
        return self.cache[key]

    def _path_from_exit(self, source, target):
        if source == target:
            return Path([source])
        anchors = self.exit_connections[source]
        anchor = min(anchors, key=lambda node: (dist(source, self.nodes[node]) +
                                                self.public_path(node, target).length, node))
        path = self.public_path(anchor, target)
        return path if source == path.points[0] else Path([source, *path.points])

    def visitor_path(self, source, target, variant):
        if source == target or (variant is None and isinstance(source, str) and isinstance(target, str)):
            return self.public_path(source, target)
        key = (source, target, variant)
        if key not in self.public_variants:
            points = self._open_path(source, target)
            if points is None:
                return None
            self.public_variants[key] = Path(points) if variant is None else self._spread_path(source, points, variant)
        return self.public_variants[key]

    @staticmethod
    def _edge_point(a, b, portion, side_m):
        dx, dz = b[0] - a[0], b[1] - a[1]
        length = dist(a, b)
        return a[0] + dx * portion - dz / length * side_m, a[1] + dz * portion + dx / length * side_m

    @cached_property
    def _public_visibility(self):
        points = {tuple(self.nodes[node]) for node in self.land_nodes}
        points.update(paths.queue.points[1] for paths in self.facilities.values())
        clearance = self.radius + .01
        for _, (x, z, width, depth) in self.reservation_bounds:
            # 예약 구획 모서리의 바깥쪽도 경유 후보로 두어 기존 보행 노드까지 우회할 필요를 줄인다.
            for corner_x in (x - clearance, x + width + clearance):
                for corner_z in (z - clearance, z + depth + clearance):
                    points.add((corner_x, corner_z))
        graph = {point: [] for point in sorted(points)
                 if point_in_polygon(point, self.map['geometry']['island_outline'])
                 and public_walkable(self.map, point, self.radius)}
        for a, b in combinations(graph, 2):
            if self._public_segment_clear(a, b, margin=0):
                length = dist(a, b)
                graph[a].append((length, b))
                graph[b].append((length, a))
        return graph

    def _visible_paths_from(self, start):
        if start in self._visible_paths:
            return self._visible_paths[start]
        if (not point_in_polygon(start, self.map['geometry']['island_outline'])
                or not public_walkable(self.map, start, self.radius)):
            return {}
        graph = self._public_visibility
        if start not in graph:
            graph = {**graph, start: [(dist(start, point), point) for point in graph
                                      if self._public_segment_clear(start, point, margin=0)]}
        pending = [(0.0, (start,))]
        distances = {start: 0.0}
        reached = {}
        while pending:
            distance, path = heappop(pending)
            point = path[-1]
            if point in reached:
                continue
            reached[point] = path
            for length, neighbor in graph[point]:
                total = distance + length
                if total < distances.get(neighbor, float('inf')):
                    distances[neighbor] = total
                    heappush(pending, (total, (*path, neighbor)))
        self._visible_paths[start] = reached
        return reached

    def _open_path(self, source, target):
        start = self.bridge_landing if source == self.boundary else source
        end = self.bridge_landing if target == self.boundary else target
        start = start if isinstance(start, tuple) else tuple(self.nodes[start])
        end = end if isinstance(end, tuple) else tuple(self.nodes[end])
        path = self._visible_paths_from(start).get(end)
        if path is None:
            return None
        if source == self.boundary:
            path = (tuple(self.nodes[source]), *path)
        if target == self.boundary:
            path = (*path, tuple(self.nodes[target]))
        return path

    @cached_property
    def _roaming_network(self):
        return self._visible_paths_from(tuple(self.nodes[self.bridge_landing]))

    def _roaming_links(self, point, count):
        links = []
        for anchor in sorted(self._roaming_network, key=lambda position: dist(point, position)):
            if anchor == point or self._public_segment_clear(point, anchor, margin=0):
                links.append(anchor)
                if len(links) == count:
                    break
        return links

    def roaming_path(self, source, rng, crowd_density):
        """현재 위치에서 도달할 수 있는 포장 위 임의 좌표로 짧게 걷는다."""
        start = tuple(self.nodes[source]) if isinstance(source, str) else tuple(source)
        if not point_in_polygon(start, self.outline):
            return None

        def local_target(origin, near, far, tries):
            connected = origin in self._roaming_network
            points = []
            for _ in range(tries):
                angle = rng.uniform(0, tau)
                distance = rng.uniform(near, far)
                point = origin[0] + distance * cos(angle), origin[1] + distance * sin(angle)
                if self._public_segment_clear(origin, point, margin=0):
                    points.append(point)
                    if len(points) == 5:
                        break
            # 좁은 길도 가끔 이용할 수 있게 혼잡도는 후보 확률에만 반영한다.
            while points:
                weights = [1 / (1 + .04 * min(crowd_density(point), 40)) for point in points]
                index, = rng.choices(range(len(points)), weights)
                point = points.pop(index)
                if connected or self._roaming_links(point, 1):
                    return point
            return None

        target = local_target(start, 14, 55, 12) or local_target(start, 5, 18, 8)
        if target is not None:
            return Path([start, target])
        for anchor in self._roaming_links(start, 3):
            if anchor == start:
                continue
            target = local_target(anchor, 9, 32, 10)
            if target is not None:
                return Path([start, anchor, target])
        return None

    def _roaming_paths_to(self, start, targets):
        if not point_in_polygon(start, self.outline):
            return {}
        paths = {}
        links = None
        for key, target in targets.items():
            if start == target:
                paths[key] = Path([start])
                continue
            if self._public_segment_clear(start, target, margin=0):
                paths[key] = Path([start, target])
                continue
            # 고정 도착점에서 계산한 경로를 뒤집어 사용하고 무작위 출발점은 캐시에 남기지 않는다.
            reached = self._visible_paths_from(target)
            if start in reached:
                paths[key] = Path(reversed(reached[start]))
                continue
            if links is None:
                links = self._roaming_links(start, 6)
            options = [Path([start, *reversed(reached[anchor])]) for anchor in links if anchor in reached]
            if options:
                paths[key] = min(options, key=lambda path: path.length)
        return paths

    def roaming_entrances(self, source, facility_ids):
        """공용 보행면의 현재 좌표부터 대기열 바로 바깥까지 연결한다."""
        targets = {key: self.facilities[key].queue.points[1] for key in facility_ids}
        return self._roaming_paths_to(tuple(source), targets)

    def roaming_exit(self, source, variant=None):
        """섬의 현재 좌표에서 진입 다리까지 연결하고 퇴장 방향 차선을 이용한다."""
        landing, boundary = (tuple(self.nodes[node]) for node in (self.bridge_landing, self.boundary))
        path = self._roaming_paths_to(tuple(source), {'landing': landing}).get('landing')
        if path is None:
            return None
        bridge = (landing, boundary) if variant is None else self._spread_path(landing, [landing, boundary], variant).points
        return Path([*path.points, *bridge[1:]])

    def entrances_from_point(self, source, facility_ids):
        """현재 좌표에서 대기열 입구까지 연결 가능한 최단 보행 경로를 반환한다."""
        reached = self._visible_paths_from(tuple(source))
        entrances = {facility: self.facilities[facility].queue.points[1:3] for facility in facility_ids}
        return {facility: path for facility, (outside, gate) in entrances.items()
                if outside in reached and (path := self.entrance_path(facility, [*reached[outside], gate]))}

    def entrance_path(self, facility_id, points):
        facility = next(f for f in self.map['facilities'] if f['id'] == facility_id)
        entry = self.nodes[facility['entrance']]
        queue = facility['queue']
        if list(points[-1]) != entry:
            return None
        x, z, width, depth = queue
        a, b = points[-2:]
        if facility_id in self.ride_access_areas:
            outside = self.facilities[facility_id].queue.points[1]
            if dist(a, outside) > 1e-8:
                return None
        approaches_gate = ((b[0] == x and a[0] < x) or (b[0] == x + width and a[0] > x + width)
                           or (b[1] == z and a[1] < z) or (b[1] == z + depth and a[1] > z + depth))
        if (approaches_gate and self._public_segment_clear(
                a, b, margin=0, entrance_queue=queue, ignore_ride_access=facility_id)
                and all(self._public_segment_clear(a, b, margin=0) for a, b in pairwise(points[:-1]))):
            return Path(points)
        return None

    def _public_segment_clear(self, a, b, *, margin=.15, entrance_queue=None, ignore_ride_access=None):
        radius = self.radius + margin
        access_area = self.ride_access_areas.get(ignore_ride_access)
        left, right = min(a[0], b[0]) - radius, max(a[0], b[0]) + radius
        top, bottom = min(a[1], b[1]) - radius, max(a[1], b[1]) + radius
        return (all(segment_obstacle_distance(a, b, obstacle, limit=radius) >= radius
                    for obstacle, (x, z, width, depth) in self.reservation_bounds
                    if obstacle is not entrance_queue and obstacle is not access_area and left <= x + width and x <= right
                    and top <= z + depth and z <= bottom)
                and all(segment_distance(a, b, c, d) >= radius
                        for c, d, x_min, x_max, z_min, z_max in self.shore_bounds
                        if left <= x_max and x_min <= right and top <= z_max and z_min <= bottom))

    def _spread_path(self, source, baseline, variant):
        boundary = tuple(self.nodes[self.boundary])
        points = [baseline[0]]
        join_points = set()
        spread = (variant - (PUBLIC_WALK_VARIANTS - 1) / 2) * 1.25
        for index, (a, b) in enumerate(pairwise(baseline)):
            length = dist(a, b)
            if boundary in (a, b):
                # 진행 방향 기준 오른쪽을 사용하고 다리의 양 끝에서 기존 연결점으로 합류한다.
                side = (self.bridge_width / 2 - self.radius) * (.28 + .52 * variant / (PUBLIC_WALK_VARIANTS - 1))
                ramp = min(.25, 8 / length)
                points.extend([self._edge_point(a, b, ramp, side), self._edge_point(a, b, 1 - ramp, side)])
            elif length > 4:
                portion = .42 + ((variant * 7 + index * 3) % 9) / 50
                offset = min(length * .25, abs(spread))
                if index == 0 and isinstance(source, tuple):
                    lead = min(6, length / 3)
                    portion = lead / length
                    offset = min(lead * .7, abs(spread))
                if spread < 0:
                    offset = -offset
                for scale in (1, .5, .25):
                    candidate = self._edge_point(a, b, portion, offset * scale)
                    if self._public_segment_clear(a, candidate) and self._public_segment_clear(candidate, b):
                        points.append(candidate)
                        break
                if b != baseline[-1] and b != tuple(self.nodes[self.bridge_landing]):
                    join_points.add(b)
            points.append(b)
        # 안전하게 이어지는 코너에서 중심 연결점 통과를 생략한다.
        for index in range(len(points) - 2, 0, -1):
            if points[index] in join_points and self._public_segment_clear(points[index - 1], points[index + 1]):
                points.pop(index)
        return Path(points)

    def _facility_paths(self, facility, report, public_nodes):
        geometry = self.map['geometry']
        outline = geometry['island_outline']
        obstacles = walk_reservations(geometry, ignore_ride_access=facility['id'])
        obstacles += [other[key] for other in self.map['facilities'] if other != facility
                      for key in ('bounds', 'queue', 'exit_area')]
        clearance = self.radius - 1e-8

        def clear(a, b, reservations):
            return (all(segment_obstacle_distance(a, b, obstacle, limit=clearance) >= clearance
                        for obstacle in reservations)
                    and point_in_polygon(a, outline) and point_in_polygon(b, outline)
                    and all(segment_distance(a, b, c, d) >= clearance for c, d in self.shore))

        def outside_gate(gate, inside):
            distance = .8 * self.queue_scale / dist(gate, inside)
            return [a + (a - b) * distance for a, b in zip(gate, inside)]

        entry_id = facility['entrance']
        entry = self.nodes[entry_id]
        entry_outside = outside_gate(entry, report['points'][1])
        if facility['id'] in self.ride_access_areas and not public_walkable(
                self.map, entry_outside, self.radius + .1):
            raise ValueError(f"대기열 입구 바로 바깥의 공공 보행 공간을 확보해야 합니다: {facility['id']}")
        entry_obstacles = [*obstacles, facility['bounds'], facility['exit_area']]
        entry_neighbors = {edge[key] for edge in geometry['edges'] if edge['kind'] == 'branch'
                           and entry_id in (edge['source'], edge['target'])
                           for key in ('source', 'target')} & public_nodes
        approaches = [node for node in entry_neighbors
                      if clear(self.nodes[node], entry_outside, [*entry_obstacles, facility['queue']])]
        if not clear(entry_outside, entry, entry_obstacles) or not approaches:
            raise ValueError(f"공공 보행 면에서 대기열에 접근할 수 없습니다: {facility['id']}")
        approach = min(approaches, key=lambda node: (self.public_path(self.boundary, node).length, node))

        gate, shoulder = report['withdrawal'][:2]
        outside = outside_gate(gate, shoulder)
        withdrawal_obstacles = [*obstacles, facility['bounds'], facility['exit_area']]
        merge_nodes = [node for node in public_nodes - {self.boundary}
                       if clear(outside, self.nodes[node], [*withdrawal_obstacles, facility['queue']])]
        if not clear(gate, outside, withdrawal_obstacles) or not merge_nodes:
            raise ValueError(f"대기열 이탈 게이트에서 공공 보행 면에 합류할 수 없습니다: {facility['id']}")
        withdrawal_merge = min(merge_nodes, key=lambda node: (dist(outside, self.nodes[node]), node))
        withdrawal = Path([self.nodes[withdrawal_merge], outside, *report['withdrawal']])

        exit_id = facility['exit']
        exit_point = self.nodes[exit_id]
        x, y, width, depth = facility['bounds']
        unloading_start = [max(x, min(x+width, exit_point[0])), max(y, min(y+depth, exit_point[1]))]
        if unloading_start == exit_point or not clear(unloading_start, exit_point, [*obstacles, facility['queue']]):
            raise ValueError(f"시설에서 하차 합류 구획으로 연결할 수 없습니다: {facility['id']}")
        exits = []
        for node in sorted(public_nodes):
            try:
                route = walking_route(self.map, exit_id, node, edge_kinds={'exit'}, excluded=self.portals - {exit_id})
            except ValueError:
                continue
            exits.append((route['distance_m'], node, route['nodes']))
        if not exits:
            raise ValueError(f"하차 후 공공 보행 면에 합류할 수 없습니다: {facility['id']}")
        _, exit_merge, exit_nodes = min(exits)

        if not clear(report['boarding_exit'], report['boarding_target'], [*obstacles, facility['exit_area']]):
            raise ValueError(f"대기열에서 탑승 지점으로 연결할 수 없습니다: {facility['id']}")
        queue = Path([self.nodes[approach], entry_outside, *report['points'], report['boarding_target']])
        unload = Path([unloading_start, *(self.nodes[node] for node in exit_nodes)])
        restricted = facility['id'] in self.ride_access_areas
        releases = self._public_exit_releases(unload, exit_merge, clear_tail=restricted)
        if not all(path.keeps_spacing(self.queue_headway_m, self.radius * 2) for path in (queue, withdrawal)):
            raise ValueError(f"대기열 진입·이탈 보행 중 방문객이 서로 겹칩니다: {facility['id']}")
        boarding = Path(queue.points[report['slot_indices'][0]+2:])
        if not boarding.keeps_spacing(report['spacing_m'], self.radius * 2):
            raise ValueError(f"탑승 지점으로 이동하는 방문객이 서로 겹칩니다: {facility['id']}")
        if not unload.keeps_spacing(WALK_M_PER_S * UNLOAD_GAP_S, self.radius * 2):
            raise ValueError(f"하차 보행 간격에서 방문객이 서로 겹칩니다: {facility['id']}")
        variants = ()
        if restricted:
            exit_obstacles = [*obstacles, facility['bounds'], facility['queue']]
            variants = self._unloading_variants(unload, exit_merge, lambda a, b: clear(a, b, exit_obstacles))
        self._validate_queue_walk(facility['id'], report, queue, withdrawal)
        return FacilityPaths(approach, queue,
                             tuple(queue.offsets[i+2] for i in report['slot_indices']), withdrawal,
                             tuple(withdrawal.offsets[i+2] for i in report['withdrawal_slot_indices']),
                             withdrawal_merge, unload, exit_merge, releases, report['boarding_capacity'], variants)

    def _unloading_variants(self, baseline, merge, clear):
        # 빨간 하차점까지 같은 시각에 도착하고, 그 뒤에서 좌우로 나뉜다.
        variants = []
        active_paths = []
        gap = WALK_M_PER_S * UNLOAD_GAP_S

        def spaced(leader, follower):
            return all(leader.keeps_spacing(gap * order, self.radius * 2, follower)
                       for order in range(1, int(leader.length / gap) + 1))

        def active_path(path, releases):
            offset = releases[-1][0]
            if offset >= path.length:
                return path
            return Path([*path.points[:bisect_left(path.offsets, offset)], path.point_at(offset)])

        def shifted_path(side):
            points = list(baseline.points[:2])
            for a, b in pairwise(baseline.points[1:]):
                length = dist(a, b)
                if length >= 2 and side:
                    ramp = min(3.5 / length, .5)
                    offset = min(length * .22, abs(side)) * (1 if side > 0 else -1)
                    for scale in (1, .65, .35):
                        shifted = [self._edge_point(a, b, part, offset * scale)
                                   for part in sorted({ramp, .7})]
                        if all(clear(c, d) for c, d in pairwise((a, *shifted, b))):
                            points.extend(shifted)
                            break
                points.append(b)
            return Path(points)

        spread_checkpoint = min(baseline.length, baseline.offsets[1] + 3.5)
        for side in (0, *UNLOAD_SPREAD_M):
            for scale in (1, .65, .35):
                path = shifted_path(side * scale)
                if any(dist(path.point_at(spread_checkpoint), other.point_at(spread_checkpoint)) < .3
                       for other, _ in variants):
                    continue
                releases = self._public_exit_releases(path, merge, clear_tail=True)
                active = active_path(path, releases)
                if spaced(active, active) and all(spaced(active, other) and spaced(other, active)
                                                 for other in active_paths):
                    variants.append((path, releases))
                    active_paths.append(active)
                    break
        return tuple(variants)

    def _public_exit_releases(self, path, merge, *, clear_tail=False):
        releases = []
        offset = path.offsets[1] + .5
        while offset < path.length and len(releases) < 4:
            point = path.point_at(offset)
            if public_walkable(self.map, point, self.radius + .15):
                next_index = bisect_right(path.offsets, offset)
                if clear_tail and any(not self._public_segment_clear(a, b)
                                      for a, b in pairwise((point, *path.points[next_index:]))):
                    offset += .5
                    continue
                anchors = tuple(node for node in self.land_nodes
                                if self._public_segment_clear(point, self.nodes[node]))
                if anchors:
                    self.exit_connections[point] = anchors
                    releases.append((offset, point))
                    offset += 1.5
                    continue
            offset += .5
        return tuple(releases) or ((path.length, merge),)

    def _validate_queue_walk(self, facility_id, report, queue, withdrawal):
        # 자리에서 이탈 통로로 옆걸음하는 구간에도 기둥의 바닥 받침 반경을 적용한다.
        sides = [(point, report['withdrawal'][index])
                 for point, index in zip(report['slots'], report['withdrawal_slot_indices'])]
        withdrawal_lines = list(pairwise(withdrawal.points))
        walking_lines = [*pairwise(queue.points), *withdrawal_lines, *sides]

        def separated(first, second, gap):
            nearby = [(c, d, min(c[0], d[0]), max(c[0], d[0]), min(c[1], d[1]), max(c[1], d[1]))
                      for c, d in second]
            for a, b in first:
                left, right = min(a[0], b[0]) - gap, max(a[0], b[0]) + gap
                top, bottom = min(a[1], b[1]) - gap, max(a[1], b[1]) + gap
                if any(left <= hi_x and right >= lo_x and top <= hi_y and bottom >= lo_y
                       and segment_distance(a, b, c, d) < gap - 1e-6
                       for c, d, lo_x, hi_x, lo_y, hi_y in nearby):
                    return False
            return True

        if not separated(walking_lines, report['rails'], self.radius + .22 * self.queue_scale):
            raise ValueError(f'대기·이탈·탑승 보행이 기둥 또는 벨트를 침범합니다: {facility_id}')
        queue_lanes = pairwise(report['points'])
        if not separated(queue_lanes, withdrawal_lines[2:], 2 * self.radius):
            raise ValueError(f'이탈 통로에서 대기 중인 방문객과 겹칩니다: {facility_id}')
