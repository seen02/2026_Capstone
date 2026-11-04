import json
import threading
import unittest
from urllib.request import Request,urlopen
from aquarium_sim.server import make_server

class PlaybackApiTests(unittest.TestCase):
    def test_motion_frames_match_final_state(self):
        server=make_server(0)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        def post(path,data):
            request=Request(f'http://127.0.0.1:{server.server_port}{path}',data=json.dumps(data).encode(),headers={'Content-Type':'application/json'})
            with urlopen(request) as response:return json.load(response)
        try:
            post('/api/advance',{'seconds':120})
            data=post('/api/advance',{'seconds':2,'motion':True})
            frames=data['motion_frames']
            self.assertEqual(len(frames),9)
            self.assertTrue(frames[0]['visitors'])
            self.assertTrue(all(abs(b['time']-a['time']-.25)<1e-8 for a,b in zip(frames,frames[1:])))
            self.assertEqual(frames[-1]['time'],data['time'])
            self.assertEqual(frames[-1]['visitors'],data['visitors'])
        finally:server.shutdown();server.server_close();thread.join()

    def test_seek_replays_active_settings_and_rejects_invalid_time(self):
        from urllib.error import HTTPError
        server=make_server(0)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        def post(path,data):
            request=Request(f'http://127.0.0.1:{server.server_port}{path}',data=json.dumps(data).encode(),headers={'Content-Type':'application/json'})
            with urlopen(request) as response:return json.load(response)
        try:
            start=post('/api/reset',{'daily_visitors':70,'seed':987,'arrival_profile':'uniform_baseline'})
            target=start['opening']+3600
            expected=post('/api/advance',{'target':target})
            post('/api/seek',{'target':start['horizon']})
            replay=post('/api/seek',{'target':target})
            self.assertEqual(expected,replay)
            self.assertEqual(replay['metrics']['planned'],70)
            opening=post('/api/seek',{'target':start['opening']})
            self.assertEqual(opening,start)
            for invalid in [start['opening']-1,start['horizon']+1,None,True]:
                with self.assertRaises(HTTPError) as caught:post('/api/seek',{'target':invalid})
                self.assertEqual(caught.exception.code,400)
            with urlopen(f'http://127.0.0.1:{server.server_port}/api/state') as response:
                self.assertEqual(json.load(response),start)
            with self.assertRaises(HTTPError) as caught:
                urlopen(f'http://127.0.0.1:{server.server_port}/api/report')
            self.assertEqual(caught.exception.code,404)
        finally:server.shutdown();server.server_close();thread.join()


    def test_compact_motion_preserves_positions_and_batch_boundary(self):
        server=make_server(0)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        def post(path,data):
            request=Request(f'http://127.0.0.1:{server.server_port}{path}',data=json.dumps(data).encode(),headers={'Content-Type':'application/json'})
            with urlopen(request) as response:return json.load(response)
        try:
            post('/api/seek',{'target':37800})
            full=post('/api/advance',{'seconds':2,'motion':True})
            post('/api/seek',{'target':37800})
            compact=post('/api/advance',{'seconds':2,'motion':True,'motion_format':'compact-v1'})
            fields=['id','persona','state','node','next_node','progress','queue_rank','queue_count','queue_slot']
            self.assertEqual(compact['motion_format'],'compact-v1')
            for a,b in zip(full['motion_frames'],compact['motion_frames']):
                self.assertEqual(a['time'],b['time'])
                self.assertEqual([[v[k] for k in fields] for v in a['visitors']],b['visitors'])
            self.assertEqual(full['metrics'],compact['metrics'])
            next_batch=post('/api/advance',{'seconds':2,'motion':True,'motion_format':'compact-v1'})
            self.assertEqual(compact['motion_frames'][-1],next_batch['motion_frames'][0])
            self.assertLess(len(json.dumps(compact['motion_frames'])),len(json.dumps(full['motion_frames']))*.4)
        finally:server.shutdown();server.server_close();thread.join()
