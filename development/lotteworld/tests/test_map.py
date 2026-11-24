from copy import deepcopy
import math
import unittest
from lotteworld_sim.scenario import load_inputs, validate
from lotteworld_sim.map_geometry import (
    distance_to_segment, obstacle_bounds, point_in_polygon, point_obstacle_distance, public_walkable,
    segment_obstacle_distance, segment_rect_distance, walk_reservations, walking_route,
)


class MapTests(unittest.TestCase):
    def setUp(self):
        self.scenario = load_inputs()

    def test_all_entrances_and_exits_have_reversible_metric_routes(self):
        data=self.scenario.map
        points={n['id']:n['point'] for n in data['geometry']['nodes']}
        for facility in data['facilities']:
            for key in ('entrance','exit'):
                with self.subTest(facility=facility['id'],port=key):
                    start=data['geometry']['boundary']; end=facility[key]
                    route=walking_route(data,start,end)
                    self.assertEqual(route['nodes'][0],start)
                    self.assertEqual(route['nodes'][-1],end)
                    expected=sum(math.dist(points[a],points[b]) for a,b in zip(route['nodes'],route['nodes'][1:]))
                    self.assertAlmostEqual(route['distance_m'],expected)
                    self.assertAlmostEqual(route['distance_m'],walking_route(data,end,start)['distance_m'])
                    self.assertGreater(route['distance_m'],0)
        self.assertEqual(data['geometry']['units'],'m')

    def test_invalid_geometry_and_physical_clearance_rejected(self):
        cases=[
            (['status'],'planned'),(['geometry','units'],'px'),(['geometry','bounds'],[0,0,True,330]),
            (['geometry','nodes',0,'point'],[float('nan'),10]),
            (['geometry','nodes',0,'point'],[float('inf'),10]),
            (['geometry','nodes',0,'point'],[True,10]),
            (['geometry','nodes',0,'point'],[-1,10]),
            (['geometry','nodes',0,'point'],[1]),
            (['geometry','nodes',1,'id'],'west-north'),
            (['geometry','edges',0,'target'],'missing'),
            (['geometry','edges',0,'target'],'west-45'),
            (['geometry','edges',0,'width'],7),
            (['geometry','edges',0,'width'],float('nan')),
            (['geometry','edges',0,'kind'],'teleport'),
            (['geometry','edges',1,'id'],'west-north--west-castle'),
            (['geometry','boundary'],'missing'),
            (['geometry','boundary'],'mid-80'),
            (['facilities',0,'bounds'],[400,20,40,24]),
            (['facilities',0,'bounds'],[150,120,40,24]),
            (['facilities',0,'queue'],[100,39,24,12]),
            (['facilities',0,'exit_area'],[108,55,8,6]),
            (['facilities',0,'entrance'],'mid-80'),
            (['facilities',0,'exit'],'missing'),
            (['facilities',0,'shape'],'unknown'),
            (['facilities',3,'level'],-1),
            (['facilities',0,'level'],False),
            (['geometry','nodes',0,'point'],[80,90]),
            (['facilities',3,'shape'],'water-coaster'),
            (['geometry','render_style'],'svg'),
            (['geometry','public_space'],'thin-paths-only'),
            (['geometry','landscape_beds'],[[141,130,14,14]]),
            (['geometry','landscape_trees'],[[143,145]]),
            (['geometry','castle_footprint'],[[0,0],[10,0],[10,10],[0,10]]),
            (['geometry','landscape_areas'],[{'id':'crossed','outline':[[50,50],[60,60],[50,60],[60,50]]}]),
            (['geometry','landscape_areas'],[{'id':'open-hole','outline':[[50,50],[60,50],[60,60],[50,60]],
                                            'holes':[[[50,50],[55,52],[52,55]]]}]),
            (['geometry','ride_access_areas'],[{'facility_id':'unknown','outline':[[50,50],[60,50],[60,60]]}]),
            (['geometry','ride_access_areas'],[{'facility_id':'gyro-drop','outline':[[50,50],[60,60],[50,60],[60,50]]}]),
            (['geometry','island_outline'],[[0,0],[10,0],[10,float('nan')],[5,10],[0,10]]),
            (['geometry','island_outline'],[[0,0],[100,100],[0,100],[100,0],[150,50]]),
            (['geometry','island_outline'],[[0,0],[50,0],[50,50],[0,50],[0,0]]),
            (['geometry','scenery_buildings'],[[170,120,10,10]]),
            (['geometry','castle_height_m'],True),
            (['geometry','castle_forward'],[1,1]),
            (['geometry','castle_model_scale_xz'],False),
            (['geometry','forecourt_width_m'],2),
            (['geometry','bridge_placement'],'corner-turn'),
            (['facilities',0,'model_height_m'],-1),
            (['facilities',3,'cutaway_depth_m'],7),
            (['facilities',0,'cutaway_depth_m'],7),
            (['facilities',0,'label_anchor'],[400,10]),
        ]
        for keys,value in cases:
            data=deepcopy(self.scenario.map);node=data
            for key in keys[:-1]: node=node[key]
            node[keys[-1]]=value
            with self.subTest(keys=keys),self.assertRaises(ValueError):
                validate(data, self.scenario.preferences)
        # 양방향 경로가 실제로 단절된 입력.
        for port in ('bridge-boundary','gyro-drop-entry','gyro-swing-exit'):
            data=deepcopy(self.scenario.map)
            data['geometry']['edges']=[e for e in data['geometry']['edges'] if port not in (e['source'],e['target'])]
            with self.subTest(disconnected=port),self.assertRaises(ValueError):
                validate(data, self.scenario.preferences)

    def test_main_loop_survives_one_main_edge_removal(self):
        data=self.scenario.map
        # 순환로의 한 구간이 끊겨도 반대쪽으로 돌아갈 수 있다.
        for index,e in enumerate(data['geometry']['edges']):
            if e['kind']=='main' and e['target']!='bridge-island':
                candidate=deepcopy(data);candidate['geometry']['edges'].pop(index)
                for f in candidate['facilities']:
                    walking_route(candidate,candidate['geometry']['boundary'],f['entrance'])

    def test_segment_clearance_handles_crossings_corners_and_parallel_paths(self):
        self.assertEqual(segment_rect_distance([0,5],[20,5],[5,0,5,10]),0)
        self.assertEqual(segment_rect_distance([0,12],[20,12],[5,0,5,10]),2)
        self.assertAlmostEqual(segment_rect_distance([0,0],[1,1],[2,2,2,2]),math.sqrt(2))

    def test_polygon_clearance_with_hole_and_tangency(self):
        area = {'outline': [[0, 0], [10, 0], [10, 10], [0, 10]],
                'holes': [[[3, 3], [7, 3], [7, 7], [3, 7]]]}
        self.assertEqual(obstacle_bounds(area), (0, 0, 10, 10))
        self.assertEqual(point_obstacle_distance([5, 5], area), 2)
        self.assertEqual(point_obstacle_distance([3, 5], area), 0)
        self.assertEqual(segment_obstacle_distance([4, 5], [6, 5], area), 1)
        self.assertEqual(segment_obstacle_distance([4, 5], [8, 5], area), 0)
        self.assertEqual(segment_obstacle_distance([-1, -1], [0, 0], area), 0)
        self.assertEqual(segment_obstacle_distance([-3, 3], [-1, 7], area, limit=.75), .75)

    def test_walk_reservations_fall_back_to_legacy_rectangles(self):
        data = deepcopy(self.scenario.map)
        geometry = data['geometry']
        geometry.pop('castle_footprint')
        geometry.pop('landscape_areas')
        geometry.pop('signposts')
        geometry.pop('ride_access_areas', None)
        self.assertEqual(walk_reservations(geometry),
                         [geometry['castle'], *geometry['scenery_buildings'], *geometry['landscape_beds']])
        self.assertFalse(public_walkable(data, [160, 150], .25))
        geometry['landscape_areas'] = []
        self.assertEqual(walk_reservations(geometry), [geometry['castle'], *geometry['scenery_buildings']])

    def test_island_outline_and_guide_relative_positions(self):
        data=self.scenario.map
        outline=data['geometry']['island_outline']
        self.assertTrue(point_in_polygon(outline[0],outline))
        self.assertFalse(point_in_polygon([369,329],outline))
        centers={f['id']:f['label_anchor'] for f in data['facilities']}
        castle=data['geometry']['castle']
        cx,cy=castle[0]+castle[2]/2,castle[1]+castle[3]/2
        self.assertLess(centers['gyro-drop'][0],cx)
        self.assertLess(centers['gyro-drop'][1],cy)
        self.assertGreater(centers['gyro-swing'][0],cx)
        self.assertLess(centers['gyro-swing'][1],centers['atlantis'][1])
        self.assertGreater(centers['atlantis'][0],cx)
        self.assertLess(centers['comet-express'][0],cx)
        self.assertGreater(centers['comet-express'][1],centers['gyro-drop'][1])
        self.assertNotIn([52,122,8,12],data['geometry']['landscape_beds'])
        self.assertGreater(centers['gyro-spin'][1],centers['comet-express'][1])
        self.assertGreater(centers['arcana-ride'][1],cy)

    def test_scenery_and_paths_must_stay_on_land(self):
        # 그래프가 연결돼 있어도 해안 밖을 지나는 보행로는 거절한다.
        data=deepcopy(self.scenario.map)
        node=next(n for n in data['geometry']['nodes'] if n['id']=='west-castle')
        node['point']=[5,80]
        with self.assertRaises(ValueError):
            validate(data, self.scenario.preferences)

    def test_broad_public_plazas_and_reserved_areas(self):
        data=self.scenario.map
        # 이전 성 예약 사각형의 모서리와 그래프 밖 포장도 지나갈 수 있다.
        for p in ([160,150],[170,130],[155.9,140],[137,130],[200,196],[84,120],[258,252.5]):
            self.assertTrue(public_walkable(data,p,.25),p)
        reserved=[f[key] for f in data['facilities'] for key in ('bounds','queue','exit_area')]
        for p in ([180,145],[33,151],[0,0],[314,320],*[[x+w/2,z+d/2] for x,z,w,d in reserved]):
            self.assertFalse(public_walkable(data,p,.25),p)
        points=[(x,y) for x in range(5,365,5) for y in range(5,325,5) if point_in_polygon((x,y),data['geometry']['island_outline'])]
        share=sum(public_walkable(data,p) for p in points)/len(points)
        self.assertGreater(share,.3)
        # 다리에서 기존 녹지였던 광장까지 실제 보행 영역을 통해 접근 가능하다.
        # 다리와 남쪽 우회 구간을 표본화할 수 있도록 2m 격자를 사용한다.
        public={(x,y) for x in range(4,370,2) for y in range(4,330,2) if public_walkable(data,(x,y),.25)}
        self.assertIn((300,302),public)
        reached={(300,302)}
        pending=[(300,302)]
        while pending:
            x,y=pending.pop()
            for other in ((x-2,y),(x+2,y),(x,y-2),(x,y+2)):
                if other in public and other not in reached:
                    reached.add(other);pending.append(other)
        for p in ((134,130),(160,150),(170,130),(200,196),(84,120)):
            self.assertIn(p,reached)
        with self.assertRaises(ValueError): public_walkable(data,[float('nan'),10])
        with self.assertRaises(ValueError): public_walkable(data,[10,10],-1)
        data=deepcopy(self.scenario.map)
        data['geometry']['scenery_buildings']=[[345,285,10,10]]
        with self.assertRaises(ValueError):
            validate(data, self.scenario.preferences)

    def test_landscape_reserves_rendered_areas_and_clears_full_graph_width(self):
        data = self.scenario.map
        geometry = data['geometry']
        areas = {area['id']: area for area in geometry['landscape_areas']}
        samples = {'north-and-east-coast': [180, 69], 'southwest-coast': [153, 299],
                   'comet-plaza': [104, 117], 'castle-east-plaza': [206, 126]}
        self.assertEqual(areas.keys(), samples.keys())
        without_landscape = deepcopy(data)
        without_landscape['geometry']['landscape_areas'] = []
        without_landscape['geometry'].pop('ride_access_areas', None)
        for name, point in samples.items():
            with self.subTest(area=name):
                self.assertEqual(point_obstacle_distance(point, areas[name]), 0)
                self.assertFalse(public_walkable(data, point))
                self.assertTrue(public_walkable(without_landscape, point))
        points = {node['id']: node['point'] for node in geometry['nodes']}
        for edge in geometry['edges']:
            a, b = points[edge['source']], points[edge['target']]
            half_width = edge['width']/2
            for name, area in areas.items():
                with self.subTest(edge=edge['id'], area=name):
                    self.assertGreaterEqual(segment_obstacle_distance(a, b, area, limit=half_width),
                                            half_width-1e-8)
        a, b = (points[geometry['edges'][0][key]] for key in ('source', 'target'))
        x, z = [(first+last)/2 for first, last in zip(a, b)]
        changed = deepcopy(data)
        changed['geometry']['landscape_areas'].append({
            'id': 'on-walkway', 'outline': [[x-1, z-1], [x+1, z-1], [x+1, z+1], [x-1, z+1]],
        })
        with self.assertRaisesRegex(ValueError, '보행로 유효 폭'):
            validate(changed, self.scenario.preferences)

    def test_ride_access_areas_reserve_open_pavement_for_their_facilities(self):
        data = self.scenario.map
        geometry = data['geometry']
        access_areas = geometry['ride_access_areas']
        self.assertEqual({area['facility_id'] for area in access_areas}, {f['id'] for f in data['facilities']})
        unrestricted = deepcopy(data)
        unrestricted['geometry'].pop('ride_access_areas')
        for area in access_areas:
            facility_id = area['facility_id']
            with self.subTest(facility=facility_id):
                left, top, width, depth = obstacle_bounds(area)
                candidates = ((x, z) for z in range(math.ceil(top), math.floor(top + depth), 2)
                              for x in range(math.ceil(left), math.floor(left + width), 2))
                sample = next((p for p in candidates if point_in_polygon(p, area['outline'])
                               and public_walkable(unrestricted, p, .25)), None)
                self.assertIsNotNone(sample, '기존 예약과 별도로 새 전용 구역에서 제한하는 포장면이 필요합니다.')
                self.assertFalse(public_walkable(data, sample, .25))
                self.assertTrue(public_walkable(data, sample, .25, ignore_ride_access=facility_id))
                for other in access_areas:
                    if other is not area:
                        self.assertFalse(public_walkable(data, sample, .25, ignore_ride_access=other['facility_id']))

    def test_ride_access_areas_cannot_reserve_another_ride_or_a_public_route(self):
        data = deepcopy(self.scenario.map)
        geometry = data['geometry']
        owner, other = data['facilities'][:2]
        x, z, w, d = other['bounds']
        geometry['ride_access_areas'] = [{
            'facility_id': owner['id'], 'outline': [[x, z], [x + w, z], [x + w, z + d], [x, z + d]],
        }]
        with self.assertRaisesRegex(ValueError, '구획이 겹칩니다'):
            validate(data, self.scenario.preferences)

        edge = next(edge for edge in geometry['edges'] if edge['kind'] == 'main')
        points = {node['id']: node['point'] for node in geometry['nodes']}
        a, b = points[edge['source']], points[edge['target']]
        x, z = ((start + end) / 2 for start, end in zip(a, b))
        geometry['ride_access_areas'][0]['outline'] = [[x - 1, z - 1], [x + 1, z - 1],
                                                       [x + 1, z + 1], [x - 1, z + 1]]
        with self.assertRaisesRegex(ValueError, '보행로 유효 폭'):
            validate(data, self.scenario.preferences)

    def test_guide_bridge_and_water_inlets(self):
        data=self.scenario.map
        points={n['id']:n['point'] for n in data['geometry']['nodes']}
        start=points['bridge-island'];end=points[data['geometry']['boundary']]
        self.assertGreater(end[0],start[0])
        self.assertGreater(end[1],start[1])
        self.assertGreaterEqual(start[1],data['geometry']['castle'][1]+data['geometry']['castle'][3])
        bridges=[e for e in data['geometry']['edges'] if e['kind']=='bridge']
        self.assertEqual(len(bridges),1)
        cx,cy=data['geometry']['castle'][0]+data['geometry']['castle'][2]/2,data['geometry']['castle'][1]+data['geometry']['castle'][3]/2
        dx,dy=data['geometry']['castle_forward']
        for x,y in (start,end):self.assertAlmostEqual((x-cx)*dy-(y-cy)*dx,0)
        self.assertTrue(public_walkable(data,[(start[0]+end[0])/2,(start[1]+end[1])/2],.25))
        for water in ([200,204],[200,205],[215,250],[300,240]):
            self.assertFalse(public_walkable(data,water),water)
        outline = data['geometry']['island_outline']
        self.assertFalse(point_in_polygon([200,205], outline))
        self.assertTrue(point_in_polygon([150,280], outline))

        length = math.dist(start, end)
        axis = [(b - a) / length for a, b in zip(start, end)]
        normal = [-axis[1], axis[0]]
        contact = [p + 4.8 * direction for p, direction in zip(start, axis)]
        shore_segments = list(zip(outline, outline[1:] + outline[:1]))
        contact_segment = min(shore_segments, key=lambda segment: distance_to_segment(contact, *segment))
        half_width = bridges[0]['width'] / 2

        # 데크 양 끝이 같은 해안 선분에 닿으면 그 사이 전폭도 해안에 닿는다.
        for offset in (-half_width, half_width):
            corner = [p + offset * direction for p, direction in zip(contact, normal)]
            self.assertAlmostEqual(distance_to_segment(corner, *contact_segment), 0, places=6)
            landward = [p - .1 * direction for p, direction in zip(corner, axis)]
            waterward = [p + .1 * direction for p, direction in zip(corner, axis)]
            self.assertTrue(point_in_polygon(landward, outline))
            self.assertFalse(point_in_polygon(waterward, outline))

        # 접합부 위쪽에서 데크 바깥으로 이어지는 양쪽 굴곡을 다리 축에 투영해 대조한다.
        inlet_offsets = []
        for point in outline:
            delta = [p - origin for p, origin in zip(point, contact)]
            along = sum(a * b for a, b in zip(delta, axis))
            lateral = sum(a * b for a, b in zip(delta, normal))
            if -16 <= along <= 1 and half_width <= abs(lateral) <= 26:
                inlet_offsets.append(lateral)
                reflected = [p - 2 * lateral * direction for p, direction in zip(point, normal)]
                distance = min(distance_to_segment(reflected, *segment) for segment in shore_segments)
                self.assertAlmostEqual(distance, 0, places=6)
        self.assertGreaterEqual(sum(offset < 0 for offset in inlet_offsets), 3)
        self.assertGreaterEqual(sum(offset > 0 for offset in inlet_offsets), 3)

        edges = {(edge['source'], edge['target']): edge for edge in data['geometry']['edges']}
        detour = ('south-east', 'south-east-bend', 'east-south', 'bridge-island')
        for source, target in zip(detour, detour[1:]):
            with self.subTest(detour=(source, target)):
                edge = edges[source, target]
                self.assertEqual((edge['kind'], edge['width']), ('main', 8))
                a, b = points[source], points[target]
                segment_length = math.dist(a, b)
                normal = [-(b[1] - a[1]) / segment_length, (b[0] - a[0]) / segment_length]
                for position in (0, .5, 1):
                    for offset in (-edge['width'] / 2, edge['width'] / 2):
                        sample = [start + position * (end - start) + offset * direction
                                  for start, end, direction in zip(a, b, normal)]
                        self.assertTrue(public_walkable(data, sample, .25), sample)


if __name__=='__main__': unittest.main()

