from copy import deepcopy
import json
import math
from pathlib import Path
import shutil
import socket
import tempfile
import threading
import time
import unittest
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

from lotteworld_sim.scenario import CONTINUOUS_PATH,RIDE_OPERATIONS_PATH,ROOT,load_inputs,validate
from lotteworld_sim.server import make_server
from lotteworld_sim.devserver import supervise


class QueueCapacityTests(unittest.TestCase):
    def test_verified_slots_meet_each_boarding_unit(self):
        scenario=load_inputs();report=scenario.metadata()['queue_report']
        expected={'atlantis':(8,20,110),'gyro-drop':(40,100,110),'gyro-swing':(40,100,110),'gyro-spin':(40,100,130),'comet-express':(26,65,130),'arcana-ride':(16,40,130)}
        self.assertEqual(sum(row['capacity'] for row in report.values()),720)
        for id,(boarding,minimum,capacity) in expected.items():
            with self.subTest(facility=id):
                row=report[id]
                self.assertEqual((row['boarding_capacity'],row['minimum_capacity'],row['capacity']),(boarding,minimum,capacity))
                self.assertTrue(row['meets_minimum'])
                self.assertEqual(len(row['slots']),capacity)
                for i,p in enumerate(row['slots']):
                    self.assertTrue(all(math.dist(p,q)>=row['spacing_m']-1e-6 for q in row['slots'][i+1:]))

    def test_insufficient_capacity_and_body_overlap_rejected(self):
        scenario=load_inputs()
        for key,value in [('boarding_capacity',49),('queue_capacity',111),('queue_capacity',None),
                          ('spacing_m',1),('person_radius_m',.5),('minimum_boarding_multiple',2),('layout_scale',0)]:
            data=deepcopy(scenario.map)
            if key in ('boarding_capacity','queue_capacity'):data['facilities'][0][key]=value
            else:data['geometry']['queue_rules'][key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):validate(data,scenario.preferences)


