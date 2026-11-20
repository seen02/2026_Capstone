from copy import deepcopy
import math
import unittest
from lotteworld_sim.scenario import load_inputs, validate
from lotteworld_sim.map_geometry import walking_route, segment_rect_distance, point_in_polygon, public_walkable


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
                validate(data,self.scenario.config,self.scenario.preferences)
        # 양방향 경로가 실제로 단절된 입력.
        for port in ('bridge-boundary','gyro-drop-entry','gyro-swing-exit'):
            data=deepcopy(self.scenario.map)
            data['geometry']['edges']=[e for e in data['geometry']['edges'] if port not in (e['source'],e['target'])]
            with self.subTest(disconnected=port),self.assertRaises(ValueError):
                validate(data,self.scenario.config,self.scenario.preferences)

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
            validate(data,self.scenario.config,self.scenario.preferences)

    def test_broad_public_plazas_and_reserved_areas(self):
        data=self.scenario.map
        # 이전 녹지였던 길 바깥 공간도 이제 포장 광장으로 이동할 수 있다.
        for p in ([137,130],[200,205],[84,120],[258,252.5]):
            self.assertTrue(public_walkable(data,p,.25),p)
        reserved=[f[key] for f in data['facilities'] for key in ('bounds','queue','exit_area')]
        for p in ([180,145],[33,151],[0,0],[314,320],*[[x+w/2,z+d/2] for x,z,w,d in reserved]):
            self.assertFalse(public_walkable(data,p,.25),p)
        self.assertTrue(public_walkable(data,[137,130],.25))
        self.assertFalse(public_walkable(data,[155.9,140],.25))
        points=[(x,y) for x in range(5,365,5) for y in range(5,325,5) if point_in_polygon((x,y),data['geometry']['island_outline'])]
        share=sum(public_walkable(data,p) for p in points)/len(points)
        self.assertGreater(share,.7)
        # 다리에서 기존 녹지였던 광장까지 실제 보행 영역을 통해 접근 가능하다.
        # 8m 폭 다리의 꺾임도 표본화할 수 있도록 2m 격자를 사용한다.
        public={(x,y) for x in range(4,370,2) for y in range(4,330,2) if public_walkable(data,(x,y),.25)}
        self.assertIn((300,302),public)
        reached={(300,302)}
        pending=[(300,302)]
        while pending:
            x,y=pending.pop()
            for other in ((x-2,y),(x+2,y),(x,y-2),(x,y+2)):
                if other in public and other not in reached:
                    reached.add(other);pending.append(other)
        for p in ((134,130),(200,204),(84,120)):
            self.assertIn(p,reached)
        with self.assertRaises(ValueError): public_walkable(data,[float('nan'),10])
        with self.assertRaises(ValueError): public_walkable(data,[10,10],-1)
        data=deepcopy(self.scenario.map)
        data['geometry']['scenery_buildings']=[[345,285,10,10]]
        with self.assertRaises(ValueError):
            validate(data,self.scenario.config,self.scenario.preferences)

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
        for water in ([215,250],[300,240]):
            self.assertFalse(public_walkable(data,water),water)
        self.assertTrue(point_in_polygon([150,280],data['geometry']['island_outline']))


if __name__=='__main__': unittest.main()

