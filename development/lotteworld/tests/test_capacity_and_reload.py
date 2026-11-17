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

from lotteworld_sim.scenario import ROOT,load_inputs,validate
from lotteworld_sim.server import make_server
from lotteworld_sim.devserver import supervise


class QueueCapacityTests(unittest.TestCase):
    def test_verified_slots_meet_each_boarding_unit(self):
        scenario=load_inputs();report=scenario.metadata()['queue_report']
        expected={'atlantis':(8,20,105),'gyro-drop':(40,100,105),'gyro-swing':(40,100,105),'gyro-spin':(40,100,130),'comet-express':(26,65,130),'arcana-ride':(16,40,126)}
        for id,(boarding,minimum,capacity) in expected.items():
            with self.subTest(facility=id):
                row=report[id]
                self.assertEqual((row['boarding_capacity'],row['minimum_capacity'],row['capacity']),(boarding,minimum,capacity))
                self.assertTrue(row['meets_minimum'])
                self.assertEqual(len(row['slots']),capacity)
                for i,p in enumerate(row['slots']):
                    self.assertTrue(all(math.dist(p,q)>=.8-1e-6 for q in row['slots'][i+1:]))

    def test_insufficient_capacity_and_body_overlap_rejected(self):
        scenario=load_inputs()
        for key,value in [('boarding',49),('spacing_m',1),('person_radius_m',.5),('minimum_boarding_multiple',2)]:
            data=deepcopy(scenario.map)
            if key=='boarding':data['facilities'][0]['boarding_capacity']=value
            else:data['geometry']['queue_rules'][key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):validate(data,scenario.config,scenario.preferences)


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
                with urlopen(base+path,timeout=3) as response:return json.load(response)
            try:
                initial=get('/api/meta');version=get('/api/dev-version')
                path=root/'configs/day.json';data=json.loads(path.read_text(encoding='utf-8'));data['seed']+=1;path.write_text(json.dumps(data),encoding='utf-8')
                self.assertEqual(get('/api/meta')['config']['seed'],initial['config']['seed']+1)
                self.assertEqual(get('/api/dev-version')['instance'],version['instance'])
                self.assertNotEqual(get('/api/dev-version')['version'],version['version'])
                map_path=root/'configs/map.json';original=map_path.read_text(encoding='utf-8');updated=json.loads(original);updated['facilities'][0]['name']='갱신 시설';map_path.write_text(json.dumps(updated),encoding='utf-8')
                self.assertEqual(get('/api/meta')['map']['facilities'][0]['name'],'갱신 시설')
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