class ReloadTests(unittest.TestCase):
    def test_same_server_reloads_json_and_static_files_and_recovers(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            shutil.copytree(ROOT/'configs',root/'configs');(root/'web').mkdir()
            (root/'web/index.html').write_text('처음 화면',encoding='utf-8')
            server=make_server(0,root=root)
            thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
            base=f'http://127.0.0.1:{server.server_port}'
            def get(path):
                # 지도 변경 후 메타데이터를 다시 만들 때 보행 경로도 검증한다.
                timeout = 15 if path == '/api/meta' else 3
                with urlopen(base+path, timeout=timeout) as response:
                    return json.load(response)
            try:
                initial=get('/api/meta');version=get('/api/dev-version')
                run_id = get('/api/state')['run_id']
                continuous_path = root / CONTINUOUS_PATH
                continuous = {**initial['continuous'], 'initial_people': 0, 'target_people': 1}
                continuous_path.write_text(json.dumps(continuous), encoding='utf-8')
                self.assertEqual(load_inputs(root=root).continuous, continuous)
                self.assertEqual(get('/api/meta')['continuous'], initial['continuous'])
                self.assertEqual(get('/api/dev-version'), version)
                state = get('/api/state')
                self.assertEqual(state['run_id'], run_id)
                self.assertEqual(state['background']['target_people'], initial['continuous']['target_people'])
                with make_server(0, root=root) as restarted:
                    self.assertNotEqual(restarted.background.run_id, run_id)
                    self.assertEqual(restarted.background.snapshot()['background']['target_people'], 1)
                operations_path = root / RIDE_OPERATIONS_PATH
                operations = json.loads(operations_path.read_text(encoding='utf-8'))
                atlantis = operations['facilities']['atlantis']
                atlantis['ride_seconds'] = 125
                atlantis['vehicle_count'] = 7
                operations_path.write_text(json.dumps(operations), encoding='utf-8')
                updated_meta = get('/api/meta')
                self.assertEqual(updated_meta['ride_operations']['facilities']['atlantis'], atlantis)
                self.assertEqual(atlantis['dispatch_interval_seconds'], 30)
                self.assertEqual(updated_meta['hashes']['map'], initial['hashes']['map'])
                self.assertNotEqual(updated_meta['hashes']['ride_operations'], initial['hashes']['ride_operations'])
                old_state = get('/api/state')
                self.assertEqual(old_state['ride_operations_hash'], initial['hashes']['ride_operations'])
                self.assertEqual(old_state['rides']['atlantis']['vehicle_count'], 8)
                with make_server(0, root=root) as restarted:
                    new_state = restarted.background.snapshot()
                    self.assertEqual(new_state['ride_operations_hash'], updated_meta['hashes']['ride_operations'])
                    self.assertEqual(new_state['rides']['atlantis']['vehicle_count'], 7)
                atlantis['dispatch_interval_seconds'] = 0
                operations_path.write_text(json.dumps(operations), encoding='utf-8')
                with self.assertRaises(HTTPError) as invalid_operations:
                    get('/api/meta')
                self.assertEqual(invalid_operations.exception.code, 422)
                self.assertEqual(get('/api/state')['ride_operations_hash'], old_state['ride_operations_hash'])
                atlantis['dispatch_interval_seconds'] = 35
                operations_path.write_text(json.dumps(operations), encoding='utf-8')
                self.assertEqual(get('/api/meta')['ride_operations']['facilities']['atlantis'], atlantis)
                preferences_path = root / 'configs/preferences.json'
                preferences = json.loads(preferences_path.read_text(encoding='utf-8'))
                preferences['behavior']['repeat_weight'] = 0.5
                preferences_path.write_text(json.dumps(preferences), encoding='utf-8')
                updated_hash = get('/api/meta')['hashes']['preferences']
                self.assertNotEqual(updated_hash, initial['hashes']['preferences'])
                updated_version = get('/api/dev-version')
                self.assertEqual(updated_version['instance'], version['instance'])
                self.assertNotEqual(updated_version['version'], version['version'])
                self.assertEqual(get('/api/state')['preferences_hash'], initial['hashes']['preferences'])
                self.assertEqual(server.background.behavior['repeat_weight'], 0.25)
                with make_server(0, root=root) as restarted:
                    self.assertEqual(restarted.background.snapshot()['preferences_hash'], updated_hash)
                    self.assertEqual(restarted.background.behavior['repeat_weight'], 0.5)
                map_path=root/'configs/map.json';original=map_path.read_text(encoding='utf-8');updated=json.loads(original);updated['facilities'][0]['name']='갱신 시설';map_path.write_text(json.dumps(updated),encoding='utf-8')
                self.assertEqual(get('/api/meta')['map']['facilities'][0]['name'],'갱신 시설')
                self.assertNotEqual(get('/api/meta')['hashes']['map'], initial['hashes']['map'])
                self.assertEqual(get('/api/state')['map_hash'], initial['hashes']['map'])
                with make_server(0, root=root) as restarted:
                    self.assertEqual(restarted.background.snapshot()['map_hash'], get('/api/meta')['hashes']['map'])
                map_path.write_text('{',encoding='utf-8')
                with self.assertRaises(HTTPError) as caught:get('/api/meta')
                self.assertEqual(caught.exception.code,422)
                map_path.write_text(original,encoding='utf-8');self.assertEqual(get('/api/meta')['map']['facilities'][0]['name'],initial['map']['facilities'][0]['name'])
                (root/'web/index.html').write_text('수정 화면',encoding='utf-8')
                with urlopen(base,timeout=3) as response:self.assertEqual(response.read().decode(),'수정 화면')
                self.assertTrue(thread.is_alive())
            finally:
                server.shutdown();server.server_close();thread.join()

    def test_python_edit_restarts_child_on_same_port(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            shutil.copytree(ROOT/'configs',root/'configs')
            shutil.copytree(ROOT/'lotteworld_sim',root/'lotteworld_sim',ignore=shutil.ignore_patterns('__pycache__'))
            (root/'web').mkdir()
            with socket.socket() as reservation:
                reservation.bind(('127.0.0.1',0));port=reservation.getsockname()[1]
            stop=threading.Event();thread=threading.Thread(target=supervise,args=(root,port,None,stop),daemon=True);thread.start()
            def wait_instance(previous=None):
                deadline=time.monotonic()+12
                while time.monotonic()<deadline:
                    try:
                        with urlopen(f'http://127.0.0.1:{port}/api/dev-version',timeout=.5) as response:instance=json.load(response)['instance']
                        if instance!=previous:return instance
                    except (URLError,OSError,ValueError):pass
                    stop.wait(.1)
                self.fail('같은 포트의 서버가 제한 시간 안에 준비되지 않았습니다.')
            try:
                first=wait_instance()
                source=root/'lotteworld_sim/__init__.py';source.write_text(source.read_text(encoding='utf-8')+'\n# 자동 반영 검사\n',encoding='utf-8')
                self.assertNotEqual(wait_instance(first),first)
                self.assertTrue(thread.is_alive())
            finally:
                stop.set();thread.join(timeout=5)
                self.assertFalse(thread.is_alive())
