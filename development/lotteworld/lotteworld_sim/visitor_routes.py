"""지도 그래프와 대기줄 중심선에서 방문객의 보행 경로를 만든다."""
from bisect import bisect_right
from dataclasses import dataclass
from itertools import accumulate, pairwise
from math import dist

from .map_geometry import (distance_to_segment, point_in_polygon, public_walkable,
                           segment_distance, segment_rect_distance, walking_route)

WALK_M_PER_S = 1.4
UNLOAD_GAP_S = 1.0
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

    def keeps_spacing(self, headway, minimum):
        # 두 사람이 같은 속도로 움직이면 두 위치의 차는 경유점 사이에서 선형이다.
        breaks = sorted(set(self.offsets) | {d + headway for d in self.offsets})
        differences = [tuple(a - b for a, b in zip(self.point_at(d), self.point_at(d - headway)))
                       for d in breaks if headway <= d <= self.length]
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


class VisitorRoutes:
    def __init__(self, map_data, reports):
        geometry = map_data['geometry']
        self.nodes = {node['id']: node['point'] for node in geometry['nodes']}
        self.boundary = geometry['boundary']
        self.map = map_data
        self.cache = {}
        self.public_kinds = {'main', 'bridge', 'branch'}
        self.portals = {facility[key] for facility in map_data['facilities'] for key in ('entrance', 'exit')}
        public_nodes = {edge[key] for edge in geometry['edges'] if edge['kind'] in self.public_kinds
                        for key in ('source', 'target')} - self.portals
        self.land_nodes = sorted(public_nodes - {self.boundary})
        self.exit_connections = {}
        self.exit_merges = {}
        rules = geometry['queue_rules']
        self.radius = rules['person_radius_m']
        self.shore = tuple(pairwise([*geometry['island_outline'], geometry['island_outline'][0]]))
        self.reservations = (geometry['castle'], *geometry['scenery_buildings'], *geometry['landscape_beds'],
                             *(facility[key] for facility in map_data['facilities']
                               for key in ('bounds', 'queue', 'exit_area')))
        self.bridge_width = next(edge['width'] for edge in geometry['edges'] if edge['kind'] == 'bridge')
        self.public_variants = {}
        # 줄 입구의 직각 구간에서도 이동 중인 두 사람의 몸체가 닿지 않도록 거리를 둔다.
        self.queue_headway_m = max(1.0, rules['spacing_m'])
        for node in public_nodes - {self.boundary}:
            if not public_walkable(map_data, self.nodes[node], self.radius):
                raise ValueError(f'공공 보행 연결점이 보행 면 밖에 있습니다: {node}')
        for node in public_nodes:
            self.public_path(self.boundary, node)
        self.facilities = {facility['id']: self._facility_paths(facility, reports[facility['id']], public_nodes)
                           for facility in map_data['facilities']}

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
        if variant is None or source == target:
            return self.public_path(source, target)
        key = (source, target, variant)
        if key not in self.public_variants:
            self.public_variants[key] = self._spread_path(source, target, variant)
        return self.public_variants[key]

    @staticmethod
    def _edge_point(a, b, portion, side_m):
        dx, dz = b[0] - a[0], b[1] - a[1]
        length = dist(a, b)
        return a[0] + dx * portion - dz / length * side_m, a[1] + dz * portion + dx / length * side_m

    def _public_segment_clear(self, a, b):
        radius = self.radius + .15
        left, right = min(a[0], b[0]) - radius, max(a[0], b[0]) + radius
        top, bottom = min(a[1], b[1]) - radius, max(a[1], b[1]) + radius
        return (all(segment_rect_distance(a, b, rect) >= radius
                    for rect in self.reservations if left <= rect[0] + rect[2] and rect[0] <= right
                    and top <= rect[1] + rect[3] and rect[1] <= bottom)
                and all(segment_distance(a, b, c, d) >= radius for c, d in self.shore
                        if left <= max(c[0], d[0]) and min(c[0], d[0]) <= right
                        and top <= max(c[1], d[1]) and min(c[1], d[1]) <= bottom))

    def _spread_path(self, source, target, variant):
        baseline = self.public_path(source, target).points
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
                if b != baseline[-1] and b != tuple(self.nodes['bridge-island']):
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
        shore = list(pairwise([*outline, outline[0]]))
        obstacles = [geometry['castle'], *geometry['scenery_buildings'], *geometry['landscape_beds']]
        obstacles += [other[key] for other in self.map['facilities'] if other != facility
                      for key in ('bounds', 'queue', 'exit_area')]

        def clear(a, b, reservations):
            return (all(segment_rect_distance(a, b, rect) >= self.radius - 1e-8 for rect in reservations)
                    and point_in_polygon(a, outline) and point_in_polygon(b, outline)
                    and all(segment_distance(a, b, c, d) >= self.radius - 1e-8 for c, d in shore))

        def outside_gate(gate, inside):
            return [a + (a - b) * .8 / dist(gate, inside) for a, b in zip(gate, inside)]

        entry_id = facility['entrance']
        entry = self.nodes[entry_id]
        entry_outside = outside_gate(entry, report['points'][1])
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
        releases = self._public_exit_releases(unload, exit_merge)
        if not all(path.keeps_spacing(self.queue_headway_m, self.radius * 2) for path in (queue, withdrawal)):
            raise ValueError(f"대기열 진입·이탈 보행 중 방문객이 서로 겹칩니다: {facility['id']}")
        boarding = Path(queue.points[report['slot_indices'][0]+2:])
        if not boarding.keeps_spacing(report['spacing_m'], self.radius * 2):
            raise ValueError(f"탑승 지점으로 이동하는 방문객이 서로 겹칩니다: {facility['id']}")
        if not unload.keeps_spacing(WALK_M_PER_S * UNLOAD_GAP_S, self.radius * 2):
            raise ValueError(f"하차 보행 간격에서 방문객이 서로 겹칩니다: {facility['id']}")
        self._validate_queue_walk(facility['id'], report, queue, withdrawal)
        return FacilityPaths(approach, queue,
                             tuple(queue.offsets[i+2] for i in report['slot_indices']), withdrawal,
                             tuple(withdrawal.offsets[i+2] for i in report['withdrawal_slot_indices']),
                             withdrawal_merge, unload, exit_merge, releases, report['boarding_capacity'])

    def _public_exit_releases(self, path, merge):
        releases = []
        offset = path.offsets[1] + .5
        while offset < path.length and len(releases) < 4:
            point = path.point_at(offset)
            if public_walkable(self.map, point, self.radius + .15):
                anchors = tuple(node for node in self.land_nodes
                                if self._public_segment_clear(point, self.nodes[node]))
                if anchors:
                    self.exit_connections[point] = anchors
                    self.exit_merges[point] = merge
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

        if not separated(walking_lines, report['rails'], self.radius + .22):
            raise ValueError(f'대기·이탈·탑승 보행이 기둥 또는 벨트를 침범합니다: {facility_id}')
        queue_lanes = pairwise(report['points'])
        if not separated(queue_lanes, withdrawal_lines[2:], 2 * self.radius):
            raise ValueError(f'이탈 통로에서 대기 중인 방문객과 겹칩니다: {facility_id}')
